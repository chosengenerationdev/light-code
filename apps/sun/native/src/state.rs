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

/// Where everything lives. `%LOCALAPPDATA%\sun-light-code`, because none of it should roam.
#[derive(Clone)]
pub struct Paths {
    pub root: PathBuf,
}

impl Paths {
    pub fn new() -> Paths {
        let base = std::env::var_os("SUN_LIGHT_CODE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("sun-light-code")))
            .unwrap_or_else(|| PathBuf::from(".sun-light-code"));
        Paths { root: base }
    }
    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }
    /// One file for every codebase, so a key is entered once. The host re-reads it when another
    /// process has changed it.
    pub fn secrets_file(&self) -> PathBuf {
        self.root.join("secrets.json")
    }
    pub fn project_dir(&self, id: &str) -> PathBuf {
        self.root.join("projects").join(id)
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

    pub fn project(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }
    pub fn project_mut(&mut self, id: &str) -> Option<&mut Project> {
        self.projects.iter_mut().find(|p| p.id == id)
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
