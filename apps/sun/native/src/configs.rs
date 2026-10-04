//! Existing Light Code settings Sun can point a codebase at, and what is in them that Sun cares about.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSource {
    pub label: String,
    pub path: String,
    pub detail: String,
}

/// Every Light Code `config.json` found on this machine, the likeliest first.
///
/// Only places Light Code itself writes: the VS Code extension's storage (stable and Insiders), the
/// Node host's data directory, and other codebases already in Sun. Nothing is guessed at beyond that;
/// any other file can still be chosen with the file picker.
pub fn find_sources(sun_projects: &[(String, String)]) -> Vec<ConfigSource> {
    let mut found = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        for (product, label) in [("Code", "VS Code"), ("Code - Insiders", "VS Code Insiders"), ("Cursor", "Cursor"), ("VSCodium", "VSCodium")] {
            let file = appdata
                .join(product)
                .join("User")
                .join("globalStorage")
                .join("chosengeneration.light-code-vscode")
                .join("config.json");
            if file.is_file() {
                found.push(ConfigSource {
                    label: format!("Light Code in {label}"),
                    detail: describe(&file),
                    path: file.to_string_lossy().into_owned(),
                });
            }
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let users = local.join("light-code").join("Data").join("users");
        if let Ok(entries) = fs::read_dir(&users) {
            for entry in entries.flatten() {
                let file = entry.path().join("config.json");
                if file.is_file() {
                    // The JetBrains plugin starts this same host with its default data folder,
                    // so IntelliJ and PyCharm settings are here too.
                    found.push(ConfigSource {
                        label: "Light Code in IntelliJ / PyCharm / Node host".into(),
                        detail: describe(&file),
                        path: file.to_string_lossy().into_owned(),
                    });
                }
            }
        }
    }
    for (name, file) in sun_projects {
        let path = Path::new(file);
        if path.is_file() && !found.iter().any(|s| same_path(&s.path, file)) {
            found.push(ConfigSource { label: format!("{name} (in Sun)"), detail: describe(path), path: file.clone() });
        }
    }
    found
}

pub fn same_path(a: &str, b: &str) -> bool {
    // Windows paths compare without case (CLAUDE.md §16).
    a.replace('/', "\\").trim_end_matches('\\').eq_ignore_ascii_case(b.replace('/', "\\").trim_end_matches('\\'))
}

/// One line saying what a config holds, so choosing between two is not a guess.
fn describe(file: &Path) -> String {
    let Ok(value) = read_json(file) else { return "could not be read".into() };
    let count = |key: &str| value.get(key).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let servers = value.get("mcpServers").and_then(|v| v.as_object()).map(|o| o.len()).unwrap_or(0);
    let mut parts = vec![plural(count("profiles"), "provider")];
    if servers > 0 {
        parts.push(plural(servers, "MCP server"));
    }
    if count("vectorStores") > 0 {
        parts.push(plural(count("vectorStores"), "search connection"));
    }
    let projects = value.get("workspaces").and_then(|v| v.as_object()).map(|o| o.len()).unwrap_or(0);
    if projects > 0 {
        parts.push(plural(projects, "project override"));
    }
    parts.join(", ")
}

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

fn read_json(file: &Path) -> Result<serde_json::Value, ()> {
    let text = fs::read_to_string(file).map_err(|_| ())?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| ())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentCodebase {
    pub name: String,
    pub path: String,
    pub from: String,
}

/// Folders recently opened in VS Code, IntelliJ IDEA or PyCharm, offered so adding one is a click.
///
/// Read from the editors' own recent lists and filtered to folders that still exist. Best effort by
/// design: a format that changes in a later editor version costs this list, never the dialog.
pub fn find_recent_codebases() -> Vec<RecentCodebase> {
    let mut found: Vec<RecentCodebase> = Vec::new();
    let mut push = |path: String, from: &str| {
        let clean = path.replace('/', "\\").trim_end_matches('\\').to_string();
        if clean.len() < 3 || !Path::new(&clean).is_dir() || found.iter().any(|r| same_path(&r.path, &clean)) {
            return;
        }
        let name = Path::new(&clean).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| clean.clone());
        found.push(RecentCodebase { name, path: clean, from: from.to_string() });
    };
    let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) else { return found };

    // Codebases Light Code has already been used in, newest chat first: the VS Code extension's task
    // index, and the Node host's (which the IntelliJ / PyCharm plugin also runs). These come first
    // because their settings and chat history are already there to be linked.
    let mut indexes: Vec<(PathBuf, &str)> = Vec::new();
    for product in ["Code", "Code - Insiders", "Cursor", "VSCodium"] {
        indexes.push((
            appdata.join(product).join("User").join("globalStorage").join("chosengeneration.light-code-vscode").join("tasks").join("index.json"),
            "Light Code in VS Code",
        ));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        if let Ok(users) = fs::read_dir(local.join("light-code").join("Data").join("users")) {
            for user in users.flatten() {
                indexes.push((user.path().join("tasks").join("index.json"), "Light Code (Node / JetBrains)"));
            }
        }
    }
    let mut used: Vec<(u64, String, &str)> = Vec::new();
    for (file, from) in &indexes {
        let Ok(value) = read_json(file) else { continue };
        for entry in value.as_array().into_iter().flatten() {
            if let Some(root) = entry.get("workspaceRoot").and_then(|v| v.as_str()) {
                let when = entry.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0);
                used.push((when, root.to_string(), from));
            }
        }
    }
    used.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, root, from) in used {
        push(root, from);
    }

    // JetBrains: %APPDATA%JetBrains<Product><version>optionsecentProjects.xml
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    if let Ok(products) = fs::read_dir(appdata.join("JetBrains")) {
        let mut dirs: Vec<_> = products.flatten().map(|e| e.path()).collect();
        dirs.sort();
        dirs.reverse(); // newest version first
        for dir in dirs {
            let product = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let from = if product.starts_with("PyCharm") {
                "PyCharm"
            } else if product.starts_with("IntelliJIdea") || product.starts_with("IdeaIC") {
                "IntelliJ IDEA"
            } else if product.starts_with("WebStorm") {
                "WebStorm"
            } else if product.starts_with("Rider") {
                "Rider"
            } else if product.starts_with("GoLand") {
                "GoLand"
            } else {
                continue;
            };
            let Ok(xml) = fs::read_to_string(dir.join("options").join("recentProjects.xml")) else { continue };
            for chunk in xml.split("<entry key=\"").skip(1) {
                if let Some(end) = chunk.find('"') {
                    push(chunk[..end].replace("$USER_HOME$", &home), from);
                }
            }
        }
    }

    // VS Code: the folders it associates with a profile, newest last in the file.
    for (product, from) in [("Code", "VS Code"), ("Code - Insiders", "VS Code Insiders")] {
        let file = appdata.join(product).join("User").join("globalStorage").join("storage.json");
        let Ok(value) = read_json(&file) else { continue };
        let mut uris: Vec<String> = Vec::new();
        if let Some(map) = value.pointer("/profileAssociations/workspaces").and_then(|v| v.as_object()) {
            uris.extend(map.keys().cloned());
        }
        if let Some(list) = value.pointer("/backupWorkspaces/folders").and_then(|v| v.as_array()) {
            uris.extend(list.iter().filter_map(|f| f.get("folderUri").and_then(|u| u.as_str()).map(String::from)));
        }
        for uri in uris.into_iter().rev() {
            if let Some(path) = file_uri_to_path(&uri) {
                push(path, from);
            }
        }
    }
    found.truncate(40);
    found
}

/// `file:///d%3A/Work/app` to `d:Workapp`. Anything else (remote, WSL) is not a local folder.
fn file_uri_to_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file:///")?;
    let mut out = Vec::new();
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A codebase's schedules as Sun's timer needs them: how many are on here, and when the soonest
/// is due. Read from the file, because a sleeping host cannot be asked.
#[derive(Debug, Default, PartialEq)]
pub struct ScheduleState {
    pub enabled: usize,
    /// Milliseconds since the epoch; the soonest `nextRunAt` of an enabled schedule here.
    pub next_due: Option<u64>,
    /// An enabled schedule with no `nextRunAt` yet: only a running host arms it.
    pub unarmed: bool,
    /// The file could not be read - treated as "keep it awake", which only costs memory.
    pub unreadable: bool,
}

/// `schedules` is an object keyed by id in Light Code's config. Sun once read it as a list, so it
/// never saw a schedule and put codebases holding them to sleep - where they never ran.
pub fn schedule_state(config_file: &str, workspace: &str) -> ScheduleState {
    let Ok(value) = read_json(Path::new(config_file)) else {
        return ScheduleState { unreadable: Path::new(config_file).exists(), ..Default::default() };
    };
    let entries: Vec<&serde_json::Value> = match value.get("schedules") {
        Some(serde_json::Value::Object(map)) => map.values().collect(),
        Some(serde_json::Value::Array(list)) => list.iter().collect(),
        _ => Vec::new(),
    };
    let mut state = ScheduleState::default();
    for s in entries {
        let enabled = s.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        let here = match s.get("workspaceRoot").and_then(|v| v.as_str()) {
            None => true,
            Some(root) => same_path(root, workspace),
        };
        if !(enabled && here) {
            continue;
        }
        state.enabled += 1;
        match s.get("nextRunAt").and_then(|v| v.as_f64()) {
            Some(at) => state.next_due = Some(state.next_due.map_or(at as u64, |d| d.min(at as u64))),
            None => state.unarmed = true,
        }
    }
    state
}

/// A scheduled run in progress somewhere under this folder: its claim file, written when a due run
/// starts and removed when it ends. A claim older than an hour is a crashed run, as the host treats it.
pub fn schedule_running(dir: &Path) -> bool {
    fn walk(dir: &Path, depth: usize) -> bool {
        let Ok(entries) = fs::read_dir(dir) else { return false };
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if entry.file_name() == "schedule-claims" {
                let fresh = fs::read_dir(&path).into_iter().flatten().flatten().any(|claim| {
                    claim.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|age| age.as_secs() < 3600).unwrap_or(false)
                });
                if fresh {
                    return true;
                }
            } else if depth < 5 && !matches!(entry.file_name().to_string_lossy().as_ref(), "webview" | "tasks" | "tool-results" | "checkpoints") {
                if walk(&path, depth + 1) {
                    return true;
                }
            }
        }
        false
    }
    walk(dir, 0)
}

/// The codebase's own `.lightcode/config.json`, which every host reads whatever Sun is told.
pub fn has_workspace_config(folder: &str) -> bool {
    Path::new(folder).join(".lightcode").join("config.json").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sun-test-{}-{}", std::process::id(), name));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        fs::write(&file, body).unwrap();
        file
    }

    /// The shape Light Code writes: an object keyed by schedule id.
    #[test]
    fn reads_schedules_as_light_code_stores_them() {
        let f = temp(
            "keyed",
            r#"{"schedules":{
                "a":{"enabled":true,"nextRunAt":1900000000000},
                "b":{"enabled":true,"nextRunAt":1800000000000,"workspaceRoot":"d:/Mine/"},
                "c":{"enabled":true,"nextRunAt":1700000000000,"workspaceRoot":"C:\\other"},
                "d":{"enabled":false,"nextRunAt":1600000000000}
            }}"#,
        );
        let s = schedule_state(f.to_str().unwrap(), "D:\\mine");
        assert_eq!(s.enabled, 2, "another project's and a disabled one do not count");
        assert_eq!(s.next_due, Some(1_800_000_000_000), "the soonest of this project's");
        assert!(!s.unarmed && !s.unreadable);
    }

    #[test]
    fn an_unarmed_schedule_needs_its_host_once() {
        let f = temp("unarmed", r#"{"schedules":{"a":{"enabled":true}}}"#);
        assert!(schedule_state(f.to_str().unwrap(), "D:\\mine").unarmed);
    }

    #[test]
    fn nothing_scheduled_and_unreadable_files() {
        let none = temp("none", r#"{"profiles":[]}"#);
        assert_eq!(schedule_state(none.to_str().unwrap(), "D:\\mine"), ScheduleState::default());
        let bad = temp("bad", "{not json");
        assert!(schedule_state(bad.to_str().unwrap(), "D:\\mine").unreadable, "doubt keeps it awake");
    }

    #[test]
    fn a_claim_file_means_a_run_is_going() {
        let dir = std::env::temp_dir().join(format!("sun-claims-{}", std::process::id()));
        let claims = dir.join("users").join("local").join("schedule-claims");
        fs::create_dir_all(&claims).unwrap();
        assert!(!schedule_running(&dir));
        fs::write(claims.join("nightly.json"), "{}").unwrap();
        assert!(schedule_running(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_a_vs_code_folder_uri() {
        assert_eq!(file_uri_to_path("file:///d%3A/Work/my%20app").as_deref(), Some("d:/Work/my app"));
        assert_eq!(file_uri_to_path("vscode-remote://wsl/home"), None);
    }

    #[test]
    fn describes_what_a_config_holds() {
        let f = temp("describe", r#"{"profiles":[{},{}],"mcpServers":{"a":{}}}"#);
        assert_eq!(describe(&f), "2 providers, 1 MCP server");
    }
}

/// Keys kept by the Light Code Node host - which the IntelliJ / PyCharm plugin runs - as
/// (secret-storage key, label, value), for importing into Sun's vault.
///
/// That host keeps them in a plain file readable by this Windows account (`secrets.json` beside its
/// `config.json`), so unlike VS Code's storage they can be read directly. Only keys a config refers to
/// are taken, labelled by the setting that refers to them; pointers to credentials and to a
/// credential tool are references, not keys, and are skipped. A vault-sealed file (Sun's own format)
/// is skipped too.
pub fn node_host_keys() -> Vec<(String, String, String)> {
    let mut found: Vec<(String, String, String)> = Vec::new();
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else { return found };
    let Ok(users) = fs::read_dir(local.join("light-code").join("Data").join("users")) else { return found };
    for user in users.flatten() {
        let Ok(secrets) = read_json(&user.path().join("secrets.json")) else { continue };
        if secrets.get("sunVault").is_some() {
            continue;
        }
        let config = read_json(&user.path().join("config.json")).unwrap_or(serde_json::Value::Null);
        for (key, label) in secret_slots(&config) {
            let Some(value) = secrets.get(&key).and_then(|v| v.as_str()) else { continue };
            if value.is_empty() || value.starts_with("credential:") || value.starts_with("tool:") || found.iter().any(|f| f.0 == key) {
                continue;
            }
            found.push((key, label, value.to_string()));
        }
    }
    found
}

/// Every secret-storage key a config names, labelled - the Rust twin of `secretSlots` in core.
fn secret_slots(config: &serde_json::Value) -> Vec<(String, String)> {
    fn words(field: &str) -> String {
        match field {
            "apiKeyRef" => "API key".into(),
            "clientSecretRef" => "client secret".into(),
            "passphraseRef" => "key passphrase".into(),
            "passwordRef" => "password".into(),
            "usernameRef" => "username".into(),
            "tokenRef" => "token".into(),
            "secretAccessKeyRef" => "secret access key".into(),
            "sessionTokenRef" => "session token".into(),
            "valueRef" => "header value".into(),
            other => other.trim_end_matches("Ref").to_string(),
        }
    }
    fn section(part: &str) -> Option<&'static str> {
        Some(match part {
            "confluence" => "Confluence",
            "jira" => "Jira",
            "bitbucket" => "Bitbucket",
            "jenkins" => "Jenkins",
            "autosys" => "AutoSys",
            "tls" => "Global client key",
            "vectorStores" => "Search connection",
            "s3" => "S3",
            _ => return None,
        })
    }
    fn walk(value: &serde_json::Value, path: &mut Vec<String>, owner: Option<String>, out: &mut Vec<(String, String)>) {
        match value {
            serde_json::Value::Array(items) => items.iter().for_each(|i| walk(i, path, owner.clone(), out)),
            serde_json::Value::Object(map) => {
                let named = ["label", "name"]
                    .iter()
                    .find_map(|k| map.get(*k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from));
                let here = named.or(owner);
                for (field, child) in map {
                    if let (Some(text), true) = (child.as_str(), field.ends_with("Ref")) {
                        if !text.is_empty() && !text.starts_with("env:") {
                            let who = here
                                .clone()
                                .or_else(|| path.iter().find_map(|p| section(p)).map(String::from))
                                .unwrap_or_else(|| path.last().cloned().unwrap_or_else(|| "Setting".into()));
                            out.push((text.to_string(), format!("{who}: {}", words(field))));
                        }
                    } else if path.is_empty() && field == "mcpServers" {
                        if let Some(servers) = child.as_object() {
                            for (server, entry) in servers {
                                let text = entry.to_string();
                                for piece in text.split("${secret:").skip(1) {
                                    if let Some(end) = piece.find('}') {
                                        out.push((piece[..end].to_string(), format!("MCP server {server}: {}", &piece[..end])));
                                    }
                                }
                            }
                        }
                    } else {
                        if path.is_empty() && field == "python" {
                            if let Some(env) = child.get("env").and_then(|e| e.as_object()) {
                                for (name, entry) in env {
                                    if entry.get("secret").and_then(|s| s.as_bool()) == Some(true) {
                                        out.push((format!("python:env:{name}"), format!("Python variable {name}")));
                                    }
                                }
                            }
                        }
                        path.push(field.clone());
                        walk(child, path, here.clone(), out);
                        path.pop();
                    }
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(config, &mut Vec::new(), None, &mut out);
    out
}

#[cfg(test)]
mod slot_tests {
    use super::secret_slots;

    #[test]
    fn labels_the_keys_a_config_names() {
        let config = serde_json::json!({
            "profiles": [{ "label": "DeepSeek", "auth": { "type": "apiKey", "apiKeyRef": "profile:ds:apiKey" } }],
            "jira": { "tokenRef": "jira:token" },
            "python": { "env": { "DB_PASSWORD": { "secret": true } } },
            "mcpServers": { "github": { "env": { "TOKEN": "${secret:gh}" } } }
        });
        let slots = secret_slots(&config);
        assert!(slots.contains(&("profile:ds:apiKey".into(), "DeepSeek: API key".into())));
        assert!(slots.contains(&("jira:token".into(), "Jira: token".into())));
        assert!(slots.contains(&("python:env:DB_PASSWORD".into(), "Python variable DB_PASSWORD".into())));
        assert!(slots.contains(&("gh".into(), "MCP server github: gh".into())));
    }
}
