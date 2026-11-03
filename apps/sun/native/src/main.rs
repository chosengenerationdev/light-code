//! Fire Code: several codebases, each with its own Light Code agent, in one Windows window.
//!
//! The window is a WebView2 page (`ui/`) holding a sidebar and one frame per codebase. Each frame
//! is the ordinary Light Code browser UI, served by a Light Code Node host this process starts for
//! that codebase. So every tool and feature is the one the Node host already has, every agent runs
//! in its own process - truly in parallel, unaffected by which chat is on screen - and Fire Code itself is
//! only the window, the supervisor and the Windows integration.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod configs;
mod environment;
mod files;
mod branches;
mod git;
mod hub;
mod reports;
mod host;
mod monitor;
mod monitoring;
mod state;
mod system;
mod share;
mod vault;

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::IconExtWindows;
use tao::window::{Icon, Theme, Window, WindowBuilder};
use wry::http::{header, Request, Response, StatusCode};
use wry::{NewWindowResponse, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows};

use host::{HostEvent, HostProcess, LaunchSpec};
use state::{ConfigMode, Paths, Project, State};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// WebView2 options. Every webview sharing the data folder must be created with the same ones, or WebView2 refuses
/// the second - which is how a monitor's grid window once failed to open.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disk-cache-size=33554432";
/// What the page's own origin is on Windows, where wry maps `sun://` to `http://sun.localhost`.
const SHELL_ORIGIN: &str = "http://sun.localhost";

const INDEX_HTML: &str = include_str!("../ui/index.html");
const SHELL_CSS: &str = include_str!("../ui/shell.css");
const SHELL_JS: &str = include_str!("../ui/shell.js");
const MONITOR_HTML: &str = include_str!("../ui/monitor.html");
const MONITOR_CSS: &str = include_str!("../ui/monitor.css");
const MONITOR_JS: &str = include_str!("../ui/monitor.js");
const ICON_PNG: &[u8] = include_bytes!("../assets/icon-256.png");

enum UserEvent {
    Ipc(String),
    Host(HostEvent),
    Toast { id: String, action: Option<String> },
    Tick,
    StartLater(String),
    /// Open a codebase as if its row were clicked: the one last open, at launch.
    Select(String),
    /// Keys arrived from the VS Code extension: who sent them, and their names.
    Shared { from: String, labels: Vec<String> },
    /// The startup script finished: what it left, or why it did not.
    ScriptDone(Result<environment::ScriptEnv, String>),
    /// `git status` counts for some codebases, worked out off the UI thread.
    Git(Vec<(String, Option<git::GitCounts>)>),
    /// A commit-and-push or pull finished: which codebase, whether it worked, and what to say.
    GitDone { id: String, ok: bool, text: String },
    /// The Rust helper read a monitor's SQLite or file source: for the check or drill-down `id`.
    MonitorFetched { id: String, result: Result<Value, String> },
    /// A monitoring notification, or one of its buttons, was clicked.
    MonitorToast { name: String, action: Option<String> },
    /// A message from a monitor's grid window.
    GridIpc { window: tao::window::WindowId, body: String },
}

/// One monitor's grid, in a window of its own.
struct GridWindow {
    name: String,
    window: Window,
    webview: WebView,
}

/// Where the startup script is. Agents asked to start while it runs wait for it, so none starts
/// without the environment the script exists to provide.
enum ScriptState {
    None,
    Running,
    Done(environment::ScriptEnv),
    Failed(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Stopped,
    Starting,
    Running,
    Sleeping,
    Failed,
}

impl Phase {
    fn word(self) -> &'static str {
        match self {
            Phase::Stopped => "stopped",
            Phase::Starting => "starting",
            Phase::Running => "running",
            Phase::Sleeping => "sleeping",
            Phase::Failed => "failed",
        }
    }
}

struct Runtime {
    phase: Phase,
    /// What the agent itself is doing, as its page reports it: idle, busy or attention.
    agent: String,
    url: Option<String>,
    process: Option<HostProcess>,
    generation: u64,
    last_activity: Instant,
    error: Option<String>,
    memory: u64,
    /// Something happened here while it was not on screen.
    unread: bool,
    /// Started by Fire Code's schedule timer rather than by you: it goes back to sleep soon after the run.
    woke_for_schedule: bool,
    /// What the agent is waiting for you to do, while it waits: approval, form or question.
    waiting_for: Option<String>,
}

impl Runtime {
    fn new() -> Runtime {
        Runtime {
            phase: Phase::Stopped,
            agent: "idle".into(),
            url: None,
            process: None,
            generation: 0,
            last_activity: Instant::now(),
            error: None,
            memory: 0,
            unread: false,
            woke_for_schedule: false,
            waiting_for: None,
        }
    }
}

struct App {
    paths: Paths,
    state: State,
    runtime: HashMap<String, Runtime>,
    active: Option<String>,
    focused: bool,
    proxy: EventLoopProxy<UserEvent>,
    icon_file: PathBuf,
    ticks: u64,
    /// The launch-time start has run. Once: a reloaded page must not restart anything.
    launched: bool,
    vault: Arc<vault::Vault>,
    /// A credentials file being imported: its text, then what it held once opened. Never sent to
    /// the page - only names are.
    import_text: Option<String>,
    import_items: Option<Vec<vault::Portable>>,
    /// Keys found for the JetBrains import, held here until confirmed; only names reach the page.
    jetbrains_keys: Option<Vec<(String, String, String)>>,
    /// A problem with Fire Code's environment (a deleted credential) has been said; said again after a save.
    env_warned: bool,
    script: ScriptState,
    /// Chats waiting for the startup script before they start.
    waiting: Vec<String>,
    /// What git says has changed in each codebase, for the sidebar.
    git: HashMap<String, git::GitCounts>,
    /// One refresh at a time: a slow repository must not pile up processes behind it.
    git_busy: Arc<std::sync::atomic::AtomicBool>,
    monitoring: monitoring::Monitoring,
    /// The theme or accent changed: the grid windows follow it.
    appearance_changed: bool,
}

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Command {
    Ready,
    PickFolder,
    PickConfig,
    Sources,
    Add { path: String, name: String, mode: ConfigMode, source: Option<String> },
    /// A codebase that is folders on a JupyterHub server.
    AddHub { name: String, hub: hub::HubInput, mode: ConfigMode, source: Option<String> },
    UpdateHub { id: String, hub: hub::HubInput },
    Remove { id: String },
    Select { id: String },
    Start { id: String },
    Sleep { id: String },
    Restart { id: String },
    /// `reason`, when waiting: approval, form or question.
    AgentState { id: String, state: String, finished: bool, #[serde(default)] reason: Option<String> },
    Settings { patch: Value },
    KeepAwake { id: String, on: bool },
    Rename { id: String, name: String },
    Reorder { ids: Vec<String> },
    ChangeConfig { id: String, mode: ConfigMode, source: Option<String> },
    OpenVsCode { id: String },
    OpenExplorer { id: String },
    /// The codebase's own buttons: commit everything with this message and push; or pull.
    GitCommitPush { id: String, message: String },
    GitPull { id: String },
    OpenLog { id: String },
    OpenDataFolder,
    ExportSource,
    OpenExternal { url: String },
    /// The icon drawn in the chosen accent: raw RGBA for the window, a PNG for notifications.
    SetIcon { size: u32, rgba: String, png: String },
    /// A codebase's own accent, or None to follow Fire Code's again.
    ProjectAccent { id: String, accent: Option<String> },
    Credentials,
    /// Values travel page -> Rust only, and an empty one means "keep what is stored".
    SaveCredential { id: Option<String>, label: String, kind: String, note: Option<String>, values: BTreeMap<String, String> },
    DeleteCredential { id: String },
    ExportCredentials { ids: Vec<String>, passphrase: String },
    /// Choose a credentials file; its contents are only read once the passphrase arrives.
    ChooseCredentialImport,
    OpenCredentialImport { passphrase: String },
    ImportCredentials { indexes: Vec<usize> },
    /// Keys the IntelliJ / PyCharm plugin's Node host keeps: listed by name, imported on confirm.
    ScanJetBrains,
    ImportJetBrains { indexes: Vec<usize> },
    /// Fire Code's environment, validated as a whole: PATH folders and variables.
    #[serde(rename_all = "camelCase")]
    SaveEnvironment { path_prefix: Vec<String>, env: Vec<environment::EnvVar>, #[serde(default)] startup_script: Option<String> },
    /// A report in Fire Code's Markdown viewer: from a link inside another report, or the list.
    OpenReport { path: String },
    /// Every report a codebase's chats have written, newest first.
    Reports { id: String },
    /// The report in the app Windows associates with it, or selected in File Explorer.
    OpenReportExternally { path: String },
    RevealReport { path: String },
    /// Run the startup script again now, after editing it.
    RunScript,
    /// Choose the startup script file.
    PickScript,
    /// Which of these folders exist, for the page to mark the missing ones.
    #[serde(rename_all = "camelCase")]
    CheckFolders { path_prefix: Vec<String> },
    /// Choose a folder for a PATH entry; the answer names the row it was for.
    PickEnvFolder { index: usize },
    /// Every running agent stopped and started again, to take a new environment.
    RestartAll,
    /// Another chat on a codebase: its own agent, same folder, settings and keys. Blank, or an
    /// archived chat (`archived`, its number) brought back with its history.
    NewChat { id: String, #[serde(default)] archived: Option<u32> },
    /// Close an extra chat: its agent stops. `archive` keeps it (history in its folder, offered by
    /// New chat); false deletes its folder. Absent means archive - the choice that loses nothing.
    CloseChat { id: String, #[serde(default)] archive: Option<bool> },
    /// Delete an archived chat and its folder for good.
    DeleteArchivedChat { id: String, chat: u32 },
    RenameChat { id: String, name: String },
    /// The branches of a codebase, for "New chat on a branch": local, remote, and those open in folders.
    ListBranches { id: String },
    /// A chat on a branch, in its own folder (a git worktree beside the repository): an existing branch,
    /// a remote one, or - with `from` - a new branch made from `from`. A branch already open in a folder
    /// is opened there instead (git allows one folder per branch).
    NewBranchChat { id: String, branch: String, #[serde(default)] from: Option<String> },
    /// What closing a branch chat's folder would lose: uncommitted files, commits not pushed.
    CheckBranch { id: String },
    /// Close a branch chat: its agent stops, its folder is removed (never the branch), and the chat is
    /// deleted. `force` removes a folder with uncommitted changes, after the page showed them.
    CloseBranch { id: String, #[serde(default)] force: bool },
    /// A Save button in a chat page (a diagram's SVG or PNG): a download link does nothing in this
    /// window, so Fire Code asks where with a Windows Save dialog and writes the bytes (base64) there.
    #[serde(rename_all = "camelCase")]
    SaveFile { id: String, request_id: String, name: String, data: String },
    /// A Browse button in a chat page: the Node host has no dialog of its own, so Fire Code opens one.
    PickPath { id: String, purpose: String, kind: String, #[serde(default)] extensions: Vec<String> },
    /// The codebase instructions every chat on it is told: read for the dialog, and saved from it.
    Instructions { id: String },
    SaveInstructions { id: String, text: String },
    /// The dashboard: one monitoring operation (`monitoring::monitor_op`), answered as `monitorReply`.
    Monitor { op: String, #[serde(default)] args: Value },
}

/// The 3-second timer everything periodic hangs off - monitoring's scheduler among it. Started once; started
/// again by the dashboard's Start when it has stopped ticking (`monitoring` `schedulerStart`).
pub(crate) fn spawn_ticker(proxy: EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        if proxy.send_event(UserEvent::Tick).is_err() {
            break;
        }
    });
}

/// Windows' "has stopped working" box for a crashed child (reported as python.exe crash notifications) is turned
/// off for everything Fire Code starts - the error mode is inherited down to each host's Python and tools. With the
/// box, a crashed worker stays alive until somebody dismisses it, and the agent waits out its timeout; without it the
/// crash ends the process at once, and the host reports the crash code and Python's own stack (PYTHONFAULTHANDLER).
fn quiet_crash_dialogs() {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn SetErrorMode(mode: u32) -> u32;
        }
        const SEM_FAILCRITICALERRORS: u32 = 0x0001;
        const SEM_NOGPFAULTERRORBOX: u32 = 0x0002;
        // SAFETY: a process-wide flag with no pointers; called once, before any child exists.
        unsafe {
            SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
        }
    }
}

fn main() {
    quiet_crash_dialogs();
    let paths = Paths::new();
    if system::hand_over_to_running_instance(&paths.root) {
        return;
    }
    let _ = std::fs::create_dir_all(&paths.root);
    system::record_helper(&paths.root);
    // Tool approvals are one list per Windows user now, shared with the VS Code extension; bring in what
    // Fire Code approved before (its old list stays, unread, for anybody going back a version).
    system::merge_approvals(&paths.root.join("approved-tools.json"), &system::shared_approvals_file());
    let mut state = State::load(&paths);
    let mut moved = false;
    for old in paths.previous_roots() {
        moved |= state.rebase(&old, &paths.root);
    }
    // Hub copies made by 0.8.0 sat inside the data folder, where the file tools may not look.
    for project in state.projects.iter_mut().filter(|p| p.hub.is_some()) {
        let old = std::path::PathBuf::from(&project.path);
        if old.starts_with(paths.root.join("hub")) {
            let new = paths.hub_copy(&project.id);
            let _ = std::fs::create_dir_all(new.parent().unwrap_or(&new));
            if !new.exists() && std::fs::rename(&old, &new).is_ok() || new.exists() {
                project.path = new.to_string_lossy().to_string();
                moved = true;
            }
        }
    }
    if moved {
        state.save(&paths);
    }
    let vault = Arc::new(vault::Vault::open(&paths).unwrap_or_else(|e| system::fatal(&e)));

    let icon_file = paths.root.join("icon.png");
    let _ = std::fs::write(&icon_file, ICON_PNG);
    system::register_app_identity(&icon_file);

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let mut builder = WindowBuilder::new()
        .with_title("Fire Code")
        .with_min_inner_size(LogicalSize::new(720.0, 480.0))
        .with_transparent(true)
        .with_visible(false);
    if let Ok(icon) = Icon::from_resource(1, None) {
        builder = builder.with_window_icon(Some(icon));
    }
    // Saved bounds are used only while they still land on a connected monitor: a laptop undocked
    // from the screen Fire Code was last on must not open a window nobody can see.
    let monitors: Vec<_> = event_loop.available_monitors().collect();
    let on_screen = |b: &state::WindowBounds| {
        monitors.iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            b.x + 80 >= p.x && b.y >= p.y - 8 && b.x + 80 < p.x + s.width as i32 && b.y + 40 < p.y + s.height as i32
        })
    };
    match state.settings.window.clone().filter(|b| on_screen(b)) {
        Some(bounds) => {
            builder = builder
                .with_inner_size(PhysicalSize::new(bounds.width.max(720), bounds.height.max(480)))
                .with_position(PhysicalPosition::new(bounds.x, bounds.y))
                .with_maximized(bounds.maximized);
        }
        None => {
            // First launch: most of the primary monitor, centred. Measured in physical pixels so
            // display scaling cannot make it larger than the screen, which a fixed logical size
            // did at 200%, putting the bottom of the window under the taskbar.
            if let Some(monitor) = event_loop.primary_monitor() {
                let (p, s) = (monitor.position(), monitor.size());
                let (w, h) = ((s.width as f64 * 0.8) as u32, (s.height as f64 * 0.8) as u32);
                builder = builder
                    .with_inner_size(PhysicalSize::new(w, h))
                    .with_position(PhysicalPosition::new(p.x + (s.width - w) as i32 / 2, p.y + (s.height - h) as i32 / 2 - 16));
            } else {
                builder = builder.with_inner_size(LogicalSize::new(1280.0, 800.0));
            }
        }
    }
    let window = builder.build(&event_loop).unwrap_or_else(|e| system::fatal(&format!("Could not create the window: {e}")));
    apply_theme(&window, &state.settings.theme);

    let mut web_context = WebContext::new(Some(paths.webview_dir()));
    let ipc_proxy = proxy.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_url("sun://localhost/index.html")
        .with_transparent(true)
        .with_devtools(cfg!(debug_assertions))
        // Reload and friends would rebuild every chat frame; nothing in Fire Code needs them.
        .with_browser_accelerator_keys(false)
        // Every page here comes from this machine, so a cache saves almost nothing, and WebView2's
        // grows into the hundreds of megabytes in the data folder. Capped at 32 MB. Setting these
        // replaces wry's defaults, which are repeated first.
        .with_additional_browser_args(BROWSER_ARGS)
        .with_default_context_menus(cfg!(debug_assertions))
        .with_custom_protocol("sun".into(), |_id, request| serve(request))
        .with_ipc_handler(move |request: Request<String>| {
            let _ = ipc_proxy.send_event(UserEvent::Ipc(request.body().clone()));
        })
        // The shell itself never navigates away. Links a chat opens in a new window go to the browser.
        .with_navigation_handler(|url| url.starts_with(SHELL_ORIGIN) || url.starts_with("sun:") || url == "about:blank")
        .with_new_window_req_handler(|url, _features| {
            // A link in a chat: the default browser, or the mail app for mailto (both schemes the chat allows).
            if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") {
                system::open_with_default_app(&url);
            }
            NewWindowResponse::Deny
        })
        .build(&window)
        .unwrap_or_else(|e| {
            system::fatal(&format!(
                "Fire Code needs the Microsoft Edge WebView2 Runtime, which comes with Windows 11 and is \
                 installed with Edge on Windows 10. It could not be started ({e}).\n\nInstall it from Microsoft \
                 (search for \"WebView2 Runtime\"), or ask IT to, then start Fire Code again."
            ))
        });

    state.projects.retain(|p| !p.id.is_empty());
    let monitoring_root = paths.root.join("monitoring");

    let mut app = App {
        paths,
        state,
        runtime: HashMap::new(),
        active: None,
        focused: true,
        proxy: proxy.clone(),
        icon_file,
        ticks: 0,
        launched: false,
        vault: vault.clone(),
        import_text: None,
        import_items: None,
        jetbrains_keys: None,
        env_warned: false,
        script: ScriptState::None,
        waiting: Vec::new(),
        git: HashMap::new(),
        git_busy: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        monitoring: monitoring::Monitoring::new(monitoring_root),
        appearance_changed: false,
    };
    // Before anything can start, so the first agent already has what the script sets.
    app.update_report_roots();
    app.run_startup_script();

    // Keys from the VS Code extension, over a pipe only this Windows user can open.
    {
        let vault = vault.clone();
        let proxy = proxy.clone();
        share::serve(
            move |entries| vault.import(entries),
            move |from, labels| {
                let _ = proxy.send_event(UserEvent::Shared { from, labels });
            },
        );
    }

    // Memory, status and the sleep check run on a timer rather than per event, so a busy agent
    // streaming hundreds of chunks never costs the window anything.
    spawn_ticker(proxy.clone());

    let mut shown = false;
    let mut grids: Vec<GridWindow> = Vec::new();
    let main_id = window.id();
    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::MonitorFetched { id, result }) => app.answered(&id, result, &webview),
            Event::UserEvent(UserEvent::MonitorToast { name, action }) => {
                window.set_minimized(false);
                window.set_visible(true);
                window.set_focus();
                app.monitor_toast(&name, action.as_deref(), &webview);
            }
            Event::UserEvent(UserEvent::GridIpc { window: from, body }) => {
                if let Some(at) = grids.iter().position(|g| g.window.id() == from) {
                    let name = grids[at].name.clone();
                    if body.contains("\"cmd\":\"close\"") {
                        grids.remove(at);
                    } else if let Some(answer) = monitoring::grid_command(&mut app, &name, &body, &webview) {
                        send(&grids[at].webview, answer);
                    }
                }
            }
            Event::WindowEvent { window_id, event, .. } if window_id != main_id => {
                if let WindowEvent::CloseRequested = event {
                    grids.retain(|g| g.window.id() != window_id);
                }
            }
            Event::NewEvents(StartCause::Init) => {}
            Event::UserEvent(UserEvent::Ipc(body)) => {
                if !shown {
                    // Shown once the page has painted, so it never flashes white first.
                    window.set_visible(true);
                    shown = true;
                }
                app.handle_ipc(&body, &window, &webview);
            }
            Event::UserEvent(UserEvent::Host(event)) => app.handle_host(event, &webview),
            Event::UserEvent(UserEvent::Toast { id, action }) => {
                window.set_minimized(false);
                window.set_visible(true);
                window.set_focus();
                app.select(&id, &webview);
                send(&webview, json!({ "type": "select", "id": id }));
                // Over the chat it came from, so closing the report leaves you where the work is.
                if let Some(path) = action.as_deref().and_then(|a| a.strip_prefix("report:")) {
                    app.show_report(path, &webview);
                }
            }
            Event::UserEvent(UserEvent::Tick) => app.tick(&window, &webview),
            Event::UserEvent(UserEvent::Shared { from, labels }) => {
                let text = if labels.is_empty() {
                    format!("{from} sent no keys - nothing it holds was set.")
                } else {
                    format!("{from} shared {} key(s): {}. Every codebase can use them now.", labels.len(), labels.join(", "))
                };
                send(&webview, json!({ "type": "notice", "level": "info", "text": text }));
                app.push_credentials(&webview);
            }
            Event::UserEvent(UserEvent::Select(id)) => {
                app.select(&id, &webview);
                send(&webview, json!({ "type": "select", "id": id }));
            }
            Event::UserEvent(UserEvent::ScriptDone(result)) => app.script_done(result, &webview),
            Event::UserEvent(UserEvent::GitDone { id, ok, text }) => {
                let name = app.state.project(&id).map(|p| p.name.clone()).unwrap_or_default();
                send(&webview, json!({ "type": "gitDone", "id": id, "ok": ok, "text": format!("{name}: {text}") }));
                app.refresh_git(Some(id));
            }
            Event::UserEvent(UserEvent::Git(results)) => {
                for (id, counts) in results {
                    match counts {
                        Some(c) => {
                            app.git.insert(id, c);
                        }
                        None => {
                            app.git.remove(&id);
                        }
                    }
                }
                send(&webview, app.git_message());
            }
            Event::UserEvent(UserEvent::StartLater(id)) => {
                if app.runtime.get(&id).map(|r| r.phase == Phase::Stopped).unwrap_or(true) {
                    app.start(&id, &webview);
                }
            }
            Event::WindowEvent { event, .. } => match event {
                WindowEvent::CloseRequested => {
                    app.remember_window(&window);
                    app.state.save(&app.paths);
                    // Dropping each host ends its job, and with it every process it started.
                    app.runtime.clear();
                    app.monitoring.executor = None;
                    grids.clear();
                    *control_flow = ControlFlow::Exit;
                }
                WindowEvent::Focused(focused) => app.focused = focused,
                WindowEvent::Resized(_) | WindowEvent::Moved(_) => app.remember_window(&window),
                _ => {}
            },
            _ => {}
        }

        // What monitoring asked for while handling that: grid windows to open, messages for open ones,
        // the dashboard brought on screen, the taskbar flashed.
        for name in std::mem::take(&mut app.monitoring.grid_open) {
            if let Some(open) = grids.iter().find(|g| g.name == name) {
                // Already open: a sheet asked for reaches it as a message, not when it is next ready.
                app.monitoring.open_sheet.remove(&name);
                open.window.set_minimized(false);
                open.window.set_focus();
                continue;
            }
            match open_grid(target, &mut web_context, &proxy, &app, &name) {
                Ok(grid) => grids.push(grid),
                Err(text) => send(&webview, json!({ "type": "notice", "level": "error", "text": text })),
            }
        }
        for message in std::mem::take(&mut app.monitoring.shell_out) {
            window.set_minimized(false);
            window.set_focus();
            send(&webview, message);
        }
        for (name, message) in std::mem::take(&mut app.monitoring.grid_out) {
            for grid in grids.iter().filter(|g| g.name == name) {
                send(&grid.webview, message.clone());
            }
        }
        if std::mem::take(&mut app.appearance_changed) {
            for grid in &grids {
                apply_theme(&grid.window, &app.state.settings.theme);
                send(&grid.webview, json!({ "type": "appearance", "theme": app.state.settings.theme, "accent": app.state.settings.accent }));
            }
        }
        if std::mem::take(&mut app.monitoring.show_dashboard) {
            window.set_minimized(false);
            window.set_visible(true);
            send(&webview, json!({ "type": "showMonitoring" }));
        }
        if std::mem::take(&mut app.monitoring.flash) {
            window.request_user_attention(Some(tao::window::UserAttentionType::Critical));
        }
    });
}

/// A monitor's grid, in its own Fire Code window: the same `sun://` pages, theme and accent as the shell.
fn open_grid(
    target: &tao::event_loop::EventLoopWindowTarget<UserEvent>,
    web_context: &mut WebContext,
    proxy: &EventLoopProxy<UserEvent>,
    app: &App,
    name: &str,
) -> Result<GridWindow, String> {
    let title = app.monitoring.found.iter().find(|f| f.name == name).map(|f| f.title()).unwrap_or_else(|| name.to_string());
    let mut builder = WindowBuilder::new()
        .with_title(format!("{title} — Fire Code monitoring"))
        .with_min_inner_size(LogicalSize::new(560.0, 360.0))
        .with_inner_size(LogicalSize::new(1180.0, 720.0));
    if let Ok(icon) = Icon::from_resource(1, None) {
        builder = builder.with_window_icon(Some(icon));
    }
    let window = builder.build(target).map_err(|e| format!("Could not open the monitor's window: {e}"))?;
    apply_theme(&window, &app.state.settings.theme);
    let (from, proxy) = (window.id(), proxy.clone());
    let encoded: String = name.bytes().map(|b| if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let webview = WebViewBuilder::new_with_web_context(web_context)
        .with_url(format!("sun://localhost/monitor.html?m={encoded}"))
        .with_additional_browser_args(BROWSER_ARGS)
        .with_devtools(cfg!(debug_assertions))
        .with_browser_accelerator_keys(false)
        .with_default_context_menus(cfg!(debug_assertions))
        .with_custom_protocol("sun".into(), |_id, request| serve(request))
        .with_ipc_handler(move |request: Request<String>| {
            let _ = proxy.send_event(UserEvent::GridIpc { window: from, body: request.body().clone() });
        })
        .with_navigation_handler(|url| url.starts_with(SHELL_ORIGIN) || url.starts_with("sun:") || url == "about:blank")
        .with_new_window_req_handler(|_url, _features| NewWindowResponse::Deny)
        .build(&window)
        .map_err(|e| format!("Could not show the monitor's window: {e}"))?;
    Ok(GridWindow { name: name.to_string(), window, webview })
}

/// The shell's own files, from inside the exe. Nothing is fetched (invariant 4).
/// Where reports may be read from: Fire Code's data folder and every codebase's folder. Kept current
/// as codebases are added and removed; read by the frame that shows HTML reports.
static REPORT_ROOTS: std::sync::RwLock<Vec<PathBuf>> = std::sync::RwLock::new(Vec::new());

fn report_roots() -> Vec<PathBuf> {
    REPORT_ROOTS.read().map(|r| r.clone()).unwrap_or_default()
}

fn serve(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = request.uri().path();
    if path == "/report" {
        let wanted = request.uri().query().and_then(|q| q.strip_prefix("p=")).map(reports::percent_decode).unwrap_or_default();
        let read = reports::read(&report_roots(), &wanted);
        return match read {
            Ok((real, text)) if reports::kind(&real) == "html" => Response::builder()
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header("Content-Security-Policy", reports::HTML_REPORT_POLICY)
                .body(Cow::Owned(text.into_bytes()))
                .unwrap(),
            _ => Response::builder().status(StatusCode::NOT_FOUND).body(Cow::Borrowed(&b""[..])).unwrap(),
        };
    }
    let (body, kind): (&'static str, &str) = match path {
        "/" | "/index.html" => (INDEX_HTML, "text/html; charset=utf-8"),
        "/shell.css" => (SHELL_CSS, "text/css; charset=utf-8"),
        "/shell.js" => (SHELL_JS, "text/javascript; charset=utf-8"),
        "/monitor.html" => (MONITOR_HTML, "text/html; charset=utf-8"),
        "/monitor.css" => (MONITOR_CSS, "text/css; charset=utf-8"),
        "/monitor.js" => (MONITOR_JS, "text/javascript; charset=utf-8"),
        "/icon.png" => {
            return Response::builder()
                .header(header::CONTENT_TYPE, "image/png")
                .body(Cow::Borrowed(ICON_PNG))
                .unwrap();
        }
        _ => {
            return Response::builder().status(StatusCode::NOT_FOUND).body(Cow::Borrowed(&b""[..])).unwrap();
        }
    };
    Response::builder()
        .header(header::CONTENT_TYPE, kind)
        // Frames only from the hosts Fire Code started, which listen on loopback; nothing else at all.
        .header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; \
             frame-src 'self' http://127.0.0.1:*; connect-src 'self'; base-uri 'none'; form-action 'none'",
        )
        .body(Cow::Borrowed(body.as_bytes()))
        .unwrap()
}

/// The title bar and the Mica behind the sidebar follow Fire Code's theme, so a dark Fire Code on a light
/// Windows is dark all the way to the window frame. "system" hands both back to Windows.
fn apply_theme(window: &Window, theme: &str) {
    let chosen = match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    window.set_theme(chosen);
    let dark = match theme {
        "light" => Some(false),
        "dark" => Some(true),
        _ => None,
    };
    // Absent on Windows 10, where the page paints its own background.
    let _ = window_vibrancy::apply_mica(window, dark);
}

fn send(webview: &WebView, message: Value) {
    let script = format!("window.__sun && window.__sun.receive({message})");
    let _ = webview.evaluate_script(&script);
}

fn folder_name(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

impl App {
    fn project_views(&self) -> Value {
        let names = state::mention_names(&self.state.projects);
        Value::Array(
            self.state
                .projects
                .iter()
                .zip(names)
                .map(|(p, (_, mention))| {
                    json!({
                        "id": p.id,
                        "name": p.name,
                        // What other codebases' chats call it: `@<mention>:path`.
                        "mention": mention,
                        "path": p.path,
                        "configMode": p.config_mode,
                        "configFile": p.config_file,
                        "configSource": p.config_source,
                        "keepAwake": p.keep_awake,
                        "accent": p.accent,
                        "chats": p.chats,
                        // Put away with Archive, offered by New chat; newest first.
                        "archived": p.archived.iter().rev().collect::<Vec<_>>(),
                        // The first chat's name once renamed. Missing here, a rename was saved and never shown.
                        "firstChatName": p.first_chat_name,
                        "hasWorkspaceConfig": configs::has_workspace_config(&p.path),
                        "missing": !Path::new(&p.path).is_dir(),
                        // Never the token: which credential holds it, by name.
                        "hub": p.hub.as_ref().map(|h| json!({
                            "url": h.url, "user": h.user, "server": h.server, "folders": h.folders, "kernel": h.kernel,
                            "credential": h.credential, "credentialLabel": h.credential.as_ref().and_then(|c| self.vault.label_of(c)),
                        })),
                    })
                })
                .collect(),
        )
    }

    fn statuses(&self) -> Value {
        let mut map = serde_json::Map::new();
        let mut total = 0u64;
        for (id, rt) in &self.runtime {
            total += rt.memory;
            map.insert(
                id.clone(),
                json!({
                    "phase": rt.phase.word(),
                    "agent": rt.agent,
                    "memory": rt.memory,
                    "error": rt.error,
                    "unread": rt.unread,
                    "schedule": rt.woke_for_schedule,
                    "waiting": rt.waiting_for,
                }),
            );
        }
        json!({ "type": "status", "statuses": map, "totalMemory": total })
    }

    /// The saved credentials and where each is used - names only, never a value.
    fn push_credentials(&self, webview: &WebView) {
        match self.vault.list() {
            Ok(mut list) => {
                // A credential feeding a Fire Code environment variable is in use too: say where.
                for item in &mut list {
                    let id = item["id"].as_str().unwrap_or_default().to_string();
                    let users: Vec<Value> = self
                        .state
                        .settings
                        .env
                        .iter()
                        .filter(|v| v.credential.as_deref().and_then(|c| c.split_once('#')).map(|(i, _)| i == id).unwrap_or(false))
                        .map(|v| Value::String(format!("Fire Code environment: {}", v.name)))
                        .collect();
                    if let (false, Some(used)) = (users.is_empty(), item["usedBy"].as_array_mut()) {
                        used.extend(users);
                    }
                }
                send(webview, json!({ "type": "credentials", "credentials": list, "pipe": share::pipe_name() }))
            }
            Err(text) => send(webview, json!({ "type": "notice", "level": "error", "text": text })),
        }
    }

    fn push_projects(&self, webview: &WebView) {
        self.update_report_roots();
        send(webview, json!({ "type": "projects", "projects": self.project_views() }));
    }

    fn handle_ipc(&mut self, body: &str, window: &Window, webview: &WebView) {
        let command: Command = match serde_json::from_str(body) {
            Ok(c) => c,
            Err(error) => {
                send(webview, json!({ "type": "notice", "level": "error", "text": format!("Fire Code did not understand a request: {error}") }));
                return;
            }
        };
        match command {
            Command::Ready => {
                send(
                    webview,
                    json!({
                        "type": "init",
                        "version": VERSION,
                        "projects": self.project_views(),
                        "settings": self.state.settings,
                        "accent": system::accent_colour(),
                        "hasSource": system::source_archive().is_some(),
                        "dataFolder": self.paths.root.to_string_lossy(),
                    }),
                );
                // Every live host's link again: a reloaded page has lost its frames.
                for (id, rt) in &self.runtime {
                    if let Some(url) = &rt.url {
                        send(webview, json!({ "type": "url", "id": id, "url": url }));
                    }
                }
                send(webview, self.statuses());
                send(webview, self.script_status());
                send(webview, self.git_message());
                if self.monitoring.settings.enabled {
                    self.monitor_scan();
                }
                self.push_monitors(webview);
                self.refresh_git(None);
                self.start_on_launch();
            }
            Command::PickFolder => {
                let picked = rfd::FileDialog::new().set_title("Choose a codebase folder").set_parent(window).pick_folder();
                if let Some(folder) = picked {
                    let path = folder.to_string_lossy().into_owned();
                    let existing = self.state.projects.iter().find(|p| configs::same_path(&p.path, &path)).map(|p| p.id.clone());
                    send(
                        webview,
                        json!({
                            "type": "folderPicked",
                            "path": path,
                            "name": folder_name(&path),
                            "hasWorkspaceConfig": configs::has_workspace_config(&path),
                            "existingId": existing,
                        }),
                    );
                }
            }
            Command::SaveEnvironment { path_prefix, env, startup_script } => {
                let startup_script = startup_script.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                if let Some(script) = &startup_script {
                    if let Err(text) = environment::check_script(script) {
                        send(webview, json!({ "type": "environmentSaved", "ok": false, "error": text }));
                        return;
                    }
                }
                let script_changed = startup_script != self.state.settings.startup_script;
                let path_prefix: Vec<String> = path_prefix.into_iter().map(|f| f.trim().to_string()).collect();
                let env: Vec<environment::EnvVar> = env
                    .into_iter()
                    .map(|v| environment::EnvVar { name: v.name.trim().to_string(), ..v })
                    .collect();
                match environment::validate(&path_prefix, &env) {
                    Err(text) => send(webview, json!({ "type": "environmentSaved", "ok": false, "error": text })),
                    Ok(()) => {
                        self.state.settings.path_prefix = path_prefix;
                        self.state.settings.env = env;
                        self.state.settings.startup_script = startup_script;
                        self.state.save(&self.paths);
                        if script_changed {
                            self.run_startup_script();
                            send(webview, self.script_status());
                        }
                        self.env_warned = false;
                        let running = self.runtime.values().filter(|r| r.process.is_some()).count();
                        send(webview, json!({ "type": "settings", "settings": self.state.settings }));
                        send(
                            webview,
                            json!({
                                "type": "environmentSaved", "ok": true, "running": running,
                                "folders": environment::folder_status(&self.state.settings.path_prefix),
                            }),
                        );
                        self.push_credentials(webview);
                    }
                }
            }
            Command::OpenReport { path } => self.show_report(&path, webview),
            Command::Reports { id } => {
                let dir = self.paths.project_dir(state::project_of(&id));
                let items: Vec<Value> = reports::list(&dir)
                    .into_iter()
                    .map(|(path, name, modified)| json!({ "path": path, "name": name, "modified": modified }))
                    .collect();
                send(webview, json!({ "type": "reports", "id": id, "reports": items }));
            }
            Command::OpenReportExternally { path } => {
                if let Ok(real) = reports::allowed(&report_roots(), &path) {
                    system::open_with_default_app(&reports::plain(&real));
                }
            }
            Command::RevealReport { path } => {
                if let Ok(real) = reports::allowed(&report_roots(), &path) {
                    let shown = reports::plain(&real);
                    use std::os::windows::process::CommandExt;
                    let _ = std::process::Command::new("explorer.exe").raw_arg(format!("/select,\"{shown}\"")).spawn();
                }
            }
            Command::RunScript => {
                self.run_startup_script();
                send(webview, self.script_status());
            }
            Command::PickScript => {
                let picked = rfd::FileDialog::new()
                    .set_title("Choose a startup script")
                    .add_filter("Scripts", &["cmd", "bat", "ps1"])
                    .set_parent(window)
                    .pick_file();
                if let Some(file) = picked {
                    send(webview, json!({ "type": "scriptPicked", "path": file.to_string_lossy() }));
                }
            }
            Command::CheckFolders { path_prefix } => {
                send(webview, json!({ "type": "folderStatus", "folders": environment::folder_status(&path_prefix) }));
            }
            Command::PickPath { id, purpose, kind, extensions } => {
                // Only a chat that exists, and only an answer the user chose in a Windows dialog.
                if !self.state.has_chat(&id) || purpose.len() > 200 {
                    return;
                }
                let mut dialog = rfd::FileDialog::new().set_parent(window);
                if let Some(project) = self.state.project(&id) {
                    if Path::new(&project.path).is_dir() {
                        dialog = dialog.set_directory(&project.path);
                    }
                }
                let picked = if kind == "folder" {
                    dialog.set_title("Choose a folder").pick_folder()
                } else {
                    let names: Vec<&str> = extensions.iter().map(|e| e.trim_start_matches('.')).filter(|e| !e.is_empty() && e.len() <= 10).collect();
                    let dialog = if names.is_empty() { dialog } else { dialog.add_filter("Files", &names) };
                    dialog.set_title("Choose a file").pick_file()
                };
                if let Some(path) = picked {
                    send(webview, json!({ "type": "pathPicked", "id": id, "purpose": purpose, "path": path.to_string_lossy() }));
                }
            }
            Command::SaveFile { id, request_id, name, data } => {
                if !self.state.has_chat(&id) {
                    return;
                }
                let answer = |path: Option<String>, error: Option<String>| {
                    send(webview, json!({ "type": "fileSaved", "id": id, "requestId": request_id, "path": path, "error": error }));
                };
                // Generous for a diagram (a PNG is a few hundred KB) and a bound on what the page may hand over.
                if data.len() > 28 * 1024 * 1024 {
                    return answer(None, Some("That file is too large to save from here.".into()));
                }
                let Some(bytes) = files::decode_base64(&data) else {
                    return answer(None, Some("The file arrived damaged - try again.".into()));
                };
                let name = files::safe_file_name(&name);
                let mut dialog = rfd::FileDialog::new().set_parent(window).set_title("Save as").set_file_name(&name);
                if let Some(extension) = Path::new(&name).extension().and_then(|e| e.to_str()) {
                    dialog = dialog.add_filter(&extension.to_uppercase(), &[extension]);
                }
                if let Some(dir) = dirs_downloads() {
                    dialog = dialog.set_directory(dir);
                }
                match dialog.save_file() {
                    None => answer(None, None),
                    Some(path) => match std::fs::write(&path, &bytes) {
                        Ok(()) => answer(Some(path.to_string_lossy().into_owned()), None),
                        Err(error) => answer(None, Some(format!("Could not write {}: {error}", path.display()))),
                    },
                }
            }
            Command::PickEnvFolder { index } => {
                let picked = rfd::FileDialog::new().set_title("Choose a folder to put on PATH").set_parent(window).pick_folder();
                if let Some(folder) = picked {
                    send(webview, json!({ "type": "envFolderPicked", "index": index, "path": folder.to_string_lossy() }));
                }
            }
            Command::RestartAll => {
                let running: Vec<String> = self.runtime.iter().filter(|(_, r)| r.process.is_some()).map(|(k, _)| k.clone()).collect();
                for key in &running {
                    self.stop(key, Phase::Stopped);
                    self.start(key, webview);
                }
                send(webview, json!({ "type": "notice", "level": "info", "text": format!("Restarted {} agent(s) with the new environment.", running.len()) }));
            }
            Command::PickConfig => {
                let picked = rfd::FileDialog::new()
                    .set_title("Choose a Light Code config.json")
                    .add_filter("Light Code settings", &["json"])
                    .set_parent(window)
                    .pick_file();
                if let Some(file) = picked {
                    send(webview, json!({ "type": "configPicked", "path": file.to_string_lossy() }));
                }
            }
            Command::Sources => {
                let ours: Vec<(String, String)> =
                    self.state.projects.iter().map(|p| (p.name.clone(), p.config_file.clone())).collect();
                send(
                    webview,
                    json!({
                        "type": "sources",
                        "sources": configs::find_sources(&ours),
                        "recent": configs::find_recent_codebases()
                            .into_iter()
                            .filter(|r| !self.state.projects.iter().any(|p| configs::same_path(&p.path, &r.path)))
                            .collect::<Vec<_>>(),
                    }),
                );
            }
            Command::Add { path, name, mode, source } => self.add(path, name, mode, source, webview),
            Command::AddHub { name, hub, mode, source } => self.add_hub(name, hub, mode, source, webview),
            Command::UpdateHub { id, hub } => self.update_hub(&id, hub, webview),
            Command::Remove { id } => {
                for key in self.state.chat_keys(&id) {
                    self.runtime.remove(&key);
                }
                self.state.projects.retain(|p| p.id != id);
                if self.active.as_deref() == Some(id.as_str()) {
                    self.active = None;
                }
                self.state.save(&self.paths);
                self.push_projects(webview);
                send(webview, json!({ "type": "removed", "id": id }));
                send(webview, self.statuses());
            }
            Command::Select { id } => self.select(&id, webview),
            Command::Start { id } | Command::Restart { id } => {
                self.stop(&id, Phase::Stopped);
                self.start(&id, webview);
            }
            Command::Sleep { id } => {
                self.stop(&id, Phase::Sleeping);
                send(webview, json!({ "type": "unload", "id": id }));
                send(webview, self.statuses());
            }
            Command::AgentState { id, state, finished, reason } => self.agent_state(&id, state, finished, reason, window, webview),
            Command::Settings { patch } => {
                let mut current = serde_json::to_value(&self.state.settings).unwrap_or(Value::Null);
                if let (Some(target), Some(changes)) = (current.as_object_mut(), patch.as_object()) {
                    for (k, v) in changes {
                        if k != "window" && k != "env" && k != "pathPrefix" {
                            target.insert(k.clone(), v.clone());
                        }
                    }
                }
                if let Ok(settings) = serde_json::from_value::<state::Settings>(current) {
                    let theme_changed = settings.theme != self.state.settings.theme;
                    self.appearance_changed |= theme_changed || settings.accent != self.state.settings.accent;
                    self.state.settings = settings;
                    self.state.save(&self.paths);
                    if theme_changed {
                        apply_theme(window, &self.state.settings.theme);
                    }
                }
                send(webview, json!({ "type": "settings", "settings": self.state.settings }));
            }
            Command::Monitor { op, args } => {
                let was_on = self.monitoring.settings.enabled;
                let answer = self.monitor_op(&op, &args, monitoring::Origin::User, webview);
                send(
                    webview,
                    match &answer {
                        Ok(data) => json!({ "type": "monitorReply", "op": op, "ok": true, "data": data }),
                        Err(error) => json!({ "type": "monitorReply", "op": op, "ok": false, "error": error }),
                    },
                );
                // Switched on or off: idle chats start again with (or without) the monitoring tools.
                if self.monitoring.settings.enabled != was_on {
                    self.monitoring_switched(webview);
                    if self.monitoring.settings.enabled {
                        self.monitor_scan();
                    }
                    self.push_monitors(webview);
                }
            }
            Command::KeepAwake { id, on } => {
                if let Some(p) = self.state.project_mut(&id) {
                    p.keep_awake = on;
                }
                self.state.save(&self.paths);
                self.push_projects(webview);
            }
            Command::Rename { id, name } => {
                let name = name.trim().to_string();
                if !name.is_empty() {
                    if let Some(p) = self.state.project_mut(&id) {
                        p.name = name;
                    }
                    self.state.save(&self.paths);
                }
                self.push_projects(webview);
            }
            Command::Reorder { ids } => {
                let mut ordered: Vec<Project> = ids.iter().filter_map(|id| self.state.project(id).cloned()).collect();
                for p in &self.state.projects {
                    if !ids.contains(&p.id) {
                        ordered.push(p.clone());
                    }
                }
                self.state.projects = ordered;
                self.state.save(&self.paths);
                self.push_projects(webview);
            }
            Command::ChangeConfig { id, mode, source } => {
                match self.resolve_config(&id, mode, source.as_deref()) {
                    Ok((file, source)) => {
                        if let Some(p) = self.state.project_mut(&id) {
                            p.config_mode = mode;
                            p.config_file = file;
                            p.config_source = source;
                        }
                        self.state.save(&self.paths);
                        self.push_projects(webview);
                        // The host reads its settings file once, at start - every chat's host.
                        for key in self.state.chat_keys(&id) {
                            if self.runtime.get(&key).map(|r| r.process.is_some()).unwrap_or(false) {
                                self.stop(&key, Phase::Stopped);
                                self.start(&key, webview);
                            }
                        }
                    }
                    Err(text) => send(webview, json!({ "type": "notice", "level": "error", "text": text })),
                }
            }
            // A chat key opens that chat's own folder - a branch chat's branch folder - so it can be run and debugged there.
            Command::OpenVsCode { id } => {
                if let Some(folder) = self.state.chat_folder(&id) {
                    if !system::open_in_vscode(&folder) {
                        send(webview, json!({ "type": "notice", "level": "error", "text": "VS Code's `code` command was not found on PATH." }));
                    }
                }
            }
            Command::GitCommitPush { id, message } => self.git_action(&id, Some(message)),
            Command::GitPull { id } => self.git_action(&id, None),
            Command::OpenExplorer { id } => {
                if let Some(folder) = self.state.chat_folder(&id) {
                    system::open_in_explorer(&folder);
                }
            }
            Command::OpenLog { id } => {
                let log = self.paths.log_file(&id);
                if log.is_file() {
                    system::open_with_default_app(&log.to_string_lossy());
                } else {
                    send(webview, json!({ "type": "notice", "level": "info", "text": "No log yet - the agent has not been started." }));
                }
            }
            Command::OpenDataFolder => system::open_in_explorer(&self.paths.root.to_string_lossy()),
            Command::ExportSource => self.export_source(window, webview),
            Command::Credentials => self.push_credentials(webview),
            Command::SaveCredential { id, label, kind, note, values } => {
                match self.vault.save(id, &label, &kind, note, &values) {
                    Ok(_) => {
                        send(webview, json!({ "type": "credentialSaved" }));
                        self.push_credentials(webview);
                    }
                    Err(text) => send(webview, json!({ "type": "credentialError", "text": text })),
                }
            }
            Command::ExportCredentials { ids, passphrase } => match self.vault.export(&ids, &passphrase) {
                Err(text) => send(webview, json!({ "type": "credentialError", "text": text })),
                Ok((text, count)) => {
                    let target = rfd::FileDialog::new()
                        .set_title("Save the credentials file")
                        .set_file_name("credentials.sunkeys")
                        .add_filter("Fire Code credentials", &["sunkeys"])
                        .set_parent(window)
                        .save_file();
                    if let Some(target) = target {
                        match std::fs::write(&target, text) {
                            Ok(()) => {
                                send(webview, json!({ "type": "credentialSaved" }));
                                send(webview, json!({ "type": "notice", "level": "info", "text": format!("Exported {count} credential(s) to {}. Send the passphrase separately from the file.", target.display()) }));
                            }
                            Err(e) => send(webview, json!({ "type": "credentialError", "text": format!("Could not write {}: {e}", target.display()) })),
                        }
                    }
                }
            },
            Command::ChooseCredentialImport => {
                let picked = rfd::FileDialog::new()
                    .set_title("Import credentials")
                    .add_filter("Fire Code credentials", &["sunkeys"])
                    .set_parent(window)
                    .pick_file();
                if let Some(file) = picked {
                    match std::fs::read_to_string(&file) {
                        Ok(text) => {
                            self.import_text = Some(text);
                            self.import_items = None;
                            send(webview, json!({ "type": "importNeedsPassphrase", "file": file.to_string_lossy() }));
                        }
                        Err(e) => send(webview, json!({ "type": "notice", "level": "error", "text": format!("Could not read {}: {e}", file.display()) })),
                    }
                }
            }
            Command::OpenCredentialImport { passphrase } => {
                let Some(text) = self.import_text.as_deref() else { return };
                match vault::Vault::open_export(text, &passphrase) {
                    Ok(items) => {
                        let preview: Vec<Value> = items
                            .iter()
                            .map(|i| json!({ "label": i.label, "kind": i.kind, "exists": self.vault.has_label(&i.label) }))
                            .collect();
                        self.import_items = Some(items);
                        send(webview, json!({ "type": "importPreview", "items": preview }));
                    }
                    Err(text) => send(webview, json!({ "type": "credentialError", "text": text })),
                }
            }
            Command::ImportCredentials { indexes } => {
                let items = self.import_items.take().unwrap_or_default();
                self.import_text = None;
                let chosen: Vec<vault::Portable> = items.into_iter().enumerate().filter(|(i, _)| indexes.contains(i)).map(|(_, c)| c).collect();
                match self.vault.import_portable(&chosen) {
                    Ok(count) => {
                        send(webview, json!({ "type": "credentialSaved" }));
                        send(webview, json!({ "type": "notice", "level": "info", "text": format!("Imported {count} credential(s).") }));
                        self.push_credentials(webview);
                    }
                    Err(text) => send(webview, json!({ "type": "credentialError", "text": text })),
                }
            }
            Command::ScanJetBrains => {
                let keys = configs::node_host_keys();
                if keys.is_empty() {
                    send(webview, json!({ "type": "notice", "level": "info", "text": "No saved keys were found for Light Code in IntelliJ or PyCharm on this computer." }));
                } else {
                    let items: Vec<Value> = keys
                        .iter()
                        .map(|(_, label, _)| json!({ "label": label, "exists": self.vault.has_label(label) }))
                        .collect();
                    self.jetbrains_keys = Some(keys);
                    send(webview, json!({ "type": "jetbrainsPreview", "items": items }));
                }
            }
            Command::ImportJetBrains { indexes } => {
                let keys = self.jetbrains_keys.take().unwrap_or_default();
                let chosen: Vec<(String, String, String)> = keys.into_iter().enumerate().filter(|(i, _)| indexes.contains(i)).map(|(_, k)| k).collect();
                match self.vault.import(&chosen) {
                    Ok(labels) => {
                        send(webview, json!({ "type": "credentialSaved" }));
                        send(webview, json!({ "type": "notice", "level": "info", "text": format!("Imported {} key(s) from IntelliJ / PyCharm. Codebases linked to that config can use them now.", labels.len()) }));
                        self.push_credentials(webview);
                    }
                    Err(text) => send(webview, json!({ "type": "credentialError", "text": text })),
                }
            }
            Command::DeleteCredential { id } => {
                match self.vault.delete(&id) {
                    Ok(()) => self.push_credentials(webview),
                    Err(text) => send(webview, json!({ "type": "notice", "level": "error", "text": text })),
                }
            }
            Command::NewChat { id, archived } => {
                let _ = self.new_chat(&id, archived, None, webview);
            }
            Command::CloseChat { id, archive } => {
                let Some(chat) = state::chat_of(&id).and_then(|c| c.parse::<u32>().ok()) else { return };
                let archive = archive != Some(false);
                // The tab beside it takes its place, as in a browser: the one to its right, else the one to its left.
                let next = self.state.project(&id).map(|p| state::tab_after_close(p, chat)).unwrap_or_else(|| state::project_of(&id).to_string());
                self.stop(&id, Phase::Stopped);
                self.runtime.remove(&id);
                if let Some(p) = self.state.project_mut(&id) {
                    if let Some(closed) = p.chats.iter().find(|c| c.id == chat).cloned() {
                        p.last_chat = p.last_chat.max(chat);
                        if archive {
                            p.archived.push(state::ArchivedChat { id: chat, name: closed.name, archived_at: state::now_millis(), folder: closed.folder, branch: closed.branch });
                        }
                    }
                    p.chats.retain(|c| c.id != chat);
                }
                if !archive {
                    self.delete_chat_folder(&id, webview);
                }
                if self.active.as_deref() == Some(id.as_str()) {
                    self.select(&next, webview);
                    send(webview, json!({ "type": "select", "id": next }));
                }
                self.state.save(&self.paths);
                self.push_projects(webview);
                send(webview, json!({ "type": "removed", "id": id }));
                send(webview, self.statuses());
            }
            Command::DeleteArchivedChat { id, chat } => {
                let Some(p) = self.state.project_mut(&id) else { return };
                if !p.archived.iter().any(|c| c.id == chat) {
                    return;
                }
                p.archived.retain(|c| c.id != chat);
                p.last_chat = p.last_chat.max(chat);
                let key = format!("{}~{}", p.id, chat);
                self.delete_chat_folder(&key, webview);
                self.state.save(&self.paths);
                self.push_projects(webview);
            }
            Command::ListBranches { id } => {
                let Some(p) = self.state.project(&id) else { return };
                let repo = PathBuf::from(&p.path);
                match branches::list(&repo) {
                    Ok(list) => send(webview, json!({ "type": "branches", "id": id, "branches": list })),
                    Err(text) => send(webview, json!({ "type": "branches", "id": id, "error": format!("Could not read the branches of {}: {text}", p.name) })),
                }
            }
            Command::NewBranchChat { id, branch, from } => {
                let Some(p) = self.state.project(&id).cloned() else { return };
                let repo = PathBuf::from(&p.path);
                let fail = |webview: &WebView, text: String| send(webview, json!({ "type": "branchFailed", "id": p.id, "error": text }));
                // Open already? Its chat if it has one, else a new chat on that folder.
                let open = branches::list(&repo).ok().and_then(|l| l.open.into_iter().find(|o| o.branch == branch && from.is_none()));
                let (folder, local) = match open {
                    Some(o) if o.main => {
                        let first = p.id.clone();
                        self.select(&first, webview);
                        send(webview, json!({ "type": "select", "id": first }));
                        return;
                    }
                    Some(o) => {
                        let same = |a: &str| a.to_lowercase().replace('/', "\\") == o.path.to_lowercase();
                        if let Some(chat) = p.chats.iter().find(|c| c.folder.as_deref().map(same).unwrap_or(false)) {
                            let key = format!("{}~{}", p.id, chat.id);
                            self.select(&key, webview);
                            send(webview, json!({ "type": "select", "id": key }));
                            return;
                        }
                        (o.path.clone(), o.branch.clone())
                    }
                    None => {
                        let chosen = branches::chosen_root(Path::new(&p.config_file));
                        let target = branches::folder_for(&repo, &branch, chosen.as_deref());
                        match branches::add(&repo, &branch, from.as_deref(), &target) {
                            Ok((made, local)) => {
                                if let Err(text) = branches::mark_for_setup(&made) {
                                    send(webview, json!({ "type": "notice", "level": "error", "text": text }));
                                }
                                (made.to_string_lossy().into_owned(), local)
                            }
                            Err(text) => return fail(webview, format!("Could not open {branch}: {text}")),
                        }
                    }
                };
                let on_disk = state::chat_numbers_on_disk(&self.paths.project_dir(&p.id));
                let Some(project) = self.state.project_mut(&p.id) else { return };
                let next = project.next_chat_id(&on_disk);
                project.last_chat = next;
                project.chats.push(state::Chat { id: next, name: format!("Chat {next}"), folder: Some(folder), branch: Some(local) });
                let key = format!("{}~{}", project.id, next);
                self.state.save(&self.paths);
                self.push_projects(webview);
                self.select(&key, webview);
                send(webview, json!({ "type": "select", "id": key }));
            }
            Command::CheckBranch { id } => {
                let Some(folder) = self.branch_folder(&id) else { return };
                match branches::status(Path::new(&folder)) {
                    Ok(status) => send(webview, json!({ "type": "branchCheck", "id": id, "folder": folder, "status": status })),
                    Err(text) => send(webview, json!({ "type": "branchCheck", "id": id, "folder": folder, "error": text })),
                }
            }
            Command::CloseBranch { id, force } => {
                let Some(folder) = self.branch_folder(&id) else { return };
                let Some(repo) = self.state.project(&id).map(|p| PathBuf::from(&p.path)) else { return };
                let Some(chat) = state::chat_of(&id).and_then(|c| c.parse::<u32>().ok()) else { return };
                // The agent first: its terminals and processes would hold the folder open.
                self.stop(&id, Phase::Stopped);
                self.runtime.remove(&id);
                if let Err(text) = branches::remove(&repo, Path::new(&folder), force) {
                    send(webview, json!({ "type": "notice", "level": "error", "text": format!("Could not remove {folder}: {text}. If a program still has it open, close that first.") }));
                    send(webview, self.statuses());
                    return;
                }
                if let Some(p) = self.state.project_mut(&id) {
                    p.last_chat = p.last_chat.max(chat);
                    p.chats.retain(|c| c.id != chat);
                }
                self.delete_chat_folder(&id, webview);
                let first = state::project_of(&id).to_string();
                if self.active.as_deref() == Some(id.as_str()) {
                    self.select(&first, webview);
                    send(webview, json!({ "type": "select", "id": first }));
                }
                self.state.save(&self.paths);
                self.push_projects(webview);
                send(webview, json!({ "type": "removed", "id": id }));
                send(webview, self.statuses());
                send(webview, json!({ "type": "notice", "level": "info", "text": format!("Closed the branch folder {folder}. The branch is still in the repository.") }));
            }
            Command::RenameChat { id, name } => {
                // Any chat, the first included - it is the codebase's own id, and its name is kept on the
                // codebase. Kept short: it is a tab label, and a notification title.
                let name: String = name.trim().chars().filter(|c| !c.is_control()).take(60).collect();
                if !name.is_empty() {
                    match state::chat_of(&id).map(|c| c.parse::<u32>().ok()) {
                        None => {
                            if let Some(p) = self.state.project_mut(&id) {
                                p.first_chat_name = Some(name);
                            }
                        }
                        Some(Some(chat)) => {
                            if let Some(c) = self.state.project_mut(&id).and_then(|p| p.chats.iter_mut().find(|c| c.id == chat)) {
                                c.name = name;
                            }
                        }
                        Some(None) => {}
                    }
                    self.state.save(&self.paths);
                    self.push_projects(webview);
                }
            }
            Command::Instructions { id } => {
                let Some(project) = self.state.project(&id) else { return };
                let pid = project.id.clone();
                let text = std::fs::read_to_string(self.paths.instructions_file(&pid)).unwrap_or_default();
                send(webview, json!({ "type": "instructions", "id": pid, "text": text.trim_start_matches('\u{feff}') }));
            }
            Command::SaveInstructions { id, text } => {
                let Some(project) = self.state.project(&id) else { return };
                let pid = project.id.clone();
                // Read in full by every chat on every request; the host cuts at 20,000 characters and
                // says so. This only refuses what cannot be meant.
                let result = if text.len() > 200_000 {
                    Err("Codebase instructions are limited to 200 KB - they are sent with every request.".to_string())
                } else {
                    state::write_atomic(&self.paths.instructions_file(&pid), &text.replace("\r\n", "\n"))
                };
                match result {
                    Ok(()) => send(webview, json!({ "type": "instructionsSaved", "id": pid, "ok": true })),
                    Err(error) => send(webview, json!({ "type": "instructionsSaved", "id": pid, "ok": false, "error": error })),
                }
            }
            Command::ProjectAccent { id, accent } => {
                let valid = accent.filter(|a| a.len() == 7 && a.starts_with('#') && a[1..].chars().all(|c| c.is_ascii_hexdigit()));
                if let Some(p) = self.state.project_mut(&id) {
                    p.accent = valid.map(|a| a.to_lowercase());
                }
                self.state.save(&self.paths);
                self.push_projects(webview);
            }
            Command::SetIcon { size, rgba, png } => {
                // The title bar and taskbar follow the accent. The exe's own icon (Explorer, a pinned
                // shortcut) is fixed at build time and stays the orange one.
                if let Some(pixels) = system::base64_decode(&rgba) {
                    if pixels.len() == (size * size * 4) as usize {
                        if let Ok(icon) = Icon::from_rgba(pixels, size, size) {
                            window.set_window_icon(Some(icon));
                        }
                    }
                }
                if let Some(bytes) = system::base64_decode(&png) {
                    let _ = std::fs::write(&self.icon_file, bytes);
                }
            }
            Command::OpenExternal { url } => {
                if url.starts_with("https://") || url.starts_with("http://") {
                    system::open_with_default_app(&url);
                }
            }
        }
    }

    /// The `config.json` a codebase will be given, and what to record as its source.
    fn resolve_config(&self, id: &str, mode: ConfigMode, source: Option<&str>) -> Result<(String, Option<String>), String> {
        let own = self.paths.project_dir(id).join("config.json");
        match mode {
            ConfigMode::New => Ok((own.to_string_lossy().into_owned(), None)),
            ConfigMode::Link => {
                let source = source.ok_or("Choose the config to link to.")?;
                if !Path::new(source).is_file() {
                    return Err(format!("{source} was not found."));
                }
                Ok((source.to_string(), Some(source.to_string())))
            }
            ConfigMode::Copy => {
                let source = source.ok_or("Choose the config to copy.")?;
                std::fs::create_dir_all(self.paths.project_dir(id)).map_err(|e| e.to_string())?;
                if own.is_file() {
                    // Kept rather than overwritten: it may hold settings made since the last copy.
                    let _ = std::fs::rename(&own, own.with_extension(format!("json.{}.bak", state::now_millis())));
                }
                std::fs::copy(source, &own).map_err(|e| format!("Could not copy {source}: {e}"))?;
                Ok((own.to_string_lossy().into_owned(), Some(source.to_string())))
            }
        }
    }

    fn add(&mut self, path: String, name: String, mode: ConfigMode, source: Option<String>, webview: &WebView) {
        if !Path::new(&path).is_dir() {
            send(webview, json!({ "type": "addResult", "ok": false, "text": format!("{path} is not a folder.") }));
            return;
        }
        if let Some(existing) = self.state.projects.iter().find(|p| configs::same_path(&p.path, &path)).map(|p| p.id.clone()) {
            send(webview, json!({ "type": "addResult", "ok": true, "id": existing }));
            self.select(&existing, webview);
            return;
        }
        let id = state::new_id();
        let (config_file, config_source) = match self.resolve_config(&id, mode, source.as_deref()) {
            Ok(r) => r,
            Err(text) => {
                send(webview, json!({ "type": "addResult", "ok": false, "text": text }));
                return;
            }
        };
        let name = if name.trim().is_empty() { folder_name(&path) } else { name.trim().to_string() };
        self.state.projects.push(Project {
            id: id.clone(),
            name,
            path,
            config_mode: mode,
            config_file,
            config_source,
            keep_awake: false,
            last_used: state::now_millis(),
            accent: None,
            chats: Vec::new(),
            first_chat_name: None,
            hub: None,
            archived: Vec::new(),
            last_chat: 0,
        });
        self.state.save(&self.paths);
        self.push_projects(webview);
        send(webview, json!({ "type": "addResult", "ok": true, "id": id }));
        self.select(&id, webview);
    }

    /// The credential a hub codebase's token lives in: the one chosen, or a typed token saved as
    /// "JupyterHub <user>@<host>" (replacing that credential's value when it already exists).
    fn hub_credential(&self, input: &hub::HubInput, settings: &hub::HubSettings, keep: Option<String>) -> Result<String, String> {
        if let Some(token) = input.token.as_ref().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
            let label = hub::credential_label(settings);
            let mut values = BTreeMap::new();
            values.insert("value".to_string(), token);
            return self.vault.save(self.vault.find_label(&label), &label, "secret", Some("JupyterHub API token".into()), &values);
        }
        if let Some(id) = input.credential.as_ref().filter(|c| !c.is_empty()) {
            return Ok(id.clone());
        }
        keep.ok_or_else(|| "Paste a JupyterHub token, or choose a saved credential that holds one.".to_string())
    }

    fn add_hub(&mut self, name: String, input: hub::HubInput, mode: ConfigMode, source: Option<String>, webview: &WebView) {
        let fail = |text: String| send(webview, json!({ "type": "addResult", "ok": false, "text": text }));
        let mut settings = match hub::validate(&input) {
            Ok(s) => s,
            Err(text) => return fail(text),
        };
        let id = state::new_id();
        settings.credential = match self.hub_credential(&input, &settings, None) {
            Ok(c) => Some(c),
            Err(text) => return fail(text),
        };
        let (config_file, config_source) = match self.resolve_config(&id, mode, source.as_deref()) {
            Ok(r) => r,
            Err(text) => return fail(text),
        };
        // The local copy lives in Fire Code's own data, one folder per codebase.
        let local = self.paths.hub_copy(&id);
        if let Err(e) = std::fs::create_dir_all(&local) {
            return fail(format!("Could not create {}: {e}", local.display()));
        }
        let name = if name.trim().is_empty() {
            settings.folders.first().and_then(|f| f.rsplit('/').next()).filter(|f| !f.is_empty()).unwrap_or(&settings.user).to_string()
        } else {
            name.trim().to_string()
        };
        self.state.projects.push(Project {
            id: id.clone(),
            name,
            path: local.to_string_lossy().to_string(),
            config_mode: mode,
            config_file,
            config_source,
            keep_awake: false,
            last_used: state::now_millis(),
            accent: None,
            chats: Vec::new(),
            first_chat_name: None,
            hub: Some(settings),
            archived: Vec::new(),
            last_chat: 0,
        });
        self.state.save(&self.paths);
        self.push_projects(webview);
        send(webview, json!({ "type": "addResult", "ok": true, "id": id }));
        self.select(&id, webview);
    }

    fn update_hub(&mut self, id: &str, input: hub::HubInput, webview: &WebView) {
        let Some(previous) = self.state.project(id).and_then(|p| p.hub.clone()) else { return };
        let result = hub::validate(&input).and_then(|mut settings| {
            settings.credential = Some(self.hub_credential(&input, &settings, previous.credential.clone())?);
            Ok(settings)
        });
        match result {
            Ok(settings) => {
                if let Some(p) = self.state.project_mut(id) {
                    p.hub = Some(settings);
                }
                self.state.save(&self.paths);
                self.push_projects(webview);
                send(webview, json!({ "type": "notice", "level": "info", "text": "JupyterHub settings saved. The agent restarts with them." }));
                for key in self.state.chat_keys(id) {
                    if self.runtime.get(&key).map(|r| r.process.is_some()).unwrap_or(false) {
                        self.stop(&key, Phase::Stopped);
                        self.start(&key, webview);
                    }
                }
            }
            Err(text) => send(webview, json!({ "type": "notice", "level": "error", "text": text })),
        }
    }

    fn select(&mut self, id: &str, webview: &WebView) {
        if !self.state.has_chat(id) {
            return;
        }
        // Looking at it is when its counts matter most.
        self.refresh_git(Some(state::project_of(id).to_string()));
        self.active = Some(id.to_string());
        if let Some(p) = self.state.project_mut(id) {
            p.last_used = state::now_millis();
        }
        self.state.settings.last_project = Some(id.to_string());
        self.state.save(&self.paths);
        let rt = self.runtime.entry(id.to_string()).or_insert_with(Runtime::new);
        rt.unread = false;
        rt.last_activity = Instant::now();
        // You are looking at it: it sleeps on the ordinary rule now, not the schedule's.
        rt.woke_for_schedule = false;
        // A failed agent waits for Restart rather than looping on a fault the user has not seen.
        if matches!(rt.phase, Phase::Stopped | Phase::Sleeping) {
            self.start(id, webview);
        } else {
            send(webview, self.statuses());
        }
    }

    fn start(&mut self, id: &str, webview: &WebView) {
        let Some(project) = self.state.project(id).cloned() else { return };
        let rt = self.runtime.entry(id.to_string()).or_insert_with(Runtime::new);
        if rt.process.is_some() {
            return;
        }
        if matches!(self.script, ScriptState::Running) {
            // Shown as starting; it starts when the script has said what the environment is.
            rt.phase = Phase::Starting;
            rt.error = None;
            if !self.waiting.iter().any(|w| w == id) {
                self.waiting.push(id.to_string());
            }
            send(webview, self.statuses());
            return;
        }
        let workspace = self.state.chat_folder(id).unwrap_or_else(|| project.path.clone());
        if !Path::new(&workspace).is_dir() {
            rt.phase = Phase::Failed;
            rt.error = Some(if workspace != project.path {
                format!("The branch folder {workspace} no longer exists. Close this chat, or open the branch again with New chat on a branch.")
            } else {
                format!("The folder {} no longer exists. Remove it from Fire Code, or restore the folder.", project.path)
            });
            send(webview, self.statuses());
            return;
        }
        rt.generation += 1;
        rt.phase = Phase::Starting;
        rt.agent = "idle".into();
        rt.error = None;
        rt.url = None;
        rt.last_activity = Instant::now();
        let script: &[(String, String)] = match &self.script {
            ScriptState::Done(done) => &done.vars,
            _ => &[],
        };
        let environment = environment::resolve(&self.state.settings.path_prefix, &self.state.settings.env, &self.vault, script);
        if !environment.problems.is_empty() && !self.env_warned {
            self.env_warned = true;
            send(webview, json!({ "type": "notice", "level": "error", "text": environment.problems.join(" ") }));
        }
        let proxy = self.proxy.clone();
        let spec = LaunchSpec {
            id: id.to_string(),
            generation: rt.generation,
            node: system::node_executable(),
            host_script: system::host_script(),
            workspace,
            data_dir: self.paths.project_dir(id),
            config_file: project.config_file.clone(),
            secrets_file: self.paths.secrets_file(),
            log_file: self.paths.log_file(id),
            frame_ancestor: SHELL_ORIGIN.to_string(),
            ripgrep: system::bundled_ripgrep(),
            vault_key: self.vault.key_hex(),
            credentials_file: self.vault.credentials_file().clone(),
            reach_anywhere: self.state.settings.reach_anywhere,
            fast_fs: system::fast_fs(),
            env: environment.vars,
            path: environment.path,
            no_schedules: state::chat_of(id).is_some(),
            change_ledger: self.paths.project_dir(state::project_of(id)).join("changes.jsonl"),
            mirror_dir: self.paths.root.join("mirrors"),
            codebase_dir: self.paths.codebase_dir(id),
            approved_tools: system::shared_approvals_file(),
            jupyter_hub: match &project.hub {
                Some(settings) => {
                    let file = self.paths.project_dir(state::project_of(id)).join("jupyterhub.json");
                    let pointed = settings
                        .credential
                        .as_ref()
                        .map(|c| self.vault.point(&hub::token_slot(&project.id), c, "value"))
                        .unwrap_or(Ok(()));
                    match pointed.and_then(|()| hub::write_spec(&file, settings, &project.id)) {
                        Ok(()) => Some(file),
                        Err(text) => {
                            send(webview, json!({ "type": "notice", "level": "error", "text": format!("JupyterHub settings for {}: {text}", project.name) }));
                            None
                        }
                    }
                }
                None => None,
            },
            mention_name: state::mention_names(&self.state.projects)
                .into_iter()
                .find(|(pid, _)| *pid == project.id)
                .map(|(_, name)| name)
                .unwrap_or_default(),
            chat_label: match state::chat_of(id) {
                Some(chat) => project.chats.iter().find(|c| c.id.to_string() == chat).map(|c| c.name.clone()).unwrap_or_else(|| format!("Chat {chat}")),
                None => project.first_chat_name.clone().unwrap_or_else(|| "Chat 1".to_string()),
            },
            // Each other hub codebase's settings, written and its token slot pointed exactly as its own
            // launch does, so this codebase can browse that hub. A failure costs that one hub only.
            sibling_hubs: {
                let names = state::mention_names(&self.state.projects);
                self.state
                    .projects
                    .iter()
                    .zip(names)
                    .filter(|(p, _)| p.id != project.id)
                    .filter_map(|(p, (_, name))| {
                        let settings = p.hub.as_ref()?;
                        let file = self.paths.project_dir(&p.id).join("jupyterhub.json");
                        if let Some(credential) = &settings.credential {
                            self.vault.point(&hub::token_slot(&p.id), credential, "value").ok()?;
                        }
                        let _ = std::fs::create_dir_all(self.paths.project_dir(&p.id));
                        hub::write_spec(&file, settings, &p.id).ok()?;
                        Some((name, file))
                    })
                    .collect()
            },
            siblings: {
                let names = state::mention_names(&self.state.projects);
                self.state
                    .projects
                    .iter()
                    .zip(names)
                    .filter(|(p, _)| p.id != project.id && Path::new(&p.path).is_dir())
                    .map(|(p, (_, name))| (name, p.path.clone()))
                    .collect()
            },
            monitoring: self.monitoring.settings.enabled,
            monitor_executor: false,
            extra_tool_folders: Vec::new(),
        };
        match host::launch(spec, move |event| {
            let _ = proxy.send_event(UserEvent::Host(event));
        }) {
            Ok(process) => rt.process = Some(process),
            Err(error) => {
                rt.phase = Phase::Failed;
                rt.error = Some(error);
            }
        }
        send(webview, self.statuses());
    }

    /// Ends the codebase's whole process tree. The generation moves on first, so the exit that
    /// follows is recognised as asked-for rather than reported as a crash.
    /// Deletes a closed chat's folder - its conversations, reports and log. Only an extra chat's
    /// (`<id>~<n>`, under `projects/<id>/chats/`), never a codebase's own. In the background with
    /// retries: the agent was just stopped and Windows keeps its files locked for a moment. A folder
    /// that cannot be deleted is left; its number is never handed out again, so it is never reopened.
    /// A branch chat's folder; None for a chat working in the codebase's own folder.
    /// Another chat on a codebase - blank, or an archived one (`archived`, its number) brought back - opened on
    /// screen. `name` names a blank one ("Alert: ..." from monitoring). Its key, `<id>~<n>`.
    pub fn new_chat(&mut self, id: &str, archived: Option<u32>, name: Option<String>, webview: &WebView) -> Option<String> {
        let on_disk = state::chat_numbers_on_disk(&self.paths.project_dir(state::project_of(id)));
        let p = self.state.project_mut(id)?;
        let next = match archived.and_then(|n| p.archived.iter().position(|c| c.id == n)) {
            // Back from the archive under its own number, so its folder - and conversation - come with it.
            Some(at) => {
                let chat = p.archived.remove(at);
                p.chats.push(state::Chat { id: chat.id, name: chat.name, folder: chat.folder, branch: chat.branch });
                chat.id
            }
            // Blank: a number no chat has ever had, so no old folder is opened.
            None => {
                let next = p.next_chat_id(&on_disk);
                p.last_chat = next;
                p.chats.push(state::Chat { id: next, name: name.unwrap_or_else(|| format!("Chat {next}")), folder: None, branch: None });
                next
            }
        };
        let key = format!("{}~{}", p.id, next);
        self.state.save(&self.paths);
        self.push_projects(webview);
        self.select(&key, webview);
        send(webview, json!({ "type": "select", "id": key }));
        Some(key)
    }

    fn branch_folder(&self, key: &str) -> Option<String> {
        let p = self.state.project(key)?;
        let chat = state::chat_of(key)?;
        p.chats.iter().find(|c| c.id.to_string() == chat)?.folder.clone()
    }

    fn delete_chat_folder(&self, key: &str, _webview: &WebView) {
        if state::chat_of(key).and_then(|c| c.parse::<u32>().ok()).is_none() {
            return;
        }
        let dir = self.paths.project_dir(key);
        std::thread::spawn(move || {
            for _ in 0..40 {
                if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        });
    }

    fn stop(&mut self, id: &str, phase: Phase) {
        if let Some(rt) = self.runtime.get_mut(id) {
            rt.generation += 1;
            if let Some(process) = rt.process.take() {
                process.stop();
            }
            rt.phase = phase;
            rt.url = None;
            rt.agent = "idle".into();
            rt.memory = 0;
        }
    }

    fn handle_host(&mut self, event: HostEvent, webview: &WebView) {
        match event {
            HostEvent::Monitor { id, generation, payload } => self.monitor_line(&id, generation, payload, webview),
            // The executor has no page and no sidebar row: only its exit matters.
            HostEvent::Url { id, .. } if id == monitoring::EXECUTOR_ID => {}
            HostEvent::Notify { id, .. } if id == monitoring::EXECUTOR_ID => {}
            HostEvent::Exited { id, generation, tail, .. } if id == monitoring::EXECUTOR_ID => self.executor_exited(generation, &tail, webview),
            HostEvent::Url { id, generation, url } => {
                let Some(rt) = self.runtime.get_mut(&id) else { return };
                if rt.generation != generation {
                    return;
                }
                rt.phase = Phase::Running;
                rt.url = Some(url.clone());
                send(webview, json!({ "type": "url", "id": id, "url": url }));
                send(webview, self.statuses());
            }
            HostEvent::Exited { id, generation, code, tail } => {
                let Some(rt) = self.runtime.get_mut(&id) else { return };
                if rt.generation != generation {
                    return;
                }
                rt.process = None;
                rt.url = None;
                rt.phase = Phase::Failed;
                rt.error = Some(format!(
                    "The agent process stopped{}.\n\n{}",
                    code.map(|c| format!(" (exit code {c})")).unwrap_or_default(),
                    tail
                ));
                send(webview, json!({ "type": "unload", "id": id }));
                send(webview, self.statuses());
                if self.state.settings.notifications {
                    if let Some(title) = self.state.chat_title(&id) {
                        let proxy = self.proxy.clone();
                        let pid = id.clone();
                        system::notify(&title, "The agent stopped unexpectedly.", Some("Open Fire Code to see why and restart it."), &self.icon_file, &[], move |action| {
                            let _ = proxy.send_event(UserEvent::Toast { id: pid.clone(), action });
                        });
                    }
                }
            }
            HostEvent::Notify { id, message, level, report_path } => {
                if let Some(rt) = self.runtime.get_mut(&id) {
                    if self.active.as_deref() != Some(id.as_str()) || !self.focused {
                        rt.unread = true;
                    }
                }
                let Some(title) = self.state.chat_title(&id) else { return };
                if !self.state.settings.notifications {
                    return;
                }
                let proxy = self.proxy.clone();
                let pid = id.clone();
                let report_action = report_path.map(|r| format!("report:{r}"));
                let mut buttons: Vec<(&str, &str)> = Vec::new();
                if let Some(action) = report_action.as_deref() {
                    buttons.push(("Open report", action));
                }
                let detail = if level == "warning" { Some("Warning") } else { None };
                system::notify(&title, &message, detail, &self.icon_file, &buttons, move |action| {
                    let _ = proxy.send_event(UserEvent::Toast { id: pid.clone(), action });
                });
                send(webview, self.statuses());
            }
        }
    }

    fn agent_state(&mut self, id: &str, agent: String, finished: bool, reason: Option<String>, window: &Window, webview: &WebView) {
        let away = self.active.as_deref() != Some(id) || !self.focused;
        let Some(rt) = self.runtime.get_mut(id) else { return };
        let changed = rt.agent != agent;
        let was_busy = rt.agent == "busy";
        rt.agent = agent.clone();
        rt.last_activity = Instant::now();
        // Only the three words the page may send; anything else is no reason at all.
        rt.waiting_for = if agent == "attention" {
            reason.filter(|r| matches!(r.as_str(), "approval" | "form" | "question"))
        } else {
            None
        };
        let waiting_for = rt.waiting_for.clone();
        if changed && agent == "attention" && !self.focused {
            // The taskbar button flashes until Fire Code is brought forward.
            window.request_user_attention(Some(tao::window::UserAttentionType::Informational));
        }
        if was_busy && agent != "busy" {
            // An agent just stopped working: it may have changed files.
            self.refresh_git(Some(state::project_of(id).to_string()));
        }
        let Some(rt) = self.runtime.get_mut(id) else { return };
        if away && (finished || (changed && agent == "attention")) {
            rt.unread = true;
            if self.state.settings.notifications {
                if let Some(title) = self.state.chat_title(id) {
                    let body = match (agent.as_str(), waiting_for.as_deref()) {
                        ("attention", Some("question")) => "Asked you a question and is waiting for your answer.",
                        ("attention", Some("form")) => "Waiting for you to fill in a form.",
                        ("attention", _) => "Waiting for your approval.",
                        _ => "The agent has finished.",
                    };
                    let proxy = self.proxy.clone();
                    let pid = id.to_string();
                    system::notify(&title, body, None, &self.icon_file, &[], move |action| {
                        let _ = proxy.send_event(UserEvent::Toast { id: pid.clone(), action });
                    });
                }
            }
        }
        send(webview, self.statuses());
        self.update_title(window);
    }

    /// "Fire Code — 2 waiting" in the title bar and taskbar, while any agent is waiting for you.
    fn update_title(&self, window: &Window) {
        let waiting = self.runtime.values().filter(|r| r.process.is_some() && r.agent == "attention").count();
        let alerts = self.monitor_alert_count();
        let mut parts = Vec::new();
        if waiting > 0 {
            parts.push(format!("{waiting} waiting for you"));
        }
        if alerts > 0 {
            parts.push(format!("{alerts} alert{}", if alerts == 1 { "" } else { "s" }));
        }
        window.set_title(&if parts.is_empty() { "Fire Code".to_string() } else { format!("Fire Code — {}", parts.join(" · ")) });
    }

    fn tick(&mut self, window: &Window, webview: &WebView) {
        self.update_title(window);
        self.monitor_tick(webview);
        self.ticks += 1;
        for rt in self.runtime.values_mut() {
            rt.memory = rt.process.as_ref().map(|p| p.memory()).unwrap_or(0);
        }
        // Every 30 seconds: what git says has changed in each codebase.
        if self.ticks % 10 == 5 {
            self.refresh_git(None);
        }
        // Every 15 seconds: wake a codebase whose schedule is about to come due.
        if self.ticks % 5 == 0 {
            self.wake_for_schedules(webview);
        }
        // Every 30 seconds: put idle codebases to sleep.
        if self.ticks % 10 == 0 {
            let limit = Duration::from_secs(self.state.settings.sleep_minutes as u64 * 60);
            let now = state::now_millis();
            let sleepy: Vec<String> = self
                .runtime
                .iter()
                .filter(|(id, rt)| {
                    // Woken only to run a schedule: back to sleep two idle minutes after it.
                    let idle_for = if rt.woke_for_schedule { Duration::from_secs(120) } else { limit };
                    let sleeping_allowed = rt.woke_for_schedule || self.state.settings.sleep_minutes > 0;
                    sleeping_allowed
                        && rt.phase == Phase::Running
                        && rt.agent == "idle"
                        && rt.last_activity.elapsed() >= idle_for
                        && self.active.as_deref() != Some(id.as_str())
                })
                .filter(|(id, _)| {
                    let Some(p) = self.state.project(id) else { return false };
                    if p.keep_awake {
                        return false;
                    }
                    // A schedule's first chat stays up while a run is going or one is near.
                    if state::chat_of(id).is_none() {
                        if configs::schedule_running(&self.paths.project_dir(id)) {
                            return false;
                        }
                        let s = configs::schedule_state(&p.config_file, &p.path);
                        if s.unreadable || s.unarmed || s.next_due.map(|d| d <= now + 10 * 60 * 1000).unwrap_or(false) {
                            return false;
                        }
                    }
                    true
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in sleepy {
                self.stop(&id, Phase::Sleeping);
                send(webview, json!({ "type": "unload", "id": id }));
            }
        }
        send(webview, self.statuses());
    }

    fn update_report_roots(&self) {
        let roots = std::iter::once(self.paths.root.clone()).chain(self.state.projects.iter().map(|p| PathBuf::from(&p.path))).collect();
        if let Ok(mut current) = REPORT_ROOTS.write() {
            *current = roots;
        }
    }

    /// A report in Fire Code's viewer. One Fire Code cannot show - outside its folder, not text, too large -
    /// goes to the default app as before, so "Open report" never does nothing.
    fn show_report(&self, path: &str, webview: &WebView) {
        match reports::read(&report_roots(), path) {
            Ok((real, text)) => {
                let shown = reports::plain(&real);
                let name = real.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                send(webview, json!({ "type": "report", "path": shown, "name": name, "text": text, "kind": reports::kind(&real) }));
            }
            Err(text) => {
                if Path::new(path).is_file() {
                    system::open_with_default_app(path);
                } else {
                    send(webview, json!({ "type": "notice", "level": "error", "text": text }));
                }
            }
        }
    }

    /// `git status` for one codebase, or all of them, in the background. Skipped while the last
    /// refresh is still running - a huge repository is then simply refreshed less often.
    fn refresh_git(&self, only: Option<String>) {
        use std::sync::atomic::Ordering;
        if self.git_busy.swap(true, Ordering::SeqCst) {
            return;
        }
        let folders: Vec<(String, String)> = self
            .state
            .projects
            .iter()
            .filter(|p| only.as_deref().map(|o| o == p.id).unwrap_or(true))
            .map(|p| (p.id.clone(), p.path.clone()))
            .collect();
        let busy = self.git_busy.clone();
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let results = folders.into_iter().map(|(id, path)| (id, git::status(&path))).collect();
            busy.store(false, Ordering::SeqCst);
            let _ = proxy.send_event(UserEvent::Git(results));
        });
    }

    /// Commit and push (with a message) or pull, for a codebase's own buttons. In the background:
    /// a push can take as long as the network does, and the window must not stop answering.
    fn git_action(&self, id: &str, message: Option<String>) {
        let Some(project) = self.state.project(id) else { return };
        let folder = project.path.clone();
        let id = state::project_of(id).to_string();
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let result = match message {
                Some(message) => git::commit_and_push(&folder, &message),
                None => git::pull(&folder),
            };
            let (ok, text) = match result {
                Ok(text) => (true, text),
                Err(text) => (false, text),
            };
            let _ = proxy.send_event(UserEvent::GitDone { id, ok, text });
        });
    }

    fn git_message(&self) -> Value {
        json!({ "type": "git", "git": self.git })
    }

    /// Runs the startup script in the background, if one is set. Agents wait for it (see start).
    fn run_startup_script(&mut self) {
        let Some(script) = self.state.settings.startup_script.clone() else {
            self.script = ScriptState::None;
            return;
        };
        self.script = ScriptState::Running;
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let _ = proxy.send_event(UserEvent::ScriptDone(environment::run_script(&script)));
        });
    }

    fn script_done(&mut self, result: Result<environment::ScriptEnv, String>, webview: &WebView) {
        match result {
            Ok(done) => {
                if done.exit_code != 0 {
                    send(
                        webview,
                        json!({ "type": "notice", "level": "error", "text": format!(
                            "The startup script ended with exit code {}. What it set is still applied.\n{}",
                            done.exit_code, done.output_tail
                        ) }),
                    );
                }
                self.script = ScriptState::Done(done);
            }
            Err(text) => {
                send(webview, json!({ "type": "notice", "level": "error", "text": format!("{text}\nAgents start without it.") }));
                self.script = ScriptState::Failed(text);
            }
        }
        send(webview, self.script_status());
        let running = self.runtime.values().filter(|r| r.process.is_some()).count();
        for key in std::mem::take(&mut self.waiting) {
            if self.runtime.get(&key).map(|r| r.process.is_none() && r.phase == Phase::Starting).unwrap_or(false) {
                self.start(&key, webview);
            }
        }
        if running > 0 {
            send(webview, json!({ "type": "scriptRanWithAgents", "running": running }));
        }
    }

    /// For the page: names only, never values - a script may set a token.
    fn script_status(&self) -> Value {
        let script = self.state.settings.startup_script.clone();
        match &self.script {
            ScriptState::None => json!({ "type": "scriptStatus", "state": "none", "script": script }),
            ScriptState::Running => json!({ "type": "scriptStatus", "state": "running", "script": script }),
            ScriptState::Failed(text) => json!({ "type": "scriptStatus", "state": "failed", "script": script, "detail": text }),
            ScriptState::Done(done) => {
                let names: Vec<&str> = done.vars.iter().map(|(k, _)| k.as_str()).filter(|k| !k.eq_ignore_ascii_case("PATH")).collect();
                let path_changed = done.vars.iter().any(|(k, _)| k.eq_ignore_ascii_case("PATH"));
                json!({
                    "type": "scriptStatus", "state": "done", "script": script, "names": names,
                    "pathChanged": path_changed, "exitCode": done.exit_code, "output": done.output_tail,
                })
            }
        }
    }

    /// Fire Code's own schedule timer. A codebase holding a schedule no longer has to stay awake all day
    /// to run it: Fire Code reads when each is due and starts that codebase's first chat a minute before,
    /// whether it was asleep or never started this session. The host then runs the job exactly as
    /// it always has, including one missed while the PC slept (it is overdue, so due at once).
    fn wake_for_schedules(&mut self, webview: &WebView) {
        let now = state::now_millis();
        let due: Vec<String> = self
            .state
            .projects
            .iter()
            .filter(|p| Path::new(&p.path).is_dir())
            .filter(|p| {
                let s = configs::schedule_state(&p.config_file, &p.path);
                s.unarmed || s.next_due.map(|d| d <= now + 60 * 1000).unwrap_or(false)
            })
            .map(|p| p.id.clone())
            .collect();
        for id in due {
            let rt = self.runtime.entry(id.clone()).or_insert_with(Runtime::new);
            if rt.process.is_some() || rt.phase == Phase::Failed {
                continue;
            }
            rt.woke_for_schedule = true;
            self.start(&id, webview);
        }
    }

    /// The codebase last open, at once; the next two most recent shortly after, so they are ready
    /// before they are clicked without competing with the first for the disk.
    fn start_on_launch(&mut self) {
        if self.launched {
            return;
        }
        self.launched = true;
        let first = self.state.settings.last_project.clone().filter(|id| self.state.has_chat(id));
        if let Some(id) = &first {
            let _ = self.proxy.send_event(UserEvent::Select(id.clone()));
        }
        if !self.state.settings.start_recent {
            return;
        }
        let mut recent: Vec<&Project> = self.state.projects.iter().filter(|p| Some(&p.id) != first.as_ref()).collect();
        recent.sort_by(|a, b| b.last_used.cmp(&a.last_used));
        for (n, p) in recent.into_iter().take(2).enumerate() {
            let proxy = self.proxy.clone();
            let id = p.id.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500 + 1000 * n as u64));
                let _ = proxy.send_event(UserEvent::StartLater(id));
            });
        }
    }

    fn export_source(&self, window: &Window, webview: &WebView) {
        let Some(archive) = system::source_archive() else {
            send(webview, json!({ "type": "notice", "level": "error", "text": "This build carries no source archive. Packaged builds of Fire Code include one." }));
            return;
        };
        let target = rfd::FileDialog::new()
            .set_title("Save the Light Code source")
            .set_file_name(format!("light-code-source-{VERSION}.zip"))
            .add_filter("Zip archive", &["zip"])
            .set_parent(window)
            .save_file();
        let Some(target) = target else { return };
        match std::fs::copy(&archive, &target) {
            Ok(_) => {
                send(webview, json!({ "type": "notice", "level": "info", "text": format!("Source saved to {}. Extract it to a short path and open START_HERE.md.", target.display()) }));
            }
            Err(error) => send(webview, json!({ "type": "notice", "level": "error", "text": format!("Could not save to {}: {error}", target.display()) })),
        }
    }

    fn remember_window(&mut self, window: &Window) {
        if window.is_minimized() {
            return;
        }
        let maximized = window.is_maximized();
        let previous = self.state.settings.window.clone();
        let bounds = if maximized {
            // Keep the restored size, so un-maximizing next time lands where it was.
            previous.map(|mut b| {
                b.maximized = true;
                b
            })
        } else {
            let size = window.inner_size();
            let position = window.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
            Some(state::WindowBounds { x: position.x, y: position.y, width: size.width, height: size.height, maximized: false })
        };
        if bounds.is_some() {
            self.state.settings.window = bounds;
        }
    }
}

#[cfg(test)]
mod command_tests {
    use super::*;

    /// The page sees a codebase only through `project_views`, which is written out field by field - so a
    /// field added to `Project` reaches the page only if it is added there too. `first_chat_name` was not:
    /// renaming the first chat was saved and never shown. Every saved field must be sent, or listed here.
    #[test]
    fn every_saved_codebase_field_reaches_the_page() {
        let main = include_str!("main.rs");
        let start = main.find("fn project_views").unwrap();
        let body = &main[start..start + main[start..].find("fn push_projects").unwrap()];
        let state = include_str!("state.rs");
        let s = state.find("pub struct Project {").unwrap();
        let fields = &state[s..s + state[s..].find("\n}").unwrap()];
        // Not for the page: when it was last opened is Rust's own bookkeeping.
        // `last_chat`: the highest chat number handed out, so none is reused - Rust's too.
        let not_sent = ["last_used", "last_chat"];
        for line in fields.lines().map(str::trim).filter(|l| l.starts_with("pub ") && !l.contains("struct ")) {
            let name = line.trim_start_matches("pub ").split(':').next().unwrap();
            if not_sent.contains(&name) {
                continue;
            }
            let camel: String = name
                .split('_')
                .enumerate()
                .map(|(i, part)| if i == 0 { part.to_string() } else { part[..1].to_uppercase() + &part[1..] })
                .collect();
            assert!(body.contains(&format!("\"{camel}\"")), "Project.{name} is saved but never sent to the page as \"{camel}\"");
        }
    }

    /// The page sends camelCase; a struct variant's fields are not renamed by the enum's own
    /// `rename_all`, so each multi-word variant carries its own. A mismatch is a save that does nothing.
    #[test]
    fn the_environment_page_is_understood() {
        let body = r#"{"cmd":"saveEnvironment","pathPrefix":["C:\\tools"],"env":[{"name":"A","value":"1"},{"name":"T","credential":"c1#value"}]}"#;
        match serde_json::from_str::<Command>(body) {
            Ok(Command::SaveEnvironment { path_prefix, env, .. }) => {
                assert_eq!(path_prefix, vec![r"C:\tools".to_string()]);
                assert_eq!(env[1].credential.as_deref(), Some("c1#value"));
            }
            _ => panic!("saveEnvironment was not understood"),
        }
        assert!(matches!(serde_json::from_str::<Command>(r#"{"cmd":"checkFolders","pathPrefix":[]}"#), Ok(Command::CheckFolders { .. })));
        assert!(matches!(serde_json::from_str::<Command>(r#"{"cmd":"pickEnvFolder","index":2}"#), Ok(Command::PickEnvFolder { index: 2 })));
        assert!(matches!(serde_json::from_str::<Command>(r#"{"cmd":"restartAll"}"#), Ok(Command::RestartAll)));
    }
}

/// The user's Downloads folder, where a Save dialog starts: where people look for a saved file.
fn dirs_downloads() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE")?;
    let downloads = std::path::Path::new(&home).join("Downloads");
    downloads.is_dir().then_some(downloads)
}
