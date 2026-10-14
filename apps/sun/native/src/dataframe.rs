//! Dataframes: CSV/TSV/delimited text, Excel sheets and the clipboard, analysed with Polars SQL.
//!
//! ## Forgiving reading, without losing data
//!
//! Asked for explicitly: reading must not fail on data-type problems. The usual way to be forgiving -
//! letting the reader skip what it cannot parse - turns those values into nulls without a word, which
//! is data loss nobody notices. So nothing here is parsed on the way in: every cell is read as text
//! (ragged rows padded, bad bytes replaced, duplicate and empty headers renamed, Excel error cells made
//! empty), and only then is each column given a type - integer, number, boolean, date, date-time - and
//! **only if every non-empty value in it converts**. Common empty markers (NA, N/A, null, -, #N/A, ...)
//! count as empty, thousands separators and accounting negatives "(1,234.50)" are understood. A column
//! with even one stray value stays text, and the answer names the column and shows examples, so the
//! person knows rather than finding out from a wrong total.
//!
//! ## Analysis
//!
//! Each source is registered by name in a Polars SQL context, so one query can join, group, window and
//! filter across several files at once, on every core. Pivot is built on top as conditional aggregation
//! in SQL, which keeps it independent of Polars' own pivot API (it changes between releases).

use calamine::{Data, Reader};
use chrono::{NaiveDate, NaiveDateTime};
use polars::prelude::*;
use polars::sql::SQLContext;
use rayon::prelude::*;
use serde_json::{json, Value};
use std::path::Path;

const MAX_PIVOT_COLUMNS: usize = 200;
const NULL_TOKENS: &[&str] = &["", "na", "n/a", "#n/a", "null", "none", "nan", "nil", "-", "--", "#null!", "#value!", "#div/0!", "#ref!", "#name?", "#num!"];

fn s<'a>(r: &'a Value, key: &str) -> Option<&'a str> {
    r.get(key).and_then(Value::as_str)
}

// ─── Reading: everything as text first ──────────────────────────────────────

struct Raw {
    name: String,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    notes: Vec<String>,
}

fn unique_headers(raw: Vec<String>, width: usize) -> Vec<String> {
    let mut seen = std::collections::HashMap::<String, usize>::new();
    (0..width)
        .map(|i| {
            let base = raw.get(i).map(|h| h.trim().to_string()).filter(|h| !h.is_empty()).unwrap_or_else(|| format!("column_{}", i + 1));
            let n = seen.entry(base.to_lowercase()).or_insert(0);
            *n += 1;
            if *n == 1 { base } else { format!("{base}_{n}") }
        })
        .collect()
}

/// The likeliest delimiter: the candidate that splits the first lines most consistently.
fn sniff(text: &str) -> u8 {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).take(20).collect();
    let mut best = (b',', 0usize);
    for d in [b'\t', b',', b';', b'|'] {
        let counts: Vec<usize> = lines.iter().map(|l| l.bytes().filter(|b| *b == d).count()).collect();
        let first = counts.first().copied().unwrap_or(0);
        if first == 0 {
            continue;
        }
        let agreeing = counts.iter().filter(|c| **c == first).count();
        let score = agreeing * 1000 + first;
        if score > best.1 {
            best = (d, score);
        }
    }
    best.0
}

fn read_delimited(name: &str, bytes: &[u8], delimiter: Option<u8>, header: bool, skip: usize) -> Result<Raw, String> {
    // Bad bytes are replaced rather than refused: a file in Windows-1252 with one accented name in it
    // must still read. A UTF-8 BOM is dropped so it does not end up in the first header.
    let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)).into_owned();
    let lossy = text.contains('\u{FFFD}');
    let delimiter = delimiter.unwrap_or_else(|| sniff(&text));
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .trim(csv::Trim::None)
        .from_reader(text.as_bytes());
    let mut records: Vec<Vec<String>> = Vec::new();
    for (i, record) in reader.records().enumerate() {
        if i < skip {
            continue;
        }
        match record {
            Ok(r) => records.push(r.iter().map(String::from).collect()),
            Err(e) => return Err(format!("{name}: could not read row {}: {e}", i + 1)),
        }
    }
    let mut notes = Vec::new();
    if lossy {
        notes.push("some bytes were not UTF-8 and were replaced with \u{FFFD}".to_string());
    }
    Ok(shape(name, records, header, &mut notes))
}

/// Header row, equal-width rows (short ones padded, long ones keep their extra cells as new columns).
fn shape(name: &str, mut records: Vec<Vec<String>>, header: bool, notes: &mut Vec<String>) -> Raw {
    records.retain(|r| r.iter().any(|c| !c.trim().is_empty()));
    let width = records.iter().map(Vec::len).max().unwrap_or(0);
    let raw_headers = if header && !records.is_empty() { records.remove(0) } else { Vec::new() };
    let ragged = records.iter().filter(|r| r.len() != width).count();
    if ragged > 0 {
        notes.push(format!("{ragged} rows had fewer or more cells than the widest row; missing cells are empty"));
    }
    for row in &mut records {
        row.resize(width, String::new());
    }
    Raw { name: name.to_string(), headers: unique_headers(raw_headers, width), rows: records, notes: std::mem::take(notes) }
}

/// An Excel serial date as ISO text: day 25569 is 1970-01-01; the fraction is the time of day.
fn excel_serial(serial: f64) -> String {
    let days = serial.floor() as i64 - 25569;
    let ms = ((serial - serial.floor()) * 86_400_000.0).round() as i64;
    let date = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap() + chrono::Duration::days(days);
    if ms == 0 {
        date.format("%Y-%m-%d").to_string()
    } else {
        (date.and_hms_opt(0, 0, 0).unwrap() + chrono::Duration::milliseconds(ms)).format("%Y-%m-%dT%H:%M:%S").to_string()
    }
}

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty | Data::Error(_) => String::new(),
        Data::String(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => if f.fract() == 0.0 && f.abs() < 1e15 { format!("{}", *f as i64) } else { f.to_string() },
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => excel_serial(d.as_f64()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
    }
}

fn read_workbook(name: &str, path: &Path, sheet: Option<&str>, header: bool, skip: usize) -> Result<Raw, String> {
    let mut book = calamine::open_workbook_auto(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let names = book.sheet_names().to_vec();
    let sheet = match sheet {
        Some(wanted) => names
            .iter()
            .find(|n| n.as_str() == wanted)
            .or_else(|| names.iter().find(|n| n.eq_ignore_ascii_case(wanted)))
            .cloned()
            .ok_or_else(|| format!("No sheet \"{wanted}\" in {}. Sheets: {}.", path.display(), names.join(", ")))?,
        None => names.first().cloned().ok_or("The workbook has no sheets.")?,
    };
    let range = book.worksheet_range(&sheet).map_err(|e| format!("Sheet \"{sheet}\": {e}"))?;
    let errors = range.used_cells().filter(|(_, _, c)| matches!(c, Data::Error(_))).count();
    let records: Vec<Vec<String>> = range.rows().skip(skip).map(|row| row.iter().map(cell_text).collect()).collect();
    let mut notes = Vec::new();
    if errors > 0 {
        notes.push(format!("{errors} cells held Excel errors (#N/A, #DIV/0!, ...) and are read as empty"));
    }
    Ok(shape(name, records, header, &mut notes))
}

#[cfg(windows)]
fn clipboard_text() -> Result<String, String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    const CF_UNICODETEXT: u32 = 13;
    unsafe {
        // Another program may hold the clipboard for a moment; try a few times.
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if !opened {
            return Err("The clipboard is in use by another program; try again.".into());
        }
        let handle = GetClipboardData(CF_UNICODETEXT);
        if handle.is_null() {
            CloseClipboard();
            return Err("The clipboard holds no text. Copy the cells (Ctrl+C in Excel) and ask again.".into());
        }
        let ptr = GlobalLock(handle) as *const u16;
        let mut len = 0usize;
        while !ptr.is_null() && *ptr.add(len) != 0 {
            len += 1;
        }
        let text = if ptr.is_null() { String::new() } else { String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len)) };
        GlobalUnlock(handle);
        CloseClipboard();
        Ok(text)
    }
}

#[cfg(not(windows))]
fn clipboard_text() -> Result<String, String> {
    Err("Reading the clipboard is supported on Windows only.".into())
}

fn identifier(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

const MAX_SQLITE_ROWS: usize = 1_000_000;

/// A value as the text every source is read as: nested objects and lists stay JSON, so nothing is lost.
fn cell_from_json(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
    }
}

/// Objects to rows: every key any object has becomes a column, in the order keys are first seen. A
/// missing key is an empty cell, so records of slightly different shapes - the norm for API results -
/// still line up.
fn rows_from_objects(name: &str, items: &[Value]) -> Result<Raw, String> {
    let mut keys: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut not_objects = 0usize;
    for item in items {
        match item {
            Value::Object(map) => {
                for key in map.keys() {
                    if seen.insert(key.clone()) {
                        keys.push(key.clone());
                    }
                }
            }
            _ => not_objects += 1,
        }
    }
    if keys.is_empty() {
        return Err(format!("Source \"{name}\" has no objects with fields to read."));
    }
    let rows: Vec<Vec<String>> = items
        .iter()
        .filter_map(Value::as_object)
        .map(|map| keys.iter().map(|k| cell_from_json(map.get(k))).collect())
        .collect();
    let mut notes = Vec::new();
    if not_objects > 0 {
        notes.push(format!("{not_objects} item(s) were not objects and were left out"));
    }
    let width = keys.len();
    Ok(Raw { name: name.to_string(), headers: unique_headers(keys, width), rows, notes })
}

/// The records in a JSON file: a list of objects, a wrapper holding one (`data`, `items`, `results`,
/// `value`, `rows`, `records`), or one object per line (JSON Lines).
fn json_records(text: &str) -> Result<Vec<Value>, String> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(items)) => Ok(items),
        Ok(Value::Object(map)) => {
            for key in ["data", "items", "results", "value", "rows", "records"] {
                if let Some(Value::Array(items)) = map.get(key) {
                    return Ok(items.clone());
                }
            }
            Ok(vec![Value::Object(map)])
        }
        Ok(_) => Err("expected a list of objects".into()),
        Err(_) => text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .enumerate()
            .map(|(i, l)| serde_json::from_str::<Value>(l).map_err(|e| format!("line {}: not JSON ({e})", i + 1)))
            .collect(),
    }
}

fn read_source(source: &Value) -> Result<Raw, String> {
    let name = s(source, "name").ok_or("Every source needs a `name` to query it by.")?;
    if !identifier(name) {
        return Err(format!("\"{name}\" cannot be a table name: use letters, digits and _ (e.g. sales_2024)."));
    }
    let header = source.get("header").and_then(Value::as_bool).unwrap_or(true);
    let skip = source.get("skipRows").and_then(Value::as_u64).unwrap_or(0) as usize;
    let delimiter = s(source, "delimiter").and_then(|d| if d == "\\t" || d.eq_ignore_ascii_case("tab") { Some(b'\t') } else { d.bytes().next() });
    // Rows the agent already has - another tool's results, an API response - joined like any file.
    if let Some(items) = source.get("rows") {
        let items = items.as_array().ok_or_else(|| format!("Source \"{name}\": `rows` must be a list of objects."))?;
        return rows_from_objects(name, items);
    }
    // A SQLite table or read-only query, through the reader that never creates or locks a database.
    if let Some(spec) = source.get("sqlite") {
        let path = s(source, "path").ok_or_else(|| format!("Source \"{name}\" reads SQLite: give the database as `path`."))?;
        let read = crate::sqlite_read::read_text_rows(path, s(spec, "table"), s(spec, "sql"), MAX_SQLITE_ROWS)?;
        let mut notes = Vec::new();
        if read.truncated {
            notes.push(format!("only the first {MAX_SQLITE_ROWS} rows were read - filter in the source query to narrow it"));
        }
        if !read.consistent {
            notes.push("the database was being written while it was read; rows may mix before and after a change".to_string());
        }
        let width = read.columns.len();
        return Ok(Raw {
            name: name.to_string(),
            headers: unique_headers(read.columns, width),
            rows: read.rows.into_iter().map(|row| row.into_iter().map(Option::unwrap_or_default).collect()).collect(),
            notes,
        });
    }
    if source.get("clipboard").and_then(Value::as_bool) == Some(true) {
        let text = clipboard_text()?;
        return read_delimited(name, text.as_bytes(), delimiter.or(Some(b'\t')).filter(|_| delimiter.is_some() || text.contains('\t')).or(None), header, skip);
    }
    let path = Path::new(s(source, "path").ok_or_else(|| format!("Source \"{name}\" needs a `path` (or clipboard: true)."))?);
    if !path.is_file() {
        return Err(format!("{} does not exist.", path.display()));
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => read_workbook(name, path, s(source, "sheet"), header, skip),
        "json" | "jsonl" | "ndjson" => {
            let bytes = std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
            let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).into_owned();
            rows_from_objects(name, &json_records(&text).map_err(|e| format!("{}: {e}", path.display()))?)
        }
        _ => {
            let bytes = std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
            let delimiter = delimiter.or(if ext == "tsv" || ext == "tab" { Some(b'\t') } else { None });
            read_delimited(name, &bytes, delimiter, header, skip)
        }
    }
}

// ─── Typing: a column gets a type only when every value fits ────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Int,
    Float,
    Bool,
    Date,
    DateTime,
    Text,
}

fn is_null(text: &str) -> bool {
    let t = text.trim();
    t.is_empty() || NULL_TOKENS.iter().any(|n| t.eq_ignore_ascii_case(n))
}

/// A number as written by people: "1,234.5", "(1,234.50)" for negative, "+3", " 7 ".
fn number_text(text: &str) -> Option<String> {
    let mut t = text.trim().to_string();
    let mut negative = false;
    if t.starts_with('(') && t.ends_with(')') {
        negative = true;
        t = t[1..t.len() - 1].trim().to_string();
    }
    if t.contains(',') {
        // Only thousands separators: 1,234 or 12,345,678.9 - never a decimal comma, which is ambiguous.
        let int_part = t.split('.').next().unwrap_or("");
        let groups: Vec<&str> = int_part.trim_start_matches(['+', '-']).split(',').collect();
        let ok = groups.len() > 1 && !groups[0].is_empty() && groups[0].len() <= 3 && groups[1..].iter().all(|g| g.len() == 3 && g.bytes().all(|b| b.is_ascii_digit()));
        if !ok {
            return None;
        }
        t = t.replace(',', "");
    }
    if negative {
        t = format!("-{t}");
    }
    Some(t)
}

fn parse_int(text: &str) -> Option<i64> {
    number_text(text)?.parse::<i64>().ok()
}
fn parse_float(text: &str) -> Option<f64> {
    let t = number_text(text)?;
    if t.eq_ignore_ascii_case("inf") || t.eq_ignore_ascii_case("infinity") || t.to_lowercase().contains("nan") {
        return None;
    }
    t.parse::<f64>().ok().filter(|f| f.is_finite())
}
fn parse_bool(text: &str) -> Option<bool> {
    match text.trim().to_ascii_lowercase().as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}
fn parse_date(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d").ok()
}
fn parse_datetime(text: &str) -> Option<NaiveDateTime> {
    let t = text.trim().trim_end_matches('Z');
    ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"].iter().find_map(|f| NaiveDateTime::parse_from_str(t, f).ok())
}

/// The narrowest kind every non-empty value fits, and, when it fell back to text, why.
fn infer(values: &[&str]) -> (Kind, Vec<String>) {
    let present: Vec<&str> = values.iter().copied().filter(|v| !is_null(v)).collect();
    if present.is_empty() {
        return (Kind::Text, vec![]);
    }
    let all = |test: &dyn Fn(&str) -> bool| present.iter().all(|v| test(v));
    if all(&|v| parse_int(v).is_some()) {
        return (Kind::Int, vec![]);
    }
    if all(&|v| parse_float(v).is_some()) {
        return (Kind::Float, vec![]);
    }
    if all(&|v| parse_bool(v).is_some()) {
        return (Kind::Bool, vec![]);
    }
    if all(&|v| parse_date(v).is_some()) {
        return (Kind::Date, vec![]);
    }
    if all(&|v| parse_date(v).is_some() || parse_datetime(v).is_some()) {
        return (Kind::DateTime, vec![]);
    }
    // Mostly numbers with a few strays: say which values kept it text.
    let numeric = present.iter().filter(|v| parse_float(v).is_some()).count();
    if numeric * 2 > present.len() {
        let mut strays: Vec<String> = present.iter().filter(|v| parse_float(v).is_none()).map(|v| v.to_string()).collect();
        let total = strays.len();
        strays.dedup();
        strays.truncate(3);
        return (Kind::Text, vec![format!("{total} value(s) are not numbers, e.g. {}", strays.iter().map(|v| format!("\"{v}\"")).collect::<Vec<_>>().join(", "))]);
    }
    (Kind::Text, vec![])
}

fn column(name: &str, values: &[&str], kind: Kind) -> PolarsResult<Column> {
    let n: PlSmallStr = name.into();
    let series = match kind {
        Kind::Int => Series::new(n, values.iter().map(|v| if is_null(v) { None } else { parse_int(v) }).collect::<Vec<Option<i64>>>()),
        Kind::Float => Series::new(n, values.iter().map(|v| if is_null(v) { None } else { parse_float(v) }).collect::<Vec<Option<f64>>>()),
        Kind::Bool => Series::new(n, values.iter().map(|v| if is_null(v) { None } else { parse_bool(v) }).collect::<Vec<Option<bool>>>()),
        Kind::Date => {
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
            Series::new(n, values.iter().map(|v| if is_null(v) { None } else { parse_date(v).map(|d| (d - epoch).num_days() as i32) }).collect::<Vec<Option<i32>>>()).cast(&DataType::Date)?
        }
        Kind::DateTime => Series::new(
            n,
            values
                .iter()
                .map(|v| {
                    if is_null(v) {
                        None
                    } else {
                        parse_datetime(v).or_else(|| parse_date(v).and_then(|d| d.and_hms_opt(0, 0, 0))).map(|t| t.and_utc().timestamp_millis())
                    }
                })
                .collect::<Vec<Option<i64>>>(),
        )
        .cast(&DataType::Datetime(TimeUnit::Milliseconds, None))?,
        Kind::Text => Series::new(n, values.iter().map(|v| if v.trim().is_empty() { None } else { Some(v.to_string()) }).collect::<Vec<Option<String>>>()),
    };
    Ok(series.into_column())
}

struct Frame {
    df: DataFrame,
    notes: Vec<String>,
}

/// Columns typed in parallel, one per core.
fn to_frame(raw: Raw) -> Result<Frame, String> {
    let width = raw.headers.len();
    let built: Vec<(Column, Vec<String>)> = (0..width)
        .into_par_iter()
        .map(|i| {
            let values: Vec<&str> = raw.rows.iter().map(|r| r[i].as_str()).collect();
            let (kind, why) = infer(&values);
            let col = column(&raw.headers[i], &values, kind).map_err(|e| e.to_string())?;
            Ok((col, why.into_iter().map(|w| format!("{}.{}: kept as text - {w}", raw.name, raw.headers[i])).collect()))
        })
        .collect::<Result<_, String>>()?;
    let mut notes: Vec<String> = raw.notes.iter().map(|n| format!("{}: {n}", raw.name)).collect();
    let mut columns = Vec::with_capacity(width);
    for (col, why) in built {
        columns.push(col);
        notes.extend(why);
    }
    let df = DataFrame::new(columns).map_err(|e| e.to_string())?;
    Ok(Frame { df, notes })
}

// ─── Output ─────────────────────────────────────────────────────────────────

fn json_of(value: AnyValue) -> Value {
    match value {
        AnyValue::Null => Value::Null,
        AnyValue::Boolean(b) => json!(b),
        AnyValue::Int8(v) => json!(v),
        AnyValue::Int16(v) => json!(v),
        AnyValue::Int32(v) => json!(v),
        AnyValue::Int64(v) => json!(v),
        AnyValue::UInt8(v) => json!(v),
        AnyValue::UInt16(v) => json!(v),
        AnyValue::UInt32(v) => json!(v),
        AnyValue::UInt64(v) => json!(v),
        AnyValue::Float32(v) => if v.is_finite() { json!(v) } else { json!(v.to_string()) },
        AnyValue::Float64(v) => if v.is_finite() { json!(v) } else { json!(v.to_string()) },
        AnyValue::String(s) => json!(s),
        AnyValue::StringOwned(s) => json!(s.as_str()),
        other => json!(other.to_string().trim_matches('"').to_string()),
    }
}

fn rows_of(df: &DataFrame, offset: usize, limit: usize) -> Vec<Value> {
    let end = (offset + limit).min(df.height());
    (offset..end)
        .map(|i| Value::Array(df.get_columns().iter().map(|c| c.get(i).map(json_of).unwrap_or(Value::Null)).collect()))
        .collect()
}

fn schema_of(df: &DataFrame) -> Vec<Value> {
    df.get_columns().iter().map(|c| json!({ "name": c.name().as_str(), "type": c.dtype().to_string(), "nulls": c.null_count() })).collect()
}

// ─── Operations ─────────────────────────────────────────────────────────────

fn load(r: &Value) -> Result<(Vec<(String, Frame)>, Vec<String>), String> {
    let sources = r.get("sources").and_then(Value::as_array).cloned().unwrap_or_default();
    if sources.is_empty() {
        return Err("Give at least one source: { name, path } or { name, clipboard: true }.".into());
    }
    // Each file is read and typed on its own core.
    let frames: Vec<(String, Frame)> = sources
        .par_iter()
        .map(|source| {
            let raw = read_source(source)?;
            let name = raw.name.clone();
            Ok((name, to_frame(raw)?))
        })
        .collect::<Result<_, String>>()?;
    let notes = frames.iter().flat_map(|(_, f)| f.notes.clone()).collect();
    Ok((frames, notes))
}

fn describe(r: &Value) -> Result<Value, String> {
    let (frames, notes) = load(r)?;
    let tables: Vec<Value> = frames
        .iter()
        .map(|(name, frame)| {
            json!({
                "name": name, "rows": frame.df.height(), "columns": schema_of(&frame.df),
                "head": rows_of(&frame.df, 0, 5),
            })
        })
        .collect();
    Ok(json!({ "ok": true, "tables": tables, "notes": notes }))
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

/// Wide from long: one output column per distinct value of `columns`, aggregating `values`.
fn pivot(ctx: &mut SQLContext, df: DataFrame, spec: &Value) -> Result<(DataFrame, Option<String>), String> {
    let index: Vec<String> = spec.get("index").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
    let on = s(spec, "columns").ok_or("pivot needs `columns`: the column whose values become the new columns.")?;
    let values = s(spec, "values").ok_or("pivot needs `values`: the column to aggregate.")?;
    let agg = s(spec, "agg").unwrap_or("sum").to_ascii_lowercase();
    if !["sum", "count", "avg", "mean", "min", "max", "first", "last"].contains(&agg.as_str()) {
        return Err(format!("pivot agg must be sum, count, avg, min, max, first or last - not \"{agg}\"."));
    }
    let names: Vec<String> = df.get_column_names().iter().map(|n| n.to_string()).collect();
    for c in index.iter().chain([on.to_string(), values.to_string()].iter()) {
        if !names.contains(c) {
            return Err(format!("pivot: there is no column \"{c}\" in the result. Columns: {}.", names.join(", ")));
        }
    }
    ctx.register("__pivot_input", df.lazy());
    let distinct = ctx
        .execute(&format!("SELECT DISTINCT {} FROM __pivot_input ORDER BY 1", quote_ident(on)))
        .and_then(|lf| lf.collect())
        .map_err(|e| format!("pivot: {e}"))?;
    let keys: Vec<Value> = distinct.get_columns()[0].as_materialized_series().iter().map(json_of).collect();
    let truncated = keys.len() > MAX_PIVOT_COLUMNS;
    let sql_agg = match agg.as_str() {
        "mean" => "AVG".to_string(),
        "first" => "FIRST".to_string(),
        "last" => "LAST".to_string(),
        other => other.to_ascii_uppercase(),
    };
    let mut select: Vec<String> = index.iter().map(|c| quote_ident(c)).collect();
    for key in keys.iter().take(MAX_PIVOT_COLUMNS) {
        let test = if key.is_null() { format!("{} IS NULL", quote_ident(on)) } else { format!("{} = {}", quote_ident(on), literal(key)) };
        let label = match key { Value::Null => "null".to_string(), Value::String(s) => s.clone(), other => other.to_string() };
        // A combination with no rows is empty, not 0: Polars sums nothing to 0, which would read as a real zero.
        let expr = if agg == "count" {
            format!("SUM(CASE WHEN {test} THEN 1 ELSE 0 END)")
        } else {
            format!(
                "CASE WHEN COUNT(CASE WHEN {test} THEN 1 END) = 0 THEN NULL ELSE {sql_agg}(CASE WHEN {test} THEN {} END) END",
                quote_ident(values)
            )
        };
        select.push(format!("{expr} AS {}", quote_ident(&label)));
    }
    let group = if index.is_empty() { String::new() } else { format!(" GROUP BY {} ORDER BY {}", index.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", "), index.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ")) };
    let wide = ctx
        .execute(&format!("SELECT {} FROM __pivot_input{group}", select.join(", ")))
        .and_then(|lf| lf.collect())
        .map_err(|e| format!("pivot: {e}"))?;
    let note = truncated.then(|| format!("pivot: {} has {} distinct values; the first {MAX_PIVOT_COLUMNS} became columns", on, keys.len()));
    Ok((wide, note))
}

/// A failed query, with what to do about the one limit models walk into: aliasing a WITH step.
fn failure(what: &str, error: &str, query: &str, tables: &[String]) -> String {
    let hint = if query.to_ascii_uppercase().contains("WITH ") && error.contains("no table or struct column named") {
        "\nA WITH step cannot be given an alias here (FROM totals t fails). Refer to it by its full name, or make it a named entry in `steps`, which can be aliased like any table."
    } else {
        ""
    };
    format!("{what}: {error}{hint}\nTables: {}.", tables.join(", "))
}

fn sql(r: &Value) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let (frames, mut notes) = load(r)?;
    let mut ctx = SQLContext::new();
    let names: Vec<String> = frames.iter().map(|(n, _)| n.clone()).collect();
    let mut first: Option<DataFrame> = None;
    for (name, frame) in frames {
        if first.is_none() {
            first = Some(frame.df.clone());
        }
        ctx.register(&name, frame.df.lazy());
    }
    let mut names = names;
    /*
     * Named steps: each a query whose result is registered as a table for the steps after it and the final
     * query - building a join in stages ("totals per owner", then join people, then pivot). Also the answer
     * to a Polars 0.49 limit: a WITH step cannot take an alias (`FROM totals t` fails), while a registered
     * table can be aliased like any source.
     */
    for step in r.get("steps").and_then(Value::as_array).cloned().unwrap_or_default() {
        let name = s(&step, "name").ok_or("Every step needs a `name`.")?.to_string();
        if !identifier(&name) {
            return Err(format!("\"{name}\" cannot be a step name: use letters, digits and _."));
        }
        let q = s(&step, "sql").map(str::trim).filter(|q| !q.is_empty()).ok_or_else(|| format!("Step \"{name}\" needs `sql`."))?;
        let df = ctx.execute(q).and_then(|lf| lf.collect()).map_err(|e| failure(&format!("Step \"{name}\" failed"), &e.to_string(), q, &names))?;
        ctx.register(&name, df.lazy());
        names.push(name);
    }
    let query = s(r, "sql").map(str::trim).filter(|q| !q.is_empty());
    let mut result = match query {
        Some(q) => ctx.execute(q).and_then(|lf| lf.collect()).map_err(|e| failure("The query failed", &e.to_string(), q, &names))?,
        None => first.ok_or("Nothing to query.")?,
    };
    if let Some(spec) = r.get("pivot").filter(|p| p.is_object()) {
        let (wide, note) = pivot(&mut ctx, result, spec)?;
        result = wide;
        notes.extend(note);
    }
    let limit = r.get("limit").and_then(Value::as_u64).unwrap_or(50).clamp(1, 5000) as usize;
    let offset = r.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let rows = rows_of(&result, offset, limit);
    let shown = rows.len();
    Ok(json!({
        "ok": true,
        "columns": schema_of(&result),
        "rows": rows,
        "resultRows": result.height(),
        "offset": offset,
        "more": offset + shown < result.height(),
        "notes": notes,
        "ms": started.elapsed().as_millis() as u64,
    }))
}

pub fn run(r: &Value) -> Result<Value, String> {
    match s(r, "action").unwrap_or("sql") {
        "describe" => describe(r),
        "sql" => sql(r),
        other => Err(format!("Unknown dataframe action \"{other}\".")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, text: &str) -> String {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        path.to_string_lossy().to_string()
    }

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("fire-df-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn types_a_column_only_when_every_value_fits_and_says_why_not() {
        let d = dir("types");
        let path = write(
            &d,
            "trades.csv",
            "id,desk,amount,traded,flag,price\n1,rates,\"1,250.50\",2024-01-02,true,10\n2,fx,(300.00),2024-01-03,false,n/a\n3,fx,N/A,2024-01-04,true,11\n4,credit,75,2024-01-05,,abc\n",
        );
        let answer = describe(&json!({ "sources": [{ "name": "trades", "path": path }] })).unwrap();
        let cols = answer["tables"][0]["columns"].as_array().unwrap();
        let ty = |name: &str| cols.iter().find(|c| c["name"] == json!(name)).unwrap()["type"].as_str().unwrap().to_string();
        assert_eq!(ty("id"), "i64");
        assert_eq!(ty("amount"), "f64");
        assert_eq!(ty("traded"), "date");
        assert_eq!(ty("flag"), "bool");
        assert_eq!(ty("price"), "str");
        let notes = answer["notes"].to_string();
        assert!(notes.contains("trades.price: kept as text") && notes.contains("\\\"abc\\\""), "{notes}");
        // Nothing was lost: the accounting negative and the thousands separator both read.
        let summed = sql(&json!({ "sources": [{ "name": "trades", "path": path }], "sql": "SELECT SUM(amount) AS total FROM trades" })).unwrap();
        assert_eq!(summed["rows"][0][0].as_f64().unwrap(), 1025.5);
    }

    #[test]
    fn forgives_ragged_rows_bad_bytes_duplicate_headers_and_a_bom() {
        let d = dir("ragged");
        let mut bytes = b"\xEF\xBB\xBFname;name;;score\nAnn;A;x;1\nBob;B\n".to_vec();
        bytes.extend_from_slice(b"Caf\xE9;C;y;3;extra\n");
        let path = d.join("messy.txt");
        std::fs::write(&path, bytes).unwrap();
        let answer = describe(&json!({ "sources": [{ "name": "messy", "path": path }] })).unwrap();
        let names: Vec<&str> = answer["tables"][0]["columns"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["name", "name_2", "column_3", "score", "column_5"]);
        assert_eq!(answer["tables"][0]["rows"], json!(3));
        let notes = answer["notes"].to_string();
        assert!(notes.contains("fewer or more cells") && notes.contains("not UTF-8"), "{notes}");
    }

    #[test]
    fn joins_groups_and_pivots_across_files() {
        let d = dir("join");
        let trades = write(&d, "t.csv", "desk,ccy,amount\nrates,USD,10\nrates,EUR,5\nfx,USD,7\nfx,USD,3\n");
        let desks = write(&d, "d.tsv", "desk\thead\nrates\tAnn\nfx\tBob\n");
        let joined = sql(&json!({
            "sources": [{ "name": "trades", "path": trades }, { "name": "desks", "path": desks }],
            "sql": "SELECT d.head, SUM(t.amount) AS total FROM trades t JOIN desks d ON t.desk = d.desk GROUP BY d.head ORDER BY d.head",
        }))
        .unwrap();
        assert_eq!(joined["rows"], json!([["Ann", 15], ["Bob", 10]]));
        let wide = sql(&json!({
            "sources": [{ "name": "trades", "path": trades }],
            "pivot": { "index": ["desk"], "columns": "ccy", "values": "amount", "agg": "sum" },
        }))
        .unwrap();
        let cols: Vec<&str> = wide["columns"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
        assert_eq!(cols, vec!["desk", "EUR", "USD"]);
        assert_eq!(wide["rows"], json!([["fx", null, 10], ["rates", 5, 10]]));
        let bad = sql(&json!({ "sources": [{ "name": "trades", "path": trades }], "sql": "SELECT nope FROM trades" })).unwrap_err();
        assert!(bad.contains("The query failed"), "{bad}");
    }

    #[test]
    fn joins_rows_the_agent_passes_with_a_file() {
        let d = dir("rows");
        let desks = write(&d, "desks.csv", "desk,head\nrates,Ann\nfx,Bob\n");
        // Another tool's results, slightly different shapes, a nested field, one stray non-object.
        let rows = json!([
            { "key": "PROJ-1", "desk": "rates", "points": 3, "labels": ["a", "b"] },
            { "key": "PROJ-2", "desk": "fx", "points": 5 },
            { "key": "PROJ-3", "desk": "fx" },
            "not an object"
        ]);
        let answer = sql(&json!({
            "sources": [{ "name": "issues", "rows": rows }, { "name": "desks", "path": desks }],
            "sql": "SELECT d.head, COUNT(*) AS issues, SUM(i.points) AS points FROM issues i JOIN desks d USING (desk) GROUP BY d.head ORDER BY d.head",
        }))
        .unwrap();
        assert_eq!(answer["rows"], json!([["Ann", 1, 3], ["Bob", 2, 5]]));
        let notes = answer["notes"].to_string();
        assert!(notes.contains("were not objects"), "{notes}");
        let described = describe(&json!({ "sources": [{ "name": "issues", "rows": [{ "labels": ["a"] }] }] })).unwrap();
        assert_eq!(described["tables"][0]["head"][0][0], json!("[\"a\"]"));
    }

    #[test]
    fn joins_a_sqlite_query_with_other_data() {
        let d = dir("sqlite");
        let db = d.join("app.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE trades (id INTEGER PRIMARY KEY, desk TEXT, amount REAL); INSERT INTO trades (desk, amount) VALUES ('rates', 10), ('fx', 7), ('fx', 3);").unwrap();
        drop(conn);
        let answer = sql(&json!({
            "sources": [
                { "name": "trades", "path": db, "sqlite": { "sql": "SELECT desk, amount FROM trades WHERE amount > 1" } },
                { "name": "heads", "rows": [{ "desk": "rates", "head": "Ann" }, { "desk": "fx", "head": "Bob" }] },
            ],
            "sql": "SELECT h.head, SUM(t.amount) AS total FROM trades t JOIN heads h USING (desk) GROUP BY h.head ORDER BY h.head",
        }))
        .unwrap();
        // A REAL column of whole numbers reads as integers: the same forgiving typing every source gets.
        assert_eq!(answer["rows"], json!([["Ann", 10], ["Bob", 10]]));
        let table = sql(&json!({ "sources": [{ "name": "t", "path": db, "sqlite": { "table": "trades" } }], "sql": "SELECT COUNT(*) AS n FROM t" })).unwrap();
        assert_eq!(table["rows"][0][0], json!(3));
        let refused = sql(&json!({ "sources": [{ "name": "t", "path": db, "sqlite": { "sql": "DELETE FROM trades" } }] })).unwrap_err();
        assert!(refused.contains("Only reading"), "{refused}");
        let missing = sql(&json!({ "sources": [{ "name": "t", "path": d.join("none.db"), "sqlite": { "table": "x" } }] })).unwrap_err();
        assert!(missing.contains("nothing was created") && !d.join("none.db").exists(), "{missing}");
    }

    #[test]
    fn builds_a_join_in_named_steps_and_explains_the_alias_limit() {
        let sources = json!([
            { "name": "issues", "rows": [{ "owner": "ann", "pts": 3 }, { "owner": "bob", "pts": 5 }, { "owner": "ann", "pts": 1 }, { "owner": "cat", "pts": 2 }] },
            { "name": "people", "rows": [{ "login": "ann", "team": "rates" }, { "login": "bob", "team": "fx" }] },
        ]);
        let staged = sql(&json!({
            "sources": sources,
            "steps": [{ "name": "per_owner", "sql": "SELECT owner, SUM(pts) AS pts FROM issues GROUP BY owner" }],
            "sql": "SELECT p.owner, p.pts, COALESCE(t.team, 'unknown') AS team FROM per_owner p LEFT JOIN people t ON p.owner = t.login ORDER BY p.owner",
        }))
        .unwrap();
        assert_eq!(staged["rows"], json!([["ann", 4, "rates"], ["bob", 5, "fx"], ["cat", 2, "unknown"]]));
        let aliased_cte = sql(&json!({
            "sources": sources,
            "sql": "WITH per_owner AS (SELECT owner FROM issues) SELECT p.owner FROM per_owner p",
        }))
        .unwrap_err();
        assert!(aliased_cte.contains("make it a named entry in `steps`"), "{aliased_cte}");
    }

    #[test]
    fn reads_json_files_as_lists_wrappers_or_lines() {
        let d = dir("json");
        let list = write(&d, "a.json", r#"[{"id":1,"v":"x"},{"id":2,"v":"y"}]"#);
        let wrapped = write(&d, "b.json", r#"{"total":2,"results":[{"id":1},{"id":2}]}"#);
        let lines = write(&d, "c.jsonl", "{\"id\":1}\n{\"id\":2}\n\n{\"id\":3}\n");
        for (path, n) in [(list, 2), (wrapped, 2), (lines, 3)] {
            let a = sql(&json!({ "sources": [{ "name": "t", "path": path }], "sql": "SELECT COUNT(*) AS n FROM t" })).unwrap();
            assert_eq!(a["rows"][0][0], json!(n));
        }
    }

    #[test]
    fn excel_dates_and_errors_come_through() {
        assert_eq!(excel_serial(45292.0), "2024-01-01");
        assert_eq!(excel_serial(45292.5), "2024-01-01T12:00:00");
        assert_eq!(cell_text(&Data::Error(calamine::CellErrorType::NA)), "");
    }
}
