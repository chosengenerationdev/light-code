//! `sun-fs`: the parallel file helper behind Sun Light Code's file tools.
//!
//! One JSON request on stdin, one JSON answer on stdout, then exit. It only ever **reads**: every
//! write an agent makes goes through Light Code's own edit tools, which show a diff and ask. Where
//! to look is decided by the caller (which has already applied the deny lists and workspace rules);
//! this program walks, reads and counts as fast as the machine allows - a parallel directory walker,
//! and big files split into ranges searched on every core.
//!
//! Operations: find, summary, duplicates (folders); readMany (several files at once); inspect,
//! lines, tail, grep (one big text file); table (CSV, TSV or Excel queried without loading it all
//! into the model).

use rayon::prelude::*;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn main() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let answer = match serde_json::from_str::<Value>(&input) {
        Ok(request) => run(&request).unwrap_or_else(|e| json!({ "ok": false, "error": e })),
        Err(e) => json!({ "ok": false, "error": format!("The request was not valid JSON: {e}") }),
    };
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{answer}");
}

fn run(r: &Value) -> Result<Value, String> {
    match r.get("op").and_then(Value::as_str).unwrap_or("") {
        "find" => find(r),
        "summary" => summary(r),
        "duplicates" => duplicates(r),
        "readMany" => read_many(r),
        "inspect" => inspect(r),
        "lines" => lines(r),
        "tail" => tail(r),
        "grep" => grep(r),
        "table" => table(r),
        other => Err(format!("Unknown operation \"{other}\".")),
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn s<'a>(r: &'a Value, key: &str) -> Option<&'a str> {
    r.get(key).and_then(Value::as_str)
}
fn u(r: &Value, key: &str, default: u64) -> u64 {
    r.get(key).and_then(Value::as_u64).unwrap_or(default)
}
fn b(r: &Value, key: &str) -> bool {
    r.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn strings(r: &Value, key: &str) -> Vec<String> {
    r.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}
fn millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
fn threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// `*` and `?` against a file name, ignoring case - all the pattern language a name search needs.
fn wildcard(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let (mut pi, mut ni, mut star, mut mark) = (0usize, 0usize, None, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(sp) = star {
            pi = sp + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// The filters every folder operation shares.
struct Filter {
    names: Vec<String>,
    extensions: Vec<String>,
    min_size: u64,
    max_size: u64,
    after: u64,
    before: u64,
    dirs: bool,
}

impl Filter {
    fn from(r: &Value) -> Filter {
        Filter {
            names: strings(r, "names"),
            extensions: strings(r, "extensions").into_iter().map(|e| e.trim_start_matches('.').to_lowercase()).collect(),
            min_size: u(r, "minSize", 0),
            max_size: u(r, "maxSize", u64::MAX),
            after: u(r, "modifiedAfter", 0),
            before: u(r, "modifiedBefore", u64::MAX),
            dirs: b(r, "directories"),
        }
    }
    fn accepts(&self, path: &Path, is_dir: bool, size: u64, modified: u64) -> bool {
        if is_dir != self.dirs {
            return false;
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if !self.names.is_empty() && !self.names.iter().any(|p| if p.contains('*') || p.contains('?') { wildcard(p, &name) } else { name.to_lowercase().contains(&p.to_lowercase()) }) {
            return false;
        }
        if !self.extensions.is_empty() {
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !self.extensions.contains(&ext) {
                return false;
            }
        }
        (is_dir || (size >= self.min_size && size <= self.max_size)) && modified >= self.after && modified <= self.before
    }
}

struct Entry {
    path: PathBuf,
    is_dir: bool,
    size: u64,
    modified: u64,
}

struct WalkOutcome {
    scanned: usize,
    errors: usize,
    timed_out: bool,
}

/// Walks every root on every core, handing each entry to `visit`, which returns false to stop.
/// Folders whose path contains any `skip` text are not entered (the caller's credential folders).
fn walk(r: &Value, visit: &(dyn Fn(Entry) -> bool + Sync)) -> Result<WalkOutcome, String> {
    let roots = strings(r, "roots");
    if roots.is_empty() {
        return Err("Name at least one folder to look in.".into());
    }
    let skip: Vec<String> = strings(r, "skip").into_iter().map(|s| s.to_lowercase()).collect();
    let budget = std::time::Duration::from_millis(u(r, "timeBudgetMs", 60_000));
    let started = Instant::now();
    let scanned = AtomicUsize::new(0);
    let errors = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let timed_out = AtomicBool::new(false);
    let mut builder = ignore::WalkBuilder::new(&roots[0]);
    for root in &roots[1..] {
        builder.add(root);
    }
    let gitignore = b(r, "gitignore");
    builder
        .hidden(!b(r, "includeHidden"))
        .git_ignore(gitignore)
        .git_global(gitignore)
        .git_exclude(gitignore)
        .ignore(gitignore)
        .parents(gitignore)
        .follow_links(false)
        .threads(threads());
    if let Some(depth) = r.get("maxDepth").and_then(Value::as_u64) {
        builder.max_depth(Some(depth as usize));
    }
    builder.build_parallel().run(|| {
        Box::new(|result| {
            if stop.load(Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }
            if started.elapsed() > budget {
                timed_out.store(true, Ordering::Relaxed);
                stop.store(true, Ordering::Relaxed);
                return ignore::WalkState::Quit;
            }
            let entry = match result {
                Ok(e) => e,
                Err(_) => {
                    errors.fetch_add(1, Ordering::Relaxed);
                    return ignore::WalkState::Continue;
                }
            };
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir && !skip.is_empty() {
                let p = format!("{}/", norm(entry.path()));
                if skip.iter().any(|s| p.contains(s)) {
                    return ignore::WalkState::Skip;
                }
            }
            if entry.depth() == 0 && is_dir {
                return ignore::WalkState::Continue;
            }
            scanned.fetch_add(1, Ordering::Relaxed);
            let meta = entry.metadata().ok();
            let item = Entry {
                path: entry.path().to_path_buf(),
                is_dir,
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta.and_then(|m| m.modified().ok()).map(millis).unwrap_or(0),
            };
            if !visit(item) {
                stop.store(true, Ordering::Relaxed);
                return ignore::WalkState::Quit;
            }
            ignore::WalkState::Continue
        })
    });
    Ok(WalkOutcome {
        scanned: scanned.load(Ordering::Relaxed),
        errors: errors.load(Ordering::Relaxed),
        timed_out: timed_out.load(Ordering::Relaxed),
    })
}

fn entry_json(e: &Entry) -> Value {
    json!({ "path": e.path.to_string_lossy(), "size": e.size, "modified": e.modified, "directory": e.is_dir })
}

// ─── Folder operations ──────────────────────────────────────────────────────

fn find(r: &Value) -> Result<Value, String> {
    let filter = Filter::from(r);
    let limit = u(r, "limit", 200).min(5000) as usize;
    let found = Mutex::new(Vec::new());
    let started = Instant::now();
    let outcome = walk(r, &|e| {
        if filter.accepts(&e.path, e.is_dir, e.size, e.modified) {
            let mut list = found.lock().unwrap();
            list.push(e);
            return list.len() < limit;
        }
        true
    })?;
    let mut list = found.into_inner().unwrap();
    // Parallel walks finish in no particular order; newest first is the order people want.
    list.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(json!({
        "ok": true,
        "matches": list.iter().map(entry_json).collect::<Vec<_>>(),
        "scanned": outcome.scanned,
        "limitReached": list.len() >= limit,
        "timedOut": outcome.timed_out,
        "unreadable": outcome.errors,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
}

fn summary(r: &Value) -> Result<Value, String> {
    let filter = Filter::from(r);
    let top = u(r, "top", 15) as usize;
    #[derive(Default)]
    struct Acc {
        files: u64,
        dirs: u64,
        bytes: u64,
        by_ext: HashMap<String, (u64, u64)>,
        largest: Vec<(u64, String, u64)>,
        newest: Vec<(u64, String, u64)>,
    }
    let acc = Mutex::new(Acc::default());
    let started = Instant::now();
    let outcome = walk(r, &|e| {
        let mut a = acc.lock().unwrap();
        if e.is_dir {
            a.dirs += 1;
            return true;
        }
        if !filter.accepts(&e.path, false, e.size, e.modified) {
            return true;
        }
        a.files += 1;
        a.bytes += e.size;
        let ext = e.path.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_else(|| "(none)".into());
        let slot = a.by_ext.entry(ext).or_insert((0, 0));
        slot.0 += 1;
        slot.1 += e.size;
        let p = e.path.to_string_lossy().to_string();
        a.largest.push((e.size, p.clone(), e.modified));
        a.newest.push((e.modified, p, e.size));
        if a.largest.len() > top * 8 {
            a.largest.sort_by(|x, y| y.0.cmp(&x.0));
            a.largest.truncate(top);
            a.newest.sort_by(|x, y| y.0.cmp(&x.0));
            a.newest.truncate(top);
        }
        true
    })?;
    let mut a = acc.into_inner().unwrap();
    a.largest.sort_by(|x, y| y.0.cmp(&x.0));
    a.largest.truncate(top);
    a.newest.sort_by(|x, y| y.0.cmp(&x.0));
    a.newest.truncate(top);
    let mut by_ext: Vec<_> = a.by_ext.into_iter().collect();
    by_ext.sort_by(|x, y| y.1 .1.cmp(&x.1 .1));
    by_ext.truncate(20);
    Ok(json!({
        "ok": true,
        "files": a.files,
        "folders": a.dirs,
        "bytes": a.bytes,
        "byExtension": by_ext.iter().map(|(e, (c, s))| json!({ "extension": e, "files": c, "bytes": s })).collect::<Vec<_>>(),
        "largest": a.largest.iter().map(|(s, p, m)| json!({ "path": p, "size": s, "modified": m })).collect::<Vec<_>>(),
        "newest": a.newest.iter().map(|(m, p, s)| json!({ "path": p, "size": s, "modified": m })).collect::<Vec<_>>(),
        "scanned": outcome.scanned,
        "timedOut": outcome.timed_out,
        "unreadable": outcome.errors,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
}

fn duplicates(r: &Value) -> Result<Value, String> {
    let mut filter = Filter::from(r);
    filter.min_size = filter.min_size.max(u(r, "minSize", 1024).max(1));
    let by_size = Mutex::new(HashMap::<u64, Vec<PathBuf>>::new());
    let started = Instant::now();
    let outcome = walk(r, &|e| {
        if filter.accepts(&e.path, e.is_dir, e.size, e.modified) {
            by_size.lock().unwrap().entry(e.size).or_default().push(e.path);
        }
        true
    })?;
    // Only files sharing a size can be identical, so only those are hashed - on every core.
    let candidates: Vec<(u64, PathBuf)> = by_size
        .into_inner()
        .unwrap()
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .flat_map(|(size, v)| v.into_iter().map(move |p| (size, p)))
        .collect();
    let hashed: Vec<(u64, String, PathBuf)> = candidates
        .par_iter()
        .filter_map(|(size, path)| {
            use sha2::Digest;
            let mut file = File::open(path).ok()?;
            let mut hasher = sha2::Sha256::new();
            let mut buf = vec![0u8; 1 << 20];
            loop {
                let n = file.read(&mut buf).ok()?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            Some((*size, format!("{:x}", hasher.finalize()), path.clone()))
        })
        .collect();
    let mut groups: HashMap<(u64, String), Vec<String>> = HashMap::new();
    for (size, hash, path) in hashed {
        groups.entry((size, hash)).or_default().push(path.to_string_lossy().to_string());
    }
    let mut list: Vec<_> = groups.into_iter().filter(|(_, v)| v.len() > 1).collect();
    list.sort_by(|a, b| (b.0 .0 * (b.1.len() as u64 - 1)).cmp(&(a.0 .0 * (a.1.len() as u64 - 1))));
    let total_groups = list.len();
    list.truncate(u(r, "limit", 50) as usize);
    Ok(json!({
        "ok": true,
        "groups": list.iter().map(|((size, _), paths)| json!({ "size": size, "copies": paths.len(), "wastedBytes": size * (paths.len() as u64 - 1), "paths": paths })).collect::<Vec<_>>(),
        "totalGroups": total_groups,
        "hashedFiles": candidates.len(),
        "scanned": outcome.scanned,
        "timedOut": outcome.timed_out,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
}

// ─── Reading ────────────────────────────────────────────────────────────────

/// Text from bytes: UTF-8 where it is, UTF-16 when it says so, lossy otherwise. `None` for binary.
fn decode(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let le = bytes[0] == 0xff;
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
        return Some(String::from_utf16_lossy(&units));
    }
    let sample = &bytes[..bytes.len().min(8192)];
    if memchr::memchr(0, sample).is_some() {
        return None;
    }
    Some(String::from_utf8_lossy(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes)).into_owned())
}

fn read_many(r: &Value) -> Result<Value, String> {
    let max_bytes = u(r, "maxBytesEach", 100_000) as usize;
    let files = r.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    let results: Vec<Value> = files
        .par_iter()
        .map(|f| {
            let path = f.get("path").and_then(Value::as_str).unwrap_or("");
            let from = f.get("fromLine").and_then(Value::as_u64).unwrap_or(1).max(1);
            let count = f.get("lines").and_then(Value::as_u64).unwrap_or(u64::MAX);
            match read_window(Path::new(path), from, count, max_bytes) {
                Ok(v) => v,
                Err(e) => json!({ "path": path, "error": e }),
            }
        })
        .collect();
    Ok(json!({ "ok": true, "files": results }))
}

/// Lines `from`..`from+count` of a file, streamed: nothing before the window is kept in memory.
fn read_window(path: &Path, from: u64, count: u64, max_bytes: usize) -> Result<Value, String> {
    let file = File::open(path).map_err(|e| format!("{e}"))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut head = vec![0u8; 8192.min(size as usize)];
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let n = reader.read(&mut head).unwrap_or(0);
    head.truncate(n);
    if decode(&head).is_none() {
        return Ok(json!({ "path": path.to_string_lossy(), "binary": true, "size": size }));
    }
    reader.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut line_no = 0u64;
    let mut out = Vec::new();
    let mut bytes = 0usize;
    let mut truncated = false;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let read = reader.read_until(b'\n', &mut buf).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        line_no += 1;
        if line_no < from {
            continue;
        }
        if line_no >= from.saturating_add(count) || bytes + buf.len() > max_bytes {
            truncated = true;
            break;
        }
        bytes += buf.len();
        out.push(String::from_utf8_lossy(&buf).trim_end_matches(['\n', '\r']).to_string());
    }
    Ok(json!({ "path": path.to_string_lossy(), "startLine": from, "lines": out, "more": truncated, "size": size }))
}

fn need_path(r: &Value) -> Result<PathBuf, String> {
    s(r, "path").map(PathBuf::from).ok_or_else(|| "Name the file.".to_string())
}

/// Byte ranges splitting a file into one piece per core, each starting at a line boundary.
fn ranges(path: &Path, size: u64) -> Result<Vec<(u64, u64)>, String> {
    let pieces = (threads() as u64).max(1).min((size / (4 << 20)).max(1));
    let mut starts = vec![0u64];
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    for i in 1..pieces {
        let mut at = size * i / pieces;
        file.seek(SeekFrom::Start(at)).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 4096];
        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                at = size;
                break;
            }
            if let Some(p) = memchr::memchr(b'\n', &buf[..n]) {
                at += p as u64 + 1;
                break;
            }
            at += n as u64;
        }
        if at > *starts.last().unwrap() && at < size {
            starts.push(at);
        }
    }
    let mut out = Vec::new();
    for (i, s) in starts.iter().enumerate() {
        out.push((*s, starts.get(i + 1).copied().unwrap_or(size)));
    }
    Ok(out)
}

fn count_newlines(path: &Path, start: u64, end: u64) -> Result<u64, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut left = end - start;
    let mut buf = vec![0u8; 1 << 20];
    let mut lines = 0u64;
    while left > 0 {
        let want = left.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..want]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        lines += memchr::memchr_iter(b'\n', &buf[..n]).count() as u64;
        left -= n as u64;
    }
    Ok(lines)
}

fn inspect(r: &Value) -> Result<Value, String> {
    let path = need_path(r)?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let size = meta.len();
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut info = Map::new();
    info.insert("ok".into(), json!(true));
    info.insert("path".into(), json!(path.to_string_lossy()));
    info.insert("size".into(), json!(size));
    info.insert("modified".into(), json!(meta.modified().ok().map(millis)));
    if matches!(ext.as_str(), "xlsx" | "xlsm" | "xlsb" | "xls" | "ods") {
        use calamine::Reader;
        let mut book = calamine::open_workbook_auto(&path).map_err(|e| format!("Could not open the workbook: {e}"))?;
        let names = book.sheet_names().to_vec();
        let mut sheets = Vec::new();
        for name in names {
            if let Ok(range) = book.worksheet_range(&name) {
                let (rows, cols) = range.get_size();
                let header: Vec<String> = range.rows().next().map(|row| row.iter().map(|c| c.to_string()).collect()).unwrap_or_default();
                sheets.push(json!({ "sheet": name, "rows": rows, "columns": cols, "header": header }));
            }
        }
        info.insert("kind".into(), json!("workbook"));
        info.insert("sheets".into(), json!(sheets));
        return Ok(Value::Object(info));
    }
    let mut head = vec![0u8; 65536.min(size as usize)];
    let n = File::open(&path).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    head.truncate(n);
    let Some(text) = decode(&head) else {
        info.insert("kind".into(), json!("binary"));
        return Ok(Value::Object(info));
    };
    // Line count on every core: the file in ranges, newlines counted with SIMD in each.
    let parts = ranges(&path, size)?;
    let total: u64 = parts.par_iter().map(|(s, e)| count_newlines(&path, *s, *e).unwrap_or(0)).sum();
    let ends_with_newline = size > 0 && {
        let mut f = File::open(&path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::End(-1)).ok();
        let mut last = [0u8; 1];
        f.read(&mut last).ok();
        last[0] == b'\n'
    };
    let line_count = total + if ends_with_newline || size == 0 { 0 } else { 1 };
    info.insert("kind".into(), json!("text"));
    info.insert("lines".into(), json!(line_count));
    info.insert("firstLines".into(), json!(text.lines().take(5).map(|l| l.chars().take(400).collect::<String>()).collect::<Vec<_>>()));
    if matches!(ext.as_str(), "csv" | "tsv" | "txt") || text.lines().next().map(|l| l.matches(',').count() > 2).unwrap_or(false) {
        if let Ok(t) = table_from_csv(&path, &json!({ "limit": 0 }), true) {
            info.insert("table".into(), json!({ "delimiter": t.delimiter.to_string(), "columns": t.headers, "types": t.types }));
        }
    }
    Ok(Value::Object(info))
}

fn lines(r: &Value) -> Result<Value, String> {
    let path = need_path(r)?;
    let mut v = read_window(&path, u(r, "from", 1).max(1), u(r, "count", 200).min(5000), u(r, "maxBytes", 200_000) as usize)?;
    v["ok"] = json!(true);
    Ok(v)
}

fn tail(r: &Value) -> Result<Value, String> {
    let path = need_path(r)?;
    let want = u(r, "count", 100).min(5000) as usize;
    let mut file = File::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    // Backwards in blocks until enough newlines are in hand - the start of the file is never read.
    let mut collected: Vec<u8> = Vec::new();
    let mut pos = size;
    while pos > 0 && memchr::memchr_iter(b'\n', &collected).count() <= want {
        let step = pos.min(1 << 20);
        pos -= step;
        file.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
        let mut block = vec![0u8; step as usize];
        file.read_exact(&mut block).map_err(|e| e.to_string())?;
        block.extend_from_slice(&collected);
        collected = block;
    }
    let text = String::from_utf8_lossy(&collected);
    let all: Vec<&str> = text.trim_end_matches(['\n', '\r']).split('\n').collect();
    let start = all.len().saturating_sub(want);
    Ok(json!({ "ok": true, "path": path.to_string_lossy(), "lines": all[start..].iter().map(|l| l.trim_end_matches('\r')).collect::<Vec<_>>(), "size": size }))
}

fn grep(r: &Value) -> Result<Value, String> {
    let path = need_path(r)?;
    let pattern = s(r, "pattern").ok_or("Give a pattern to search for.")?;
    let regex = regex::RegexBuilder::new(pattern)
        .case_insensitive(!b(r, "caseSensitive"))
        .size_limit(10 << 20)
        .build()
        .map_err(|e| format!("The pattern is not a valid regular expression: {e}"))?;
    let context = u(r, "context", 0).min(10) as usize;
    let limit = u(r, "limit", 100).min(2000) as usize;
    let size = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?.len();
    let parts = ranges(&path, size)?;
    // First the line number each range starts at (counted in parallel), then the search itself.
    let counts: Vec<u64> = parts.par_iter().map(|(s, e)| count_newlines(&path, *s, *e).unwrap_or(0)).collect();
    let mut offsets = vec![0u64; parts.len()];
    for i in 1..parts.len() {
        offsets[i] = offsets[i - 1] + counts[i - 1];
    }
    let found = AtomicUsize::new(0);
    let per_range: Vec<Vec<Value>> = parts
        .par_iter()
        .zip(offsets.par_iter())
        .map(|((start, end), first)| {
            let mut hits = Vec::new();
            let Ok(mut file) = File::open(&path) else { return hits };
            if file.seek(SeekFrom::Start(*start)).is_err() {
                return hits;
            }
            let reader = BufReader::with_capacity(1 << 20, file.take(end - start));
            let mut before: std::collections::VecDeque<String> = std::collections::VecDeque::new();
            let mut pending: Vec<(usize, Value)> = Vec::new();
            for (i, line) in reader.split(b'\n').enumerate() {
                let Ok(raw) = line else { break };
                let text = String::from_utf8_lossy(&raw).trim_end_matches('\r').to_string();
                let number = first + i as u64 + 1;
                for (left, hit) in pending.iter_mut() {
                    if *left > 0 {
                        hit["after"].as_array_mut().unwrap().push(json!(text.chars().take(500).collect::<String>()));
                        *left -= 1;
                    }
                }
                if regex.is_match(&text) {
                    if found.fetch_add(1, Ordering::Relaxed) >= limit * 4 {
                        break;
                    }
                    pending.push((context, json!({ "line": number, "text": text.chars().take(1000).collect::<String>(), "before": before.iter().cloned().collect::<Vec<_>>(), "after": [] })));
                }
                if context > 0 {
                    before.push_back(text.chars().take(500).collect());
                    if before.len() > context {
                        before.pop_front();
                    }
                }
                let (done, rest): (Vec<_>, Vec<_>) = pending.into_iter().partition(|(left, _)| *left == 0);
                hits.extend(done.into_iter().map(|(_, h)| h));
                pending = rest;
            }
            hits.extend(pending.into_iter().map(|(_, h)| h));
            hits
        })
        .collect();
    let all: Vec<Value> = per_range.into_iter().flatten().collect();
    let total = all.len();
    Ok(json!({ "ok": true, "path": path.to_string_lossy(), "matches": all.into_iter().take(limit).collect::<Vec<_>>(), "matchCount": total, "limitReached": total > limit, "lines": offsets.last().copied().unwrap_or(0) + counts.last().copied().unwrap_or(0) }))
}

// ─── Tables ─────────────────────────────────────────────────────────────────

struct Table {
    headers: Vec<String>,
    types: Vec<String>,
    delimiter: char,
    rows: Vec<Vec<String>>,
    scanned: u64,
}

fn number(v: &str) -> Option<f64> {
    let t = v.trim();
    if t.is_empty() {
        return None;
    }
    t.replace(',', "").trim_start_matches(['$', '£', '€']).parse::<f64>().ok()
}

fn infer_types(headers: &[String], rows: &[Vec<String>]) -> Vec<String> {
    (0..headers.len())
        .map(|i| {
            let values: Vec<&String> = rows.iter().filter_map(|r| r.get(i)).filter(|v| !v.trim().is_empty()).take(1000).collect();
            if values.is_empty() {
                "empty".into()
            } else if values.iter().all(|v| number(v).is_some()) {
                "number".into()
            } else {
                "text".into()
            }
        })
        .collect()
}

/// Reads a delimited file. With `limit: 0` only the header and a sample are kept (for inspect).
fn table_from_csv(path: &Path, r: &Value, sample_only: bool) -> Result<Table, String> {
    let mut head = vec![0u8; 16384];
    let n = File::open(path).and_then(|mut f| f.read(&mut head)).map_err(|e| e.to_string())?;
    let first = String::from_utf8_lossy(&head[..n]).lines().next().unwrap_or("").to_string();
    let delimiter = s(r, "delimiter").and_then(|d| d.chars().next()).unwrap_or_else(|| {
        [',', '\t', ';', '|'].into_iter().max_by_key(|c| first.matches(*c).count()).unwrap_or(',')
    });
    let has_header = r.get("header").and_then(Value::as_bool).unwrap_or(true);
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter as u8)
        .has_headers(has_header)
        .flexible(true)
        .from_reader(BufReader::with_capacity(1 << 20, File::open(path).map_err(|e| e.to_string())?));
    let mut headers: Vec<String> = if has_header {
        reader.headers().map_err(|e| e.to_string())?.iter().map(|h| h.trim_start_matches('\u{feff}').to_string()).collect()
    } else {
        Vec::new()
    };
    let mut rows = Vec::new();
    let mut scanned = 0u64;
    for record in reader.records() {
        let Ok(record) = record else { continue };
        scanned += 1;
        rows.push(record.iter().map(String::from).collect::<Vec<_>>());
        if sample_only && rows.len() >= 1000 {
            break;
        }
    }
    if !has_header {
        let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        headers = (1..=width).map(|i| format!("column{i}")).collect();
    }
    let types = infer_types(&headers, &rows);
    Ok(Table { headers, types, delimiter, rows, scanned })
}

fn table_from_workbook(path: &Path, r: &Value) -> Result<Table, String> {
    use calamine::Reader;
    let mut book = calamine::open_workbook_auto(path).map_err(|e| format!("Could not open the workbook: {e}"))?;
    let sheet = match s(r, "sheet") {
        Some(name) => name.to_string(),
        None => book.sheet_names().first().cloned().ok_or("The workbook has no sheets.")?,
    };
    let range = book.worksheet_range(&sheet).map_err(|e| format!("Sheet \"{sheet}\": {e}"))?;
    let mut iter = range.rows();
    let has_header = r.get("header").and_then(Value::as_bool).unwrap_or(true);
    let headers: Vec<String> = if has_header {
        iter.next().map(|row| row.iter().map(|c| c.to_string()).collect()).unwrap_or_default()
    } else {
        (1..=range.get_size().1).map(|i| format!("column{i}")).collect()
    };
    let rows: Vec<Vec<String>> = iter.map(|row| row.iter().map(|c| c.to_string()).collect()).collect();
    let types = infer_types(&headers, &rows);
    let scanned = rows.len() as u64;
    Ok(Table { headers, types, delimiter: ',', rows, scanned })
}

fn column(headers: &[String], name: &str) -> Result<usize, String> {
    headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case(name.trim()))
        .ok_or_else(|| format!("No column \"{name}\". The columns are: {}.", headers.join(", ")))
}

fn passes(row: &[String], filters: &[(usize, String, String)]) -> bool {
    filters.iter().all(|(i, op, value)| {
        let cell = row.get(*i).map(String::as_str).unwrap_or("");
        let (a, b) = (number(cell), number(value));
        match op.as_str() {
            "eq" | "=" | "==" => match (a, b) { (Some(x), Some(y)) => x == y, _ => cell.eq_ignore_ascii_case(value) },
            "ne" | "!=" => match (a, b) { (Some(x), Some(y)) => x != y, _ => !cell.eq_ignore_ascii_case(value) },
            "gt" | ">" => matches!((a, b), (Some(x), Some(y)) if x > y) || (a.is_none() && cell > value.as_str()),
            "ge" | ">=" => matches!((a, b), (Some(x), Some(y)) if x >= y) || (a.is_none() && cell >= value.as_str()),
            "lt" | "<" => matches!((a, b), (Some(x), Some(y)) if x < y) || (a.is_none() && !cell.is_empty() && cell < value.as_str()),
            "le" | "<=" => matches!((a, b), (Some(x), Some(y)) if x <= y) || (a.is_none() && !cell.is_empty() && cell <= value.as_str()),
            "contains" => cell.to_lowercase().contains(&value.to_lowercase()),
            "startsWith" => cell.to_lowercase().starts_with(&value.to_lowercase()),
            "empty" => cell.trim().is_empty(),
            "notEmpty" => !cell.trim().is_empty(),
            _ => false,
        }
    })
}

fn table(r: &Value) -> Result<Value, String> {
    let path = need_path(r)?;
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let t = if matches!(ext.as_str(), "xlsx" | "xlsm" | "xlsb" | "xls" | "ods") { table_from_workbook(&path, r)? } else { table_from_csv(&path, r, false)? };
    let filters: Vec<(usize, String, String)> = r
        .get("filters")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|f| {
                    Ok((
                        column(&t.headers, f.get("column").and_then(Value::as_str).unwrap_or(""))?,
                        f.get("op").and_then(Value::as_str).unwrap_or("eq").to_string(),
                        f.get("value").map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap_or_default(),
                    ))
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .transpose()?
        .unwrap_or_default();
    // Filtering on every core.
    let matched: Vec<&Vec<String>> = t.rows.par_iter().filter(|row| passes(row, &filters)).collect();
    let group_by: Vec<usize> = strings(r, "groupBy").iter().map(|c| column(&t.headers, c)).collect::<Result<_, _>>()?;
    let aggregates: Vec<(String, Option<usize>)> = r
        .get("aggregates")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|g| {
                    let f = g.get("fn").and_then(Value::as_str).unwrap_or("count").to_string();
                    let c = g.get("column").and_then(Value::as_str);
                    Ok((f, c.map(|c| column(&t.headers, c)).transpose()?))
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .transpose()?
        .unwrap_or_default();
    let limit = u(r, "limit", 50).min(1000) as usize;
    let offset = u(r, "offset", 0) as usize;

    let (columns, mut out): (Vec<String>, Vec<Vec<Value>>) = if !group_by.is_empty() || !aggregates.is_empty() {
        let aggs = if aggregates.is_empty() { vec![("count".to_string(), None)] } else { aggregates };
        #[derive(Clone, Default)]
        struct Cell {
            count: u64,
            sum: f64,
            min: Option<f64>,
            max: Option<f64>,
            numeric: u64,
            distinct: std::collections::HashSet<String>,
        }
        // Grouped in parallel, then the partial groups merged.
        let groups: HashMap<Vec<String>, Vec<Cell>> = matched
            .par_iter()
            .fold(HashMap::new, |mut acc: HashMap<Vec<String>, Vec<Cell>>, row| {
                let key: Vec<String> = group_by.iter().map(|i| row.get(*i).cloned().unwrap_or_default()).collect();
                let cells = acc.entry(key).or_insert_with(|| vec![Cell::default(); aggs.len()]);
                for (k, (f, c)) in aggs.iter().enumerate() {
                    let cell = &mut cells[k];
                    cell.count += 1;
                    if let Some(i) = c {
                        let v = row.get(*i).map(String::as_str).unwrap_or("");
                        if f == "distinct" {
                            cell.distinct.insert(v.to_string());
                        }
                        if let Some(n) = number(v) {
                            cell.numeric += 1;
                            cell.sum += n;
                            cell.min = Some(cell.min.map_or(n, |m| m.min(n)));
                            cell.max = Some(cell.max.map_or(n, |m| m.max(n)));
                        }
                    }
                }
                acc
            })
            .reduce(HashMap::new, |mut a, b| {
                for (key, cells) in b {
                    let slot = a.entry(key).or_insert_with(|| vec![Cell::default(); cells.len()]);
                    for (x, y) in slot.iter_mut().zip(cells) {
                        x.count += y.count;
                        x.sum += y.sum;
                        x.numeric += y.numeric;
                        x.min = match (x.min, y.min) { (Some(p), Some(q)) => Some(p.min(q)), (p, q) => p.or(q) };
                        x.max = match (x.max, y.max) { (Some(p), Some(q)) => Some(p.max(q)), (p, q) => p.or(q) };
                        x.distinct.extend(y.distinct);
                    }
                }
                a
            });
        let mut columns: Vec<String> = group_by.iter().map(|i| t.headers[*i].clone()).collect();
        columns.extend(aggs.iter().map(|(f, c)| match c { Some(i) => format!("{f}({})", t.headers[*i]), None => f.clone() }));
        let rows = groups
            .into_iter()
            .map(|(key, cells)| {
                let mut row: Vec<Value> = key.into_iter().map(Value::from).collect();
                for ((f, _), cell) in aggs.iter().zip(cells) {
                    row.push(match f.as_str() {
                        "sum" => json!(cell.sum),
                        "avg" => if cell.numeric > 0 { json!(cell.sum / cell.numeric as f64) } else { Value::Null },
                        "min" => json!(cell.min),
                        "max" => json!(cell.max),
                        "distinct" => json!(cell.distinct.len()),
                        _ => json!(cell.count),
                    });
                }
                row
            })
            .collect();
        (columns, rows)
    } else {
        let selected: Vec<usize> = {
            let names = strings(r, "columns");
            if names.is_empty() { (0..t.headers.len()).collect() } else { names.iter().map(|c| column(&t.headers, c)).collect::<Result<_, _>>()? }
        };
        let columns = selected.iter().map(|i| t.headers[*i].clone()).collect();
        let rows = matched.iter().map(|row| selected.iter().map(|i| Value::from(row.get(*i).cloned().unwrap_or_default())).collect()).collect();
        (columns, rows)
    };

    if let Some(sort) = r.get("sort").and_then(Value::as_array) {
        for key in sort.iter().rev() {
            let name = key.get("column").and_then(Value::as_str).unwrap_or("");
            let desc = key.get("desc").and_then(Value::as_bool).unwrap_or(false);
            let i = column(&columns, name)?;
            out.par_sort_by(|a, b| {
                let (x, y) = (&a[i], &b[i]);
                let ord = match (x.as_f64().or_else(|| x.as_str().and_then(number)), y.as_f64().or_else(|| y.as_str().and_then(number))) {
                    (Some(p), Some(q)) => p.partial_cmp(&q).unwrap_or(std::cmp::Ordering::Equal),
                    _ => x.to_string().cmp(&y.to_string()),
                };
                if desc { ord.reverse() } else { ord }
            });
        }
    }
    let total = out.len();
    let page: Vec<Vec<Value>> = out.into_iter().skip(offset).take(limit).collect();
    Ok(json!({
        "ok": true,
        "columns": columns,
        "types": t.types,
        "allColumns": t.headers,
        "rows": page,
        "resultRows": total,
        "matchedRows": matched.len(),
        "scannedRows": t.scanned,
        "offset": offset,
        "more": offset + limit < total,
    }))
}
