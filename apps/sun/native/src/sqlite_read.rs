//! SQLite, read in parallel without creating a database and without blocking anybody else's.
//!
//! ## Never creates a database
//!
//! SQLite's `open` creates a missing file unless told otherwise, and an empty file is a valid empty
//! database - so "the path was mistyped" turns silently into "the table does not exist", with a new
//! file left behind. Here the file must already exist and start with SQLite's 16-byte signature
//! (a zero-byte file is refused too), and it is opened through the URI form with `mode=ro` and the
//! read-only flag only - never `SQLITE_OPEN_CREATE`. ATTACH is limited to zero databases, so a
//! query cannot open (or create) a second file either.
//!
//! ## Never blocks the database
//!
//! An ordinary SQLite reader holds a SHARED lock for as long as a statement runs, and in the classic
//! rollback-journal mode a writer cannot commit until every SHARED lock is gone - a slow analytical
//! read here would stall the application that owns the database. So:
//!
//! - **Rollback-journal databases are opened `immutable=1`**: SQLite takes no file locks at all, so
//!   a writer can never wait on this program. The price is that nothing stops a write landing while
//!   we read, so every read is wrapped in an optimistic check: a fingerprint of the file (the commit
//!   counter in the header, its size and timestamp, and whether a hot journal says a write is in
//!   progress) before and after. A mismatch retries; after the retries the answer is returned
//!   flagged `consistent: false`, never silently.
//! - **WAL databases whose WAL file holds data** cannot be read immutable (that mode ignores the WAL,
//!   so the newest commits would be missing). They are opened as an ordinary read-only WAL reader,
//!   and a WAL reader never blocks a writer - that is the point of WAL. The WAL file joins the
//!   fingerprint, because parallel workers each take their own snapshot.
//! - A WAL database with no WAL data left is wholly in the main file and is read immutable.
//!
//! ## Fast
//!
//! A table scan is split into rowid ranges and every range runs on its own connection on its own
//! core. Filtering and per-range grouping happen inside SQLite (C, with indexes); the ranges are
//! merged here. Tables without a rowid, and views, run as one range.

use rayon::prelude::*;
use rusqlite::limits::Limit;
use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

const SIGNATURE: &[u8; 16] = b"SQLite format 3\0";
/// Rollback-journal header magic: a journal that starts with it belongs to a write in progress.
const JOURNAL_MAGIC: [u8; 8] = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7];
const ATTEMPTS: u32 = 4;
const MAX_TEXT: usize = 4000;
/// Ranges per core: more than one, so a range full of matches does not leave the others idle.
const RANGES_PER_CORE: usize = 4;

fn s<'a>(r: &'a Value, key: &str) -> Option<&'a str> {
    r.get(key).and_then(Value::as_str)
}
fn u(r: &Value, key: &str, default: u64) -> u64 {
    r.get(key).and_then(Value::as_u64).unwrap_or(default)
}
fn threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

// ─── Opening ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
enum Access {
    /// No locks at all; guarded by the fingerprint.
    Immutable,
    /// A WAL reader: shares the WAL index, never blocks a writer.
    WalReader,
}

impl Access {
    fn describe(self) -> &'static str {
        match self {
            Access::Immutable => "lock-free (opened immutable: no locks taken, checked for changes before and after)",
            Access::WalReader => "WAL reader (read-only; a WAL reader never blocks writers)",
        }
    }
}

#[derive(Clone)]
struct Db {
    path: PathBuf,
    uri: String,
    access: Access,
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// `file:` URI for SQLite. Only the characters SQLite's URI parser treats specially are escaped.
fn uri_for(path: &Path, access: Access) -> String {
    let mut p = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = p.strip_prefix("//?/UNC/") {
        p = format!("//{rest}");
    } else if let Some(rest) = p.strip_prefix("//?/") {
        p = rest.to_string();
    }
    let mut escaped = String::with_capacity(p.len() + 16);
    for ch in p.chars() {
        match ch {
            '%' => escaped.push_str("%25"),
            '?' => escaped.push_str("%3f"),
            '#' => escaped.push_str("%23"),
            ' ' => escaped.push_str("%20"),
            _ => escaped.push(ch),
        }
    }
    // A drive path needs an empty authority (file:///C:/...); a UNC path keeps its leading //.
    let prefix = if escaped.starts_with("//") { "file:" } else if escaped.starts_with('/') { "file://" } else { "file:///" };
    let flags = match access {
        Access::Immutable => "?mode=ro&immutable=1",
        Access::WalReader => "?mode=ro",
    };
    format!("{prefix}{escaped}{flags}")
}

/// Checks the file is an existing SQLite database and decides how to read it. Creates nothing.
fn locate(r: &Value) -> Result<Db, String> {
    let path = PathBuf::from(s(r, "path").ok_or("No database path given.")?);
    let meta = std::fs::metadata(&path).map_err(|_| {
        format!("There is no database at {} - nothing was created; check the path.", path.display())
    })?;
    if !meta.is_file() {
        return Err(format!("{} is a folder, not a database file.", path.display()));
    }
    let mut header = [0u8; 100];
    let read = File::open(&path)
        .and_then(|mut f| f.read(&mut header))
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if read == 0 {
        return Err(format!("{} is an empty file, not a database. It was left as it is.", path.display()));
    }
    if read < 100 || &header[..16] != SIGNATURE {
        return Err(format!("{} is not a SQLite database (it does not start with SQLite's signature).", path.display()));
    }
    // Bytes 18 and 19 are the write and read format versions; 2 means WAL.
    let wal_mode = header[18] == 2 || header[19] == 2;
    let wal_has_data = std::fs::metadata(sidecar(&path, "-wal")).map(|m| m.len() > 0).unwrap_or(false);
    let access = if wal_mode && wal_has_data { Access::WalReader } else { Access::Immutable };
    Ok(Db { uri: uri_for(&path, access), path, access })
}

/*
 * Before SQLite starts: no global memory statistics, and multi-thread mode (every worker has its own
 * connection, so SQLite's per-connection mutexes are not needed). With the defaults every allocation in
 * every worker took one global lock, and the parallel scan measured *slower* than a single connection
 * (3.2s against 1.05s over 5 million rows). Memory-mapped I/O is deliberately not switched on: on
 * Windows a mapped file cannot be truncated, so an application vacuuming its database would fail while
 * this read - the one thing this module promises not to do.
 */
fn configure_once() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_config(rusqlite::ffi::SQLITE_CONFIG_MEMSTATUS, 0 as std::os::raw::c_int);
        rusqlite::ffi::sqlite3_config(rusqlite::ffi::SQLITE_CONFIG_MULTITHREAD);
    });
}

fn open(db: &Db) -> Result<Connection, String> {
    configure_once();
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(&db.uri, flags).map_err(|e| format!("Could not open {}: {e}", db.path.display()))?;
    // A query cannot reach (or create) a second file.
    let _ = conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
    let _ = conn.pragma_update(None, "query_only", true);
    // Sorting and grouping build temporary B-trees, which by default go to a temp *file* - one per range,
    // each created and antivirus-scanned on Windows. Measured: 5.1s on one thread against 1.05s for the
    // same plain query. In memory, and no file is written anywhere.
    let _ = conn.pragma_update(None, "temp_store", "MEMORY");
    // Only a WAL reader can ever wait, and only for the WAL index, never for a writer to finish.
    let _ = conn.busy_timeout(Duration::from_secs(3));
    Ok(conn)
}

// ─── The change check ───────────────────────────────────────────────────────

#[derive(PartialEq, Debug)]
struct Fingerprint {
    size: u64,
    modified: u128,
    counter: [u8; 4],
    wal: Option<(u64, u128)>,
    writing: bool,
}

fn stat(path: &Path) -> Option<(u64, u128)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
    Some((meta.len(), modified))
}

fn fingerprint(db: &Db) -> Fingerprint {
    let (size, modified) = stat(&db.path).unwrap_or((0, 0));
    let mut header = [0u8; 28];
    let _ = File::open(&db.path).and_then(|mut f| f.read_exact(&mut header));
    let mut journal = [0u8; 8];
    let writing = File::open(sidecar(&db.path, "-journal")).and_then(|mut f| f.read_exact(&mut journal)).is_ok() && journal == JOURNAL_MAGIC;
    Fingerprint {
        size,
        modified,
        counter: [header[24], header[25], header[26], header[27]],
        wal: stat(&sidecar(&db.path, "-wal")),
        writing,
    }
}

/// Runs `read` until the database looks the same before and after it; says so when it never did.
fn consistent<T>(db: &Db, read: impl Fn() -> Result<T, String>) -> Result<(T, bool), String> {
    let mut last = None;
    for attempt in 0..ATTEMPTS {
        let before = fingerprint(db);
        if before.writing {
            std::thread::sleep(Duration::from_millis(100 * u64::from(attempt + 1)));
            continue;
        }
        let result = read();
        if fingerprint(db) == before {
            return result.map(|value| (value, true));
        }
        last = Some(result);
        std::thread::sleep(Duration::from_millis(50 * u64::from(attempt + 1)));
    }
    match last {
        Some(result) => result.map(|value| (value, false)),
        None => read().map(|value| (value, false)),
    }
}

// ─── Values ─────────────────────────────────────────────────────────────────

fn to_json(value: ValueRef) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        // Beyond 2^53 a JSON number loses digits; an id must stay exact.
        ValueRef::Integer(i) if i.unsigned_abs() > (1u64 << 53) => json!(i.to_string()),
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => if f.is_finite() { json!(f) } else { json!(f.to_string()) },
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            if text.chars().count() > MAX_TEXT {
                json!(format!("{}... [{} characters]", text.chars().take(MAX_TEXT).collect::<String>(), text.chars().count()))
            } else {
                json!(text)
            }
        }
        ValueRef::Blob(bytes) => {
            let head: String = bytes.iter().take(16).map(|b| format!("{b:02x}")).collect();
            json!(format!("<blob {} bytes{}>", bytes.len(), if bytes.is_empty() { String::new() } else { format!(": {head}{}", if bytes.len() > 16 { "..." } else { "" }) }))
        }
    }
}

/// A parameter as SQL: whole numbers as integers, other numbers as reals, everything else as text.
fn bind(value: &Value) -> Sql {
    match value {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(i64::from(*b)),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(text) => match (text.parse::<i64>(), text.parse::<f64>()) {
            (Ok(i), _) => Sql::Integer(i),
            (_, Ok(f)) if f.is_finite() => Sql::Real(f),
            _ => Sql::Text(text.clone()),
        },
        other => Sql::Text(other.to_string()),
    }
}

fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

// ─── Schema ─────────────────────────────────────────────────────────────────

struct TableInfo {
    name: String,
    kind: String,
    columns: Vec<(String, String, bool)>,
    has_rowid: bool,
}

fn tables(conn: &Connection) -> Result<Vec<TableInfo>, String> {
    let mut stmt = conn
        .prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|e| e.to_string())?;
    let names: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    let mut out = Vec::new();
    for (name, kind) in names {
        let mut info = conn.prepare(&format!("PRAGMA table_info({})", quote(&name))).map_err(|e| e.to_string())?;
        let columns = info
            .query_map([], |row| Ok((row.get::<_, String>(1)?, row.get::<_, String>(2).unwrap_or_default(), row.get::<_, i64>(5)? > 0)))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        let has_rowid = kind == "table" && conn.prepare(&format!("SELECT rowid FROM {} LIMIT 0", quote(&name))).is_ok();
        out.push(TableInfo { name, kind, columns, has_rowid });
    }
    Ok(out)
}

fn find_table<'a>(all: &'a [TableInfo], name: &str) -> Result<&'a TableInfo, String> {
    all.iter().find(|t| t.name == name).or_else(|| all.iter().find(|t| t.name.eq_ignore_ascii_case(name))).ok_or_else(|| {
        format!("No table or view named \"{name}\". There are: {}.", all.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", "))
    })
}

fn column<'a>(table: &'a TableInfo, name: &str) -> Result<&'a str, String> {
    table.columns.iter().map(|c| c.0.as_str()).find(|c| c.eq_ignore_ascii_case(name)).ok_or_else(|| {
        format!("\"{}\" has no column \"{name}\". Columns: {}.", table.name, table.columns.iter().map(|c| c.0.as_str()).collect::<Vec<_>>().join(", "))
    })
}

fn schema(db: &Db, r: &Value) -> Result<Value, String> {
    let conn = open(db)?;
    let all = tables(&conn)?;
    let counts = r.get("counts").and_then(Value::as_bool).unwrap_or(true);
    let indexes: Vec<(String, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT name, tbl_name, coalesce(sql,'') FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    // Row counts, one table per connection on every core.
    let numbers: Vec<Option<i64>> = all
        .par_iter()
        .map(|t| {
            if !counts || t.kind != "table" {
                return None;
            }
            let conn = open(db).ok()?;
            conn.query_row(&format!("SELECT count(*) FROM {}", quote(&t.name)), [], |row| row.get(0)).ok()
        })
        .collect();
    let journal: String = conn.pragma_query_value(None, "journal_mode", |row| row.get(0)).unwrap_or_default();
    let page_size: i64 = conn.pragma_query_value(None, "page_size", |row| row.get(0)).unwrap_or(0);
    let list: Vec<Value> = all
        .iter()
        .zip(numbers)
        .map(|(t, rows)| {
            json!({
                "name": t.name, "kind": t.kind, "rows": rows, "rowid": t.has_rowid,
                "columns": t.columns.iter().map(|(n, ty, pk)| json!({ "name": n, "type": ty, "primaryKey": pk })).collect::<Vec<_>>(),
                "indexes": indexes.iter().filter(|i| i.1 == t.name).map(|i| json!({ "name": i.0, "sql": i.2 })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({ "tables": list, "journalMode": journal, "pageSize": page_size }))
}

// ─── Query ──────────────────────────────────────────────────────────────────

fn query(db: &Db, r: &Value) -> Result<Value, String> {
    let sql = s(r, "sql").ok_or("No SQL given.")?.trim().trim_end_matches(';').trim().to_string();
    let limit = u(r, "limit", 200).clamp(1, 5000) as usize;
    let params: Vec<Sql> = r.get("params").and_then(Value::as_array).map(|a| a.iter().map(bind).collect()).unwrap_or_default();
    let conn = open(db)?;
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("SQLite refused the query: {e}"))?;
    if !stmt.readonly() {
        return Err("Only reading statements run here (SELECT, WITH, read-only PRAGMA, EXPLAIN). Nothing was changed.".into());
    }
    let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let width = columns.len();
    let mut rows = stmt.query(params_from_iter(params.iter())).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut more = false;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if out.len() == limit {
            more = true;
            break;
        }
        out.push(Value::Array((0..width).map(|i| row.get_ref(i).map(to_json).unwrap_or(Value::Null)).collect()));
    }
    Ok(json!({ "columns": columns, "rows": out, "more": more }))
}

// ─── Parallel scan ──────────────────────────────────────────────────────────

/// Rowid ranges covering the table, or one unbounded range for a table without rowids or a view.
fn ranges(conn: &Connection, table: &TableInfo) -> Vec<Option<(i64, i64)>> {
    if !table.has_rowid {
        return vec![None];
    }
    let bounds: Option<(i64, i64)> = conn
        .query_row(&format!("SELECT min(rowid), max(rowid) FROM {}", quote(&table.name)), [], |row| {
            Ok(match (row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?) {
                (Some(a), Some(b)) => Some((a, b)),
                _ => None,
            })
        })
        .unwrap_or(None);
    let Some((low, high)) = bounds else { return vec![] };
    let pieces = (threads() * RANGES_PER_CORE) as i128;
    let span = i128::from(high) - i128::from(low) + 1;
    let step = ((span + pieces - 1) / pieces).max(1);
    let mut out = Vec::new();
    let mut start = i128::from(low);
    while start <= i128::from(high) {
        let end = (start + step - 1).min(i128::from(high));
        out.push(Some((start as i64, end as i64)));
        start = end + 1;
    }
    out
}

/// A WHERE clause and its parameters from `filters`, with every column checked against the table.
fn filters_sql(table: &TableInfo, r: &Value) -> Result<(Vec<String>, Vec<Sql>), String> {
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    for f in r.get("filters").and_then(Value::as_array).cloned().unwrap_or_default() {
        let col = quote(column(table, f.get("column").and_then(Value::as_str).unwrap_or(""))?);
        let op = f.get("op").and_then(Value::as_str).unwrap_or("eq");
        let value = f.get("value").cloned().unwrap_or(Value::Null);
        let text = match &value { Value::String(t) => t.clone(), Value::Null => String::new(), other => other.to_string() };
        let compare = |sym: &str, clauses: &mut Vec<String>, params: &mut Vec<Sql>| {
            clauses.push(format!("{col} {sym} ?"));
            params.push(bind(&value));
        };
        match op {
            "eq" => compare("=", &mut clauses, &mut params),
            "ne" => {
                clauses.push(format!("({col} IS NULL OR {col} <> ?)"));
                params.push(bind(&value));
            }
            "gt" => compare(">", &mut clauses, &mut params),
            "ge" => compare(">=", &mut clauses, &mut params),
            "lt" => compare("<", &mut clauses, &mut params),
            "le" => compare("<=", &mut clauses, &mut params),
            "contains" => {
                clauses.push(format!("instr(lower(CAST({col} AS TEXT)), lower(?)) > 0"));
                params.push(Sql::Text(text));
            }
            "startsWith" => {
                clauses.push(format!("substr(lower(CAST({col} AS TEXT)), 1, length(?)) = lower(?)"));
                params.push(Sql::Text(text.clone()));
                params.push(Sql::Text(text));
            }
            "empty" => clauses.push(format!("({col} IS NULL OR trim(CAST({col} AS TEXT)) = '')")),
            "notEmpty" => clauses.push(format!("({col} IS NOT NULL AND trim(CAST({col} AS TEXT)) <> '')")),
            other => return Err(format!("Unknown filter \"{other}\".")),
        }
    }
    Ok((clauses, params))
}

fn range_sql(range: Option<(i64, i64)>, clauses: &[String], params: &[Sql]) -> (String, Vec<Sql>) {
    let mut all = clauses.to_vec();
    let mut values = Vec::new();
    if let Some((a, b)) = range {
        all.insert(0, "rowid BETWEEN ? AND ?".into());
        values.push(Sql::Integer(a));
        values.push(Sql::Integer(b));
    }
    values.extend(params.iter().cloned());
    (if all.is_empty() { String::new() } else { format!(" WHERE {}", all.join(" AND ")) }, values)
}

#[derive(Default, Clone)]
struct Partial {
    count: i64,
    sums: Vec<f64>,
    numeric: Vec<i64>,
    mins: Vec<Option<Value>>,
    maxs: Vec<Option<Value>>,
}

fn ordering(a: &Value, b: &Value) -> std::cmp::Ordering {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => a.to_string().cmp(&b.to_string()),
    }
}

fn scan(db: &Db, r: &Value) -> Result<Value, String> {
    let started = Instant::now();
    let conn = open(db)?;
    let all = tables(&conn)?;
    let table = find_table(&all, s(r, "table").ok_or("Which table? Give `table`.")?)?;
    let (clauses, params) = filters_sql(table, r)?;
    let pieces = ranges(&conn, table);
    let limit = u(r, "limit", 50).clamp(1, 2000) as usize;
    let offset = u(r, "offset", 0) as usize;
    let group: Vec<String> = r
        .get("groupBy")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(|c| column(table, c).map(String::from)).collect::<Result<Vec<_>, _>>())
        .transpose()?
        .unwrap_or_default();
    let aggregates: Vec<(String, Option<String>)> = r
        .get("aggregates")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|x| {
                    let f = x.get("fn").and_then(Value::as_str).unwrap_or("count").to_string();
                    let c = x.get("column").and_then(Value::as_str).map(|c| column(table, c).map(String::from)).transpose()?;
                    Ok((f, c))
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .transpose()?
        .unwrap_or_default();
    let sort: Vec<(String, bool)> = r
        .get("sort")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|x| (x.get("column").and_then(Value::as_str).unwrap_or("").to_string(), x.get("desc").and_then(Value::as_bool).unwrap_or(false))).collect())
        .unwrap_or_default();
    let ranges_used = pieces.len();

    if group.is_empty() && aggregates.is_empty() {
        // Rows: each range returns its matches in order (or sorted), counting every match but
        // decoding only the first offset+limit of them.
        let columns: Vec<String> = match r.get("columns").and_then(Value::as_array) {
            Some(a) if !a.is_empty() => a.iter().filter_map(Value::as_str).map(|c| column(table, c).map(String::from)).collect::<Result<_, _>>()?,
            _ => table.columns.iter().map(|c| c.0.clone()).collect(),
        };
        let order_sql = if sort.is_empty() {
            if table.has_rowid { " ORDER BY rowid".to_string() } else { String::new() }
        } else {
            let parts = sort.iter().map(|(c, d)| Ok(format!("{} {}", quote(column(table, c)?), if *d { "DESC" } else { "ASC" }))).collect::<Result<Vec<_>, String>>()?;
            format!(" ORDER BY {}", parts.join(", "))
        };
        let keep = offset + limit;
        let select = columns.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
        let sort_index: Vec<(usize, bool)> = sort.iter().filter_map(|(c, d)| columns.iter().position(|x| x.eq_ignore_ascii_case(c)).map(|i| (i, *d))).collect();
        let ((matched, mut rows), consistent) = consistent(db, || {
            let parts: Vec<Result<(i64, Vec<Vec<Value>>), String>> = pieces
                .par_iter()
                .map(|range| {
                    let conn = open(db)?;
                    let (where_sql, values) = range_sql(*range, &clauses, &params);
                    let sql = format!("SELECT {select} FROM {}{where_sql}{order_sql}", quote(&table.name));
                    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                    let mut cursor = stmt.query(params_from_iter(values.iter())).map_err(|e| e.to_string())?;
                    let (mut count, mut kept) = (0i64, Vec::new());
                    while let Some(row) = cursor.next().map_err(|e| e.to_string())? {
                        if kept.len() < keep {
                            kept.push((0..columns.len()).map(|i| row.get_ref(i).map(to_json).unwrap_or(Value::Null)).collect());
                        }
                        count += 1;
                    }
                    Ok((count, kept))
                })
                .collect();
            let mut matched = 0;
            let mut rows = Vec::new();
            for part in parts {
                let (count, kept) = part?;
                matched += count;
                rows.extend(kept);
            }
            Ok((matched, rows))
        })?;
        // Ranges came back in rowid order; a sort is merged here across them.
        if !sort_index.is_empty() {
            rows.sort_by(|a, b| {
                for (i, desc) in &sort_index {
                    let o = ordering(&a[*i], &b[*i]);
                    if o != std::cmp::Ordering::Equal {
                        return if *desc { o.reverse() } else { o };
                    }
                }
                std::cmp::Ordering::Equal
            });
        }
        let page: Vec<Value> = rows.into_iter().skip(offset).take(limit).map(Value::Array).collect();
        let more = (offset + page.len()) < matched as usize;
        return Ok(json!({
            "columns": columns, "rows": page, "matchedRows": matched, "resultRows": matched, "offset": offset, "more": more,
            "ranges": ranges_used, "consistent": consistent, "ms": started.elapsed().as_millis() as u64,
        }));
    }

    // Grouping: every range groups inside SQLite, and the partial groups are merged here.
    let aggs = if aggregates.is_empty() { vec![("count".to_string(), None)] } else { aggregates };
    let distinct_cols: Vec<String> = aggs.iter().filter(|a| a.0 == "distinct").filter_map(|a| a.1.clone()).collect();
    let value_cols: Vec<String> = {
        let mut v: Vec<String> = aggs.iter().filter(|a| a.0 != "count" && a.0 != "distinct").filter_map(|a| a.1.clone()).collect();
        v.dedup();
        v
    };
    for (f, c) in &aggs {
        if f != "count" && c.is_none() {
            return Err(format!("{f} needs a column."));
        }
        if !["count", "sum", "avg", "min", "max", "distinct"].contains(&f.as_str()) {
            return Err(format!("Unknown aggregate \"{f}\"."));
        }
    }
    let group_sql = group.iter().map(|c| quote(c)).collect::<Vec<_>>();
    let mut select = group_sql.clone();
    select.push("count(*)".into());
    // Four slots per column, but only the aggregates asked for are computed per row; the others are
    // constants. Computing all four always made a sum cost twice what SQLite needed.
    for c in &value_cols {
        let q = quote(c);
        let wants = |f: &str| aggs.iter().any(|(name, col)| name == f && col.as_deref() == Some(c.as_str()));
        select.push(if wants("sum") || wants("avg") { format!("total({q})") } else { "0".into() });
        select.push(if wants("avg") { format!("count(CASE WHEN typeof({q}) IN ('integer','real') THEN 1 END)") } else { "0".into() });
        select.push(if wants("min") { format!("min({q})") } else { "NULL".into() });
        select.push(if wants("max") { format!("max({q})") } else { "NULL".into() });
    }
    let group_clause = if group.is_empty() { String::new() } else { format!(" GROUP BY {}", group_sql.join(", ")) };
    type Groups = HashMap<String, (Vec<Value>, Partial, Vec<HashSet<String>>)>;
    let (groups, consistent) = consistent(db, || {
        let parts: Vec<Result<Groups, String>> = pieces
            .par_iter()
            .map(|range| {
                let conn = open(db)?;
                let (where_sql, values) = range_sql(*range, &clauses, &params);
                let mut groups: Groups = HashMap::new();
                let sql = format!("SELECT {} FROM {}{where_sql}{group_clause}", select.join(", "), quote(&table.name));
                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                let mut cursor = stmt.query(params_from_iter(values.iter())).map_err(|e| e.to_string())?;
                while let Some(row) = cursor.next().map_err(|e| e.to_string())? {
                    let key_values: Vec<Value> = (0..group.len()).map(|i| row.get_ref(i).map(to_json).unwrap_or(Value::Null)).collect();
                    let count: i64 = row.get(group.len()).unwrap_or(0);
                    if count == 0 {
                        continue;
                    }
                    let entry = groups.entry(Value::Array(key_values.clone()).to_string()).or_insert_with(|| {
                        (key_values, Partial { sums: vec![0.0; value_cols.len()], numeric: vec![0; value_cols.len()], mins: vec![None; value_cols.len()], maxs: vec![None; value_cols.len()], count: 0 }, vec![HashSet::new(); distinct_cols.len()])
                    });
                    entry.1.count += count;
                    for (j, _) in value_cols.iter().enumerate() {
                        let base = group.len() + 1 + j * 4;
                        entry.1.sums[j] += row.get::<_, f64>(base).unwrap_or(0.0);
                        entry.1.numeric[j] += row.get::<_, i64>(base + 1).unwrap_or(0);
                        let lo = row.get_ref(base + 2).map(to_json).unwrap_or(Value::Null);
                        let hi = row.get_ref(base + 3).map(to_json).unwrap_or(Value::Null);
                        if !lo.is_null() && entry.1.mins[j].as_ref().map_or(true, |m| ordering(&lo, m).is_lt()) {
                            entry.1.mins[j] = Some(lo);
                        }
                        if !hi.is_null() && entry.1.maxs[j].as_ref().map_or(true, |m| ordering(&hi, m).is_gt()) {
                            entry.1.maxs[j] = Some(hi);
                        }
                    }
                }
                // Distinct values cannot be merged from per-range counts, so the values themselves come back.
                for (d, col) in distinct_cols.iter().enumerate() {
                    let mut keys = group_sql.clone();
                    keys.push(quote(col));
                    let sql = format!("SELECT {} FROM {}{where_sql} GROUP BY {}", keys.join(", "), quote(&table.name), keys.join(", "));
                    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                    let mut cursor = stmt.query(params_from_iter(values.iter())).map_err(|e| e.to_string())?;
                    while let Some(row) = cursor.next().map_err(|e| e.to_string())? {
                        let key_values: Vec<Value> = (0..group.len()).map(|i| row.get_ref(i).map(to_json).unwrap_or(Value::Null)).collect();
                        if let Some(entry) = groups.get_mut(&Value::Array(key_values).to_string()) {
                            if entry.2[d].len() < 1_000_000 {
                                entry.2[d].insert(row.get_ref(group.len()).map(to_json).unwrap_or(Value::Null).to_string());
                            }
                        }
                    }
                }
                Ok(groups)
            })
            .collect();
        let mut merged: Groups = HashMap::new();
        for part in parts {
            for (key, (values, partial, sets)) in part? {
                match merged.get_mut(&key) {
                    None => {
                        merged.insert(key, (values, partial, sets));
                    }
                    Some(entry) => {
                        entry.1.count += partial.count;
                        for j in 0..value_cols.len() {
                            entry.1.sums[j] += partial.sums[j];
                            entry.1.numeric[j] += partial.numeric[j];
                            if let Some(lo) = &partial.mins[j] {
                                if entry.1.mins[j].as_ref().map_or(true, |m| ordering(lo, m).is_lt()) {
                                    entry.1.mins[j] = Some(lo.clone());
                                }
                            }
                            if let Some(hi) = &partial.maxs[j] {
                                if entry.1.maxs[j].as_ref().map_or(true, |m| ordering(hi, m).is_gt()) {
                                    entry.1.maxs[j] = Some(hi.clone());
                                }
                            }
                        }
                        for (d, set) in sets.into_iter().enumerate() {
                            entry.2[d].extend(set);
                        }
                    }
                }
            }
        }
        Ok(merged)
    })?;

    let mut columns: Vec<String> = group.clone();
    for (f, c) in &aggs {
        columns.push(match c { Some(c) => format!("{f}({c})"), None => format!("{f}") });
    }
    let matched: i64 = groups.values().map(|g| g.1.count).sum();
    let mut rows: Vec<Vec<Value>> = groups
        .into_values()
        .map(|(mut values, partial, sets)| {
            for (f, c) in &aggs {
                let j = c.as_ref().and_then(|c| value_cols.iter().position(|v| v == c));
                values.push(match (f.as_str(), j) {
                    ("count", _) => json!(partial.count),
                    ("sum", Some(j)) => json!(partial.sums[j]),
                    ("avg", Some(j)) => if partial.numeric[j] > 0 { json!(partial.sums[j] / partial.numeric[j] as f64) } else { Value::Null },
                    ("min", Some(j)) => partial.mins[j].clone().unwrap_or(Value::Null),
                    ("max", Some(j)) => partial.maxs[j].clone().unwrap_or(Value::Null),
                    ("distinct", _) => {
                        let d = c.as_ref().and_then(|c| distinct_cols.iter().position(|v| v == c)).unwrap_or(0);
                        json!(sets.get(d).map_or(0, HashSet::len))
                    }
                    _ => Value::Null,
                });
            }
            values
        })
        .collect();
    let sort_index: Vec<(usize, bool)> = if sort.is_empty() {
        (0..group.len()).map(|i| (i, false)).collect()
    } else {
        sort.iter()
            .map(|(c, d)| columns.iter().position(|x| x.eq_ignore_ascii_case(c)).map(|i| (i, *d)).ok_or_else(|| format!("Sort by a result column: {}.", columns.join(", "))))
            .collect::<Result<_, _>>()?
    };
    rows.sort_by(|a, b| {
        for (i, desc) in &sort_index {
            let o = ordering(&a[*i], &b[*i]);
            if o != std::cmp::Ordering::Equal {
                return if *desc { o.reverse() } else { o };
            }
        }
        std::cmp::Ordering::Equal
    });
    let total = rows.len();
    let page: Vec<Value> = rows.into_iter().skip(offset).take(limit).map(Value::Array).collect();
    Ok(json!({
        "columns": columns, "rows": page, "matchedRows": matched, "resultRows": total, "offset": offset,
        "more": offset + page.len() < total, "ranges": ranges_used, "consistent": consistent, "ms": started.elapsed().as_millis() as u64,
    }))
}

// ─── Search everywhere ──────────────────────────────────────────────────────

fn search(db: &Db, r: &Value) -> Result<Value, String> {
    let started = Instant::now();
    let needle = s(r, "text").ok_or("What to look for? Give `text`.")?.to_string();
    if needle.is_empty() {
        return Err("Give some text to search for.".into());
    }
    let limit = u(r, "limit", 100).clamp(1, 1000) as usize;
    let conn = open(db)?;
    let all = tables(&conn)?;
    let only: Vec<String> = r.get("tables").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
    let chosen: Vec<&TableInfo> = all.iter().filter(|t| t.kind == "table" && (only.is_empty() || only.iter().any(|o| o.eq_ignore_ascii_case(&t.name)))).collect();
    // Every (table, range) pair is one job, so a single huge table still spreads across the cores.
    let jobs: Vec<(&TableInfo, Option<(i64, i64)>)> = chosen.iter().flat_map(|t| ranges(&conn, t).into_iter().map(move |range| (*t, range))).collect();
    let ((hits, total), consistent) = consistent(db, || {
        let found: Vec<Result<(Vec<Value>, usize), String>> = jobs
            .par_iter()
            .map(|(table, range)| {
                if table.columns.is_empty() {
                    return Ok((vec![], 0));
                }
                let conn = open(db)?;
                let tests: Vec<String> = table.columns.iter().map(|c| format!("instr(lower(CAST({} AS TEXT)), lower(?1)) > 0", quote(&c.0))).collect();
                let mut clauses = vec![format!("({})", tests.join(" OR "))];
                let mut values = vec![Sql::Text(needle.clone())];
                if let Some((a, b)) = range {
                    clauses.push("rowid BETWEEN ?2 AND ?3".into());
                    values.push(Sql::Integer(*a));
                    values.push(Sql::Integer(*b));
                }
                let id = if table.has_rowid { "rowid, " } else { "NULL, " };
                let cols = table.columns.iter().map(|c| quote(&c.0)).collect::<Vec<_>>().join(", ");
                let sql = format!("SELECT {id}{cols} FROM {} WHERE {}", quote(&table.name), clauses.join(" AND "));
                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                let mut cursor = stmt.query(params_from_iter(values.iter())).map_err(|e| e.to_string())?;
                let lower = needle.to_lowercase();
                let (mut out, mut count) = (Vec::new(), 0usize);
                while let Some(row) = cursor.next().map_err(|e| e.to_string())? {
                    count += 1;
                    if out.len() >= limit {
                        continue;
                    }
                    let rowid = row.get_ref(0).map(to_json).unwrap_or(Value::Null);
                    for (i, c) in table.columns.iter().enumerate() {
                        let value = row.get_ref(i + 1).map(to_json).unwrap_or(Value::Null);
                        let text = match &value { Value::String(t) => t.clone(), Value::Null => continue, other => other.to_string() };
                        if let Some(at) = text.to_lowercase().find(&lower) {
                            let chars: Vec<char> = text.chars().collect();
                            let start_char = text[..at.min(text.len())].chars().count().saturating_sub(60);
                            let snippet: String = chars.iter().skip(start_char).take(160).collect();
                            out.push(json!({ "table": table.name, "rowid": rowid, "column": c.0, "value": snippet }));
                        }
                    }
                }
                Ok((out, count))
            })
            .collect();
        let mut hits = Vec::new();
        let mut total = 0;
        for part in found {
            let (h, c) = part?;
            total += c;
            hits.extend(h);
        }
        Ok((hits, total))
    })?;
    let shown: Vec<Value> = hits.into_iter().take(limit).collect();
    Ok(json!({ "hits": shown, "matchedRows": total, "tables": chosen.len(), "ranges": jobs.len(), "consistent": consistent, "ms": started.elapsed().as_millis() as u64 }))
}

// ─── Entry ──────────────────────────────────────────────────────────────────

/// Rows as text for the dataframe: a table, or one read-only query, through the same opening rules as
/// everything here - never created, never locked, writes refused. Text because the dataframe types every
/// column itself (forgivingly) whatever it came from; `None` is SQL NULL.
pub struct TextRows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub consistent: bool,
    pub truncated: bool,
}

pub fn read_text_rows(path: &str, table: Option<&str>, sql: Option<&str>, max_rows: usize) -> Result<TextRows, String> {
    let db = locate(&json!({ "path": path }))?;
    let statement = match (table, sql) {
        (_, Some(q)) if !q.trim().is_empty() => q.trim().trim_end_matches(';').to_string(),
        (Some(t), _) if !t.trim().is_empty() => format!("SELECT * FROM {}", quote(t.trim())),
        _ => return Err(format!("A SQLite source needs a `table` or a `sql` query ({path}).")),
    };
    let ((columns, rows, truncated), consistent) = consistent(&db, || {
        let conn = open(&db)?;
        let mut stmt = conn.prepare(&statement).map_err(|e| format!("SQLite refused the query on {path}: {e}"))?;
        if !stmt.readonly() {
            return Err("Only reading statements run on a SQLite source. Nothing was changed.".into());
        }
        let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
        let width = columns.len();
        let mut cursor = stmt.query([]).map_err(|e| e.to_string())?;
        let (mut rows, mut truncated) = (Vec::new(), false);
        while let Some(row) = cursor.next().map_err(|e| e.to_string())? {
            if rows.len() == max_rows {
                truncated = true;
                break;
            }
            rows.push(
                (0..width)
                    .map(|i| match row.get_ref(i) {
                        Ok(ValueRef::Null) | Err(_) => None,
                        Ok(ValueRef::Integer(v)) => Some(v.to_string()),
                        Ok(ValueRef::Real(v)) => Some(v.to_string()),
                        Ok(ValueRef::Text(t)) => Some(String::from_utf8_lossy(t).into_owned()),
                        Ok(ValueRef::Blob(b)) => Some(format!("<blob {} bytes>", b.len())),
                    })
                    .collect(),
            );
        }
        Ok((columns, rows, truncated))
    })?;
    Ok(TextRows { columns, rows, consistent, truncated })
}

pub fn run(r: &Value) -> Result<Value, String> {
    let db = locate(r)?;
    let mut answer = match s(r, "action").unwrap_or("schema") {
        "schema" => consistent(&db, || schema(&db, r)).map(|(mut v, ok)| {
            v["consistent"] = json!(ok);
            v
        })?,
        "query" => consistent(&db, || query(&db, r)).map(|(mut v, ok)| {
            v["consistent"] = json!(ok);
            v
        })?,
        "scan" => scan(&db, r)?,
        "search" => search(&db, r)?,
        other => return Err(format!("Unknown SQLite action \"{other}\".")),
    };
    if let Value::Object(map) = &mut answer {
        map.insert("ok".into(), json!(true));
        map.insert("access".into(), json!(db.access.describe()));
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fire-sqlite-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A database written by an ordinary read-write connection, as an application would.
    fn make(path: &Path, wal: bool, rows: i64) -> Connection {
        let conn = Connection::open(path).unwrap();
        if wal {
            conn.pragma_update(None, "journal_mode", "wal").unwrap();
        }
        conn.execute_batch("CREATE TABLE trades (id INTEGER PRIMARY KEY, desk TEXT, amount REAL, note TEXT); CREATE INDEX trades_desk ON trades(desk);").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        {
            let mut insert = conn.prepare("INSERT INTO trades (desk, amount, note) VALUES (?, ?, ?)").unwrap();
            for i in 0..rows {
                let desk = ["rates", "fx", "credit"][(i % 3) as usize];
                insert.execute(rusqlite::params![desk, (i % 100) as f64, if i == rows / 2 { "needle in the middle" } else { "plain" }]).unwrap();
            }
        }
        tx.commit().unwrap();
        conn
    }

    #[test]
    fn never_creates_a_database() {
        let dir = temp("missing");
        let path = dir.join("nothing.db");
        let err = run(&json!({ "path": path, "action": "schema" })).unwrap_err();
        assert!(err.contains("nothing was created"), "{err}");
        assert!(!path.exists());
        // An empty file is a valid empty database to SQLite; here it is refused and left alone.
        std::fs::write(&path, b"").unwrap();
        assert!(run(&json!({ "path": path })).unwrap_err().contains("empty file"));
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        std::fs::write(&path, b"not a database at all, just text that is long enough to have a header of one hundred bytes......").unwrap();
        assert!(run(&json!({ "path": path })).unwrap_err().contains("not a SQLite database"));
    }

    #[test]
    fn a_reader_here_never_stops_a_writer_committing() {
        for wal in [false, true] {
            let dir = temp(if wal { "wal" } else { "rollback" });
            let path = dir.join("app.db");
            let writer = make(&path, wal, 50_000);
            // No busy timeout on the writer: if this program held any lock, its commit would fail at once.
            writer.busy_timeout(Duration::from_millis(0)).unwrap();
            let db = locate(&json!({ "path": path })).unwrap();
            assert_eq!(db.access, if wal { Access::WalReader } else { Access::Immutable });
            let reader = open(&db).unwrap();
            let mut stmt = reader.prepare("SELECT amount FROM trades").unwrap();
            let mut rows = stmt.query([]).unwrap();
            rows.next().unwrap(); // a statement open mid-read
            writer.execute("INSERT INTO trades (desk, amount, note) VALUES ('fx', 1, 'while reading')", []).expect("the writer committed while a read was open");
            drop(rows);
            drop(stmt);
            // And the read path makes no files: no -journal, and no -wal/-shm for a rollback database.
            if !wal {
                assert!(!sidecar(&path, "-wal").exists() && !sidecar(&path, "-shm").exists());
            }
        }
    }

    #[test]
    fn refuses_to_write_and_to_attach() {
        let dir = temp("readonly");
        let path = dir.join("app.db");
        drop(make(&path, false, 10));
        let err = run(&json!({ "path": path, "action": "query", "sql": "DELETE FROM trades" })).unwrap_err();
        assert!(err.contains("Only reading"), "{err}");
        let other = dir.join("other.db");
        let attach = run(&json!({ "path": path, "action": "query", "sql": format!("ATTACH '{}' AS x", other.display()) }));
        assert!(attach.is_err());
        assert!(!other.exists(), "ATTACH must not create a file");
        let counted = run(&json!({ "path": path, "action": "query", "sql": "SELECT count(*) FROM trades" })).unwrap();
        assert_eq!(counted["rows"][0][0], json!(10));
    }

    #[test]
    fn scans_in_parallel_ranges_and_agrees_with_sqlite() {
        let dir = temp("scan");
        let path = dir.join("app.db");
        let writer = make(&path, false, 30_000);
        let expected: (i64, f64) = writer.query_row("SELECT count(*), total(amount) FROM trades WHERE desk = 'fx' AND amount >= 50", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        drop(writer);
        let grouped = run(&json!({
            "path": path, "action": "scan", "table": "trades",
            "filters": [{ "column": "amount", "op": "ge", "value": "50" }],
            "groupBy": ["desk"], "aggregates": [{ "fn": "count" }, { "fn": "sum", "column": "amount" }, { "fn": "distinct", "column": "amount" }],
        }))
        .unwrap();
        assert!(grouped["ranges"].as_u64().unwrap() > 1);
        assert_eq!(grouped["consistent"], json!(true));
        let fx = grouped["rows"].as_array().unwrap().iter().find(|r| r[0] == json!("fx")).unwrap();
        assert_eq!(fx[1], json!(expected.0));
        assert_eq!(fx[2].as_f64().unwrap(), expected.1);
        assert_eq!(fx[3], json!(50));

        let rows = run(&json!({ "path": path, "action": "scan", "table": "trades", "columns": ["id", "amount"], "sort": [{ "column": "amount", "desc": true }, { "column": "id" }], "limit": 3 })).unwrap();
        assert_eq!(rows["matchedRows"], json!(30_000));
        assert_eq!(rows["rows"][0][1].as_f64().unwrap(), 99.0);
        assert_eq!(rows["rows"][0][0], json!(100));

        let found = run(&json!({ "path": path, "action": "search", "text": "NEEDLE" })).unwrap();
        assert_eq!(found["matchedRows"], json!(1));
        assert_eq!(found["hits"][0]["column"], json!("note"));
        assert_eq!(found["hits"][0]["rowid"], json!(15_001));
    }

    #[test]
    fn sees_commits_still_in_the_wal() {
        let dir = temp("walread");
        let path = dir.join("app.db");
        let writer = make(&path, true, 100);
        writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        writer.execute("INSERT INTO trades (desk, amount, note) VALUES ('fx', 1, 'only in the wal')", []).unwrap();
        let found = run(&json!({ "path": path, "action": "search", "text": "only in the wal" })).unwrap();
        assert_eq!(found["matchedRows"], json!(1));
        drop(writer);
    }

    #[test]
    fn a_path_with_spaces_and_a_hash_opens() {
        let dir = temp("odd name");
        let path = dir.join("my #1 db.sqlite");
        drop(make(&path, false, 5));
        assert_eq!(run(&json!({ "path": path, "action": "query", "sql": "SELECT count(*) FROM trades" })).unwrap()["rows"][0][0], json!(5));
    }
}
