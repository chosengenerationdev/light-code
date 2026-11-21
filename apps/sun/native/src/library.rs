//! `library`: every skill and Python-tool file in a set of folders, read in one call, in parallel.
//!
//! Asked for after a chat took a minute and a half to load its skills and Python tools from the folders kept in step
//! with an S3 bucket: "it shouldnt take 1.5 mins!, please leverage the power of rust". The loaders read one file at a
//! time - a skill, then the next, then both copies again when a name is in two folders - and on a managed Windows
//! machine every open is scanned before it returns. Here the listing and every read happen at once, on a pool wider
//! than the machine's cores (the work is waiting on the disk and the scanner, not computing), and a file whose size and
//! modified time match what the caller already holds is not read at all - so a second load costs a listing.
//!
//! Read-only: lists folders and reads files, nothing else. Only the shapes the loaders look at are read: in a skills
//! folder `*.md` and a sub-folder's `SKILL.md` (any case); in a tools folder `*.py` and `.registry.json`.

use rayon::prelude::*;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Files over this are not returned whole; the loaders would not use a skill or tool that size anyway.
const MAX_FILE: u64 = 4 * 1024 * 1024;

struct Wanted {
    path: PathBuf,
}

fn listing(dir: &Path) -> Option<Vec<(String, bool)>> {
    let entries = fs::read_dir(dir).ok()?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push((name, is_dir));
    }
    out.sort();
    Some(out)
}

fn entries_json(entries: &[(String, bool)]) -> Value {
    Value::Array(entries.iter().map(|(name, is_dir)| json!({ "name": name, "dir": is_dir })).collect())
}

fn stamp(meta: &fs::Metadata) -> (f64, u64) {
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
    (mtime, meta.len())
}

pub fn run(r: &Value) -> Result<Value, String> {
    let roots = r.get("roots").and_then(Value::as_array).ok_or("roots is required")?;
    let known: Map<String, Value> = r.get("known").and_then(Value::as_object).cloned().unwrap_or_default();
    let roots: Vec<(PathBuf, String)> = roots
        .iter()
        .filter_map(|root| Some((PathBuf::from(root.get("dir")?.as_str()?), root.get("kind")?.as_str()?.to_string())))
        .collect();

    let pool = rayon::ThreadPoolBuilder::new().num_threads(32).build().map_err(|e| e.to_string())?;
    pool.install(|| {
        // 1. Every root listed at once; a skills root's sub-folders listed at once after that.
        let top: Vec<(PathBuf, String, Option<Vec<(String, bool)>>)> = roots.par_iter().map(|(dir, kind)| (dir.clone(), kind.clone(), listing(dir))).collect();
        let mut dirs = Map::new();
        let mut wanted: Vec<Wanted> = Vec::new();
        let mut sub_dirs: Vec<PathBuf> = Vec::new();
        for (dir, kind, entries) in &top {
            let key = dir.to_string_lossy().to_string();
            match entries {
                None => {
                    dirs.insert(key, json!({ "exists": false }));
                }
                Some(entries) => {
                    dirs.insert(key, json!({ "exists": true, "entries": entries_json(entries) }));
                    for (name, is_dir) in entries {
                        let lower = name.to_lowercase();
                        if kind == "skills" {
                            if *is_dir {
                                sub_dirs.push(dir.join(name));
                            } else if lower.ends_with(".md") {
                                wanted.push(Wanted { path: dir.join(name) });
                            }
                        } else if !*is_dir && (lower.ends_with(".py") || lower == ".registry.json") {
                            wanted.push(Wanted { path: dir.join(name) });
                        }
                    }
                }
            }
        }
        let inner: Vec<(PathBuf, Option<Vec<(String, bool)>>)> = sub_dirs.par_iter().map(|dir| (dir.clone(), listing(dir))).collect();
        for (dir, entries) in &inner {
            let key = dir.to_string_lossy().to_string();
            match entries {
                None => {
                    dirs.insert(key, json!({ "exists": false }));
                }
                Some(entries) => {
                    dirs.insert(key, json!({ "exists": true, "entries": entries_json(entries) }));
                    for (name, is_dir) in entries {
                        if !*is_dir && name.to_lowercase() == "skill.md" {
                            wanted.push(Wanted { path: dir.join(name) });
                        }
                    }
                }
            }
        }

        // 2. Every file at once: a stat, and the contents only when it changed since the caller's copy.
        let files: Vec<(String, Value)> = wanted
            .par_iter()
            .map(|want| {
                let key = want.path.to_string_lossy().to_string();
                let meta = match fs::metadata(&want.path) {
                    Ok(meta) => meta,
                    Err(e) => return (key, json!({ "error": e.to_string() })),
                };
                let (mtime, size) = stamp(&meta);
                let same = known.get(&key).and_then(Value::as_array).map(|pair| {
                    pair.first().and_then(Value::as_f64).map(|m| (m - mtime).abs() < 1.0).unwrap_or(false) && pair.get(1).and_then(Value::as_u64) == Some(size)
                });
                if same == Some(true) {
                    return (key, json!({ "mtimeMs": mtime, "size": size, "unchanged": true }));
                }
                if size > MAX_FILE {
                    return (key, json!({ "mtimeMs": mtime, "size": size, "error": "too large to load" }));
                }
                match fs::read(&want.path) {
                    Ok(bytes) => (key, json!({ "mtimeMs": mtime, "size": size, "text": String::from_utf8_lossy(&bytes) })),
                    Err(e) => (key, json!({ "mtimeMs": mtime, "size": size, "error": e.to_string() })),
                }
            })
            .collect();
        let mut out = Map::new();
        for (key, value) in files {
            out.insert(key, value);
        }
        Ok(json!({ "ok": true, "dirs": dirs, "files": out }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lc-library-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_skills_in_both_layouts_and_tools_with_their_registry() {
        let base = scratch("layouts");
        let skills = base.join("skills");
        let tools = base.join("tools");
        fs::create_dir_all(skills.join("deploy")).unwrap();
        fs::create_dir_all(&tools).unwrap();
        fs::write(skills.join("review.md"), "---\nname: review\ndescription: d\n---\nbody").unwrap();
        fs::write(skills.join("deploy").join("SKILL.md"), "---\ndescription: d\n---\nsteps").unwrap();
        fs::write(skills.join("deploy").join("template.xlsx"), "binary").unwrap();
        fs::write(tools.join("load.py"), "def run(): pass").unwrap();
        fs::write(tools.join(".registry.json"), "{}").unwrap();
        fs::write(tools.join("notes.txt"), "not a tool").unwrap();
        let answer = run(&json!({ "roots": [{ "dir": skills, "kind": "skills" }, { "dir": tools, "kind": "tools" }, { "dir": base.join("missing"), "kind": "skills" }] })).unwrap();
        let files = answer["files"].as_object().unwrap();
        let has = |p: PathBuf| files.contains_key(&p.to_string_lossy().to_string());
        assert!(has(skills.join("review.md")));
        assert!(has(skills.join("deploy").join("SKILL.md")));
        assert!(has(tools.join("load.py")));
        assert!(has(tools.join(".registry.json")));
        assert!(!has(skills.join("deploy").join("template.xlsx")));
        assert!(!has(tools.join("notes.txt")));
        assert_eq!(files[&skills.join("review.md").to_string_lossy().to_string()]["text"], "---\nname: review\ndescription: d\n---\nbody");
        assert_eq!(answer["dirs"][base.join("missing").to_string_lossy().to_string()]["exists"], false);
        assert_eq!(answer["dirs"][skills.join("deploy").to_string_lossy().to_string()]["exists"], true);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn does_not_read_a_file_the_caller_already_has() {
        let base = scratch("known");
        fs::write(base.join("a.py"), "x = 1").unwrap();
        let first = run(&json!({ "roots": [{ "dir": base, "kind": "tools" }] })).unwrap();
        let key = base.join("a.py").to_string_lossy().to_string();
        let entry = &first["files"][&key];
        let known = json!({ key.clone(): [entry["mtimeMs"], entry["size"]] });
        let second = run(&json!({ "roots": [{ "dir": base, "kind": "tools" }], "known": known })).unwrap();
        assert_eq!(second["files"][&key]["unchanged"], true);
        assert!(second["files"][&key].get("text").is_none());
        let _ = fs::remove_dir_all(&base);
    }
}
