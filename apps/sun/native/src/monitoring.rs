//! Monitoring: the runtime around `monitor.rs` - when checks run, where their rows come from, where their
//! history goes, who is told, and the one set of operations the dashboard, grid windows and agents use.
//!
//! ## Where rows come from
//!
//! - **SQLite and data files** are read here, by the Rust helper (`fire-fs`): no Node, no network.
//! - **A tool** (a Python tool, an MCP tool, a read tool) runs in the *monitoring executor*: a Light Code host
//!   Fire Code starts in the background, with no window, using one codebase's settings. It is also what
//!   reaches the team's OpenSearch history and the model that explains an alert - so invariant 2 holds:
//!   every network request still goes through the one HttpClient.
//!
//! ## Team monitors: OpenSearch, and no races
//!
//! A team monitor runs only with the team's OpenSearch history set (the user's rule). Every member's Fire Code
//! may run it; before a check it **claims the slot** (`history.ts`: a create-only document), so a slot runs
//! once across the team, and the newest check from anyone is what every dashboard shows. Writes are new
//! documents only, cleanup removes only one's own - see `history.ts` for each race and its answer. Here, on
//! one machine, a monitor never has two checks in flight (`running`), and state files are written whole.
//!
//! ## Memory
//!
//! Only a summary of each monitor is held (`Summary`: a few numbers and its alert ids); the rows live on disk
//! and are read when a grid window opens or an agent asks. Sparklines come from a 48-point tail kept in
//! memory. The scan re-reads only skill files that changed (`ScanCache`). The executor runs only while a
//! monitor needs it.

use crate::host::{HostProcess, LaunchSpec};
use crate::monitor::{self, Ack, CheckRecord, Found, Level, LocalNow, Mode, MonitorState, RunRecord, Source};
use crate::{environment, send, system, App, UserEvent, SHELL_ORIGIN};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use wry::WebView;

/// The executor's key among host processes. Not a codebase id (those never start with `~`).
pub const EXECUTOR_ID: &str = "~monitoring";
/// Checks in flight at once.
const MAX_RUNNING: usize = 4;
/// How long the executor has to start before what waits for it fails.
const EXECUTOR_START_SECS: u64 = 90;
/// How long past a check's own timeout a colleague's check of a window may take to arrive before this computer
/// takes the window over (once): their Fire Code may have closed, slept or failed mid-check.
const TAKEOVER_GRACE_SECS: u64 = 180;
/// Points kept per monitor for its sparkline.
const SPARK: usize = 48;
/// How often the team's newest checks are read, and old history pruned.
const LATEST_EVERY: Duration = Duration::from_secs(30);
const PRUNE_EVERY: Duration = Duration::from_secs(6 * 3600);

pub struct Executor {
    process: HostProcess,
    generation: u64,
    ready: bool,
    started: Instant,
}

/// Who is waiting for an answer that takes a round trip.
#[derive(Clone)]
pub enum Target {
    Grid(String),
    Agent { host: String, generation: u64, id: Value },
}

enum Pending {
    Check { name: String, started: Instant, at: i64, timeout: u64 },
    /// `manual`: "Run now" on a team monitor - lost means a colleague checked it moments ago.
    Claim { name: String, slot: i64, manual: bool, attempt: u8, started: Instant },
    Details { name: String, row: usize, started: Instant },
    Write { started: Instant },
    Latest { started: Instant },
    History { name: String, days: u32, key: Option<String>, alert: Option<String>, range: Option<(i64, i64)>, target: Target, started: Instant },
    ExplainHistory { name: String, row: usize, started: Instant },
    /// A monitor file's version history, asked of the executor (`kind: history`).
    FileHistory { name: String, modified: std::time::SystemTime, started: Instant },
    /// The team's record of a monitor's changes, for its grid window.
    Revisions { name: String, started: Instant },
    /// The dashboard's refresh: the host syncing the team's skills; `before` is what was here when it was pressed.
    Sync { before: Vec<String>, started: Instant },
    Explain { name: String, row: usize, context: Value, started: Instant },
    Prune { started: Instant },
    /// A team copy's skill file changed (`write`) or deleted everywhere (`delete`) by the host, which has the
    /// bucket and repository connections. `approve`: the new block's hash, when the old one was approved.
    SkillChange { name: String, op: &'static str, approve: Option<String>, via_grid: bool, started: Instant },
    /// Whether a team monitor's tool can run on this computer, asked before claiming its run.
    Probe { name: String, started: Instant },
    /// A colleague's newest check's whole grid, from the team index - so every member sees every row.
    TeamGrid { name: String, at: i64, hash: String, started: Instant },
    /// A colleague's past check's whole grid, for History.
    PastGrid { name: String, at: i64, by: Option<String>, started: Instant },
    /// A check run offline, offered to the team: claim its window, and write it only if nobody else had it.
    Backfill { name: String, slot: i64, doc: Value, started: Instant },
}

impl Pending {
    fn expired(&self) -> bool {
        let (started, limit) = match self {
            Pending::Check { started, timeout, .. } => (started, *timeout + 5),
            Pending::Explain { started, .. } => (started, 180),
            Pending::Details { started, .. } | Pending::History { started, .. } | Pending::ExplainHistory { started, .. } | Pending::Revisions { started, .. } => (started, 120),
            Pending::Claim { started, .. } | Pending::Write { started } | Pending::Latest { started } => (started, 60),
            Pending::Prune { started } => (started, 300),
            Pending::SkillChange { started, .. } | Pending::Sync { started, .. } => (started, 180),
            Pending::Probe { started, .. } | Pending::FileHistory { started, .. } | Pending::Backfill { started, .. } | Pending::TeamGrid { started, .. } | Pending::PastGrid { started, .. } => (started, 60),
        };
        started.elapsed() > Duration::from_secs(limit)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    User,
    Agent,
}

/// What is held in memory per monitor: never its rows.
#[derive(Clone)]
pub struct Summary {
    at: i64,
    level: Level,
    error: Option<String>,
    headline: String,
    last_success_at: Option<i64>,
    by: Option<String>,
    row_count: usize,
    /// Every alert's id and level, so acknowledgements count at once without the rows.
    alerts: Vec<(String, Level)>,
}

impl Summary {
    fn of(record: &RunRecord) -> Summary {
        Summary {
            at: record.at,
            level: record.level,
            error: record.error.clone(),
            headline: record.headline.clone(),
            last_success_at: record.last_success_at,
            by: record.by.clone(),
            row_count: record.evaluation.as_ref().map(|e| e.rows.len()).unwrap_or(0),
            alerts: record.evaluation.as_ref().map(|e| e.alerts.iter().map(|a| (a.id.clone(), a.level)).collect()).unwrap_or_default(),
        }
    }
}

pub struct Monitoring {
    pub store: monitor::Store,
    pub settings: monitor::Settings,
    pub states: HashMap<String, MonitorState>,
    pub found: Vec<Found>,
    scan_cache: monitor::ScanCache,
    summaries: HashMap<String, Summary>,
    spark: HashMap<String, VecDeque<(i64, Level)>>,
    /// Names with a check (or its claim) in flight.
    running: HashMap<String, Instant>,
    /// The slot this computer last tried to claim, per team monitor, so a lost claim is not tried again.
    last_claim: HashMap<String, i64>,
    /// A claim lost to a colleague: the slot, when, and which attempt (1, or 2 for the one takeover).
    claim_lost: HashMap<String, (i64, Instant, u8)>,
    /// Why a check that is due has not started, in words, for its tile and grid.
    waiting_for: HashMap<String, String>,
    /// When the scheduler last looked for due checks (epoch seconds): the dashboard says whether it is working.
    last_tick_at: Option<i64>,
    /// Each monitor file's version history (`sharing/provenance.ts`: the team repository, else git), by the
    /// file's modified time when it was read - asked again only when the file changes.
    file_history: HashMap<String, (std::time::SystemTime, Value)>,
    /// The last change of each monitor recorded here (`Revision`), so a scan notices the next.
    revision_seen: HashMap<String, monitor::Revision>,
    pending: HashMap<String, Pending>,
    /// Requests waiting for the executor to be ready.
    queued: Vec<Value>,
    pub executor: Option<Executor>,
    executor_generation: u64,
    pub executor_error: Option<String>,
    executor_retry_at: Option<Instant>,
    /// The last thing the team's OpenSearch history refused, until something works again.
    team_error: Option<String>,
    /// This person, as the team's history names them (from the executor's first write).
    me: Option<String>,
    /// Whether each team monitor can run on this computer, as last found, and when (`ready_here`).
    readiness: HashMap<String, (Result<(), String>, Instant)>,
    /// When this computer's own check of a team monitor last failed: colleagues get the next windows.
    failed_here: HashMap<String, i64>,
    /// A team check running here without a claim, because the team's history could not be reached: its window.
    offline_slot: HashMap<String, i64>,
    /// Checks run offline, to offer to the team once it can be reached: (monitor, window, record). Kept on disk.
    offline_queue: Vec<(String, i64, Value)>,
    next_id: u64,
    last_scan: Option<Instant>,
    last_latest: Option<Instant>,
    last_prune: Option<Instant>,
    /// The last explanation per monitor - its row, text and facts - for "Start a chat". One each, so it cannot grow.
    explanations: HashMap<String, (usize, String, Value)>,
    /// Grid windows to open, and messages for the open ones, by monitor name: drained by the event loop.
    pub grid_open: Vec<String>,
    pub grid_out: Vec<(String, Value)>,
    /// A sheet (the schedule editor, the delete check) a grid window opens with, asked for from the dashboard
    /// before the window exists: taken when its page says it is ready.
    pub open_sheet: HashMap<String, Value>,
    /// Messages for the main window: a chat to fill in, the dashboard to show.
    pub shell_out: Vec<Value>,
    pub show_dashboard: bool,
    /// Flash the taskbar button: a notification that wanted attention went out while Fire Code was not in front.
    pub flash: bool,
}

impl Monitoring {
    pub fn new(root: PathBuf) -> Monitoring {
        let store = monitor::Store::new(root);
        let offline_queue = store.offline_queue();
        // A scheduler stopped from the dashboard starts again with Fire Code (asked for: "when Fire Code starts,
        // if the scheduler is down, it should be started automatically"). Stop lasts until the next launch.
        let mut settings = store.settings();
        if settings.scheduler_stopped {
            settings.scheduler_stopped = false;
            let _ = store.save_settings(&settings);
        }
        Monitoring {
            settings,
            states: store.states(),
            store,
            found: Vec::new(),
            scan_cache: monitor::ScanCache::default(),
            summaries: HashMap::new(),
            spark: HashMap::new(),
            running: HashMap::new(),
            last_claim: HashMap::new(),
            claim_lost: HashMap::new(),
            waiting_for: HashMap::new(),
            revision_seen: HashMap::new(),
            last_tick_at: None,
            file_history: HashMap::new(),
            pending: HashMap::new(),
            queued: Vec::new(),
            executor: None,
            executor_generation: 0,
            executor_error: None,
            executor_retry_at: None,
            team_error: None,
            me: None,
            readiness: HashMap::new(),
            failed_here: HashMap::new(),
            offline_slot: HashMap::new(),
            offline_queue,
            next_id: 0,
            last_scan: None,
            last_latest: None,
            last_prune: None,
            explanations: HashMap::new(),
            grid_open: Vec::new(),
            grid_out: Vec::new(),
            open_sheet: HashMap::new(),
            shell_out: Vec::new(),
            show_dashboard: false,
            flash: false,
        }
    }

    fn id(&mut self) -> String {
        self.next_id += 1;
        format!("m{}", self.next_id)
    }

    fn found(&self, name: &str) -> Option<&Found> {
        self.found.iter().find(|f| f.name == name)
    }

    fn approved(&self, f: &Found) -> bool {
        self.states.get(&f.name).and_then(|s| s.approved.as_deref()) == Some(f.hash.as_str())
    }

    fn save_states(&self) {
        let _ = self.store.save_states(&self.states);
    }

    fn acked(&self, name: &str, id: &str, level: Level, now: i64) -> bool {
        self.states.get(name).and_then(|s| s.acks.get(id)).map(|a| a.level >= level && a.until.map(|u| u > now).unwrap_or(true)).unwrap_or(false)
    }

    /// The level now: the worst alert nobody has acknowledged - acknowledgements count at once.
    fn level_now(&self, f: &Found, s: &Summary, now: i64) -> Level {
        let Ok(m) = &f.monitor else { return s.level };
        if s.error.is_some() {
            return Level::Purple;
        }
        s.alerts.iter().filter(|(id, level)| !self.acked(&f.name, id, *level, now)).map(|(_, l)| *l).max().unwrap_or(if s.row_count == 0 { m.when_empty } else { m.when_clear })
    }

    fn open_alerts(&self, f: &Found, s: &Summary, now: i64) -> usize {
        s.alerts.iter().filter(|(id, level)| !self.acked(&f.name, id, *level, now)).count()
    }

    fn spark_push(&mut self, name: &str, at: i64, level: Level) {
        let points = self.spark.entry(name.to_string()).or_default();
        points.push_back((at, level));
        while points.len() > SPARK {
            points.pop_front();
        }
    }
}

fn mode_word(mode: Mode) -> &'static str {
    match mode {
        Mode::Off => "off",
        Mode::Dashboard => "dashboard",
        Mode::Silent => "silent",
        Mode::Toast => "toast",
        Mode::Urgent => "urgent",
        Mode::Alarm => "alarm",
    }
}

fn parse_mode(text: &str) -> Option<Mode> {
    serde_json::from_value(Value::String(text.to_string())).ok()
}

/// A source with `{column}` in its args or SQL filled from a row - a drill-down's.
fn fill_source(source: &Source, row: &monitor::Row) -> Source {
    fn fill(value: &Value, row: &monitor::Row) -> Value {
        match value {
            Value::String(s) => {
                // A value that is exactly one placeholder keeps the cell's own type (a number stays a number).
                if let Some(key) = s.strip_prefix('{').and_then(|r| r.strip_suffix('}')) {
                    if let Some(v) = monitor::cell(row, key) {
                        return v.clone();
                    }
                }
                Value::String(monitor::fill_template(s, row))
            }
            Value::Array(a) => Value::Array(a.iter().map(|v| fill(v, row)).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), fill(v, row))).collect()),
            other => other.clone(),
        }
    }
    match source {
        Source::Tool { tool, args } => Source::Tool { tool: tool.clone(), args: fill(args, row) },
        Source::Sqlite { path, sql } => Source::Sqlite { path: path.clone(), sql: monitor::fill_template(sql, row) },
        Source::Files { files, sql } => Source::Files { files: files.clone(), sql: monitor::fill_template(sql, row) },
    }
}

/// A SQLite or file source, read by the Rust helper in its own process: its answer, or why not.
fn run_helper(helper: &Path, source: &Source, timeout: u64) -> Result<Value, String> {
    use std::io::{Read, Write};
    use std::os::windows::process::CommandExt;
    let request = match source {
        Source::Sqlite { path, sql } => json!({ "op": "sqlite", "path": path, "action": "query", "sql": sql, "limit": monitor::MAX_ROWS }),
        Source::Files { files, sql } => json!({
            "op": "dataframe",
            "action": "sql",
            "sources": files.iter().map(|(name, path)| json!({ "name": name, "path": path })).collect::<Vec<_>>(),
            "sql": sql,
            "limit": monitor::MAX_ROWS,
        }),
        Source::Tool { .. } => return Err("A tool runs in the executor, not the helper.".into()),
    };
    let mut child = std::process::Command::new(helper)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| format!("Could not start the Rust helper ({}): {e}", helper.display()))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(request.to_string().as_bytes());
    }
    let mut stdout = child.stdout.take().ok_or("The helper has no output.")?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + Duration::from_secs(timeout);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return Err(format!("Reading {} took longer than {timeout} seconds.", source.describe()));
            }
        }
    }
    let text = reader.join().unwrap_or_default();
    let answer: Value = serde_json::from_str(text.trim()).map_err(|_| "The helper's answer could not be read.".to_string())?;
    if answer.get("ok") == Some(&Value::Bool(false)) {
        return Err(answer.get("error").and_then(Value::as_str).unwrap_or("The helper could not read it.").to_string());
    }
    Ok(answer)
}

fn local_clock(at: i64, offset: i64) -> String {
    monitor::local_date_time(at, offset).1
}

fn clock(minutes: u16) -> String {
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

/// "Older than N days" from the dashboard: None when not asked (everything, or the retention), at least one day.
fn older_than_days(args: &Value) -> Result<Option<i64>, String> {
    match args.get("olderThanDays") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_i64() {
            Some(days) if (1..=3650).contains(&days) => Ok(Some(days)),
            _ => Err("\"Older than\" is a number of days, 1 or more.".into()),
        },
    }
}

/// When a snooze ends: `until` (epoch seconds, from "Snooze until…") or `minutes` from now; 0 or none ends it.
/// At most 30 days ahead, so a mistyped year does not silence a monitor for good.
fn snooze_end(args: &Value, now: i64) -> Result<Option<i64>, String> {
    if let Some(until) = args.get("until").and_then(Value::as_i64) {
        if until <= now {
            return Err("That time has already passed - choose one in the future.".into());
        }
        if until > now + 30 * 86_400 {
            return Err("A snooze lasts at most 30 days. To stop a monitor for longer, pause it.".into());
        }
        return Ok(Some(until));
    }
    let minutes = args.get("minutes").and_then(Value::as_u64).unwrap_or(60).min(30 * 24 * 60);
    Ok((minutes > 0).then(|| now + minutes as i64 * 60))
}

/// After this computer's own check failed at `failed`: leave the claim to colleagues while that is recent (three
/// windows, at least 30 minutes), unless the team's newest check is more than a window old - nobody else is running
/// it, so this computer tries again rather than leave it unrun.
fn steps_back(failed: Option<i64>, newest: i64, every: i64, now: i64) -> bool {
    let Some(failed) = failed else { return false };
    now - failed <= (every * 3).max(1800) && now - newest <= every + 120
}

/// The largest grid shared in the team index: past it, members see the alerted rows only.
const SHARED_GRID_ROWS: usize = 5000;
const SHARED_GRID_BYTES: usize = 2 * 1024 * 1024;

/// Why History has no whole grid for a check, in words.
fn past_grid_missing(by: Option<&str>) -> String {
    match by {
        Some(by) => format!("The whole grid of this check is not in the team history - it was too large to share, or {by}'s Fire Code was older than 0.65.0. Here are the rows it alerted on."),
        None => "The whole grid of this check is no longer kept - grids go with the history they belong to.".to_string(),
    }
}

/// How long "can run here" is believed before it is asked again.
const READY_FOR: Duration = Duration::from_secs(600);

/// How many checks of a team monitor this computer keeps: its tile's bars and a short look back offline. The
/// whole history is the team index's, stored once for everyone (not once per member).
const TEAM_LOCAL_CHECKS: usize = 200;

/// The schedule fields of a block, as written - what the schedule editor starts from.
fn schedule_spec(block: &str) -> Value {
    let spec: Map<String, Value> = serde_json::from_str(block).unwrap_or_default();
    Value::Object(monitor::SCHEDULE_KEYS.iter().filter_map(|k| spec.get(*k).map(|v| (k.to_string(), v.clone()))).collect())
}

/// A copy synced from the team's bucket or repository: changed or deleted where the team keeps it, through the
/// host (Fire Code has no network of its own), because a change made only here would be undone by the next sync.
fn is_team_copy(f: &monitor::Found) -> bool {
    matches!(f.origin.as_str(), "bucket" | "team repository")
}

/// Where a team copy lives, in words.
fn team_place(f: &monitor::Found) -> &'static str {
    if f.origin == "bucket" {
        "the team's bucket"
    } else {
        "the team repository"
    }
}

/// Whether an operation came from a monitor's own window, which is then told how it ended.
fn via_grid(args: &Value) -> bool {
    args.get("via").and_then(Value::as_str) == Some("grid")
}

/// The schedule in words, for the tile and the agent: "every 15 min, 09:00-", "at 07:30 on mon-fri".
fn schedule_words(m: &monitor::Monitor) -> String {
    let mut parts = Vec::new();
    if m.every_secs > 0 {
        let s = m.every_secs;
        parts.push(if s % 86_400 == 0 { format!("every {} d", s / 86_400) } else if s % 3600 == 0 { format!("every {} h", s / 3600) } else { format!("every {} min", s / 60) });
        if let Some((a, b)) = m.window {
            parts.push(match (a, b) {
                (0, end) => format!("until {}", clock(end)),
                (start, 1440) => format!("from {}", clock(start)),
                (start, end) => format!("{}-{}", clock(start), clock(end)),
            });
        }
    }
    if !m.times.is_empty() {
        parts.push(format!("at {}", m.times.iter().map(|t| clock(*t)).collect::<Vec<_>>().join(", ")));
    }
    if let Some(days) = m.days {
        let names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
        parts.push(format!("on {}", names.iter().zip(days).filter(|(_, on)| *on).map(|(n, _)| *n).collect::<Vec<_>>().join(", ")));
    }
    parts.join(", ")
}

impl App {
    // ─── Folders and scanning ────────────────────────────────────────────────

    /// Every folder a monitor skill can be in: the user's personal skills, each codebase's own (and any
    /// folders its settings name), the bucket and team-repository copies, and any added in Settings.
    pub fn monitor_folders(&self) -> Vec<monitor::Folder> {
        let mut folders = vec![monitor::Folder { path: system::personal_skills_dir(), team: false, origin: "personal".into() }];
        for project in &self.state.projects {
            let base = PathBuf::from(&project.path);
            folders.push(monitor::Folder { path: base.join(".lightcode").join("skills"), team: true, origin: project.name.clone() });
            if let Ok(text) = std::fs::read_to_string(&project.config_file) {
                if let Ok(config) = serde_json::from_str::<Value>(&text) {
                    let skills = config.get("skills");
                    let named = skills.and_then(|s| s.get("dir")).and_then(Value::as_str).into_iter().chain(
                        skills.and_then(|s| s.get("paths")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str),
                    );
                    for dir in named.filter(|d| !d.trim().is_empty()) {
                        let path = if Path::new(dir).is_absolute() { PathBuf::from(dir) } else { base.join(dir) };
                        folders.push(monitor::Folder { path, team: true, origin: project.name.clone() });
                    }
                }
            }
        }
        let mirrors = self.paths.root.join("mirrors");
        for connection in std::fs::read_dir(mirrors.join("s3")).into_iter().flatten().flatten() {
            for kind in std::fs::read_dir(connection.path()).into_iter().flatten().flatten() {
                if kind.file_name().to_string_lossy().starts_with("skills-") {
                    folders.push(monitor::Folder { path: kind.path(), team: true, origin: "bucket".into() });
                }
            }
        }
        for repo in std::fs::read_dir(mirrors.join("teamrepo")).into_iter().flatten().flatten() {
            folders.push(monitor::Folder { path: repo.path().join("skills"), team: true, origin: "team repository".into() });
            folders.push(monitor::Folder { path: repo.path().join("saved-here").join("skills"), team: true, origin: "team repository".into() });
        }
        for extra in &self.monitoring.settings.extra_folders {
            folders.push(monitor::Folder { path: PathBuf::from(extra), team: true, origin: "folder".into() });
        }
        folders
    }

    pub fn monitor_scan(&mut self) {
        let folders = self.monitor_folders();
        let found = monitor::scan_cached(&folders, &mut self.monitoring.scan_cache);
        for f in &found {
            if !self.monitoring.summaries.contains_key(&f.name) {
                if let Some(record) = self.monitoring.store.result(&f.name) {
                    self.monitoring.summaries.insert(f.name.clone(), Summary::of(&record));
                }
            }
            if !self.monitoring.spark.contains_key(&f.name) {
                let tail = self.monitoring.store.history_tail(&f.name, SPARK);
                self.monitoring.spark.insert(f.name.clone(), tail.into_iter().collect());
            }
        }
        // Monitors that are gone take what was held for them.
        let names: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();
        self.monitoring.summaries.retain(|n, _| names.contains(&n.as_str()));
        self.monitoring.spark.retain(|n, _| names.contains(&n.as_str()));
        self.monitoring.explanations.retain(|n, _| names.contains(&n.as_str()));
        self.monitoring.found = found;
        self.monitoring.last_scan = Some(Instant::now());
        self.note_revisions();
        if self.monitoring.executor.is_some() {
            self.ask_file_histories();
        }
    }

    /// Asks the executor for the history of every monitor file that changed since it was last read.
    fn ask_file_histories(&mut self) {
        let wanted: Vec<(String, PathBuf, std::time::SystemTime)> = self
            .monitoring
            .found
            .iter()
            .filter_map(|f| {
                let modified = std::fs::metadata(&f.file).ok()?.modified().ok()?;
                let known = self.monitoring.file_history.get(&f.name).map(|(m, _)| *m == modified).unwrap_or(false);
                let asking = self.monitoring.pending.values().any(|p| matches!(p, Pending::FileHistory { name, .. } if *name == f.name));
                (!known && !asking).then(|| (f.name.clone(), f.file.clone(), modified))
            })
            .collect();
        for (name, file, modified) in wanted {
            let _ = self.exec_request(json!({ "kind": "history", "file": file.to_string_lossy() }), Pending::FileHistory { name, modified, started: Instant::now() });
        }
    }

    /// Who changed a monitor last and when: its newest commit (team repository or git) unless the file has
    /// changes no commit holds; else its labels. Who wrote it: the label, else the first commit when the whole
    /// history was read.
    fn provenance(&self, f: &Found) -> (Option<String>, Option<i64>, Option<String>, Option<&'static str>) {
        let history = self.monitoring.file_history.get(&f.name).map(|(_, h)| h).filter(|h| !h.is_null());
        let commits = history.and_then(|h| h.get("commits")).and_then(Value::as_array);
        let uncommitted = history.and_then(|h| h.get("uncommitted")).and_then(Value::as_bool).unwrap_or(false);
        let source = history.and_then(|h| h.get("source")).and_then(Value::as_str).map(|s| if s == "bitbucket" { "Bitbucket" } else { "git" });
        let newest = commits.and_then(|c| c.first());
        let (by, at) = match newest {
            Some(c) if !uncommitted => (c.get("by").and_then(Value::as_str).map(String::from), c.get("at").and_then(Value::as_i64)),
            _ => (f.labels.saved_by(), f.labels.updated_at().or_else(|| self.monitoring.revision_seen.get(&f.name).map(|r| r.at))),
        };
        let author = f.labels.author.clone().or_else(|| {
            let all = commits?;
            (all.len() < 50).then(|| all.last()?.get("by")?.as_str().map(String::from)).flatten()
        });
        (by, at, author, newest.filter(|_| !uncommitted).and(source))
    }

    /// Records each monitor's new version, as it arrives - saved here, by an agent, or synced from a colleague: who
    /// saved it (its labels), when, and what changed. A team monitor's is offered to the team's index too.
    fn note_revisions(&mut self) {
        let mut offers: Vec<(String, monitor::Revision)> = Vec::new();
        for f in &self.monitoring.found {
            if !self.monitoring.revision_seen.contains_key(&f.name) {
                if let Some(last) = self.monitoring.store.revisions(&f.name).pop() {
                    self.monitoring.revision_seen.insert(f.name.clone(), last);
                }
            }
            let before = self.monitoring.revision_seen.get(&f.name);
            if before.map(|b| b.hash == f.hash && b.version == f.labels.version).unwrap_or(false) {
                continue;
            }
            let modified = std::fs::metadata(&f.file).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64);
            let revision = monitor::Revision {
                at: f.labels.updated_at().or(modified).unwrap_or_else(monitor::now_secs),
                by: f.labels.saved_by(),
                author: f.labels.author.clone(),
                version: f.labels.version,
                hash: f.hash.clone(),
                change: monitor::describe_change(before, &f.block, &f.hash),
                block: Some(f.block.clone()),
            };
            self.monitoring.store.add_revision(&f.name, &revision);
            if f.team {
                offers.push((f.name.clone(), revision.clone()));
            }
            self.monitoring.revision_seen.insert(f.name.clone(), revision);
        }
        if !offers.is_empty() && self.team_ready().is_ok() {
            for (name, revision) in offers {
                let _ = self.store_request("writeRevision", json!({ "monitor": name, "revision": revision }), Pending::Write { started: Instant::now() });
            }
        }
    }

    /// What a refresh found, in words: new monitors and gone ones by name, and where it synced from.
    fn refresh_words(&self, before: &[String], synced: &[String]) -> String {
        let now: Vec<&String> = self.monitoring.found.iter().map(|f| &f.name).collect();
        let title = |n: &str| self.monitoring.found(n).map(|f| f.title()).unwrap_or_else(|| n.to_string());
        let added: Vec<String> = now.iter().filter(|n| !before.contains(n)).map(|n| title(n)).collect();
        let gone: Vec<&String> = before.iter().filter(|n| !now.contains(n)).collect();
        let from = if synced.is_empty() { String::new() } else { format!(" after syncing {}", synced.join(" and ")) };
        let list = |names: Vec<String>| if names.len() > 3 { format!("{} and {} more", names[..3].join(", "), names.len() - 3) } else { names.join(", ") };
        match (added.is_empty(), gone.is_empty()) {
            (true, true) => format!("Up to date{from} - {} monitors, nothing added or removed.", now.len()),
            (false, true) => format!("New{from}: {}.", list(added)),
            (true, false) => format!("Gone{from}: {}.", list(gone.iter().map(|s| s.to_string()).collect())),
            (false, false) => format!("New{from}: {}. Gone: {}.", list(added), list(gone.iter().map(|s| s.to_string()).collect())),
        }
    }

    /// This person, for a label: as the team's history names them, else the Windows user.
    fn me(&self) -> String {
        self.monitoring.me.clone().or_else(|| std::env::var("USERNAME").ok()).unwrap_or_default()
    }

    /// A monitor's changes, newest first: those seen here, and for a team monitor the team's record (asked for in
    /// the background; the window is told when it arrives).
    pub fn revisions_message(&mut self, name: &str) -> Value {
        let mut local = self.monitoring.store.revisions(name);
        local.reverse();
        let team = self.monitoring.found(name).map(|f| f.team).unwrap_or(false) && self.team_ready().is_ok();
        if team {
            let _ = self.store_request("revisions", json!({ "monitor": name }), Pending::Revisions { name: name.to_string(), started: Instant::now() });
        }
        // The file's commits too, asked for now if not known (this is a user opening Changes: the executor may start).
        let history = self.monitoring.file_history.get(name).map(|(_, h)| h.clone());
        let history_missing = history.is_none();
        if history_missing {
            if let Some(f) = self.monitoring.found(name).cloned() {
                if let Some(modified) = std::fs::metadata(&f.file).ok().and_then(|m| m.modified().ok()) {
                    let _ = self.exec_request(json!({ "kind": "history", "file": f.file.to_string_lossy() }), Pending::FileHistory { name: f.name.clone(), modified, started: Instant::now() });
                }
            }
        }
        json!({ "type": "revisions", "revisions": local, "teamPending": team, "history": history.unwrap_or(Value::Null), "historyPending": history_missing })
    }

    // ─── The team's history ──────────────────────────────────────────────────

    /// The codebase whose settings the executor runs with.
    fn executor_project(&self) -> Option<crate::state::Project> {
        self.monitoring.settings.executor.as_deref().and_then(|id| self.state.project(id)).or_else(|| self.state.projects.first()).cloned()
    }

    /// The OpenSearch connections in the executor codebase's settings: id and label.
    fn team_stores(&self) -> Vec<(String, String)> {
        let Some(project) = self.executor_project() else { return Vec::new() };
        let Ok(text) = std::fs::read_to_string(&project.config_file) else { return Vec::new() };
        let Ok(config) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
        config
            .get("vectorStores")
            .and_then(Value::as_object)
            .map(|stores| {
                stores
                    .iter()
                    .filter(|(_, s)| s.get("kind").and_then(Value::as_str) == Some("opensearch"))
                    .map(|(id, s)| (id.clone(), s.get("label").and_then(Value::as_str).filter(|l| !l.is_empty()).unwrap_or(id).to_string()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The team's history connection and index, or why team monitors cannot run.
    fn team_ready(&self) -> Result<(String, String), String> {
        let s = &self.monitoring.settings;
        let Some(id) = s.team_store.clone().filter(|id| !id.is_empty()) else {
            return Err("Team monitoring keeps its history in the team's OpenSearch index: choose its connection in Settings → Monitoring → Team history.".into());
        };
        let project = self.executor_project().ok_or("Add a codebase first: team history is reached with a codebase's settings.")?;
        if !self.team_stores().iter().any(|(sid, _)| *sid == id) {
            return Err(format!("The OpenSearch connection \"{id}\" is not in the settings of {} (Settings → Monitoring → Run tools with the settings of).", project.name));
        }
        Ok((id, s.team_index.clone()))
    }

    fn team_names(&self) -> Vec<String> {
        self.monitoring.found.iter().filter(|f| f.team && f.monitor.is_ok() && self.monitoring.approved(f)).map(|f| f.name.clone()).collect()
    }

    // ─── The executor ────────────────────────────────────────────────────────

    fn ensure_executor(&mut self) -> Result<(), String> {
        if self.monitoring.executor.is_some() {
            return Ok(());
        }
        if let Some(at) = self.monitoring.executor_retry_at {
            if Instant::now() < at {
                return Err(self.monitoring.executor_error.clone().unwrap_or_else(|| "The monitoring executor is restarting.".into()));
            }
        }
        let project = self.executor_project().ok_or("Add a codebase first: monitors that use a tool run it with a codebase's settings (Settings → Monitoring).")?;
        let root = self.paths.root.join("monitoring");
        let workspace = root.join("workspace");
        let _ = std::fs::create_dir_all(&workspace);
        let script: &[(String, String)] = match &self.script {
            crate::ScriptState::Done(done) => &done.vars,
            _ => &[],
        };
        let environment = environment::resolve(&self.state.settings.path_prefix, &self.state.settings.env, &self.vault, script);
        self.monitoring.executor_generation += 1;
        let generation = self.monitoring.executor_generation;
        let proxy = self.proxy.clone();
        let spec = LaunchSpec {
            id: EXECUTOR_ID.to_string(),
            generation,
            node: system::node_executable(),
            host_script: system::host_script(),
            workspace: workspace.to_string_lossy().to_string(),
            data_dir: root.join("executor"),
            config_file: project.config_file.clone(),
            secrets_file: self.paths.secrets_file(),
            log_file: root.join("executor.log"),
            frame_ancestor: SHELL_ORIGIN.to_string(),
            ripgrep: system::bundled_ripgrep(),
            vault_key: self.vault.key_hex(),
            credentials_file: self.vault.credentials_file().clone(),
            reach_anywhere: self.state.settings.reach_anywhere,
            fast_fs: system::fast_fs(),
            env: environment.vars,
            path: environment.path,
            no_schedules: true,
            siblings: Vec::new(),
            sibling_hubs: Vec::new(),
            change_ledger: root.join("changes.jsonl"),
            jupyter_hub: None,
            approved_tools: system::shared_approvals_file(),
            mirror_dir: self.paths.root.join("mirrors"),
            codebase_dir: root.join("executor-codebase"),
            mention_name: "monitoring".into(),
            chat_label: "Monitoring".into(),
            monitoring: false,
            monitor_executor: true,
            extra_tool_folders: self.state.projects.iter().map(|p| PathBuf::from(&p.path).join(".lightcode").join("tools")).filter(|p| p.is_dir()).collect(),
        };
        let process = crate::host::launch(spec, move |event| {
            let _ = proxy.send_event(UserEvent::Host(event));
        })?;
        self.monitoring.executor = Some(Executor { process, generation, ready: false, started: Instant::now() });
        self.monitoring.executor_error = None;
        Ok(())
    }

    fn stop_executor(&mut self) {
        self.monitoring.executor_generation += 1;
        if let Some(e) = self.monitoring.executor.take() {
            e.process.stop();
        }
        // What was queued for it fails by its own timeout, with that reason.
        self.monitoring.queued.clear();
    }

    /// One request to the executor, remembered under a new id until it answers.
    fn exec_request(&mut self, mut payload: Value, pending: Pending) -> Result<String, String> {
        self.ensure_executor()?;
        let id = self.monitoring.id();
        payload["type"] = json!("monitorRequest");
        payload["id"] = json!(id);
        let e = self.monitoring.executor.as_ref().expect("started above");
        if e.ready {
            if !e.process.send_line(&payload) {
                return Err("The monitoring executor could not be reached.".into());
            }
        } else {
            self.monitoring.queued.push(payload);
        }
        self.monitoring.pending.insert(id.clone(), pending);
        Ok(id)
    }

    fn store_request(&mut self, op: &str, args: Value, pending: Pending) -> Result<String, String> {
        let (store, index) = self.team_ready()?;
        self.exec_request(json!({ "kind": "store", "op": op, "storeId": store, "index": index, "args": args }), pending)
    }

    // ─── The schedule ────────────────────────────────────────────────────────

    /// Every 3 seconds, from `tick`: rescan now and then, start what is due, read the team's newest, prune.
    pub fn monitor_tick(&mut self, webview: &WebView) {
        if !self.monitoring.settings.enabled {
            if self.monitoring.executor.is_some() {
                self.stop_executor();
            }
            return;
        }
        if self.monitoring.last_scan.map(|t| t.elapsed() > Duration::from_secs(30)).unwrap_or(true) {
            self.monitor_scan();
            self.push_monitors(webview);
        }
        let now = monitor::now_secs();
        let local = monitor::local_now();
        self.monitoring.last_tick_at = Some(now);
        // A name marked running with nothing in flight for it is a check that will never finish - it would never
        // be due again. Freed here, so one lost answer cannot stop a monitor for good.
        let in_flight: Vec<String> = self
            .monitoring
            .pending
            .values()
            .filter_map(|p| match p {
                Pending::Check { name, .. } | Pending::Claim { name, .. } => Some(name.clone()),
                _ => None,
            })
            .collect();
        self.monitoring.running.retain(|name, since| in_flight.contains(name) || since.elapsed() < Duration::from_secs(10));

        let expired: Vec<String> = self.monitoring.pending.iter().filter(|(_, p)| p.expired()).map(|(id, _)| id.clone()).collect();
        for id in expired {
            self.answered(&id, Err("No answer in time - it was stopped waiting. A tool that takes this long may need a larger timeoutSeconds.".into()), webview);
        }
        if let Some(e) = &self.monitoring.executor {
            if !e.ready && e.started.elapsed() > Duration::from_secs(EXECUTOR_START_SECS) {
                self.monitoring.executor_error = Some("The monitoring executor did not start in time. Its log is monitoring\\executor.log in the data folder.".into());
                self.stop_executor();
            }
        }

        let team = self.team_ready().ok();
        // A monitor that reads through a tool must not wait for the executor to start when it falls due: it is
        // started as soon as such a monitor exists (and restarted after its retry wait when it stopped).
        let wants_executor = self.monitoring.found.iter().any(|f| matches!(&f.monitor, Ok(m) if matches!(m.source, Source::Tool { .. })) && self.monitoring.approved(f));
        if wants_executor && self.monitoring.executor.is_none() {
            let _ = self.ensure_executor();
        }
        let mut waiting: HashMap<String, String> = HashMap::new();
        let mut due: Vec<(String, bool, i64, u8)> = Vec::new();
        let stopped = self.monitoring.settings.scheduler_stopped;
        for f in self.monitoring.found.iter().filter(|_| !stopped) {
            let Ok(m) = f.monitor.as_ref() else { continue };
            let state = self.monitoring.states.get(&f.name);
            if !self.monitoring.approved(f) || state.map(|s| s.paused).unwrap_or(false) || self.monitoring.running.contains_key(&f.name) {
                continue;
            }
            if f.team && team.is_none() {
                continue;
            }
            let last = self.monitoring.summaries.get(&f.name).map(|s| s.at);
            let Some(slot) = m.due_slot(last, now, local) else { continue };
            let mut attempt = 1u8;
            // A claim this computer lost for this slot is not tried again: a team member has it - unless their
            // check has not arrived well after it should have finished. Then one other member takes the window over
            // (a second claim, so still only one of them), rather than the window going unchecked.
            if f.team && self.monitoring.last_claim.get(&f.name) == Some(&slot) {
                match self.monitoring.claim_lost.get(&f.name) {
                    Some((s, lost, 1)) if *s == slot && lost.elapsed().as_secs() > m.timeout_secs + TAKEOVER_GRACE_SECS => attempt = 2,
                    _ => {
                        waiting.insert(f.name.clone(), "A colleague's Fire Code has this window - their check shows here when it arrives.".into());
                        continue;
                    }
                }
            }
            due.push((f.name.clone(), f.team, slot, attempt));
        }
        for (name, is_team, slot, attempt) in due {
            if self.monitoring.running.len() >= MAX_RUNNING {
                waiting.insert(name, format!("Waiting its turn - {MAX_RUNNING} checks are running at once."));
                continue;
            }
            if is_team {
                let Some(f) = self.monitoring.found(&name).cloned() else { continue };
                // Only a computer that can run it claims it: one that cannot leaves it to a colleague who can.
                match self.ready_here(&f) {
                    Some(Ok(())) => {}
                    None => {
                        waiting.insert(name, "Making sure it can run on this computer first…".into());
                        continue;
                    }
                    // The tile's "Runs elsewhere" says why.
                    Some(Err(_)) => continue,
                }
                if self.leaving_to_colleagues(&f, now) {
                    continue;
                }
                self.monitoring.running.insert(name.clone(), Instant::now());
                self.monitoring.last_claim.insert(name.clone(), slot);
                let claimed = self.store_request("claim", json!({ "monitor": name, "slot": slot, "attempt": attempt }), Pending::Claim { name: name.clone(), slot, manual: false, attempt, started: Instant::now() });
                if let Err(error) = claimed {
                    self.monitoring.running.remove(&name);
                    self.monitoring.team_error = Some(error);
                    self.monitoring.offline_slot.insert(name.clone(), slot);
                    self.start_check(&name, webview);
                }
            } else {
                self.start_check(&name, webview);
            }
        }
        if waiting != self.monitoring.waiting_for {
            self.monitoring.waiting_for = waiting;
            self.push_monitors(webview);
        }

        // The team's newest checks, by anyone.
        let names = self.team_names();
        let reading = self.monitoring.pending.values().any(|p| matches!(p, Pending::Latest { .. }));
        if team.is_some() && !names.is_empty() && !reading && self.monitoring.last_latest.map(|t| t.elapsed() >= LATEST_EVERY).unwrap_or(true) {
            self.monitoring.last_latest = Some(Instant::now());
            if let Err(error) = self.store_request("latest", json!({ "monitors": names }), Pending::Latest { started: Instant::now() }) {
                self.monitoring.team_error = Some(error);
            }
        }
        if self.monitoring.last_prune.map(|t| t.elapsed() >= PRUNE_EVERY).unwrap_or(true) {
            self.monitoring.last_prune = Some(Instant::now());
            self.prune_history();
        }
        // The executor stays up only while something needs it.
        let needs = self.monitoring.found.iter().any(|f| matches!(&f.monitor, Ok(m) if matches!(m.source, Source::Tool { .. })) && self.monitoring.approved(f))
            || (team.is_some() && !names.is_empty())
            || !self.monitoring.pending.is_empty();
        if !needs && self.monitoring.executor.is_some() {
            self.stop_executor();
        }
    }

    /// Old history goes: here, and this person's own checks in the team's index.
    fn prune_history(&mut self) -> usize {
        let before = monitor::now_secs() - self.monitoring.settings.retention_days.max(1) as i64 * 86_400;
        self.prune_before(before)
    }

    /// Every monitor's checks older than `before`: here, and this person's own in the team's index.
    fn prune_before(&mut self, before: i64) -> usize {
        let removed = self.monitoring.store.prune(before);
        if self.team_ready().is_ok() {
            let _ = self.store_request("prune", json!({ "before": before }), Pending::Prune { started: Instant::now() });
        }
        removed
    }

    fn fetch(&mut self, source: &Source, timeout: u64, pending: Pending) -> Result<(), String> {
        match source {
            Source::Tool { tool, args } => self.exec_request(json!({ "kind": "fetch", "tool": tool, "args": args, "timeoutMs": timeout * 1000 }), pending).map(|_| ()),
            other => {
                let helper = system::fast_fs().ok_or("The Rust helper (fire-fs.exe) is not beside Fire Code, so SQLite and file monitors cannot read. Reinstall Fire Code.")?;
                let id = self.monitoring.id();
                self.monitoring.pending.insert(id.clone(), pending);
                let (source, proxy) = (other.clone(), self.proxy.clone());
                std::thread::spawn(move || {
                    let result = run_helper(&helper, &source, timeout);
                    let _ = proxy.send_event(UserEvent::MonitorFetched { id, result });
                });
                Ok(())
            }
        }
    }

    pub fn start_check(&mut self, name: &str, webview: &WebView) {
        let Some(f) = self.monitoring.found(name).cloned() else { return };
        let Ok(m) = &f.monitor else { return };
        let at = monitor::now_secs();
        self.monitoring.running.insert(f.name.clone(), Instant::now());
        let pending = Pending::Check { name: f.name.clone(), started: Instant::now(), at, timeout: m.timeout_secs };
        if let Err(error) = self.fetch(&m.source, m.timeout_secs, pending) {
            self.finish_check(&f.name, at, Instant::now(), Err(error), webview);
            return;
        }
        self.push_monitors(webview);
    }

    /// An answer - from the helper or the executor - for whatever asked.
    pub fn answered(&mut self, id: &str, result: Result<Value, String>, webview: &WebView) {
        let Some(pending) = self.monitoring.pending.remove(id) else { return };
        match pending {
            Pending::Check { name, started, at, .. } => self.finish_check(&name, at, started, result, webview),
            Pending::Claim { name, slot, manual, attempt, .. } => match result {
                Ok(Value::Bool(true)) => {
                    self.monitoring.team_error = None;
                    self.monitoring.running.remove(&name);
                    self.start_check(&name, webview);
                }
                Ok(_) => {
                    // A team member has this slot: their check arrives with the next read of the newest.
                    self.monitoring.running.remove(&name);
                    self.monitoring.last_latest = None;
                    self.monitoring.claim_lost.insert(name.clone(), (slot, Instant::now(), attempt));
                    if manual {
                        let text = "A colleague checked it within the last two minutes - showing their check rather than running it again.";
                        self.monitoring.grid_out.push((name.clone(), json!({ "type": "notice", "text": text })));
                        self.monitoring.shell_out.push(json!({ "type": "monitorReply", "op": "run", "ok": true, "data": { "name": name, "message": text } }));
                    }
                    self.push_monitors(webview);
                }
                Err(error) => {
                    // The team's history cannot be reached: the check still runs here - a monitor that stops when
                    // the network does is no monitor - and is offered to the team once it can be reached.
                    self.monitoring.running.remove(&name);
                    self.monitoring.team_error = Some(error);
                    self.monitoring.offline_slot.insert(name.clone(), slot);
                    self.start_check(&name, webview);
                    self.push_monitors(webview);
                }
            },
            Pending::TeamGrid { name, at, hash, .. } => {
                // Every row of a colleague's check, in place of the alerted rows its summary carried.
                if let Ok(value) = result {
                    if let Ok(e) = serde_json::from_value::<monitor::Evaluation>(value) {
                        self.monitoring.store.save_grid_as(&name, &hash, &e);
                        self.full_team_grid(&name, at, e);
                        self.push_monitors(webview);
                    }
                }
            }
            Pending::PastGrid { name, at, by, .. } => {
                let message = match result.ok().and_then(|v| serde_json::from_value::<monitor::Evaluation>(v).ok()) {
                    Some(e) => json!({ "type": "pastGrid", "ok": true, "at": at, "evaluation": e }),
                    None => json!({ "type": "pastGrid", "ok": false, "at": at, "error": past_grid_missing(by.as_deref()) }),
                };
                self.monitoring.grid_out.push((name, message));
            }
            Pending::Probe { name, .. } => {
                let ready = match result {
                    Ok(answer) if answer.get("ready").and_then(Value::as_bool) == Some(true) => Ok(()),
                    Ok(answer) => Err(answer.get("reason").and_then(Value::as_str).unwrap_or("It cannot run on this computer.").to_string()),
                    Err(error) => Err(error),
                };
                self.monitoring.readiness.insert(name, (ready, Instant::now()));
                self.push_monitors(webview);
            }
            Pending::Backfill { name, slot, doc, .. } => match result {
                Ok(Value::Bool(true)) => {
                    // Nobody had this window: the offline check is the team's record of it, and its grid with it.
                    if let Some(hash) = doc.get("grid").and_then(Value::as_str) {
                        if let Some(e) = self.monitoring.store.grid(&name, hash) {
                            self.share_grid(&name, hash, &e);
                        }
                    }
                    let _ = self.store_request("write", json!({ "record": doc }), Pending::Write { started: Instant::now() });
                }
                Ok(_) => {}
                Err(_) => {
                    // Still unreachable: kept for the next try.
                    self.monitoring.offline_queue.push((name, slot, doc));
                    self.monitoring.store.save_offline_queue(&self.monitoring.offline_queue);
                }
            },
            Pending::Details { name, row, .. } => {
                let message = match result.and_then(|v| match &v {
                    Value::String(text) => monitor::rows_from_text(text, None),
                    other => monitor::rows_from(other, None),
                }) {
                    Ok(rows) => json!({ "type": "details", "row": row, "ok": true, "columns": monitor::default_columns(&rows), "rows": rows }),
                    Err(error) => json!({ "type": "details", "row": row, "ok": false, "error": error }),
                };
                self.monitoring.grid_out.push((name, message));
            }
            Pending::Sync { before, .. } => {
                let synced: Vec<String> = match &result {
                    Ok(answer) => answer.get("synced").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default(),
                    Err(_) => Vec::new(),
                };
                self.monitor_scan();
                self.push_monitors(webview);
                let mut message = self.refresh_words(&before, &synced);
                if let Err(error) = result {
                    message = format!("{message} The team's skills could not be synced: {error}");
                }
                self.monitoring.shell_out.push(json!({ "type": "monitorReply", "op": "refresh", "ok": true, "data": { "message": message, "refreshed": true } }));
            }
            Pending::FileHistory { name, modified, .. } => {
                // A failure is kept as "nothing known", so it is not asked again until the file changes.
                let history = result.unwrap_or(Value::Null);
                self.monitoring.file_history.insert(name.clone(), (modified, history.clone()));
                self.monitoring.grid_out.push((name, json!({ "type": "fileHistory", "history": history })));
                self.push_monitors(webview);
            }
            Pending::Revisions { name, .. } => {
                let message = match result {
                    Ok(list) => json!({ "type": "revisions", "team": list, "teamPending": false }),
                    Err(error) => json!({ "type": "revisions", "teamError": error, "teamPending": false }),
                };
                self.monitoring.grid_out.push((name, message));
            }
            Pending::Write { .. } => match result {
                Ok(answer) => {
                    self.monitoring.team_error = None;
                    if let Some(by) = answer.get("by").and_then(Value::as_str) {
                        self.monitoring.me = Some(by.to_string());
                    }
                }
                Err(error) => self.monitoring.team_error = Some(error),
            },
            Pending::Latest { .. } => match result {
                Ok(map) => {
                    self.monitoring.team_error = None;
                    self.apply_latest(&map, webview);
                    // Reachable again: offer what ran offline.
                    self.offer_offline();
                }
                Err(error) => {
                    self.monitoring.team_error = Some(error);
                    self.push_monitors(webview);
                }
            },
            Pending::History { name, days, key, alert, range, target, .. } => {
                let answer = result.map(|v| serde_json::from_value::<Vec<CheckRecord>>(v).unwrap_or_default()).map(|records| self.history_payload(&name, days, key.as_deref(), alert.as_deref(), range, records, &target));
                self.respond(&target, "history", answer);
            }
            Pending::ExplainHistory { name, row, .. } => {
                let records = result.map(|v| serde_json::from_value::<Vec<CheckRecord>>(v).unwrap_or_default());
                match records {
                    Ok(records) => self.explain_with(&name, row, records),
                    Err(error) => self.monitoring.grid_out.push((name, json!({ "type": "explanation", "row": row, "ok": false, "error": error }))),
                }
            }
            Pending::Explain { name, row, context, .. } => {
                let message = match result {
                    Ok(Value::String(text)) => {
                        self.monitoring.explanations.insert(name.clone(), (row, text.clone(), context));
                        json!({ "type": "explanation", "row": row, "ok": true, "text": text })
                    }
                    Ok(_) => json!({ "type": "explanation", "row": row, "ok": false, "error": "The explanation came back empty." }),
                    Err(error) => json!({ "type": "explanation", "row": row, "ok": false, "error": error }),
                };
                self.monitoring.grid_out.push((name, message));
            }
            Pending::Prune { .. } => {
                if let Err(error) = result {
                    self.monitoring.team_error = Some(error);
                }
            }
            Pending::SkillChange { name, op, approve, via_grid, .. } => {
                let said = match &result {
                    Ok(Value::String(text)) => text.clone(),
                    Ok(_) => String::new(),
                    Err(error) => error.clone(),
                };
                if result.is_ok() {
                    if op == "delete" {
                        self.forget_monitor(&name);
                    } else if let Some(hash) = approve {
                        self.monitoring.states.entry(name.clone()).or_default().approved = Some(hash);
                    }
                    self.monitor_scan();
                    self.save_monitor_states();
                    self.push_monitors(webview);
                }
                let sheet = if op == "delete" { "delete" } else { "schedule" };
                if via_grid {
                    let message = if result.is_ok() {
                        let mut grid = self.grid_message(&name);
                        grid["sheetDone"] = json!(sheet);
                        grid["doneText"] = json!(said);
                        grid
                    } else {
                        json!({ "type": "notice", "level": "error", "text": said })
                    };
                    self.monitoring.grid_out.push((name.clone(), message));
                }
                self.monitoring.shell_out.push(match &result {
                    Ok(_) => json!({ "type": "monitorReply", "op": op, "ok": true, "data": { "name": name, "message": said } }),
                    Err(_) => json!({ "type": "monitorReply", "op": op, "ok": false, "error": said }),
                });
            }
        }
    }

    /// Whether this computer can run a team monitor's check: `Some(Ok)` yes, `Some(Err)` why not, `None` not known
    /// yet. A SQLite or file source is looked at here; a tool is asked of the executor (`probe`, the same lookup a
    /// check makes) and the answer kept ten minutes, re-asked in the background meanwhile.
    fn ready_here(&mut self, f: &Found) -> Option<Result<(), String>> {
        let Ok(m) = &f.monitor else { return Some(Err("It cannot run as written.".into())) };
        fn missing(path: &str) -> String {
            format!("{path} cannot be reached from this computer.")
        }
        match &m.source {
            Source::Sqlite { .. } | Source::Files { .. } => {
                let known = self.monitoring.readiness.get(&f.name).cloned();
                let fresh = known.as_ref().map(|(_, at)| at.elapsed() < READY_FOR).unwrap_or(false);
                let asking = self.monitoring.pending.values().any(|p| matches!(p, Pending::Probe { name, .. } if *name == f.name));
                if !fresh && !asking {
                    // A path on a share that does not answer can take many seconds to fail: never on this thread.
                    let paths: Vec<String> = match &m.source {
                        Source::Sqlite { path, .. } => vec![path.clone()],
                        Source::Files { files, .. } => files.iter().map(|(_, path)| path.clone()).filter(|p| !p.contains('*') && !p.contains('?')).collect(),
                        _ => Vec::new(),
                    };
                    let id = self.monitoring.id();
                    self.monitoring.pending.insert(id.clone(), Pending::Probe { name: f.name.clone(), started: Instant::now() });
                    let proxy = self.proxy.clone();
                    std::thread::spawn(move || {
                        let result = match paths.iter().find(|p| !Path::new(p.as_str()).exists()) {
                            Some(path) => json!({ "ready": false, "reason": missing(path) }),
                            None => json!({ "ready": true }),
                        };
                        let _ = proxy.send_event(UserEvent::MonitorFetched { id, result: Ok(result) });
                    });
                }
                known.map(|(ready, _)| ready)
            }
            Source::Tool { tool, .. } => {
                let known = self.monitoring.readiness.get(&f.name).cloned();
                let fresh = known.as_ref().map(|(_, at)| at.elapsed() < READY_FOR).unwrap_or(false);
                let asking = self.monitoring.pending.values().any(|p| matches!(p, Pending::Probe { name, .. } if *name == f.name));
                if !fresh && !asking {
                    if let Err(error) = self.exec_request(json!({ "kind": "probe", "tool": tool }), Pending::Probe { name: f.name.clone(), started: Instant::now() }) {
                        return Some(Err(error));
                    }
                }
                known.map(|(ready, _)| ready)
            }
        }
    }

    /// Why a check is not running yet, when it should be: the executor still starting, a turn, a colleague's window.
    fn waiting_reason(&self, f: &Found) -> Option<String> {
        if let Some(reason) = self.monitoring.waiting_for.get(&f.name) {
            return Some(reason.clone());
        }
        let tool = matches!(&f.monitor, Ok(m) if matches!(m.source, Source::Tool { .. }));
        if tool && self.monitoring.running.contains_key(&f.name) && !self.monitoring.executor.as_ref().map(|e| e.ready).unwrap_or(false) {
            return Some(match &self.monitoring.executor_error {
                Some(error) if self.monitoring.executor.is_none() => format!("Waiting for the monitoring executor - {error}"),
                _ => "Starting the monitoring executor - the check runs as soon as it is up.".to_string(),
            });
        }
        None
    }

    /// A team monitor whose last check here failed leaves the next windows to colleagues - for three windows (at
    /// least 30 minutes) - so a member whose credential or network is broken does not keep winning the claim and
    /// recording failures for everyone. Unless nobody has checked it for a window since: then nobody else can, and
    /// this computer tries again.
    fn leaving_to_colleagues(&self, f: &Found, now: i64) -> bool {
        let Ok(m) = &f.monitor else { return false };
        let every = if m.every_secs > 0 { m.every_secs as i64 } else { 3600 };
        let newest = self.monitoring.summaries.get(&f.name).map(|s| s.at).unwrap_or(0);
        steps_back(self.monitoring.failed_here.get(&f.name).copied(), newest, every, now)
    }

    /// Checks run offline, offered to the team's history now that it answers: each claims its window and is written
    /// only if nobody else had it - a colleague who was online for that window keeps the record.
    fn offer_offline(&mut self) {
        if self.monitoring.offline_queue.is_empty() {
            return;
        }
        let batch: Vec<(String, i64, Value)> = self.monitoring.offline_queue.drain(..self.monitoring.offline_queue.len().min(20)).collect();
        self.monitoring.store.save_offline_queue(&self.monitoring.offline_queue);
        for (name, slot, doc) in batch {
            let pending = Pending::Backfill { name: name.clone(), slot, doc: doc.clone(), started: Instant::now() };
            if self.store_request("claim", json!({ "monitor": name, "slot": slot }), pending).is_err() {
                self.monitoring.offline_queue.push((name, slot, doc));
            }
        }
        self.monitoring.store.save_offline_queue(&self.monitoring.offline_queue);
    }

    /// Shares a team check's whole grid in the team index, so every member sees the same rows. A grid over
    /// `SHARED_GRID_ROWS` rows or `SHARED_GRID_BYTES` is not shared - members then see its alerted rows.
    fn share_grid(&mut self, name: &str, hash: &str, e: &monitor::Evaluation) {
        if e.rows.len() > SHARED_GRID_ROWS || serde_json::to_string(e).map(|s| s.len()).unwrap_or(usize::MAX) > SHARED_GRID_BYTES {
            return;
        }
        let _ = self.store_request("writeGrid", json!({ "monitor": name, "hash": hash, "evaluation": e }), Pending::Write { started: Instant::now() });
    }

    /// A colleague's newest check, with every row it read: the result here, if that check is still the newest.
    fn full_team_grid(&mut self, name: &str, at: i64, e: monitor::Evaluation) {
        let Some(mut record) = self.monitoring.store.result(name) else { return };
        if record.at != at {
            return;
        }
        record.evaluation = Some(e);
        record.partial = false;
        let _ = self.monitoring.store.save_result(name, &record);
        self.monitoring.grid_out.push((name.to_string(), self.grid_message(name)));
    }

    /// What is kept here about a monitor that is gone: results, history, state, and what is held in memory.
    fn forget_monitor(&mut self, name: &str) {
        self.monitoring.store.delete_history(name);
        self.monitoring.store.delete_revisions(name);
        self.monitoring.revision_seen.remove(name);
        self.monitoring.summaries.remove(name);
        self.monitoring.spark.remove(name);
        self.monitoring.explanations.remove(name);
        self.monitoring.states.remove(name);
    }

    fn finish_check(&mut self, name: &str, at: i64, started: Instant, result: Result<Value, String>, webview: &WebView) {
        self.monitoring.running.remove(name);
        let Some(f) = self.monitoring.found(name).cloned() else { return };
        let Ok(m) = &f.monitor else { return };
        let now = monitor::now_secs();
        let local = monitor::local_now();
        let rows = result.and_then(|v| match &v {
            Value::String(text) => monitor::rows_from_text(text, m.rows_path.as_deref()),
            other => monitor::rows_from(other, m.rows_path.as_deref()),
        });
        let duration_ms = started.elapsed().as_millis() as u64;
        let record = match rows {
            Ok(rows) => {
                let acks = self.monitoring.states.get(name).map(|s| s.acks.clone()).unwrap_or_default();
                let evaluation = monitor::evaluate(m, rows, &acks, now, local.offset_secs);
                // Acknowledgements of alerts that are gone are dropped: a fixed problem that comes back is new.
                if let Some(state) = self.monitoring.states.get_mut(name) {
                    state.acks.retain(|id, _| evaluation.alerts.iter().any(|a| &a.id == id));
                }
                RunRecord { at, duration_ms, level: evaluation.level, error: None, headline: evaluation.headline.clone(), evaluation: Some(evaluation), last_success_at: Some(at), by: None, partial: false }
            }
            Err(error) => {
                // The last good rows stay on screen, marked as old, rather than vanishing.
                let previous = self.monitoring.store.result(name);
                RunRecord {
                    at,
                    duration_ms,
                    level: Level::Purple,
                    headline: format!("Check failed: {}", error.lines().next().unwrap_or("")),
                    error: Some(error),
                    last_success_at: previous.as_ref().and_then(|p| p.last_success_at),
                    evaluation: previous.and_then(|p| p.evaluation),
                    by: None,
                    partial: false,
                }
            }
        };
        let mut check = CheckRecord::from_run(&record);
        // The whole grid stays here, for History's "as it was" - the team's index keeps the summary and alerted rows.
        check.grid = record.evaluation.as_ref().and_then(|e| self.monitoring.store.save_grid(name, e));
        let _ = self.monitoring.store.save_result(name, &record);
        self.monitoring.store.record_history(name, &check);
        self.monitoring.spark_push(name, at, record.level);
        if f.team {
            // The team's history is kept once, in its index; here only enough for the tile and offline.
            self.monitoring.store.keep_last(name, TEAM_LOCAL_CHECKS);
        }
        self.monitoring.summaries.insert(name.to_string(), Summary::of(&record));
        if f.team {
            if record.error.is_some() {
                self.monitoring.failed_here.insert(name.to_string(), now);
            } else {
                self.monitoring.failed_here.remove(name);
            }
            let mut doc = serde_json::to_value(&check).unwrap_or_default();
            doc["monitor"] = json!(name);
            match self.monitoring.offline_slot.remove(name) {
                Some(slot) => {
                    // Run offline: kept (at most 50 per monitor, newest) to offer when the team can be reached.
                    self.monitoring.offline_queue.push((name.to_string(), slot, doc));
                    let mut seen = 0;
                    let mut keep = vec![true; self.monitoring.offline_queue.len()];
                    for (i, (n, _, _)) in self.monitoring.offline_queue.iter().enumerate().rev() {
                        if n == name {
                            seen += 1;
                            keep[i] = seen <= 50;
                        }
                    }
                    let mut i = 0;
                    self.monitoring.offline_queue.retain(|_| {
                        i += 1;
                        keep[i - 1]
                    });
                    self.monitoring.store.save_offline_queue(&self.monitoring.offline_queue);
                }
                None => {
                    if let (Some(hash), Some(e)) = (check.grid.as_deref(), record.evaluation.as_ref()) {
                        self.share_grid(name, hash, e);
                    }
                    if let Err(error) = self.store_request("write", json!({ "record": doc }), Pending::Write { started: Instant::now() }) {
                        self.monitoring.team_error = Some(error);
                    }
                }
            }
        }
        self.save_monitor_states();
        self.maybe_notify(&f, now, local);
        self.push_monitors(webview);
        self.monitoring.grid_out.push((name.to_string(), self.grid_message(name)));
    }

    /// The team's newest checks: a colleague's newer one becomes what this dashboard shows.
    fn apply_latest(&mut self, map: &Value, webview: &WebView) {
        let Some(map) = map.as_object() else { return };
        let now = monitor::now_secs();
        let local = monitor::local_now();
        let mut changed = false;
        for (name, doc) in map {
            let Ok(check) = serde_json::from_value::<CheckRecord>(doc.clone()) else { continue };
            let Some(f) = self.monitoring.found(name).cloned() else { continue };
            let Ok(m) = &f.monitor else { continue };
            if self.monitoring.summaries.get(name).map(|s| s.at >= check.at).unwrap_or(false) {
                continue;
            }
            let previous_success = self.monitoring.summaries.get(name).and_then(|s| s.last_success_at);
            let record = RunRecord {
                at: check.at,
                duration_ms: check.duration_ms,
                level: check.level,
                error: check.error.clone(),
                headline: check.headline.clone(),
                evaluation: Some(check.evaluation(m)),
                last_success_at: if check.error.is_none() { Some(check.at) } else { previous_success },
                by: check.by.clone(),
                partial: true,
            };
            let _ = self.monitoring.store.save_result(name, &record);
            self.monitoring.store.record_history(name, &check);
            self.monitoring.store.keep_last(name, TEAM_LOCAL_CHECKS);
            self.monitoring.spark_push(name, check.at, check.level);
            self.monitoring.summaries.insert(name.clone(), Summary::of(&record));
            self.maybe_notify(&f, now, local);
            // The same rows as the member who ran it: their whole grid, here already or fetched from the team.
            if let Some(hash) = check.grid.clone() {
                match self.monitoring.store.grid(name, &hash) {
                    Some(e) => self.full_team_grid(name, check.at, e),
                    None => {
                        let _ = self.store_request("grid", json!({ "monitor": name, "hash": hash }), Pending::TeamGrid { name: name.clone(), at: check.at, hash: hash.clone(), started: Instant::now() });
                    }
                }
            }
            self.monitoring.grid_out.push((name.clone(), self.grid_message(name)));
            changed = true;
        }
        if changed {
            self.push_monitors(webview);
        }
    }

    fn save_monitor_states(&self) {
        self.monitoring.save_states();
    }

    fn maybe_notify(&mut self, f: &Found, now: i64, local: LocalNow) {
        let Ok(m) = &f.monitor else { return };
        let Some(summary) = self.monitoring.summaries.get(&f.name).cloned() else { return };
        let level = self.monitoring.level_now(f, &summary, now);
        let state = self.monitoring.states.entry(f.name.clone()).or_default().clone();
        let decision = monitor::should_notify(m, level, &state, &self.monitoring.settings, now, local);
        {
            let state = self.monitoring.states.entry(f.name.clone()).or_default();
            match decision {
                Some(_) => {
                    state.notified_level = Some(level);
                    state.notified_at = Some(now);
                }
                // Better, but not worth a word: remembered, so getting worse again is told.
                None if level < state.notified_level.unwrap_or(Level::Green) => state.notified_level = Some(level),
                None => {}
            }
        }
        self.save_monitor_states();
        let Some((mode, telling)) = decision else { return };
        if mode <= Mode::Dashboard {
            return;
        }
        let style = match mode {
            Mode::Silent => system::ToastStyle::Silent,
            Mode::Toast => system::ToastStyle::Normal,
            Mode::Urgent => system::ToastStyle::Urgent,
            _ => system::ToastStyle::Alarm,
        };
        let title = match telling {
            monitor::Telling::Recovered => format!("{} - clear again", f.title()),
            monitor::Telling::StillBad => format!("{} - still {}", f.title(), level.meaning().to_lowercase()),
            monitor::Telling::Worse => format!("{} - {}", f.title(), level.meaning()),
        };
        let detail = format!(
            "{} monitor · checked {}{}",
            if f.team { "Team" } else { "Personal" },
            local_clock(summary.at, local.offset_secs),
            summary.by.as_deref().map(|b| format!(" by {b}")).unwrap_or_default()
        );
        let buttons: Vec<(&str, &str)> = if telling == monitor::Telling::Recovered { vec![("Open", "open")] } else { vec![("Open", "open"), ("Acknowledge", "ack"), ("Snooze 1 hour", "snooze60")] };
        let (proxy, name) = (self.proxy.clone(), f.name.clone());
        system::notify_styled(&title, &summary.headline, Some(&detail), &self.icon_file, &buttons, style, move |action| {
            let _ = proxy.send_event(UserEvent::MonitorToast { name: name.clone(), action });
        });
        if mode >= Mode::Toast && !self.focused {
            self.monitoring.flash = true;
        }
    }

    /// A monitoring notification was clicked, or one of its buttons.
    pub fn monitor_toast(&mut self, name: &str, action: Option<&str>, webview: &WebView) {
        match action {
            Some("ack") => {
                let _ = self.monitor_op("ack", &json!({ "name": name }), Origin::User, webview);
            }
            Some("snooze60") => {
                let _ = self.monitor_op("snooze", &json!({ "name": name, "minutes": 60 }), Origin::User, webview);
            }
            _ => {
                self.monitoring.show_dashboard = true;
                self.monitoring.grid_open.push(name.to_string());
            }
        }
    }

    /// A `light-code-monitor:` line from a host: the executor's answer, or a chat's agent asking.
    pub fn monitor_line(&mut self, from: &str, generation: u64, payload: Value, webview: &WebView) {
        let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        if from == EXECUTOR_ID {
            if self.monitoring.executor.as_ref().map(|e| e.generation) != Some(generation) {
                return;
            }
            match kind {
                "ready" => {
                    if let Some(e) = self.monitoring.executor.as_mut() {
                        e.ready = true;
                    }
                    for request in std::mem::take(&mut self.monitoring.queued) {
                        // Its timeout counts from now: the wait for the executor to start is not the tool's time.
                        if let Some(id) = request.get("id").and_then(Value::as_str) {
                            if let Some(Pending::Check { started, .. } | Pending::Probe { started, .. }) = self.monitoring.pending.get_mut(id) {
                                *started = Instant::now();
                            }
                        }
                        let sent = self.monitoring.executor.as_ref().map(|e| e.process.send_line(&request)).unwrap_or(false);
                        if !sent {
                            if let Some(id) = request.get("id").and_then(Value::as_str) {
                                self.answered(id, Err("The monitoring executor could not be reached.".into()), webview);
                            }
                        }
                    }
                }
                "answer" => {
                    let id = payload.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    let result = if payload.get("ok") == Some(&Value::Bool(true)) {
                        Ok(payload.get("data").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(payload.get("error").and_then(Value::as_str).unwrap_or("It failed.").to_string())
                    };
                    self.answered(&id, result, webview);
                }
                _ => {}
            }
            return;
        }
        if kind != "request" {
            return;
        }
        let id = payload.get("id").cloned().unwrap_or(Value::Null);
        let op = payload.get("op").and_then(Value::as_str).unwrap_or("").to_string();
        let args = payload.get("args").cloned().unwrap_or_else(|| json!({}));
        let target = Target::Agent { host: from.to_string(), generation, id };
        if !self.monitoring.settings.enabled {
            self.respond(&target, "reply", Err("Monitoring is off. Switch it on in Fire Code → Settings → Monitoring.".into()));
            return;
        }
        if op == "history" {
            self.history_request(&args, target);
            return;
        }
        let answer = self.monitor_op(&op, &args, Origin::Agent, webview);
        self.respond(&target, "reply", answer);
    }

    /// An answer to whoever waits: an agent's host, or a grid window (as a message of `kind`).
    fn respond(&mut self, target: &Target, kind: &str, answer: Result<Value, String>) {
        match target {
            Target::Agent { host, generation, id } => {
                let reply = match answer {
                    Ok(data) => json!({ "type": "monitorReply", "id": id, "ok": true, "data": data }),
                    Err(error) => json!({ "type": "monitorReply", "id": id, "ok": false, "error": error }),
                };
                if let Some(rt) = self.runtime.get(host) {
                    if rt.generation == *generation {
                        if let Some(process) = &rt.process {
                            process.send_line(&reply);
                        }
                    }
                }
            }
            Target::Grid(name) => {
                let message = match answer {
                    Ok(mut data) => {
                        data["type"] = json!(kind);
                        data["ok"] = json!(true);
                        data
                    }
                    Err(error) => json!({ "type": kind, "ok": false, "error": error }),
                };
                self.monitoring.grid_out.push((name.clone(), message));
            }
        }
    }

    /// The executor exited: what it was doing fails, and it is tried again a minute later.
    pub fn executor_exited(&mut self, generation: u64, tail: &str, webview: &WebView) {
        if self.monitoring.executor.as_ref().map(|e| e.generation) != Some(generation) {
            return;
        }
        self.monitoring.executor = None;
        self.monitoring.executor_error = Some(format!("The monitoring executor stopped. {}", tail.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ")));
        self.monitoring.executor_retry_at = Some(Instant::now() + Duration::from_secs(60));
        self.monitoring.queued.clear();
        // Everything but a helper read was the executor's.
        let ids: Vec<String> = self.monitoring.pending.keys().cloned().collect();
        let error = self.monitoring.executor_error.clone().unwrap_or_default();
        for id in ids {
            let helper_read = match self.monitoring.pending.get(&id) {
                Some(Pending::Check { name, .. }) | Some(Pending::Details { name, .. }) => {
                    self.monitoring.found(name).and_then(|f| f.monitor.as_ref().ok()).map(|m| !matches!(m.source, Source::Tool { .. })).unwrap_or(false)
                }
                _ => false,
            };
            if !helper_read {
                self.answered(&id, Err(error.clone()), webview);
            }
        }
    }

    // ─── History, explanations, chats ────────────────────────────────────────

    fn history_request(&mut self, args: &Value, target: Target) {
        let Some(name) = args.get("name").and_then(Value::as_str).map(String::from) else {
            self.respond(&target, "history", Err("Name the monitor (\"name\").".into()));
            return;
        };
        let Some(f) = self.monitoring.found(&name).cloned() else {
            self.respond(&target, "history", Err(format!("No monitor called \"{name}\".")));
            return;
        };
        let days = args.get("days").and_then(Value::as_u64).unwrap_or(14).clamp(1, 366) as u32;
        let key = args.get("key").and_then(Value::as_str).map(String::from);
        let alert = args.get("alert").and_then(Value::as_str).map(String::from);
        // One day (the History view's date box): its start and end, in epoch seconds the page worked out locally.
        let range = match (args.get("from").and_then(Value::as_i64), args.get("until").and_then(Value::as_i64)) {
            (Some(from), Some(until)) if until > from => Some((from, until)),
            _ => None,
        };
        let since = range.map(|(from, _)| from).unwrap_or_else(|| monitor::now_secs() - days as i64 * 86_400);
        if f.team && self.team_ready().is_ok() {
            let mut query = json!({ "monitor": name, "since": since, "limit": 2000 });
            if let Some((_, until)) = range {
                query["until"] = json!(until);
            }
            let pending = Pending::History { name: name.clone(), days, key, alert, range, target: target.clone(), started: Instant::now() };
            if let Err(error) = self.store_request("history", query, pending) {
                self.respond(&target, "history", Err(error));
            }
        } else {
            let records: Vec<CheckRecord> = self.monitoring.store.history_since(&name, since).into_iter().filter(|r| range.map(|(_, until)| r.at < until).unwrap_or(true)).collect();
            let payload = self.history_payload(&name, days, key.as_deref(), alert.as_deref(), range, records, &target);
            self.respond(&target, "history", Ok(payload));
        }
    }

    /// Checks newest first and each alert's pattern; a grid also gets each check's alerted rows.
    fn history_payload(&self, name: &str, days: u32, key: Option<&str>, alert: Option<&str>, range: Option<(i64, i64)>, mut records: Vec<CheckRecord>, target: &Target) -> Value {
        let local = monitor::local_now();
        let patterns = monitor::alert_patterns(&records, key, alert, monitor::now_secs(), local.offset_secs);
        records.sort_by_key(|r| -r.at);
        let rows = matches!(target, Target::Grid(_));
        let checks: Vec<Value> = records
            .iter()
            .take(if rows { 300 } else { 200 })
            .map(|r| {
                let mut c = json!({ "at": r.at, "level": r.level, "headline": r.headline, "alerts": r.alerts, "rowCount": r.row_count, "durationMs": r.duration_ms, "by": r.by, "error": r.error, "grid": r.grid });
                if rows {
                    c["found"] = json!(r.found);
                }
                c
            })
            .collect();
        json!({ "name": name, "days": days, "from": range.map(|r| r.0), "until": range.map(|r| r.1), "checks": checks, "total": records.len(), "patterns": patterns })
    }

    fn explain_request(&mut self, name: &str, row: usize) -> Result<Value, String> {
        let f = self.monitoring.found(name).cloned().ok_or_else(|| format!("No monitor called \"{name}\"."))?;
        if f.team && self.team_ready().is_ok() {
            let since = monitor::now_secs() - 14 * 86_400;
            self.store_request("history", json!({ "monitor": name, "since": since, "limit": 2000 }), Pending::ExplainHistory { name: name.to_string(), row, started: Instant::now() })?;
        } else {
            let records = self.monitoring.store.history_since(name, monitor::now_secs() - 14 * 86_400);
            self.explain_with(name, row, records);
        }
        Ok(json!({ "row": row, "pending": true }))
    }

    /// The facts about one alerted row: the monitor, the author's advice, the row, each alert's history.
    fn alert_context(&self, name: &str, row: usize, records: &[CheckRecord]) -> Result<Value, String> {
        let f = self.monitoring.found(name).ok_or_else(|| format!("No monitor called \"{name}\"."))?;
        let m = f.monitor.as_ref().map_err(|e| e.clone())?;
        let record = self.monitoring.store.result(name).ok_or("This monitor has not been checked yet.")?;
        let e = record.evaluation.as_ref().ok_or("The last check read no rows.")?;
        let cells = e.rows.get(row).cloned().ok_or("That row is no longer there - the monitor has checked again since.")?;
        let local = monitor::local_now();
        let alerts: Vec<Value> = e
            .alerts
            .iter()
            .filter(|a| a.row == row)
            .map(|a| {
                let rule = a.id.split('|').next().and_then(|r| r.parse::<usize>().ok()).and_then(|r| m.rules.get(r));
                let pattern = monitor::alert_patterns(records, None, Some(&a.id), monitor::now_secs(), local.offset_secs).into_iter().next();
                json!({ "level": a.level, "meaning": a.level.meaning(), "message": a.message, "column": a.column, "acknowledged": a.acknowledged, "advice": rule.and_then(|r| r.advice.clone()), "history": pattern })
            })
            .collect();
        if alerts.is_empty() {
            return Err("There is no alert on this row.".into());
        }
        Ok(json!({
            "monitor": { "name": f.name, "title": f.title(), "summary": f.summary(), "runbook": m.runbook, "team": f.team, "reads": m.source.describe(), "schedule": schedule_words(m) },
            "row": cells,
            "alerts": alerts,
            "checked": { "at": monitor::local_date_time(record.at, local.offset_secs), "by": record.by },
        }))
    }

    fn explain_with(&mut self, name: &str, row: usize, records: Vec<CheckRecord>) {
        let message = match self.alert_context(name, row, &records) {
            Ok(context) => match self.exec_request(json!({ "kind": "explain", "context": context.clone() }), Pending::Explain { name: name.to_string(), row, context, started: Instant::now() }) {
                Ok(_) => return,
                Err(error) => json!({ "type": "explanation", "row": row, "ok": false, "error": error }),
            },
            Err(error) => json!({ "type": "explanation", "row": row, "ok": false, "error": error }),
        };
        self.monitoring.grid_out.push((name.to_string(), message));
    }

    /// A chat about an alert: named after it, on the codebase chosen (the first by default), its box holding
    /// what is known - the facts and the dashboard's explanation - for the user to send.
    fn start_chat(&mut self, name: &str, row: usize, codebase: Option<&str>, webview: &WebView) -> Result<Value, String> {
        let project = codebase.and_then(|id| self.state.project(id)).or_else(|| self.state.projects.first()).cloned().ok_or("Add a codebase first: a chat runs in one.")?;
        let (context, explanation) = match self.monitoring.explanations.get(name) {
            Some((r, text, context)) if *r == row => (context.clone(), Some(text.clone())),
            _ => (self.alert_context(name, row, &self.monitoring.store.history_since(name, monitor::now_secs() - 14 * 86_400))?, None),
        };
        let title = self.monitoring.found(name).map(|f| f.title()).unwrap_or_else(|| name.to_string());
        let first = context["alerts"][0]["message"].as_str().unwrap_or("").to_string();
        let mut chat_name = format!("Alert: {}", if first.is_empty() { title.clone() } else { first.clone() });
        if chat_name.chars().count() > 48 {
            chat_name = format!("{}…", chat_name.chars().take(47).collect::<String>());
        }
        let key = context["alerts"][0]["history"]["key"].as_str().map(String::from);
        let text = [
            format!("Help me investigate this monitoring alert from Fire Code: {title} - {first}."),
            format!(
                "Check its history with monitor_history (name \"{name}\"{}), look at what the monitor reads, and tell me the likely cause and what to do. The author's advice is in the details.",
                key.map(|k| format!(", key \"{k}\"")).unwrap_or_default()
            ),
            String::new(),
            "```json".into(),
            serde_json::to_string_pretty(&context).unwrap_or_default().chars().take(12_000).collect(),
            "```".into(),
            explanation.map(|e| format!("\nWhat the dashboard said about it:\n\n{e}")).unwrap_or_default(),
        ]
        .join("\n");
        let chat = self.new_chat(&project.id, None, Some(chat_name), webview).ok_or("The chat could not be opened.")?;
        self.monitoring.shell_out.push(json!({ "type": "prefillChat", "id": chat, "text": text }));
        Ok(json!({ "chat": chat, "codebase": project.name }))
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    /// The colour a tile shows, and why.
    fn display(&self, f: &Found, now: i64, local: LocalNow) -> (Level, &'static str) {
        let Ok(m) = &f.monitor else { return (Level::Purple, "broken") };
        if !self.monitoring.approved(f) {
            return (Level::Grey, "review");
        }
        if f.team && self.team_ready().is_err() {
            return (Level::Grey, "noTeam");
        }
        if self.monitoring.states.get(&f.name).map(|s| s.paused).unwrap_or(false) {
            return (Level::Grey, "paused");
        }
        let Some(s) = self.monitoring.summaries.get(&f.name) else {
            return (Level::Grey, if self.monitoring.running.contains_key(&f.name) { "checking" } else { "waiting" });
        };
        if s.error.is_some() {
            return (Level::Purple, "failed");
        }
        let last = s.last_success_at.unwrap_or(s.at);
        if (m.active(local) || !m.times.is_empty()) && now - last > m.stale_after() {
            return (Level::Purple, "stale");
        }
        (self.monitoring.level_now(f, s, now), "ok")
    }

    fn monitor_view(&self, f: &Found, now: i64, local: LocalNow, team_problem: Option<&str>) -> Value {
        let state = self.monitoring.states.get(&f.name).cloned().unwrap_or_default();
        let summary = self.monitoring.summaries.get(&f.name);
        let (level, status) = self.display(f, now, local);
        let m = f.monitor.as_ref().ok();
        let history: Vec<Value> = self.monitoring.spark.get(&f.name).map(|p| p.iter().map(|(at, l)| json!([at, l])).collect()).unwrap_or_default();
        let provenance = self.provenance(f);
        json!({
            "name": f.name,
            "title": f.title(),
            "summary": f.summary(),
            "description": f.description,
            "team": f.team,
            "origin": f.origin,
            "file": f.file.to_string_lossy(),
            "level": level,
            "status": status,
            "meaning": level.meaning(),
            "headline": match status {
                "review" => "Needs your review before it runs on this computer".to_string(),
                "noTeam" => team_problem.unwrap_or("Team monitoring needs the team's OpenSearch history").to_string(),
                "paused" => "Paused".to_string(),
                "waiting" => "Waiting for its first check".to_string(),
                "checking" => "Checking…".to_string(),
                "broken" => f.monitor.as_ref().err().cloned().unwrap_or_default(),
                "stale" => format!("No fresh data since {}", summary.map(|s| local_clock(s.last_success_at.unwrap_or(s.at), local.offset_secs)).unwrap_or_default()),
                _ => summary.map(|s| s.headline.clone()).unwrap_or_default(),
            },
            "error": summary.and_then(|s| s.error.clone()),
            "specError": f.monitor.as_ref().err(),
            "lastRun": summary.map(|s| s.at),
            "lastBy": summary.and_then(|s| s.by.clone()),
            "nextRun": m.and_then(|m| m.next_run(summary.map(|s| s.at), now, local)),
            // A due check that has not started: since when (the tile and grid say "Due since", not "Next ... ago").
            "overdueSince": m.and_then(|m| m.overdue_since(summary.map(|s| s.at), now, local)).filter(|_| !state.paused),
            "every": m.map(|m| m.every_secs),
            "schedule": m.map(schedule_words),
            // The schedule as written, for the editor, and why it cannot be changed here when it cannot.
            "scheduleSpec": schedule_spec(&f.block),
            // A team monitor this computer leaves to colleagues, and why; and checks run offline, not yet shared.
            "notHere": f.team.then(|| match self.monitoring.readiness.get(&f.name) {
                Some((Err(reason), _)) => Some(reason.clone()),
                _ if self.leaving_to_colleagues(f, now) => Some("Its last check on this computer failed, so colleagues' Fire Code runs it for a while.".to_string()),
                _ => None,
            }).flatten(),
            "offline": self.monitoring.offline_queue.iter().filter(|(n, _, _)| *n == f.name).count(),
            // Changed through the host: the dashboard says where the change goes.
            "teamCopy": is_team_copy(f).then(|| team_place(f)),
            "running": self.monitoring.running.contains_key(&f.name),
            "waitingFor": self.waiting_reason(f),
            "author": provenance.2,
            "version": f.labels.version,
            "updatedAt": provenance.1,
            "updatedBy": provenance.0,
            // Where "updated by" came from: "Bitbucket" or "git" when from a commit, absent when from the labels.
            "updatedFrom": provenance.3,
            "approved": self.monitoring.approved(f),
            // What approving it would let run, shown on the review card (invariant 8: the spec itself).
            "block": (!self.monitoring.approved(f)).then(|| f.block.clone()),
            "paused": state.paused,
            "snoozeUntil": state.snooze_until.filter(|u| *u > now),
            "mode": state.mode.map(mode_word),
            "notifyFrom": state.notify_from.unwrap_or_else(|| m.map(|m| m.notify_from).unwrap_or(Level::Amber)),
            "openAlerts": summary.map(|s| self.monitoring.open_alerts(f, s, now)),
            "rowCount": summary.map(|s| s.row_count),
            "source": m.map(|m| m.source.describe()),
            "sourceKind": m.map(|m| m.source.kind()),
            "history": history,
        })
    }

    pub fn monitors_message(&self) -> Value {
        let now = monitor::now_secs();
        let local = monitor::local_now();
        let team = self.team_ready();
        let problem = team.as_ref().err().map(String::as_str);
        let monitors: Vec<Value> = self.monitoring.found.iter().map(|f| self.monitor_view(f, now, local, problem)).collect();
        let s = &self.monitoring.settings;
        json!({
            "type": "monitors",
            "enabled": s.enabled,
            "settings": s,
            "monitors": monitors,
            "codebases": self.state.projects.iter().map(|p| json!({ "id": p.id, "name": p.name })).collect::<Vec<_>>(),
            // Whether checks are being started on time: stopped by the user, or when it last looked (every 3 s).
            "scheduler": {
                "stopped": s.scheduler_stopped,
                "lastTick": self.monitoring.last_tick_at,
                "running": self.monitoring.running.len(),
                "waiting": self.monitoring.waiting_for.len(),
            },
            "executor": {
                "running": self.monitoring.executor.as_ref().map(|e| e.ready).unwrap_or(false),
                "starting": self.monitoring.executor.as_ref().map(|e| !e.ready).unwrap_or(false),
                "error": self.monitoring.executor_error,
            },
            "teamReady": team.is_ok(),
            "teamProblem": problem,
            "teamError": self.monitoring.team_error,
            "teamStores": self.team_stores().into_iter().map(|(id, label)| json!({ "id": id, "label": label })).collect::<Vec<_>>(),
            "levels": monitor::LEVELS.iter().map(|l| json!({ "level": l, "meaning": l.meaning() })).collect::<Vec<_>>(),
        })
    }

    pub fn push_monitors(&self, webview: &WebView) {
        send(webview, self.monitors_message());
    }

    /// Alerts the title bar and the dashboard button count: monitors in red or amber, not snoozed or paused.
    pub fn monitor_alert_count(&self) -> usize {
        if !self.monitoring.settings.enabled {
            return 0;
        }
        let now = monitor::now_secs();
        let local = monitor::local_now();
        self.monitoring
            .found
            .iter()
            .filter(|f| self.display(f, now, local).0 >= Level::Amber)
            .filter(|f| !self.monitoring.states.get(&f.name).and_then(|s| s.snooze_until).map(|u| u > now).unwrap_or(false))
            .count()
    }

    /// Everything a grid window shows for one monitor: its last check, read from disk now.
    pub fn grid_message(&self, name: &str) -> Value {
        let now = monitor::now_secs();
        let local = monitor::local_now();
        let Some(f) = self.monitoring.found(name) else { return json!({ "type": "grid", "missing": true, "name": name }) };
        let team = self.team_ready();
        let mut record = self.monitoring.store.result(name);
        if let Some(e) = record.as_mut().and_then(|r| r.evaluation.as_mut()) {
            for alert in &mut e.alerts {
                alert.acknowledged = self.monitoring.acked(name, &alert.id, alert.level, now);
            }
        }
        let m = f.monitor.as_ref().ok();
        json!({
            "type": "grid",
            "monitor": self.monitor_view(f, now, local, team.as_ref().err().map(String::as_str)),
            "record": record,
            "columns": m.map(|m| m.columns.clone()),
            "rules": m.map(|m| m.rules.iter().map(|r| json!({ "level": r.level, "advice": r.advice, "message": r.message })).collect::<Vec<_>>()),
            "runbook": m.and_then(|m| m.runbook.clone()),
            // When each alert's acknowledgement or snooze ends (absent: while the alert lasts).
            "acks": self.monitoring.states.get(name).map(|s| s.acks.iter().map(|(id, a)| (id.clone(), json!({ "until": a.until, "note": a.note }))).collect::<Map<String, Value>>()),
            "hasDetails": m.map(|m| m.details.is_some()).unwrap_or(false),
            "codebases": self.state.projects.iter().map(|p| json!({ "id": p.id, "name": p.name })).collect::<Vec<_>>(),
            "appearance": { "theme": self.state.settings.theme, "accent": self.state.settings.accent },
        })
    }

    // ─── Operations ─────────────────────────────────────────────────────────

    /// What the dashboard, a grid window and an agent may do. `Origin::Agent` cannot approve a monitor it did
    /// not just write, take an approval back, delete history or change monitoring's settings.
    pub fn monitor_op(&mut self, op: &str, args: &Value, origin: Origin, webview: &WebView) -> Result<Value, String> {
        let name = || args.get("name").and_then(Value::as_str).map(String::from).ok_or_else(|| "Name the monitor (\"name\").".to_string());
        let known = |app: &App, n: &str| -> Result<(), String> {
            if app.monitoring.found(n).is_some() {
                Ok(())
            } else {
                Err(format!("No monitor called \"{n}\". Monitors: {}.", app.monitoring.found.iter().map(|f| f.name.as_str()).collect::<Vec<_>>().join(", ")))
            }
        };
        let now = monitor::now_secs();
        let result = match op {
            "list" => Ok(self.monitors_message()),
            "rescan" => {
                self.monitor_scan();
                Ok(json!({ "monitors": self.monitoring.found.len() }))
            }
            "schedulerStop" | "schedulerStart" => {
                // Asked for: see whether the scheduler is working, start it when it is not, and stop it.
                if origin == Origin::Agent {
                    return Err("Only the user stops or starts the monitoring scheduler, from the dashboard.".into());
                }
                let start = op == "schedulerStart";
                self.monitoring.settings.scheduler_stopped = !start;
                self.monitoring.store.save_settings(&self.monitoring.settings)?;
                if start {
                    // A fresh start: what was stuck is let go, the executor may start again at once, the folders
                    // are read again, and the timer itself is started again if it stopped ticking.
                    self.monitoring.running.clear();
                    self.monitoring.pending.retain(|_, p| !matches!(p, Pending::Check { .. } | Pending::Claim { .. } | Pending::Probe { .. }));
                    self.monitoring.waiting_for.clear();
                    self.monitoring.claim_lost.clear();
                    self.monitoring.readiness.clear();
                    self.monitoring.executor_retry_at = None;
                    self.monitoring.last_scan = None;
                    if self.monitoring.last_tick_at.map(|t| now - t > 10).unwrap_or(true) {
                        crate::spawn_ticker(self.proxy.clone());
                    }
                    self.monitor_tick(webview);
                }
                Ok(json!({ "stopped": !start, "message": if start { "The scheduler is running - checks start when they are due." } else { "The scheduler is stopped - no check starts by itself until you start it. Run now still works." } }))
            }
            "refresh" => {
                // Asked for: a refresh to see newly added checks, and deleted ones go. The folders are read now;
                // the team's bucket and repository are synced by the host, then read again.
                let before: Vec<String> = self.monitoring.found.iter().map(|f| f.name.clone()).collect();
                self.monitor_scan();
                self.push_monitors(webview);
                let syncing = self.exec_request(json!({ "kind": "sync" }), Pending::Sync { before: before.clone(), started: Instant::now() }).is_ok();
                if !syncing {
                    let message = self.refresh_words(&before, &[]);
                    return Ok(json!({ "message": message, "refreshed": true }));
                }
                Ok(json!({ "syncing": true, "refreshing": true }))
            }
            "get" => {
                let n = name()?;
                known(self, &n)?;
                let mut grid = self.grid_message(&n);
                let limit = args.get("rows").and_then(Value::as_u64).unwrap_or(100).min(1000) as usize;
                let only = args.get("onlyAlerts").and_then(Value::as_bool).unwrap_or(false);
                if let Some(e) = grid.get_mut("record").and_then(|r| r.get_mut("evaluation")).filter(|e| e.is_object()) {
                    let alerted: Vec<usize> = e["alerts"].as_array().into_iter().flatten().filter_map(|a| a["row"].as_u64().map(|r| r as usize)).collect();
                    if let Some(rows) = e.get_mut("rows").and_then(Value::as_array_mut) {
                        let total = rows.len();
                        let kept: Vec<Value> = rows.iter().enumerate().filter(|(i, _)| !only || alerted.contains(i)).map(|(i, r)| json!({ "row": i, "cells": r })).take(limit).collect();
                        *rows = kept;
                        e["rowsTotal"] = json!(total);
                    }
                }
                Ok(grid)
            }
            "run" => {
                let n = name()?;
                known(self, &n)?;
                let f = self.monitoring.found(&n).cloned().expect("known");
                if !self.monitoring.approved(&f) {
                    return Err(format!("\"{n}\" has not been approved on this computer yet - open it on the dashboard and approve it."));
                }
                if let Err(e) = &f.monitor {
                    return Err(e.clone());
                }
                if f.team {
                    self.team_ready()?;
                }
                // Asked for now. A team monitor claims a two-minute slot first (negative, so it never meets a
                // scheduled one): several people pressing Run now together make one check and one record, and the
                // others are shown it. Two at once on this computer `running` prevents.
                if !self.monitoring.running.contains_key(&n) {
                    if f.team {
                        let slot = -(now / 120);
                        self.monitoring.running.insert(n.clone(), Instant::now());
                        let claimed = self.store_request("claim", json!({ "monitor": n, "slot": slot }), Pending::Claim { name: n.clone(), slot, manual: true, attempt: 1, started: Instant::now() });
                        if let Err(error) = claimed {
                            self.monitoring.running.remove(&n);
                            return Err(error);
                        }
                    } else {
                        self.start_check(&n, webview);
                    }
                }
                Ok(json!({ "started": true, "name": n }))
            }
            "pause" | "resume" => {
                let n = name()?;
                known(self, &n)?;
                let on = op == "pause" && args.get("on").and_then(Value::as_bool).unwrap_or(true);
                self.monitoring.states.entry(n.clone()).or_default().paused = on;
                Ok(json!({ "name": n, "paused": on }))
            }
            "snooze" => {
                let n = name()?;
                known(self, &n)?;
                let until = snooze_end(args, now)?;
                self.monitoring.states.entry(n.clone()).or_default().snooze_until = until;
                Ok(json!({ "name": n, "snoozeUntil": until }))
            }
            "ack" | "unack" => {
                let n = name()?;
                known(self, &n)?;
                let alerts = self.monitoring.summaries.get(&n).map(|s| s.alerts.clone()).unwrap_or_default();
                let wanted: Option<Vec<String>> = args.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect());
                let chosen: Vec<(String, Level)> = alerts.into_iter().filter(|(id, _)| wanted.as_ref().map(|w| w.contains(id)).unwrap_or(true)).collect();
                // An end time makes it a snooze of those alerts (a row's, from the grid); none: while the alert lasts.
                let until = if args.get("until").is_some() || args.get("minutes").is_some() { snooze_end(args, now)? } else { None };
                let note = args.get("note").and_then(Value::as_str).map(|s| s.chars().take(300).collect::<String>());
                let state = self.monitoring.states.entry(n.clone()).or_default();
                for (id, level) in &chosen {
                    if op == "ack" {
                        state.acks.insert(id.clone(), Ack { level: *level, at: now, until, note: note.clone() });
                    } else {
                        state.acks.remove(id);
                    }
                }
                Ok(json!({ "name": n, "changed": chosen.len() }))
            }
            "notify" => {
                let n = name()?;
                known(self, &n)?;
                let state = self.monitoring.states.entry(n.clone()).or_default();
                if let Some(mode) = args.get("mode").and_then(Value::as_str) {
                    state.mode = if mode == "default" { None } else { Some(parse_mode(mode).ok_or_else(|| format!("\"{mode}\" is not a notification level - off, dashboard, silent, toast, urgent, alarm or default."))?) };
                }
                if let Some(from) = args.get("notifyFrom").and_then(Value::as_str) {
                    state.notify_from = if from == "default" { None } else { Some(Level::parse(from).ok_or_else(|| format!("\"{from}\" is not an alert level."))?) };
                }
                Ok(json!({ "name": n, "mode": state.mode.map(mode_word), "notifyFrom": state.notify_from }))
            }
            "approve" => {
                // Rescanned first: a monitor an agent has just written must be the one approved.
                self.monitor_scan();
                let n = name()?;
                known(self, &n)?;
                let f = self.monitoring.found(&n).cloned().expect("known");
                if origin == Origin::Agent {
                    let block = args.get("block").and_then(Value::as_str).ok_or("Only the user approves a monitor from the dashboard.")?;
                    if monitor::hash_block(block) != f.hash {
                        return Err(format!("\"{n}\" on disk is not the monitor that was written; approve it on the dashboard."));
                    }
                }
                if let Err(e) = &f.monitor {
                    return Err(format!("It cannot run: {e}"));
                }
                self.monitoring.states.entry(n.clone()).or_default().approved = Some(f.hash.clone());
                Ok(json!({ "name": n, "approved": true }))
            }
            "revoke" => {
                let n = name()?;
                if origin == Origin::Agent {
                    return Err("Only the user takes an approval back.".into());
                }
                self.monitoring.states.entry(n.clone()).or_default().approved = None;
                Ok(json!({ "name": n, "approved": false }))
            }
            "evaluate" => {
                let block = args.get("block").and_then(Value::as_str).ok_or("Give the monitor block to try (\"block\").")?;
                let m = monitor::compile(block)?;
                let rows = match (args.get("text").and_then(Value::as_str), args.get("rows")) {
                    (Some(text), _) => monitor::rows_from_text(text, m.rows_path.as_deref())?,
                    (None, Some(value)) => monitor::rows_from(value, m.rows_path.as_deref())?,
                    (None, None) => Vec::new(),
                };
                let local = monitor::local_now();
                let e = monitor::evaluate(&m, rows, &HashMap::new(), now, local.offset_secs);
                Ok(json!({
                    "level": e.level,
                    "meaning": e.level.meaning(),
                    "headline": e.headline,
                    "rows": e.rows.len(),
                    "columns": e.columns,
                    "alerts": e.alerts.iter().take(50).collect::<Vec<_>>(),
                    "counts": e.counts,
                    "every": m.every_secs,
                    "schedule": schedule_words(&m),
                    "source": m.source.describe(),
                    "sourceKind": m.source.kind(),
                }))
            }
            "fetchPreview" => {
                // Rows a SQLite or file source gives now, for the create tool's preview. A tool source the
                // calling chat already ran itself.
                let block = args.get("block").and_then(Value::as_str).ok_or("Give the monitor block (\"block\").")?;
                let m = monitor::compile(block)?;
                match &m.source {
                    Source::Tool { .. } => Err("A tool source is tried by the chat that is creating the monitor.".into()),
                    other => {
                        let helper = system::fast_fs().ok_or("The Rust helper is not installed beside Fire Code.")?;
                        run_helper(&helper, other, m.timeout_secs.min(60))
                    }
                }
            }
            "settings" => {
                if let Some(patch) = args.get("patch").filter(|p| p.is_object()) {
                    if origin == Origin::Agent {
                        return Err("Monitoring's settings are changed in Fire Code → Settings → Monitoring.".into());
                    }
                    let mut current = serde_json::to_value(&self.monitoring.settings).unwrap_or_default();
                    for (k, v) in patch.as_object().into_iter().flatten() {
                        current[k] = v.clone();
                    }
                    let next: monitor::Settings = serde_json::from_value(current).map_err(|e| format!("Those settings are not valid: {e}"))?;
                    if let Some(q) = next.quiet_hours.as_deref().filter(|q| !q.is_empty()) {
                        if !q.contains('-') {
                            return Err("Quiet hours are written \"22:00-07:00\".".into());
                        }
                    }
                    if next.team_index.trim().is_empty() || !next.team_index.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') {
                        return Err("The team index name is lowercase letters, digits, - and _ - and everyone in the team must use the same one.".into());
                    }
                    let executor_changed = next.executor != self.monitoring.settings.executor;
                    let team_changed = next.team_store != self.monitoring.settings.team_store || next.team_index != self.monitoring.settings.team_index;
                    self.monitoring.settings = next;
                    self.monitoring.store.save_settings(&self.monitoring.settings)?;
                    if executor_changed {
                        self.stop_executor();
                    }
                    if team_changed {
                        self.monitoring.team_error = None;
                        self.monitoring.last_latest = None;
                        self.monitoring.last_claim.clear();
                    }
                    self.monitor_scan();
                }
                Ok(serde_json::to_value(&self.monitoring.settings).unwrap_or_default())
            }
            "cleanup" => {
                if origin == Origin::Agent {
                    return Err("History is cleaned up from Fire Code → Settings → Monitoring.".into());
                }
                let removed = match older_than_days(args)? {
                    Some(days) => self.prune_before(now - days * 86_400),
                    None => self.prune_history(),
                };
                self.monitoring.last_prune = Some(Instant::now());
                for f in self.monitoring.found.clone() {
                    let tail = self.monitoring.store.history_tail(&f.name, SPARK);
                    self.monitoring.spark.insert(f.name.clone(), tail.into_iter().collect());
                }
                Ok(json!({ "removed": removed, "retentionDays": self.monitoring.settings.retention_days, "team": self.team_ready().is_ok() }))
            }
            "deleteCheck" => {
                // One check from History: here, and this person's own record of it in the team index.
                let n = name()?;
                if origin == Origin::Agent {
                    return Err("Only the user deletes a check from the history.".into());
                }
                let at = args.get("at").and_then(Value::as_i64).ok_or("Which check (\"at\").")?;
                let removed = self.monitoring.store.delete_check(&n, at);
                let tail = self.monitoring.store.history_tail(&n, SPARK);
                self.monitoring.spark.insert(n.clone(), tail.into_iter().collect());
                if self.monitoring.found(&n).map(|f| f.team).unwrap_or(false) && self.team_ready().is_ok() {
                    let _ = self.store_request("deleteCheck", json!({ "monitor": n, "at": at }), Pending::Prune { started: Instant::now() });
                }
                Ok(json!({ "name": n, "at": at, "removed": removed }))
            }
            "deleteHistory" => {
                let n = name()?;
                if origin == Origin::Agent {
                    return Err("Only the user deletes a monitor's history.".into());
                }
                // Asked for: "delete history older than a month or N days" - here, and this person's own team records.
                if let Some(days) = older_than_days(args)? {
                    let before = now - days * 86_400;
                    let removed = self.monitoring.store.prune_monitor(&n, before);
                    let tail = self.monitoring.store.history_tail(&n, SPARK);
                    self.monitoring.spark.insert(n.clone(), tail.into_iter().collect());
                    if self.monitoring.found(&n).map(|f| f.team).unwrap_or(false) && self.team_ready().is_ok() {
                        let _ = self.store_request("prune", json!({ "before": before, "monitor": n }), Pending::Prune { started: Instant::now() });
                    }
                    return Ok(json!({ "name": n, "removed": removed, "olderThanDays": days }));
                }
                self.monitoring.store.delete_history(&n);
                self.monitoring.summaries.remove(&n);
                self.monitoring.spark.remove(&n);
                self.monitoring.explanations.remove(&n);
                if self.monitoring.found(&n).map(|f| f.team).unwrap_or(false) && self.team_ready().is_ok() {
                    // Only this person's own checks: a colleague's are theirs (history.ts).
                    let _ = self.store_request("prune", json!({ "before": now + 86_400, "monitor": n }), Pending::Prune { started: Instant::now() });
                }
                Ok(json!({ "name": n, "deleted": true }))
            }
            "setSchedule" => {
                // The user's own edit, from the schedule editor: they see the values they set, so a monitor that
                // was approved stays approved. An agent changes a monitor with monitor_create, approved as a diff.
                let n = name()?;
                if origin == Origin::Agent {
                    return Err("An agent changes a monitor with monitor_create, so the change is shown and approved.".into());
                }
                known(self, &n)?;
                let f = self.monitoring.found(&n).cloned().expect("known");
                let schedule = args.get("schedule").and_then(Value::as_object).ok_or("Give the schedule (\"schedule\").")?;
                let text = std::fs::read_to_string(&f.file).map_err(|e| format!("Could not read {}: {e}", f.file.display()))?;
                // The file as it was when the editor opened, or the edit is made against something else.
                if monitor::monitor_block(&text).map(|b| monitor::hash_block(&b)) != Some(f.hash.clone()) {
                    self.monitor_scan();
                    return Err(format!("{} changed on disk since this was opened. Open the schedule again.", f.file.display()));
                }
                let (next, block) = monitor::with_schedule(&text, schedule)?;
                // Labelled like any save: one version on, now, by this person - so "last updated by" is true.
                let next = monitor::stamp_save(&next, &self.me(), now);
                let was_approved = self.monitoring.approved(&f);
                if is_team_copy(&f) {
                    // A copy synced from the team: written where the team keeps it, or the next sync puts the old one back.
                    let approve = was_approved.then(|| monitor::hash_block(&block));
                    let pending = Pending::SkillChange { name: n.clone(), op: "write", approve, via_grid: via_grid(args), started: Instant::now() };
                    self.exec_request(json!({ "kind": "skill", "op": "write", "name": n, "file": f.file.to_string_lossy(), "content": next }), pending)?;
                    return Ok(json!({ "name": n, "pending": true, "message": format!("Saving the new schedule to {}…", team_place(&f)) }));
                }
                crate::state::write_atomic(&f.file, &next)?;
                if was_approved {
                    self.monitoring.states.entry(n.clone()).or_default().approved = Some(monitor::hash_block(&block));
                }
                self.monitor_scan();
                Ok(json!({ "name": n, "approved": was_approved, "schedule": schedule_spec(&block) }))
            }
            "delete" => {
                // For good: the skill file, its results and history here, its own checks in the team history.
                let n = name()?;
                if origin == Origin::Agent {
                    return Err("Only the user deletes a monitor, from the dashboard.".into());
                }
                known(self, &n)?;
                let f = self.monitoring.found(&n).cloned().expect("known");
                if is_team_copy(&f) {
                    // Deleted where the team keeps it - the repository, then the bucket, then the copies here - by
                    // the same "Delete everywhere" Settings → Skills has; else the next sync brings it back.
                    let pending = Pending::SkillChange { name: n.clone(), op: "delete", approve: None, via_grid: via_grid(args), started: Instant::now() };
                    self.exec_request(json!({ "kind": "skill", "op": "delete", "name": n, "file": f.file.to_string_lossy() }), pending)?;
                    if f.team && self.team_ready().is_ok() {
                        let _ = self.store_request("prune", json!({ "before": now + 86_400, "monitor": n, "revisions": true }), Pending::Prune { started: Instant::now() });
                    }
                    return Ok(json!({ "name": n, "pending": true, "message": format!("Deleting it from {}…", team_place(&f)) }));
                }
                // A skill kept as name/SKILL.md is its folder (pictures and files with it), as delete_skill removes it.
                let own_folder = f.file.file_name().map(|s| s.to_string_lossy().eq_ignore_ascii_case("skill.md")).unwrap_or(false);
                let removed = match (own_folder, f.file.parent()) {
                    (true, Some(folder)) => std::fs::remove_dir_all(folder),
                    _ => std::fs::remove_file(&f.file),
                };
                removed.map_err(|e| format!("Could not delete {}: {e}", f.file.display()))?;
                self.forget_monitor(&n);
                if f.team && self.team_ready().is_ok() {
                    // Only this person's own checks: a colleague's are theirs (history.ts).
                    let _ = self.store_request("prune", json!({ "before": now + 86_400, "monitor": n, "revisions": true }), Pending::Prune { started: Instant::now() });
                }
                self.monitor_scan();
                Ok(json!({ "name": n, "deleted": true }))
            }
            "open" => {
                let n = name()?;
                known(self, &n)?;
                self.monitoring.show_dashboard = true;
                self.monitoring.grid_open.push(n.clone());
                if let Some(sheet) = args.get("sheet").and_then(Value::as_str).filter(|s| matches!(*s, "schedule" | "delete" | "history")) {
                    // A new window reads it when ready; an open one is told now (and the event loop drops the pending one).
                    // "history" may name a check (`at`, from a bar on the tile) to open on.
                    let at = args.get("at").and_then(Value::as_i64);
                    let wanted = json!({ "kind": sheet, "at": at });
                    self.monitoring.open_sheet.insert(n.clone(), wanted.clone());
                    self.monitoring.grid_out.push((n.clone(), json!({ "type": "sheet", "kind": sheet, "at": at })));
                }
                Ok(json!({ "opened": n }))
            }
            "dashboard" => {
                self.monitoring.show_dashboard = true;
                Ok(json!({ "shown": true }))
            }
            "openFile" => {
                let n = name()?;
                let f = self.monitoring.found(&n).ok_or_else(|| format!("No monitor called \"{n}\"."))?;
                system::open_in_explorer(&format!("/select,{}", f.file.display()));
                Ok(json!({}))
            }
            "details" => {
                let n = name()?;
                let row = args.get("row").and_then(Value::as_u64).ok_or("Which row (\"row\").")? as usize;
                let f = self.monitoring.found(&n).cloned().ok_or_else(|| format!("No monitor called \"{n}\"."))?;
                let m = f.monitor.as_ref().map_err(|e| e.clone())?;
                let record = self.monitoring.store.result(&n);
                let cells = record.as_ref().and_then(|r| r.evaluation.as_ref()).and_then(|e| e.rows.get(row)).cloned().ok_or("That row is no longer there - the monitor has checked again since.")?;
                match &m.details {
                    None => Ok(json!({ "row": row, "cells": cells })),
                    Some(details) => {
                        if !self.monitoring.approved(&f) {
                            return Err("Approve the monitor before its breakdown can run.".into());
                        }
                        let source = fill_source(details, &cells);
                        self.fetch(&source, m.timeout_secs, Pending::Details { name: n.clone(), row, started: Instant::now() })?;
                        Ok(json!({ "row": row, "cells": cells, "pending": true }))
                    }
                }
            }
            other => Err(format!("\"{other}\" is not a monitoring operation.")),
        };
        if result.is_ok() && !matches!(op, "list" | "get" | "evaluate" | "fetchPreview" | "details" | "rescan" | "refresh") {
            self.save_monitor_states();
            self.push_monitors(webview);
            if let Some(n) = args.get("name").and_then(Value::as_str) {
                self.monitoring.grid_out.push((n.to_string(), self.grid_message(n)));
            }
        }
        result
    }

    /// Starts every idle chat again so its agent gets (or loses) the monitoring tools.
    pub fn monitoring_switched(&mut self, webview: &WebView) {
        let idle: Vec<String> = self.runtime.iter().filter(|(_, r)| r.process.is_some() && r.agent == "idle").map(|(id, _)| id.clone()).collect();
        for id in idle {
            self.stop(&id, crate::Phase::Stopped);
            self.start(&id, webview);
        }
    }
}

/// What a grid window's page may ask: the same operations, for its own monitor only.
pub fn grid_command(app: &mut App, name: &str, body: &str, webview: &WebView) -> Option<Value> {
    let request: Value = serde_json::from_str(body).ok()?;
    let cmd = request.get("cmd").and_then(Value::as_str).unwrap_or("");
    let mut args: Map<String, Value> = request.as_object().cloned().unwrap_or_default();
    args.insert("name".into(), Value::String(name.to_string()));
    args.insert("via".into(), Value::String("grid".into()));
    let args = Value::Object(args);
    match cmd {
        "ready" => {
            let mut message = app.grid_message(name);
            if let Some(sheet) = app.monitoring.open_sheet.remove(name) {
                message["sheet"] = sheet;
            }
            Some(message)
        }
        "deleteCheck" => Some(match app.monitor_op(cmd, &args, Origin::User, webview) {
            Ok(_) => json!({ "type": "checkDeleted", "at": args["at"] }),
            Err(error) => json!({ "type": "notice", "level": "error", "text": error }),
        }),
        "setSchedule" | "delete" => Some(match app.monitor_op(cmd, &args, Origin::User, webview) {
            // A team copy goes through the host: the window waits for its answer (`Pending::SkillChange`).
            Ok(data) if data.get("pending") == Some(&Value::Bool(true)) => json!({ "type": "sheetPending", "text": data["message"] }),
            Ok(_) => {
                let mut grid = app.grid_message(name);
                grid["sheetDone"] = json!(if cmd == "delete" { "delete" } else { "schedule" });
                grid
            }
            Err(error) => json!({ "type": "notice", "level": "error", "text": error }),
        }),
        "ack" | "unack" | "run" | "snooze" | "notify" | "pause" | "resume" | "openFile" | "approve" => Some(match app.monitor_op(cmd, &args, Origin::User, webview) {
            Ok(_) => app.grid_message(name),
            Err(error) => json!({ "type": "notice", "level": "error", "text": error }),
        }),
        "details" => Some(match app.monitor_op("details", &args, Origin::User, webview) {
            Ok(data) => json!({ "type": "details", "row": data["row"], "ok": true, "cells": data["cells"], "pending": data.get("pending").cloned().unwrap_or(Value::Bool(false)) }),
            Err(error) => json!({ "type": "details", "row": args["row"], "ok": false, "error": error }),
        }),
        "history" => {
            app.history_request(&args, Target::Grid(name.to_string()));
            None
        }
        "revisions" => Some(app.revisions_message(name)),
        "pastGrid" => {
            // A check from History, as it was: its whole grid - kept here, or shared in the team index.
            let at = args.get("at").and_then(Value::as_i64).unwrap_or(0);
            let hash = args.get("hash").and_then(Value::as_str).unwrap_or("").to_string();
            let by = args.get("by").and_then(Value::as_str).filter(|b| !b.is_empty()).map(String::from);
            if let Some(e) = app.monitoring.store.grid(name, &hash) {
                return Some(json!({ "type": "pastGrid", "ok": true, "at": at, "evaluation": e }));
            }
            let team = app.monitoring.found(name).map(|f| f.team).unwrap_or(false);
            if team && !hash.is_empty() && app.team_ready().is_ok() {
                let pending = Pending::PastGrid { name: name.to_string(), at, by: by.clone(), started: Instant::now() };
                if app.store_request("grid", json!({ "monitor": name, "hash": hash }), pending).is_ok() {
                    return None;
                }
            }
            Some(json!({ "type": "pastGrid", "ok": false, "at": at, "error": past_grid_missing(by.as_deref()) }))
        }
        "explain" => {
            let row = args.get("row").and_then(Value::as_u64).unwrap_or(0) as usize;
            Some(match app.explain_request(name, row) {
                Ok(_) => json!({ "type": "explanation", "row": row, "pending": true }),
                Err(error) => json!({ "type": "explanation", "row": row, "ok": false, "error": error }),
            })
        }
        "startChat" => {
            let row = args.get("row").and_then(Value::as_u64).unwrap_or(0) as usize;
            let codebase = args.get("codebase").and_then(Value::as_str).map(String::from);
            Some(match app.start_chat(name, row, codebase.as_deref(), webview) {
                Ok(data) => json!({ "type": "chatStarted", "ok": true, "codebase": data["codebase"] }),
                Err(error) => json!({ "type": "notice", "level": "error", "text": error }),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_member_whose_check_failed_leaves_it_to_colleagues_but_never_to_nobody() {
        let (every, failed) = (600, 1_000_000);
        // Never failed here: claims as usual.
        assert!(!steps_back(None, failed, every, failed + 600));
        // Failed here; a colleague checked it this window: leave the next ones to them.
        assert!(steps_back(Some(failed), failed + 610, every, failed + 1210));
        // Failed here, and nobody has checked it for more than a window: nobody else can - try again here.
        assert!(!steps_back(Some(failed), failed, every, failed + 1300));
        // Long enough ago (30 minutes at least): claims again.
        assert!(!steps_back(Some(failed), failed + 1790, every, failed + 1801));
    }

    #[test]
    fn older_than_is_whole_days_one_or_more() {
        assert_eq!(older_than_days(&json!({})), Ok(None));
        assert_eq!(older_than_days(&json!({ "olderThanDays": 30 })), Ok(Some(30)));
        assert!(older_than_days(&json!({ "olderThanDays": 0 })).is_err());
        assert!(older_than_days(&json!({ "olderThanDays": "30" })).is_err());
    }

    #[test]
    fn a_snooze_ends_when_asked_never_in_the_past_and_not_for_ever() {
        let now = 1_800_000_000;
        assert_eq!(snooze_end(&json!({ "until": now + 3600 }), now), Ok(Some(now + 3600)));
        assert_eq!(snooze_end(&json!({ "minutes": 240 }), now), Ok(Some(now + 240 * 60)));
        assert_eq!(snooze_end(&json!({ "minutes": 0 }), now), Ok(None), "0 ends it");
        assert!(snooze_end(&json!({ "until": now - 1 }), now).unwrap_err().contains("already passed"));
        assert!(snooze_end(&json!({ "until": now + 31 * 86_400 }), now).unwrap_err().contains("30 days"));
    }
}
