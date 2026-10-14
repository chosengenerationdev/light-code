//! The usage dashboard's shared-folder store, done here because a team-year is thousands of small
//! files on a network share: read in parallel, written atomically, and every file that could not be
//! read named with Windows' reason rather than silently missing from the numbers.
//!
//! Layout (the same as `usage/store.ts`, which falls back to it without this helper):
//! `<root>/<user>/<YYYY-MM-DD>__<install>.jsonl` - one person's day on one install, JSON Lines - and
//! `<root>/_profiles/<user>.json` - the details a user-info tool gave for that person.
//!
//! Folder only. S3 and the vector stores are network stores, and all network traffic goes through the
//! one HttpClient in the TypeScript core (invariant 2), so they are not reached from here.

use rayon::prelude::*;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub fn run(r: &Value) -> Result<Value, String> {
    let root = r.get("root").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).ok_or("A usage request needs `root`.")?;
    let root = Path::new(root);
    match r.get("action").and_then(Value::as_str).unwrap_or("") {
        "write" => write_shard(root, r),
        "writeProfile" => write_profile(root, r),
        "read" => read(root, r),
        "backfill" => backfill(root, r),
        other => Err(format!("Unknown usage action \"{other}\".")),
    }
}

/// A path segment that cannot climb out of the folder or name a device.
fn segment(value: &str, what: &str) -> Result<String, String> {
    let ok = !value.is_empty()
        && value.len() <= 80
        && value != "."
        && value != ".."
        && !value.starts_with('.')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | '-'));
    if ok { Ok(value.to_string()) } else { Err(format!("\"{value}\" is not a usable {what}.")) }
}

fn is_day(day: &str) -> bool {
    let b = day.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// `YYYY-MM-DD__install.jsonl` to (day, install).
fn shard_name(name: &str) -> Option<(String, String)> {
    let stem = name.strip_suffix(".jsonl")?;
    let (day, install) = stem.split_once("__")?;
    (is_day(day) && !install.is_empty() && install.chars().all(|c| c.is_ascii_alphanumeric())).then(|| (day.to_string(), install.to_string()))
}

/// `YYYY-MM__install.jsonl` (a rolled-up month) to (month, install).
fn month_name(name: &str) -> Option<(String, String)> {
    let stem = name.strip_suffix(".jsonl")?;
    let (month, install) = stem.split_once("__")?;
    let b = month.as_bytes();
    let ok = b.len() == 7 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit());
    (ok && !install.is_empty() && install.chars().all(|c| c.is_ascii_alphanumeric())).then(|| (month.to_string(), install.to_string()))
}

/// Written beside the target and renamed over it, so a colleague reading at that moment sees the
/// old file or the new one, never half. Retried briefly: a share or antivirus can hold a file open.
fn write_atomically(target: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let temporary = target.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temporary, text).map_err(|e| format!("Could not write {}: {e}", temporary.display()))?;
    let mut last = String::new();
    for attempt in 0..8 {
        match std::fs::rename(&temporary, target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(100 * (attempt + 1)));
            }
        }
    }
    let _ = std::fs::remove_file(&temporary);
    Err(format!("Could not replace {}: {last}", target.display()))
}

fn valid_event(value: &Value) -> bool {
    value.get("t").map_or(false, Value::is_number)
        && value.get("u").map_or(false, Value::is_string)
        && matches!(value.get("k").and_then(Value::as_str), Some("skill" | "tool"))
        && value.get("n").map_or(false, Value::is_string)
}

fn write_shard(root: &Path, r: &Value) -> Result<Value, String> {
    let user = segment(r.get("user").and_then(Value::as_str).unwrap_or(""), "user name")?;
    let day = r.get("day").and_then(Value::as_str).filter(|d| is_day(d)).ok_or("`day` must be YYYY-MM-DD.")?;
    let install = r.get("instance").and_then(Value::as_str).unwrap_or("");
    if install.is_empty() || !install.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("`instance` must be letters and digits.".into());
    }
    let events = r.get("events").and_then(Value::as_array).ok_or("`events` must be a list.")?;
    let mut text = String::new();
    let mut written = 0usize;
    for event in events.iter().filter(|e| valid_event(e)) {
        text.push_str(&event.to_string());
        text.push('\n');
        written += 1;
    }
    let target = root.join(&user).join(format!("{day}__{install}.jsonl"));
    write_atomically(&target, &text)?;
    Ok(json!({ "ok": true, "path": target.to_string_lossy(), "events": written }))
}

fn write_profile(root: &Path, r: &Value) -> Result<Value, String> {
    let user = segment(r.get("user").and_then(Value::as_str).unwrap_or(""), "user name")?;
    let profile = r.get("profile").and_then(Value::as_object).ok_or("`profile` must be an object.")?;
    // Only short strings: a profile is a few labels, and this file is read by every colleague.
    let mut clean = Map::new();
    for (key, value) in profile {
        if let Some(text) = value.as_str() {
            if key.len() <= 40 && !text.is_empty() {
                clean.insert(key.clone(), Value::String(text.chars().take(200).collect()));
            }
        } else if let Some(number) = value.as_f64() {
            clean.insert(key.clone(), json!(number));
        }
    }
    let target = root.join("_profiles").join(format!("{user}.json"));
    write_atomically(&target, &Value::Object(clean).to_string())?;
    Ok(json!({ "ok": true, "path": target.to_string_lossy() }))
}

fn read(root: &Path, r: &Value) -> Result<Value, String> {
    let from = r.get("fromDay").and_then(Value::as_str).filter(|d| is_day(d)).ok_or("`fromDay` must be YYYY-MM-DD.")?;
    let to = r.get("toDay").and_then(Value::as_str).filter(|d| is_day(d)).ok_or("`toDay` must be YYYY-MM-DD.")?;
    let users = match std::fs::read_dir(root) {
        Ok(entries) => entries.filter_map(Result::ok).filter(|e| e.file_type().map_or(false, |t| t.is_dir())).map(|e| e.path()).collect::<Vec<PathBuf>>(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({ "ok": true, "events": [], "profiles": {}, "files": 0, "unreadable": [] }))
        }
        Err(e) => return Err(format!("Could not list {}: {e}", root.display())),
    };

    let mut unreadable: Vec<Value> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut profile_files: Vec<PathBuf> = Vec::new();
    for folder in &users {
        let is_profiles = folder.file_name().map_or(false, |n| n == "_profiles");
        match std::fs::read_dir(folder) {
            Ok(entries) => {
                // The roll-up rule (`selectShards` in usage/store.ts): month files overlapping the range, and
                // day files in it unless that install has rolled their month up - then the days are
                // leftovers of a roll-up between writing the month and deleting them.
                let mut days: Vec<(String, String, PathBuf)> = Vec::new();
                let mut rolled: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
                for entry in entries.filter_map(Result::ok) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if is_profiles {
                        if name.ends_with(".json") {
                            profile_files.push(entry.path());
                        }
                    } else if let Some((day, install)) = shard_name(&name) {
                        if day.as_str() >= from && day.as_str() <= to {
                            days.push((day, install, entry.path()));
                        }
                    } else if let Some((month, install)) = month_name(&name) {
                        if month.as_str() >= &from[..7] && month.as_str() <= &to[..7] {
                            files.push(entry.path());
                        }
                        rolled.insert((month, install));
                    }
                }
                for (day, install, path) in days {
                    if !rolled.contains(&(day[..7].to_string(), install)) {
                        files.push(path);
                    }
                }
            }
            Err(e) => unreadable.push(json!({ "path": folder.to_string_lossy(), "error": e.to_string() })),
        }
    }

    let results: Vec<Result<Vec<Value>, Value>> = files
        .par_iter()
        .map(|file| match std::fs::read_to_string(file) {
            Ok(text) => Ok(text
                .lines()
                .filter(|line| !line.trim().is_empty())
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(valid_event)
                .collect()),
            Err(e) => Err(json!({ "path": file.to_string_lossy(), "error": e.to_string() })),
        })
        .collect();
    let mut events = Vec::new();
    for result in results {
        match result {
            Ok(mut found) => events.append(&mut found),
            Err(problem) => unreadable.push(problem),
        }
    }

    let mut profiles = Map::new();
    for file in profile_files {
        let user = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        match std::fs::read_to_string(&file).map_err(|e| e.to_string()).and_then(|text| serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())) {
            Ok(value) if value.is_object() => {
                profiles.insert(user, value);
            }
            Ok(_) => {}
            Err(error) => unreadable.push(json!({ "path": file.to_string_lossy(), "error": error })),
        }
    }

    Ok(json!({ "ok": true, "events": events, "profiles": profiles, "files": files.len(), "unreadable": unreadable }))
}

/// Paths compared the way Windows compares them, in either slash style, with `.` and `..` resolved -
/// the same answer `comparablePath(path.join(...))` gives in `usage/backfill.ts`.
fn comparable(value: &str) -> String {
    let unified = value.replace('\\', "/");
    let unc = unified.starts_with("//");
    let mut parts: Vec<&str> = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    let rooted = if unc { format!("//{joined}") } else if unified.starts_with('/') { format!("/{joined}") } else { joined };
    rooted.to_lowercase()
}

fn is_absolute_path(value: &str) -> bool {
    let b = value.as_bytes();
    value.starts_with('/') || value.starts_with('\\') || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\'))
}

fn base_name(value: &str) -> String {
    value.replace('\\', "/").trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

/// Usage recovered from saved conversations - see `usage/backfill.ts`, which this mirrors exactly.
fn backfill(tasks_dir: &Path, r: &Value) -> Result<Value, String> {
    let user = r.get("user").and_then(Value::as_str).ok_or("`user` is required.")?.to_string();
    let project = r.get("project").and_then(Value::as_str).map(str::to_string);
    let workspace = r.get("workspaceRoot").and_then(Value::as_str).map(comparable);
    let before = r.get("before").and_then(Value::as_f64).ok_or("`before` is required.")?;
    let skip: Vec<String> = r.get("skip").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let mut skills_by_path: std::collections::HashMap<String, (String, Option<String>)> = std::collections::HashMap::new();
    let mut skills_by_name: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
    for skill in r.get("skills").and_then(Value::as_array).cloned().unwrap_or_default() {
        let (Some(name), Some(path)) = (skill.get("name").and_then(Value::as_str), skill.get("path").and_then(Value::as_str)) else { continue };
        let author = skill.get("author").and_then(Value::as_str).map(str::to_string);
        skills_by_path.insert(comparable(path), (name.to_string(), author.clone()));
        skills_by_name.entry(name.to_string()).or_insert(author);
    }
    let tool_authors = r.get("toolAuthors").and_then(Value::as_object).cloned().unwrap_or_default();

    let files: Vec<PathBuf> = match std::fs::read_dir(tasks_dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().map_or(false, |x| x == "json") && p.file_name().map_or(false, |n| n != "index.json"))
            .collect(),
        Err(_) => return Ok(json!({ "ok": true, "events": [], "tasks": 0, "unreadable": 0 })),
    };

    let results: Vec<Option<Vec<Value>>> = files
        .par_iter()
        .map(|file| {
            let task: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
            let updated = task.get("updatedAt").and_then(Value::as_f64)?;
            if updated >= before {
                return Some(Vec::new());
            }
            let created = task.get("createdAt").and_then(Value::as_f64).filter(|c| *c <= updated).unwrap_or(updated);
            let root = task.get("workspaceRoot").and_then(Value::as_str);
            let task_project = match (root, &workspace) {
                (Some(root), Some(current)) if comparable(root) == *current => project.clone(),
                (Some(root), _) => Some(base_name(root)),
                _ => None,
            };
            let mut calls: Vec<(String, Map<String, Value>)> = Vec::new();
            for message in task.get("messages").and_then(Value::as_array)? {
                if message.get("role").and_then(Value::as_str) != Some("assistant") {
                    continue;
                }
                for call in message.get("toolCalls").and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[]) {
                    let Some(mut name) = call.get("name").and_then(Value::as_str).map(str::to_string) else { continue };
                    let mut args = match call.get("arguments") {
                        Some(Value::String(text)) => serde_json::from_str::<Value>(text).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default(),
                        Some(Value::Object(map)) => map.clone(),
                        _ => Map::new(),
                    };
                    if name == "call_tool" {
                        if let Some(inner) = args.get("name").and_then(Value::as_str).map(str::to_string) {
                            name = inner;
                            args = args.get("arguments").and_then(Value::as_object).cloned().unwrap_or_default();
                        }
                    }
                    if !skip.contains(&name) {
                        calls.push((name, args));
                    }
                }
            }
            let count = calls.len();
            let mut events = Vec::new();
            for (index, (name, args)) in calls.into_iter().enumerate() {
                let t = if count == 1 { updated } else { (created + (updated - created) * index as f64 / (count - 1) as f64).round() };
                let mut base = Map::new();
                base.insert("t".into(), json!(t as i64));
                base.insert("u".into(), json!(user));
                if let Some(p) = &task_project {
                    base.insert("p".into(), json!(p));
                }
                let mut tool = base.clone();
                tool.insert("k".into(), json!("tool"));
                tool.insert("n".into(), json!(name));
                if let Some(author) = name.strip_prefix("py__").and_then(|bare| tool_authors.get(bare)) {
                    tool.insert("a".into(), author.clone());
                }
                events.push(Value::Object(tool));
                let skill = if name == "read_file" {
                    args.get("path").and_then(Value::as_str).and_then(|requested| {
                        let absolute = match root {
                            Some(root) if !is_absolute_path(requested) => format!("{root}/{requested}"),
                            _ => requested.to_string(),
                        };
                        skills_by_path.get(&comparable(&absolute)).cloned()
                    })
                } else if name == "use_skill_file" {
                    args.get("skill").and_then(Value::as_str).and_then(|wanted| skills_by_name.get(wanted).map(|author| (wanted.to_string(), author.clone())))
                } else {
                    None
                };
                if let Some((skill_name, author)) = skill {
                    let mut used = base;
                    used.insert("k".into(), json!("skill"));
                    used.insert("n".into(), json!(skill_name));
                    if let Some(author) = author {
                        used.insert("a".into(), json!(author));
                    }
                    events.push(Value::Object(used));
                }
            }
            Some(events)
        })
        .collect();

    let mut events = Vec::new();
    let mut unreadable = 0usize;
    for result in results {
        match result {
            Some(mut found) => events.append(&mut found),
            None => unreadable += 1,
        }
    }
    Ok(json!({ "ok": true, "events": events, "tasks": files.len(), "unreadable": unreadable }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fire-usage-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_shards_and_profiles_and_reads_back_only_the_range() {
        let root = temp();
        let r = |v: Value| run(&v).unwrap();
        let ev = |t: u64, n: &str| json!({ "t": t, "u": "ann", "k": "skill", "n": n });
        r(json!({ "root": root.to_string_lossy(), "action": "write", "user": "ann", "day": "2026-10-09", "instance": "a1", "events": [ev(1, "deploy"), json!({ "junk": true })] }));
        r(json!({ "root": root.to_string_lossy(), "action": "write", "user": "ann", "day": "2026-10-10", "instance": "a1", "events": [ev(2, "review")] }));
        // Rewriting a day replaces it.
        r(json!({ "root": root.to_string_lossy(), "action": "write", "user": "ann", "day": "2026-10-10", "instance": "a1", "events": [ev(2, "review"), ev(3, "review")] }));
        r(json!({ "root": root.to_string_lossy(), "action": "writeProfile", "user": "ann", "profile": { "displayName": "Ann Example", "team": "Rates", "nested": { "x": 1 } } }));
        let read = r(json!({ "root": root.to_string_lossy(), "action": "read", "fromDay": "2026-10-10", "toDay": "2026-10-10" }));
        assert_eq!(read["events"].as_array().unwrap().len(), 2);
        assert_eq!(read["files"], 1);
        assert_eq!(read["profiles"]["ann"]["team"], "Rates");
        assert!(read["profiles"]["ann"].get("nested").is_none());
        let all = r(json!({ "root": root.to_string_lossy(), "action": "read", "fromDay": "2000-01-01", "toDay": "2100-01-01" }));
        // The junk line was refused at write time.
        assert_eq!(all["events"].as_array().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reads_rolled_up_months_and_skips_their_leftover_days() {
        let root = temp();
        let user = root.join("ann");
        std::fs::create_dir_all(&user).unwrap();
        let line = |n: &str| format!("{}\n", json!({ "t": 1, "u": "ann", "k": "skill", "n": n }));
        std::fs::write(user.join("2026-09__a1.jsonl"), line("in-month")).unwrap();
        // A leftover day of the rolled month, and a day of another install that has not rolled up.
        std::fs::write(user.join("2026-09-03__a1.jsonl"), line("leftover")).unwrap();
        std::fs::write(user.join("2026-09-03__b2.jsonl"), line("other-install")).unwrap();
        std::fs::write(user.join("2026-10-01__a1.jsonl"), line("october")).unwrap();
        let read = run(&json!({ "root": root.to_string_lossy(), "action": "read", "fromDay": "2026-09-01", "toDay": "2026-10-31" })).unwrap();
        let mut names: Vec<String> = read["events"].as_array().unwrap().iter().map(|e| e["n"].as_str().unwrap().to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["in-month", "october", "other-install"]);
        // A range that ends before the month is not given it.
        let august = run(&json!({ "root": root.to_string_lossy(), "action": "read", "fromDay": "2026-08-01", "toDay": "2026-08-31" })).unwrap();
        assert_eq!(august["events"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_names_that_could_leave_the_folder() {
        let root = temp();
        for user in ["..", "a/b", "a\\b", ".hidden", ""] {
            let answer = run(&json!({ "root": root.to_string_lossy(), "action": "write", "user": user, "day": "2026-10-10", "instance": "a", "events": [] }));
            assert!(answer.is_err(), "{user} was accepted");
        }
        assert!(run(&json!({ "root": root.to_string_lossy(), "action": "write", "user": "ann", "day": "../x", "instance": "a", "events": [] })).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backfills_tool_calls_and_skill_reads_from_saved_tasks() {
        let dir = temp();
        let task = json!({
            "workspaceRoot": "C:\\work\\proj",
            "createdAt": 1000, "updatedAt": 3000,
            "messages": [
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": "", "toolCalls": [{ "id": "1", "name": "read_file", "arguments": "{\"path\":\".lightcode\\\\skills\\\\deploy.md\"}" }] },
                { "role": "tool", "toolCallId": "1", "content": "..." },
                { "role": "assistant", "content": "", "toolCalls": [{ "id": "2", "name": "call_tool", "arguments": "{\"name\":\"py__fetch\",\"arguments\":{}}" }] },
                { "role": "assistant", "content": "", "toolCalls": [{ "id": "3", "name": "attempt_completion", "arguments": "{}" }] }
            ]
        });
        std::fs::write(dir.join("t1.json"), task.to_string()).unwrap();
        std::fs::write(dir.join("later.json"), json!({ "createdAt": 1, "updatedAt": 99999, "messages": [{ "role": "assistant", "toolCalls": [{ "name": "x", "arguments": "{}" }] }] }).to_string()).unwrap();
        std::fs::write(dir.join("index.json"), "[]").unwrap();
        std::fs::write(dir.join("broken.json"), "{").unwrap();
        let answer = run(&json!({
            "root": dir.to_string_lossy(), "action": "backfill", "user": "ann", "project": "Proj", "workspaceRoot": "c:/work/proj",
            "skills": [{ "name": "deploy", "path": "c:/work/proj/.lightcode/skills/deploy.md", "author": "bob" }],
            "toolAuthors": { "fetch": "cat" }, "skip": ["attempt_completion"], "before": 5000
        }))
        .unwrap();
        let events = answer["events"].as_array().unwrap();
        let names: Vec<&str> = events.iter().map(|e| e["n"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["read_file", "deploy", "py__fetch"]);
        assert_eq!(events[1]["a"], "bob");
        assert_eq!(events[2]["a"], "cat");
        assert_eq!(events[0]["t"], 1000);
        assert_eq!(events[2]["t"], 3000);
        assert_eq!(events[0]["p"], "Proj");
        assert_eq!(answer["tasks"], 3);
        assert_eq!(answer["unreadable"], 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_root_is_no_events() {
        let answer = run(&json!({ "root": "Z:/definitely/not/here/usage", "action": "read", "fromDay": "2026-01-01", "toDay": "2026-12-31" })).unwrap();
        assert_eq!(answer["events"].as_array().unwrap().len(), 0);
    }
}
