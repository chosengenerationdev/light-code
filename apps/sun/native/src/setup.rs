//! Moving a Fire Code setup to another computer (asked for: "export project setup - codebases and
//! opened chats with their names - which I can import on my other machine, pointing the codebases at
//! the right folders; a JupyterHub codebase can stay the same").
//!
//! One JSON file: every codebase with its name, folder, open chats by name, accent and, when asked
//! for, its Light Code settings. **No secrets travel**: a Light Code config holds only references to
//! secrets (CLAUDE.md §15), and a JupyterHub token is named by its credential's label - credentials
//! move with Settings → Credentials → Export, which is encrypted under a passphrase. Conversations do
//! not travel either; the chats arrive empty under their names.
//!
//! Folders differ between computers, so the import shows each one and lets it be changed before
//! anything is added; a codebase whose folder is already in Fire Code is left alone.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state::{Project, State};

pub const FORMAT: &str = "fire-code-setup";
pub const VERSION: u32 = 1;
/// Bounds on a file from anywhere: more than this is not a setup somebody exported.
const MAX_CODEBASES: usize = 500;
const MAX_CHATS: usize = 100;
const MAX_NAME: usize = 120;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetupFile {
    pub format: String,
    pub version: u32,
    #[serde(default)]
    pub exported_at: u64,
    pub codebases: Vec<SetupCodebase>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetupCodebase {
    pub name: String,
    /// The folder on the computer it came from. For a JupyterHub codebase, empty: its local copy is
    /// made by Fire Code wherever it is imported.
    #[serde(default)]
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub: Option<SetupHub>,
    /// Every open chat's name, the first chat first.
    #[serde(default)]
    pub chats: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(default)]
    pub keep_awake: bool,
    /// Its Light Code settings (`config.json`), when the export included them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetupHub {
    pub url: String,
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    pub folders: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel: Option<String>,
    /// The label of the credential holding the token here - never the token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_label: Option<String>,
}

/// The names of a codebase's open chats, the first chat first, as its tabs show them.
pub fn chat_names(p: &Project) -> Vec<String> {
    let mut names = vec![p.first_chat_name.clone().unwrap_or_else(|| "Chat 1".to_string())];
    names.extend(p.chats.iter().map(|c| c.name.clone()));
    names
}

/// The setup as a file. `label_of` names a credential by id; `settings_of` reads a codebase's config.
pub fn export(
    state: &State,
    now: u64,
    label_of: impl Fn(&str) -> Option<String>,
    settings_of: impl Fn(&Project) -> Option<Value>,
) -> SetupFile {
    let codebases = state
        .projects
        .iter()
        .map(|p| SetupCodebase {
            name: p.name.clone(),
            path: if p.hub.is_some() { String::new() } else { p.path.clone() },
            hub: p.hub.as_ref().map(|h| SetupHub {
                url: h.url.clone(),
                user: h.user.clone(),
                server: h.server.clone(),
                folders: h.folders.clone(),
                kernel: h.kernel.clone(),
                credential_label: h.credential.as_deref().and_then(&label_of),
            }),
            chats: chat_names(p),
            accent: p.accent.clone(),
            keep_awake: p.keep_awake,
            settings: settings_of(p),
        })
        .collect();
    SetupFile { format: FORMAT.into(), version: VERSION, exported_at: now, codebases }
}

/// Reads and checks a setup file. Every name is trimmed and bounded; a chat list that is empty gets
/// its one first chat. A settings value that is not a JSON object is dropped, not refused.
pub fn parse(text: &str) -> Result<SetupFile, String> {
    let mut file: SetupFile = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("This is not a Fire Code setup file ({e})."))?;
    if file.format != FORMAT {
        return Err("This is not a Fire Code setup file. Export one from Settings → Setup on the other computer.".into());
    }
    if file.version > VERSION {
        return Err(format!("This setup file was made by a newer Fire Code (format {}). Update Fire Code here first.", file.version));
    }
    if file.codebases.is_empty() {
        return Err("This setup file lists no codebases.".into());
    }
    if file.codebases.len() > MAX_CODEBASES {
        return Err(format!("This setup file lists {} codebases; at most {MAX_CODEBASES} can be imported.", file.codebases.len()));
    }
    for c in &mut file.codebases {
        c.name = bounded(&c.name);
        if c.name.is_empty() {
            c.name = "Codebase".into();
        }
        c.chats = c.chats.iter().map(|n| bounded(n)).filter(|n| !n.is_empty()).take(MAX_CHATS).collect();
        if c.chats.is_empty() {
            c.chats.push("Chat 1".into());
        }
        if c.settings.as_ref().map(|s| !s.is_object()).unwrap_or(false) {
            c.settings = None;
        }
        if c.accent.as_ref().map(|a| !is_hex(a)).unwrap_or(false) {
            c.accent = None;
        }
    }
    Ok(file)
}

fn bounded(text: &str) -> String {
    text.trim().chars().filter(|c| !c.is_control()).take(MAX_NAME).collect()
}

fn is_hex(text: &str) -> bool {
    text.len() == 7 && text.starts_with('#') && text[1..].chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{Chat, ConfigMode, Settings};

    fn project(name: &str, path: &str) -> Project {
        Project {
            id: format!("id-{name}"),
            name: name.into(),
            path: path.into(),
            config_mode: ConfigMode::New,
            config_file: format!("C:/data/{name}/config.json"),
            config_source: None,
            keep_awake: false,
            last_used: 0,
            accent: Some("#16a34a".into()),
            chats: vec![Chat { id: 2, name: "Review".into(), folder: None, branch: None }],
            first_chat_name: Some("Main".into()),
            hub: None,
            archived: Vec::new(),
            last_chat: 2,
        }
    }

    #[test]
    fn exports_codebases_chats_and_settings_but_no_token() {
        let mut hub = project("hubbed", "C:/data-hub/x");
        hub.hub = Some(crate::hub::HubSettings {
            url: "https://hub.example".into(),
            user: "me".into(),
            server: None,
            folders: vec!["work".into()],
            kernel: None,
            credential: Some("cred-1".into()),
        });
        let state = State { projects: vec![project("api", "D:/code/api"), hub], settings: Settings::default() };
        let file = export(&state, 5, |id| (id == "cred-1").then(|| "JupyterHub me@hub".to_string()), |p| {
            (p.name == "api").then(|| serde_json::json!({ "profiles": [] }))
        });
        let text = serde_json::to_string(&file).unwrap();
        assert!(!text.contains("cred-1"), "a credential id is this computer's, never exported");
        let back = parse(&text).unwrap();
        assert_eq!(back.codebases[0].chats, vec!["Main", "Review"]);
        assert_eq!(back.codebases[0].path, "D:/code/api");
        assert!(back.codebases[0].settings.is_some());
        assert_eq!(back.codebases[1].path, "", "a hub codebase's local copy is made where it is imported");
        assert_eq!(back.codebases[1].hub.as_ref().unwrap().credential_label.as_deref(), Some("JupyterHub me@hub"));
    }

    #[test]
    fn refuses_other_files_and_tidies_what_it_reads() {
        assert!(parse("{}").is_err());
        assert!(parse(r#"{"format":"something-else","version":1,"codebases":[]}"#).is_err());
        assert!(parse(r#"{"format":"fire-code-setup","version":99,"codebases":[{"name":"a"}]}"#).unwrap_err().contains("newer"));
        let file = parse(r##"{"format":"fire-code-setup","version":1,"codebases":[{"name":"  a  ","path":"D:/a","chats":["", "  x "],"accent":"red","settings":[1]}]}"##).unwrap();
        let c = &file.codebases[0];
        assert_eq!(c.name, "a");
        assert_eq!(c.chats, vec!["x"]);
        assert!(c.accent.is_none() && c.settings.is_none());
        let empty = parse(r#"{"format":"fire-code-setup","version":1,"codebases":[{"name":"b","chats":[]}]}"#).unwrap();
        assert_eq!(empty.codebases[0].chats, vec!["Chat 1"]);
    }
}
