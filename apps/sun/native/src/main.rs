//! Sun Light Code: several codebases, each with its own Light Code agent, in one Windows window.
//!
//! The window is a WebView2 page (`ui/`) holding a sidebar and one frame per codebase. Each frame
//! is the ordinary Light Code browser UI, served by a Light Code Node host this process starts for
//! that codebase. So every tool and feature is the one the Node host already has, every agent runs
//! in its own process - truly in parallel, unaffected by which chat is on screen - and Sun itself is
//! only the window, the supervisor and the Windows integration.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod configs;
mod host;
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
/// What the page's own origin is on Windows, where wry maps `sun://` to `http://sun.localhost`.
const SHELL_ORIGIN: &str = "http://sun.localhost";

const INDEX_HTML: &str = include_str!("../ui/index.html");
const SHELL_CSS: &str = include_str!("../ui/shell.css");
const SHELL_JS: &str = include_str!("../ui/shell.js");
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
}

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Command {
    Ready,
    PickFolder,
    PickConfig,
    Sources,
    Add { path: String, name: String, mode: ConfigMode, source: Option<String> },
    Remove { id: String },
    Select { id: String },
    Start { id: String },
    Sleep { id: String },
    Restart { id: String },
    AgentState { id: String, state: String, finished: bool },
    Settings { patch: Value },
    KeepAwake { id: String, on: bool },
    Rename { id: String, name: String },
    Reorder { ids: Vec<String> },
    ChangeConfig { id: String, mode: ConfigMode, source: Option<String> },
    OpenVsCode { id: String },
    OpenExplorer { id: String },
    OpenLog { id: String },
    OpenDataFolder,
    ExportSource,
    OpenExternal { url: String },
    /// The icon drawn in the chosen accent: raw RGBA for the window, a PNG for notifications.
    SetIcon { size: u32, rgba: String, png: String },
    /// A codebase's own accent, or None to follow Sun's again.
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
}

fn main() {
    let paths = Paths::new();
    if system::hand_over_to_running_instance(&paths.root) {
        return;
    }
    let _ = std::fs::create_dir_all(&paths.root);
    let mut state = State::load(&paths);
    let vault = Arc::new(vault::Vault::open(&paths).unwrap_or_else(|e| system::fatal(&e)));

    let icon_file = paths.root.join("icon.png");
    let _ = std::fs::write(&icon_file, ICON_PNG);
    system::register_app_identity(&icon_file);

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let mut builder = WindowBuilder::new()
        .with_title("Sun Light Code")
        .with_min_inner_size(LogicalSize::new(720.0, 480.0))
        .with_transparent(true)
        .with_visible(false);
    if let Ok(icon) = Icon::from_resource(1, None) {
        builder = builder.with_window_icon(Some(icon));
    }
    // Saved bounds are used only while they still land on a connected monitor: a laptop undocked
    // from the screen Sun was last on must not open a window nobody can see.
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
        // Reload and friends would rebuild every chat frame; nothing in Sun needs them.
        .with_browser_accelerator_keys(false)
        .with_default_context_menus(cfg!(debug_assertions))
        .with_custom_protocol("sun".into(), |_id, request| serve(request))
        .with_ipc_handler(move |request: Request<String>| {
            let _ = ipc_proxy.send_event(UserEvent::Ipc(request.body().clone()));
        })
        // The shell itself never navigates away. Links a chat opens in a new window go to the browser.
        .with_navigation_handler(|url| url.starts_with(SHELL_ORIGIN) || url.starts_with("sun:") || url == "about:blank")
        .with_new_window_req_handler(|url, _features| {
            if url.starts_with("https://") || url.starts_with("http://") {
                system::open_with_default_app(&url);
            }
            NewWindowResponse::Deny
        })
        .build(&window)
        .unwrap_or_else(|e| {
            system::fatal(&format!(
                "Sun Light Code needs the Microsoft Edge WebView2 Runtime, which comes with Windows 11 and is \
                 installed with Edge on Windows 10. It could not be started ({e}).\n\nInstall it from Microsoft \
                 (search for \"WebView2 Runtime\"), or ask IT to, then start Sun again."
            ))
        });

    state.projects.retain(|p| !p.id.is_empty());

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
    };

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
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(3));
            if proxy.send_event(UserEvent::Tick).is_err() {
                break;
            }
        });
    }

    let mut shown = false;
    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
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
                if let Some(path) = action.as_deref().and_then(|a| a.strip_prefix("report:")) {
                    system::open_with_default_app(path);
                }
                window.set_minimized(false);
                window.set_visible(true);
                window.set_focus();
                app.select(&id, &webview);
                send(&webview, json!({ "type": "select", "id": id }));
            }
            Event::UserEvent(UserEvent::Tick) => app.tick(&webview),
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
                    *control_flow = ControlFlow::Exit;
                }
                WindowEvent::Focused(focused) => app.focused = focused,
                WindowEvent::Resized(_) | WindowEvent::Moved(_) => app.remember_window(&window),
                _ => {}
            },
            _ => {}
        }
    });
}

/// The shell's own files, from inside the exe. Nothing is fetched (invariant 4).
fn serve(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = request.uri().path();
    let (body, kind): (&'static str, &str) = match path {
        "/" | "/index.html" => (INDEX_HTML, "text/html; charset=utf-8"),
        "/shell.css" => (SHELL_CSS, "text/css; charset=utf-8"),
        "/shell.js" => (SHELL_JS, "text/javascript; charset=utf-8"),
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
        // Frames only from the hosts Sun started, which listen on loopback; nothing else at all.
        .header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; \
             frame-src http://127.0.0.1:*; connect-src 'self'; base-uri 'none'; form-action 'none'",
        )
        .body(Cow::Borrowed(body.as_bytes()))
        .unwrap()
}

/// The title bar and the Mica behind the sidebar follow Sun's theme, so a dark Sun on a light
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
        Value::Array(
            self.state
                .projects
                .iter()
                .map(|p| {
                    json!({
                        "id": p.id,
                        "name": p.name,
                        "path": p.path,
                        "configMode": p.config_mode,
                        "configFile": p.config_file,
                        "configSource": p.config_source,
                        "keepAwake": p.keep_awake,
                        "accent": p.accent,
                        "hasWorkspaceConfig": configs::has_workspace_config(&p.path),
                        "missing": !Path::new(&p.path).is_dir(),
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
                }),
            );
        }
        json!({ "type": "status", "statuses": map, "totalMemory": total })
    }

    /// The saved credentials and where each is used - names only, never a value.
    fn push_credentials(&self, webview: &WebView) {
        match self.vault.list() {
            Ok(list) => send(webview, json!({ "type": "credentials", "credentials": list, "pipe": share::pipe_name() })),
            Err(text) => send(webview, json!({ "type": "notice", "level": "error", "text": text })),
        }
    }

    fn push_projects(&self, webview: &WebView) {
        send(webview, json!({ "type": "projects", "projects": self.project_views() }));
    }

    fn handle_ipc(&mut self, body: &str, window: &Window, webview: &WebView) {
        let command: Command = match serde_json::from_str(body) {
            Ok(c) => c,
            Err(error) => {
                send(webview, json!({ "type": "notice", "level": "error", "text": format!("Sun did not understand a request: {error}") }));
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
            Command::Remove { id } => {
                self.runtime.remove(&id);
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
            Command::AgentState { id, state, finished } => self.agent_state(&id, state, finished, webview),
            Command::Settings { patch } => {
                let mut current = serde_json::to_value(&self.state.settings).unwrap_or(Value::Null);
                if let (Some(target), Some(changes)) = (current.as_object_mut(), patch.as_object()) {
                    for (k, v) in changes {
                        if k != "window" {
                            target.insert(k.clone(), v.clone());
                        }
                    }
                }
                if let Ok(settings) = serde_json::from_value::<state::Settings>(current) {
                    let theme_changed = settings.theme != self.state.settings.theme;
                    self.state.settings = settings;
                    self.state.save(&self.paths);
                    if theme_changed {
                        apply_theme(window, &self.state.settings.theme);
                    }
                }
                send(webview, json!({ "type": "settings", "settings": self.state.settings }));
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
                        // The host reads its settings file once, at start.
                        if self.runtime.get(&id).map(|r| r.process.is_some()).unwrap_or(false) {
                            self.stop(&id, Phase::Stopped);
                            self.start(&id, webview);
                        }
                    }
                    Err(text) => send(webview, json!({ "type": "notice", "level": "error", "text": text })),
                }
            }
            Command::OpenVsCode { id } => {
                if let Some(p) = self.state.project(&id) {
                    if !system::open_in_vscode(&p.path) {
                        send(webview, json!({ "type": "notice", "level": "error", "text": "VS Code's `code` command was not found on PATH." }));
                    }
                }
            }
            Command::OpenExplorer { id } => {
                if let Some(p) = self.state.project(&id) {
                    system::open_in_explorer(&p.path);
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
                        .add_filter("Sun Light Code credentials", &["sunkeys"])
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
                    .add_filter("Sun Light Code credentials", &["sunkeys"])
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
        });
        self.state.save(&self.paths);
        self.push_projects(webview);
        send(webview, json!({ "type": "addResult", "ok": true, "id": id }));
        self.select(&id, webview);
    }

    fn select(&mut self, id: &str, webview: &WebView) {
        if self.state.project(id).is_none() {
            return;
        }
        self.active = Some(id.to_string());
        if let Some(p) = self.state.project_mut(id) {
            p.last_used = state::now_millis();
        }
        self.state.settings.last_project = Some(id.to_string());
        self.state.save(&self.paths);
        let rt = self.runtime.entry(id.to_string()).or_insert_with(Runtime::new);
        rt.unread = false;
        rt.last_activity = Instant::now();
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
        if !Path::new(&project.path).is_dir() {
            rt.phase = Phase::Failed;
            rt.error = Some(format!("The folder {} no longer exists. Remove it from Sun, or restore the folder.", project.path));
            send(webview, self.statuses());
            return;
        }
        rt.generation += 1;
        rt.phase = Phase::Starting;
        rt.agent = "idle".into();
        rt.error = None;
        rt.url = None;
        rt.last_activity = Instant::now();
        let proxy = self.proxy.clone();
        let spec = LaunchSpec {
            id: id.to_string(),
            generation: rt.generation,
            node: system::node_executable(),
            host_script: system::host_script(),
            workspace: project.path.clone(),
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
                    if let Some(p) = self.state.project(&id) {
                        let proxy = self.proxy.clone();
                        let pid = id.clone();
                        system::notify(&p.name, "The agent stopped unexpectedly.", Some("Open Sun to see why and restart it."), &self.icon_file, &[], move |action| {
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
                let Some(p) = self.state.project(&id) else { return };
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
                system::notify(&p.name, &message, detail, &self.icon_file, &buttons, move |action| {
                    let _ = proxy.send_event(UserEvent::Toast { id: pid.clone(), action });
                });
                send(webview, self.statuses());
            }
        }
    }

    fn agent_state(&mut self, id: &str, agent: String, finished: bool, webview: &WebView) {
        let away = self.active.as_deref() != Some(id) || !self.focused;
        let Some(rt) = self.runtime.get_mut(id) else { return };
        let changed = rt.agent != agent;
        rt.agent = agent.clone();
        rt.last_activity = Instant::now();
        if away && (finished || (changed && agent == "attention")) {
            rt.unread = true;
            if self.state.settings.notifications {
                if let Some(p) = self.state.project(id) {
                    let body = if agent == "attention" { "Waiting for your approval." } else { "The agent has finished." };
                    let proxy = self.proxy.clone();
                    let pid = id.to_string();
                    system::notify(&p.name, body, None, &self.icon_file, &[], move |action| {
                        let _ = proxy.send_event(UserEvent::Toast { id: pid.clone(), action });
                    });
                }
            }
        }
        send(webview, self.statuses());
    }

    fn tick(&mut self, webview: &WebView) {
        self.ticks += 1;
        for rt in self.runtime.values_mut() {
            rt.memory = rt.process.as_ref().map(|p| p.memory()).unwrap_or(0);
        }
        // Every 30 seconds: put idle codebases to sleep.
        if self.ticks % 10 == 0 && self.state.settings.sleep_minutes > 0 {
            let limit = Duration::from_secs(self.state.settings.sleep_minutes as u64 * 60);
            let sleepy: Vec<String> = self
                .runtime
                .iter()
                .filter(|(id, rt)| {
                    rt.phase == Phase::Running
                        && rt.agent == "idle"
                        && rt.last_activity.elapsed() >= limit
                        && self.active.as_deref() != Some(id.as_str())
                })
                .filter_map(|(id, _)| self.state.project(id))
                .filter(|p| !p.keep_awake && !configs::has_active_schedules(&p.config_file, &p.path))
                .map(|p| p.id.clone())
                .collect();
            for id in sleepy {
                self.stop(&id, Phase::Sleeping);
                send(webview, json!({ "type": "unload", "id": id }));
            }
        }
        send(webview, self.statuses());
    }

    /// The codebase last open, at once; the next two most recent shortly after, so they are ready
    /// before they are clicked without competing with the first for the disk.
    fn start_on_launch(&mut self) {
        if self.launched {
            return;
        }
        self.launched = true;
        let first = self.state.settings.last_project.clone().filter(|id| self.state.project(id).is_some());
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
            send(webview, json!({ "type": "notice", "level": "error", "text": "This build carries no source archive. Packaged builds of Sun include one." }));
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
