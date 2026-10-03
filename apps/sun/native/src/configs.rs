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

/// Whether this codebase has a schedule that could fire. Such a codebase is never put to sleep:
/// schedules run inside its host, and a sleeping host would silently miss them.
///
/// Read from the file rather than asked of the host, because a sleeping host cannot be asked. Any
/// doubt - an unreadable file - answers yes, which only costs memory.
pub fn has_active_schedules(config_file: &str, workspace: &str) -> bool {
    let Ok(value) = read_json(Path::new(config_file)) else {
        return Path::new(config_file).exists();
    };
    let Some(schedules) = value.get("schedules").and_then(|v| v.as_array()) else { return false };
    schedules.iter().any(|s| {
        let enabled = s.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        let here = match s.get("workspaceRoot").and_then(|v| v.as_str()) {
            None => true,
            Some(root) => same_path(root, workspace),
        };
        enabled && here
    })
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

    #[test]
    fn schedules_for_another_project_do_not_keep_this_one_awake() {
        let f = temp("other", r#"{"schedules":[{"enabled":true,"workspaceRoot":"C:\\other"}]}"#);
        assert!(!has_active_schedules(f.to_str().unwrap(), "D:\\mine"));
    }

    #[test]
    fn an_enabled_schedule_here_or_anywhere_keeps_it_awake() {
        let here = temp("here", r#"{"schedules":[{"enabled":true,"workspaceRoot":"d:/Mine/"}]}"#);
        assert!(has_active_schedules(here.to_str().unwrap(), "D:\\mine"));
        let anywhere = temp("anywhere", r#"{"schedules":[{"enabled":true}]}"#);
        assert!(has_active_schedules(anywhere.to_str().unwrap(), "D:\\mine"));
    }

    #[test]
    fn a_disabled_schedule_does_not() {
        let f = temp("off", r#"{"schedules":[{"enabled":false}]}"#);
        assert!(!has_active_schedules(f.to_str().unwrap(), "D:\\mine"));
    }

    #[test]
    fn an_unreadable_config_errs_towards_staying_awake() {
        let f = temp("bad", "{not json");
        assert!(has_active_schedules(f.to_str().unwrap(), "D:\\mine"));
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
