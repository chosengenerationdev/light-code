//! What Sun remembers between runs: the codebases, how each finds its settings, and the window.
//!
//! One JSON file, written to a sibling and renamed so a crash mid-write leaves the old file rather
//! than half of a new one. The same rule the Node host follows for `config.json` (CLAUDE.md §15),
//! learnt there from a real corruption.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// How a codebase finds its Light Code settings.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ConfigMode {
    /// Its own settings file, empty to begin with.
    New,
    /// An existing `config.json` used in place - the VS Code extension's, say - so edits made in
    /// either app reach the other.
    Link,
    /// A copy of an existing file, taken when the codebase was added. Independent afterwards.
    Copy,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub config_mode: ConfigMode,
    /// The `config.json` the host is given. For `Link` it is the source itself; otherwise it is
    /// inside this codebase's data folder.
    pub config_file: String,
    /// What it was linked to or copied from, for the settings dialog to say.
    #[serde(default)]
    pub config_source: Option<String>,
    #[serde(default)]
    pub keep_awake: bool,
    #[serde(default)]
    pub last_used: u64,
    /// An accent chosen for this codebase in its own Appearance tab; Sun's when absent. Kept here,
    /// not in the config file, which may be linked to VS Code's.
    #[serde(default)]
    pub accent: Option<String>,
    /// Chats beyond the first, each its own agent on the same folder, settings and keys. The first
    /// chat is the codebase itself (runtime key = project id); these are `<id>~<chat id>`.
    #[serde(default)]
    pub chats: Vec<Chat>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: u32,
    pub name: String,
}

/// The codebase a runtime key belongs to: `abc` and `abc~2` are both codebase `abc`.
pub fn project_of(key: &str) -> &str {
    key.split('~').next().unwrap_or(key)
}

/// The chat part of a runtime key, for the extra chats; None for a codebase's first chat.
pub fn chat_of(key: &str) -> Option<&str> {
    key.split_once('~').map(|(_, chat)| chat)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Minutes an idle codebase stays awake. 0 means never sleep.
    pub sleep_minutes: u32,
    pub sidebar_hidden: bool,
    pub sidebar_width: u32,
    pub last_project: Option<String>,
    /// Start the most recently used codebases at launch, so they are ready before they are clicked.
    pub start_recent: bool,
    /// Windows notifications when a background agent finishes or needs you.
    pub notifications: bool,
    /// system, light or dark. Every codebase's chat pane follows it.
    pub theme: String,
    /// The accent colour, #rrggbb. Every pane follows it too; role colours stay each pane's own.
    pub accent: String,
    /// Let each codebase's assistant read any drive or share and write anywhere, asking every time
    /// it writes outside the codebase. On by default; the floor in core's `fs/reach.ts` always holds.
    pub reach_anywhere: bool,
    /// Folders put in front of PATH for every agent Sun starts, first one first. `%NAME%` expands.
    pub path_prefix: Vec<String>,
    /// Variables every agent Sun starts is given; a value may come from a saved credential.
    pub env: Vec<crate::environment::EnvVar>,
    /// A .cmd, .bat or .ps1 run when Sun starts; the environment it leaves is given to every agent.
    pub startup_script: Option<String>,
    pub window: Option<WindowBounds>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            sleep_minutes: 30,
            sidebar_hidden: false,
            sidebar_width: 264,
            last_project: None,
            start_recent: true,
            notifications: true,
            theme: "system".into(),
            accent: "#f26b1d".into(),
            reach_anywhere: true,
            path_prefix: Vec::new(),
            env: Vec::new(),
            startup_script: None,
            window: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub projects: Vec<Project>,
    pub settings: Settings,
}

/// Where everything lives. `%LOCALAPPDATA%\sun-code`, because none of it should roam.
#[derive(Clone)]
pub struct Paths {
    pub root: PathBuf,
}

impl Paths {
    pub fn new() -> Paths {
        if let Some(home) = std::env::var_os("SUN_CODE_HOME") {
            return Paths { root: PathBuf::from(home) };
        }
        let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
            return Paths { root: PathBuf::from(".sun-code") };
        };
        let root = local.join("sun-code");
        let old = local.join("sun-light-code");
        // Sun Code was Sun Light Code until 0.5.0. Its folder moves across once, keeping the vault,
        // the codebases and their chats. If the move cannot happen - the old app is still open -
        // the old folder is used where it is, and the move is tried again next launch.
        if !root.exists() && old.join("state.json").is_file() && std::fs::rename(&old, &root).is_err() {
            return Paths { root: old };
        }
        Paths { root }
    }

    /// The folder this data lived in under the old name, for rewriting paths saved inside it.
    pub fn previous_root(&self) -> Option<PathBuf> {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
        (self.root == local.join("sun-code")).then(|| local.join("sun-light-code"))
    }
    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }
    /// One file for every codebase, so a key is entered once. The host re-reads it when another
    /// process has changed it.
    pub fn secrets_file(&self) -> PathBuf {
        self.root.join("secrets.json")
    }
    /// A codebase's data folder; an extra chat keeps its history in a folder of its own inside it.
    pub fn project_dir(&self, key: &str) -> PathBuf {
        let base = self.root.join("projects").join(project_of(key));
        match chat_of(key) {
            Some(chat) => base.join("chats").join(chat),
            None => base,
        }
    }
    pub fn webview_dir(&self) -> PathBuf {
        self.root.join("webview")
    }
    pub fn log_file(&self, id: &str) -> PathBuf {
        self.project_dir(id).join("host.log")
    }
}

impl State {
    pub fn load(paths: &Paths) -> State {
        let file = paths.state_file();
        match fs::read_to_string(&file) {
            Ok(text) => match serde_json::from_str::<State>(&text) {
                Ok(state) => state,
                Err(_) => {
                    // Kept aside rather than overwritten: it is the user's list of codebases, and a
                    // bad file is something to look at, not to lose.
                    let _ = fs::rename(&file, file.with_extension("json.damaged"));
                    State::default()
                }
            },
            Err(_) => State::default(),
        }
    }

    /// Settings files kept in the data folder were saved with its old path; after the folder moved
    /// they are found under the new one. True when something changed.
    pub fn rebase(&mut self, old: &Path, new: &Path) -> bool {
        let old_text = old.to_string_lossy().to_string();
        let mut changed = false;
        for p in &mut self.projects {
            let n = old_text.len();
            let under = p.config_file.len() > n
                && p.config_file.is_char_boundary(n)
                && p.config_file[..n].eq_ignore_ascii_case(&old_text)
                && p.config_file[n..].starts_with(['\\', '/']);
            if under {
                p.config_file = format!("{}{}", new.to_string_lossy(), &p.config_file[n..]);
                changed = true;
            }
        }
        changed
    }

    pub fn save(&self, paths: &Paths) {
        let file = paths.state_file();
        if let Some(parent) = file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let Ok(text) = serde_json::to_string_pretty(self) else { return };
        let temp = file.with_extension("json.tmp");
        if fs::write(&temp, text).is_ok() {
            replace_file(&temp, &file);
        }
    }

    /// The codebase for a project id or a chat's runtime key.
    pub fn project(&self, key: &str) -> Option<&Project> {
        let id = project_of(key);
        self.projects.iter().find(|p| p.id == id)
    }
    pub fn project_mut(&mut self, key: &str) -> Option<&mut Project> {
        let id = project_of(key);
        self.projects.iter_mut().find(|p| p.id == id)
    }
    /// Whether this runtime key names a chat that exists: the codebase itself, or one of its chats.
    pub fn has_chat(&self, key: &str) -> bool {
        match (self.project(key), chat_of(key)) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some(p), Some(chat)) => p.chats.iter().any(|c| c.id.to_string() == chat),
        }
    }
    /// Every runtime key of a codebase: its first chat, then the others.
    pub fn chat_keys(&self, id: &str) -> Vec<String> {
        match self.project(id) {
            None => Vec::new(),
            Some(p) => std::iter::once(p.id.clone()).chain(p.chats.iter().map(|c| format!("{}~{}", p.id, c.id))).collect(),
        }
    }
    /// A notification's title: the codebase, and the chat when it is not the first.
    pub fn chat_title(&self, key: &str) -> Option<String> {
        let p = self.project(key)?;
        Some(match chat_of(key).and_then(|chat| p.chats.iter().find(|c| c.id.to_string() == chat)) {
            Some(c) => format!("{} · {}", p.name, c.name),
            None => p.name.clone(),
        })
    }
}

/// Rename over the target, retrying briefly. Windows refuses a rename over a file another program
/// has open for that moment (antivirus, an indexer), which `replaceFile` in core answers the same way.
fn replace_file(from: &Path, to: &Path) {
    for _ in 0..30 {
        if fs::rename(from, to).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = fs::remove_file(from);
}

pub fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A short id that sorts by creation and never repeats on one machine.
pub fn new_id() -> String {
    format!("p{:x}{:04x}", now_millis(), std::process::id() as u16 ^ (now_millis() as u16).rotate_left(7))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str, chats: &[u32]) -> Project {
        Project {
            id: id.into(),
            name: "Payments".into(),
            path: "D:/work/payments".into(),
            config_mode: ConfigMode::New,
            config_file: "config.json".into(),
            config_source: None,
            keep_awake: false,
            last_used: 0,
            accent: None,
            chats: chats.iter().map(|&n| Chat { id: n, name: format!("Chat {n}") }).collect(),
        }
    }

    #[test]
    fn a_chat_key_names_its_codebase_and_its_own_folder() {
        assert_eq!(project_of("abc~3"), "abc");
        assert_eq!(project_of("abc"), "abc");
        assert_eq!(chat_of("abc"), None);
        let paths = Paths { root: PathBuf::from("R") };
        assert_eq!(paths.project_dir("abc"), PathBuf::from("R").join("projects").join("abc"));
        assert_eq!(paths.project_dir("abc~3"), PathBuf::from("R").join("projects").join("abc").join("chats").join("3"));
    }

    #[test]
    fn only_chats_that_exist_are_chats() {
        let state = State { projects: vec![project("abc", &[2, 3])], settings: Settings::default() };
        assert!(state.has_chat("abc"));
        assert!(state.has_chat("abc~3"));
        assert!(!state.has_chat("abc~4"));
        assert!(!state.has_chat("zzz"));
        assert_eq!(state.chat_keys("abc"), vec!["abc", "abc~2", "abc~3"]);
        assert_eq!(state.chat_title("abc~2").as_deref(), Some("Payments · Chat 2"));
        assert_eq!(state.chat_title("abc").as_deref(), Some("Payments"));
    }

    #[test]
    fn settings_files_follow_the_data_folder_when_it_moves() {
        let mut p = project("abc", &[]);
        p.config_file = r"C:\Users\a\AppData\Local\Sun-Light-Code\projects\abc\config.json".into();
        let mut linked = project("def", &[]);
        linked.config_file = r"C:\Users\a\AppData\Roaming\Code\config.json".into();
        let mut lookalike = project("ghi", &[]);
        lookalike.config_file = r"C:\Users\a\AppData\Local\sun-light-code-old\config.json".into();
        let mut state = State { projects: vec![p, linked, lookalike], settings: Settings::default() };
        let old = PathBuf::from(r"C:\Users\a\AppData\Local\sun-light-code");
        let new = PathBuf::from(r"C:\Users\a\AppData\Local\sun-code");
        assert!(state.rebase(&old, &new));
        assert_eq!(state.projects[0].config_file, r"C:\Users\a\AppData\Local\sun-code\projects\abc\config.json");
        assert_eq!(state.projects[1].config_file, r"C:\Users\a\AppData\Roaming\Code\config.json");
        assert_eq!(state.projects[2].config_file, r"C:\Users\a\AppData\Local\sun-light-code-old\config.json");
        assert!(!state.rebase(&old, &new));
    }

    #[test]
    fn a_saved_project_without_chats_still_loads() {
        let json = r#"{"id":"abc","name":"P","path":"D:/p","configMode":"new","configFile":"c.json"}"#;
        let p: Project = serde_json::from_str(json).unwrap();
        assert!(p.chats.is_empty());
    }
}
