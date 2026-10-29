//! Monitoring: the engine. What a monitor is, how its rows are judged, when it runs and who is told.
//!
//! A **monitor is a skill** - a markdown file with frontmatter - holding a fenced ` ```monitor ` block of
//! JSON: what to read (`source`), how often (`every`, `activeHours`, `days`), how to show it (`columns`)
//! and the alert rules (`rules`). It travels exactly as skills travel: a personal one sits in the user's
//! personal skills folder; a team one wherever the team keeps skills (a codebase's `.lightcode/skills`, a
//! bucket folder, the team repository's copy), and each person's Fire Code runs it with their own
//! credentials. Nothing about a monitor is decided by a model at run time: a check reads rows and applies
//! rules, so it costs no model call and gives the same answer every time (the user's choice).
//!
//! This module is pure - no window, no processes - so every rule is pinned by tests. The runtime that
//! schedules checks, fetches rows and notifies is `monitoring.rs`.
//!
//! ## Trust
//!
//! A monitor names a tool to run unattended, so a monitor this machine has not approved never runs: its
//! block's SHA-256 must be the one approved here (by creating it here, or Approve on the dashboard). A
//! colleague's changed monitor is asked about again. The tool itself is still subject to everything it is
//! subject to in a chat - a Python tool must be approved, and the executor refuses edit and command tools.

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

/// Rows kept from one check. More is a sign the monitor should filter at its source.
pub const MAX_ROWS: usize = 5000;
/// Columns shown when a monitor names none.
const MAX_DEFAULT_COLUMNS: usize = 30;

// ─── Levels ─────────────────────────────────────────────────────────────────

/// An alert colour, least to most severe. Purple is "cannot tell" - the check failed or its data is
/// stale - which needs attention but is not the monitored thing failing; it ranks below amber.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum Level {
    Grey,
    Green,
    Blue,
    Purple,
    Amber,
    Red,
}

pub const LEVELS: [Level; 6] = [Level::Red, Level::Amber, Level::Purple, Level::Blue, Level::Green, Level::Grey];

impl Level {
    pub fn parse(text: &str) -> Option<Level> {
        Some(match text.trim().to_ascii_lowercase().as_str() {
            "grey" | "gray" | "off" | "paused" | "none" => Level::Grey,
            "green" | "ok" | "success" | "good" => Level::Green,
            "blue" | "info" | "information" => Level::Blue,
            "purple" | "stale" | "unknown" | "nodata" | "no-data" => Level::Purple,
            "amber" | "warning" | "warn" | "yellow" | "orange" => Level::Amber,
            "red" | "failure" | "fail" | "critical" | "error" | "alert" => Level::Red,
            _ => return None,
        })
    }
    pub fn word(self) -> &'static str {
        match self {
            Level::Grey => "grey",
            Level::Green => "green",
            Level::Blue => "blue",
            Level::Purple => "purple",
            Level::Amber => "amber",
            Level::Red => "red",
        }
    }
    /// What the colour means, for the legend and notifications.
    pub fn meaning(self) -> &'static str {
        match self {
            Level::Red => "Failure - needs attention",
            Level::Amber => "Warning",
            Level::Purple => "No fresh data - the check failed or is late",
            Level::Blue => "Information",
            Level::Green => "All clear",
            Level::Grey => "Paused, not run yet, or waiting for your approval",
        }
    }
}

impl Serialize for Level {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.word())
    }
}

impl<'de> Deserialize<'de> for Level {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Level, D::Error> {
        let text = String::deserialize(d)?;
        Level::parse(&text).ok_or_else(|| serde::de::Error::custom(format!("\"{text}\" is not an alert level - red, amber, purple, blue, green or grey")))
    }
}

// ─── Time ───────────────────────────────────────────────────────────────────

pub fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The local clock, as monitors need it: weekday (0 = Monday), minutes past midnight, and how far local
/// time is ahead of UTC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalNow {
    pub weekday: u8,
    pub minutes: u16,
    pub offset_secs: i64,
}

#[cfg(windows)]
pub fn local_now() -> LocalNow {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::{GetLocalTime, GetSystemTime};
    let mut local: SYSTEMTIME = unsafe { std::mem::zeroed() };
    let mut utc: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe {
        GetLocalTime(&mut local);
        GetSystemTime(&mut utc);
    }
    let secs = |t: &SYSTEMTIME| {
        days_from_civil(t.wYear as i64, t.wMonth as i64, t.wDay as i64) * 86_400 + t.wHour as i64 * 3600 + t.wMinute as i64 * 60 + t.wSecond as i64
    };
    // Rounded to the minute: the two calls are a moment apart.
    let offset = ((secs(&local) - secs(&utc)) as f64 / 60.0).round() as i64 * 60;
    LocalNow { weekday: ((local.wDayOfWeek as u8) + 6) % 7, minutes: local.wHour * 60 + local.wMinute, offset_secs: offset }
}

#[cfg(not(windows))]
pub fn local_now() -> LocalNow {
    let now = now_secs();
    LocalNow { weekday: (((now / 86_400) + 3) % 7) as u8, minutes: ((now % 86_400) / 60) as u16, offset_secs: 0 }
}

/// `90s`, `15m`, `2h`, `1d`, `1w`, or a bare number of minutes.
pub fn parse_duration(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_f64() {
        return (n > 0.0).then_some((n * 60.0) as u64);
    }
    let text = value.as_str()?.trim().to_ascii_lowercase();
    let split = text.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(text.len());
    let number: f64 = text[..split].parse().ok()?;
    let unit = text[split..].trim();
    let scale = match unit {
        "" | "m" | "min" | "mins" | "minute" | "minutes" => 60.0,
        "s" | "sec" | "secs" | "second" | "seconds" => 1.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600.0,
        "d" | "day" | "days" => 86_400.0,
        "w" | "week" | "weeks" => 604_800.0,
        _ => return None,
    };
    (number > 0.0).then_some((number * scale) as u64)
}

/// A timestamp as epoch seconds: ISO 8601 (`2026-10-25`, `2026-10-25T14:05:00Z`, `...+01:00`), AutoSys's
/// `10/25/2026 14:05:00`, or epoch seconds or milliseconds. A time without a zone is local time.
pub fn parse_datetime(value: &Value, offset_secs: i64) -> Option<i64> {
    if let Some(n) = value.as_f64() {
        if n > 1e11 {
            return Some((n / 1000.0) as i64);
        }
        return (n > 1e8).then_some(n as i64);
    }
    let text = value.as_str()?.trim();
    let digits = |s: &str| -> Option<i64> { (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten() };
    let (date, rest) = match text.find(|c: char| c == 'T' || c == ' ') {
        Some(at) => (&text[..at], text[at + 1..].trim()),
        None => (text, ""),
    };
    let (y, m, d) = if date.contains('-') {
        let mut parts = date.split('-');
        (digits(parts.next()?)?, digits(parts.next()?)?, digits(parts.next()?)?)
    } else if date.contains('/') {
        let mut parts = date.split('/');
        let (m, d, y) = (digits(parts.next()?)?, digits(parts.next()?)?, digits(parts.next()?)?);
        (y, m, d)
    } else {
        return None;
    };
    if !(1900..=9999).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // The time, and a zone if there is one: Z, +hh:mm, -hhmm.
    let (clock, zone) = match rest.find(|c: char| c == 'Z' || c == 'z' || c == '+' || (c == '-')) {
        Some(at) => (&rest[..at], Some(&rest[at..])),
        None => (rest, None),
    };
    let mut parts = clock.split(':');
    let h = parts.next().filter(|s| !s.is_empty()).map(|s| digits(s)).unwrap_or(Some(0))?;
    let mi = parts.next().map(digits).unwrap_or(Some(0))?;
    let s = parts.next().map(|s| digits(s.split('.').next().unwrap_or("0"))).unwrap_or(Some(0))?;
    if h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let naive = days_from_civil(y, m, d) * 86_400 + h * 3600 + mi * 60 + s;
    let offset = match zone {
        None => offset_secs,
        Some(z) if z.eq_ignore_ascii_case("z") => 0,
        Some(z) => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let body: String = z[1..].chars().filter(|c| c.is_ascii_digit()).collect();
            if body.len() < 2 {
                return None;
            }
            let hours: i64 = body[..2].parse().ok()?;
            let minutes: i64 = if body.len() >= 4 { body[2..4].parse().ok()? } else { 0 };
            sign * (hours * 3600 + minutes * 60)
        }
    };
    Some(naive - offset)
}

/// `07:00-19:00` as minutes past midnight; a window ending before it starts runs past midnight.
fn parse_window(text: &str) -> Option<(u16, u16)> {
    let (a, b) = text.split_once('-')?;
    // Either side may be left open: "09:00-" is "not before nine", "-17:00" is "until five".
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() && b.is_empty() {
        return None;
    }
    let start = if a.is_empty() { 0 } else { clock_minutes(a)? };
    let end = if b.is_empty() { 1440 } else { clock_minutes(b)? };
    Some((start, end))
}

/// `07:30` as minutes past midnight.
fn clock_minutes(text: &str) -> Option<u16> {
    let (h, m) = text.trim().split_once(':')?;
    let (h, m): (u16, u16) = (h.trim().parse().ok()?, m.trim().parse().ok()?);
    (h <= 24 && m < 60 && h * 60 + m <= 1440).then_some(h * 60 + m)
}

fn in_window(window: (u16, u16), minutes: u16) -> bool {
    let (start, end) = window;
    if start <= end {
        minutes >= start && minutes < end
    } else {
        minutes >= start || minutes < end
    }
}

// ─── The spec ───────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// text, number, percent, datetime, duration, bytes - how the grid shows the value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawSpec {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    /// How often: "15m". Optional when `at` gives the times instead.
    #[serde(default)]
    every: Option<Value>,
    /// Exact times of day to check: "07:30" or ["07:30", "12:00", "18:00"].
    #[serde(default)]
    at: Option<Value>,
    #[serde(default)]
    active_hours: Option<String>,
    #[serde(default)]
    days: Option<Vec<String>>,
    source: Value,
    #[serde(default)]
    rows: Option<String>,
    #[serde(default)]
    columns: Vec<Column>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    rules: Vec<RawRule>,
    #[serde(default)]
    when_empty: Option<Level>,
    #[serde(default)]
    when_clear: Option<Level>,
    #[serde(default)]
    details: Option<Value>,
    /// The least severe level that notifies for this monitor. Default amber.
    #[serde(default)]
    notify: Option<Level>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
    /// The author's general advice: who owns it, where to look first, known false alarms.
    #[serde(default)]
    runbook: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRule {
    level: Level,
    when: Value,
    /// "row" or "cell". Default: the cell, when the rule is about one column.
    #[serde(default)]
    highlight: Option<String>,
    /// Which cell to highlight, when not the rule's own column.
    #[serde(default)]
    column: Option<String>,
    /// `{name} failed at {lastEnd}` - filled from the row.
    #[serde(default)]
    message: Option<String>,
    /// The author's words for this alert: what it means and what to do.
    #[serde(default)]
    advice: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    /// Run by the monitoring executor (a Light Code host): a Python tool (`py__name`), an MCP tool, or a
    /// read tool. Anything needing the network or a credential goes this way (invariant 2).
    Tool { tool: String, args: Value },
    /// Read here, by the Rust helper: never created, never locked.
    Sqlite { path: String, sql: String },
    /// CSV, TSV, Excel, JSON files, read here and queried with SQL by the Rust helper.
    Files { files: Vec<(String, String)>, sql: String },
}

impl Source {
    pub fn kind(&self) -> &'static str {
        match self {
            Source::Tool { .. } => "tool",
            Source::Sqlite { .. } => "sqlite",
            Source::Files { .. } => "files",
        }
    }
    pub fn describe(&self) -> String {
        match self {
            Source::Tool { tool, .. } => format!("the tool {tool}"),
            Source::Sqlite { path, .. } => format!("the SQLite file {path}"),
            Source::Files { files, .. } => format!("{}", files.iter().map(|(_, p)| p.as_str()).collect::<Vec<_>>().join(", ")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Matches,
    In,
    NotIn,
    Empty,
    NotEmpty,
    OlderThan,
    NewerThan,
}

fn parse_op(text: &str) -> Option<Op> {
    Some(match text.trim() {
        "==" | "=" | "eq" | "is" | "equals" => Op::Eq,
        "!=" | "<>" | "ne" | "isNot" | "notEquals" => Op::Ne,
        ">" | "gt" => Op::Gt,
        ">=" | "gte" | "ge" => Op::Ge,
        "<" | "lt" => Op::Lt,
        "<=" | "lte" | "le" => Op::Le,
        "contains" => Op::Contains,
        "notContains" | "doesNotContain" => Op::NotContains,
        "startsWith" => Op::StartsWith,
        "endsWith" => Op::EndsWith,
        "matches" | "regex" => Op::Matches,
        "in" | "oneOf" => Op::In,
        "notIn" | "noneOf" => Op::NotIn,
        "empty" | "isEmpty" | "missing" => Op::Empty,
        "notEmpty" | "isNotEmpty" | "present" => Op::NotEmpty,
        "olderThan" => Op::OlderThan,
        "newerThan" | "within" => Op::NewerThan,
        _ => return None,
    })
}

#[derive(Clone, Debug)]
pub enum Cond {
    All(Vec<Cond>),
    Any(Vec<Cond>),
    Not(Box<Cond>),
    Test { column: String, op: Op, value: Value, regex: Option<Regex>, seconds: Option<u64> },
}

impl Cond {
    /// The one column this condition is about, when it is about one.
    fn column(&self) -> Option<&str> {
        match self {
            Cond::Test { column, .. } => Some(column),
            Cond::Not(inner) => inner.column(),
            Cond::All(list) | Cond::Any(list) if list.len() == 1 => list[0].column(),
            _ => None,
        }
    }
}

fn parse_cond(value: &Value, depth: usize) -> Result<Cond, String> {
    if depth > 8 {
        return Err("Conditions nest at most 8 deep.".into());
    }
    let Some(object) = value.as_object() else { return Err("A condition is an object: {\"column\", \"op\", \"value\"}, or {\"all\"|\"any\": [...]}, or {\"not\": {...}}.".into()) };
    let list = |key: &str| -> Result<Vec<Cond>, String> {
        let items = object[key].as_array().ok_or_else(|| format!("\"{key}\" takes a list of conditions."))?;
        if items.is_empty() {
            return Err(format!("\"{key}\" has no conditions in it."));
        }
        items.iter().map(|item| parse_cond(item, depth + 1)).collect()
    };
    if object.contains_key("all") {
        return Ok(Cond::All(list("all")?));
    }
    if object.contains_key("any") {
        return Ok(Cond::Any(list("any")?));
    }
    if let Some(inner) = object.get("not") {
        return Ok(Cond::Not(Box::new(parse_cond(inner, depth + 1)?)));
    }
    let column = object.get("column").and_then(Value::as_str).filter(|c| !c.trim().is_empty()).ok_or("A condition names its \"column\".")?.to_string();
    let op_text = object.get("op").and_then(Value::as_str).unwrap_or("==");
    let op = parse_op(op_text).ok_or_else(|| {
        format!("\"{op_text}\" is not an operator - use ==, !=, >, >=, <, <=, contains, notContains, startsWith, endsWith, matches, in, notIn, empty, notEmpty, olderThan or newerThan.")
    })?;
    let value = object.get("value").cloned().unwrap_or(Value::Null);
    let needs_value = !matches!(op, Op::Empty | Op::NotEmpty);
    if needs_value && value.is_null() {
        return Err(format!("The condition on \"{column}\" ({op_text}) needs a \"value\"."));
    }
    if matches!(op, Op::In | Op::NotIn) && !value.is_array() {
        return Err(format!("\"{op_text}\" on \"{column}\" takes a list as its value."));
    }
    let regex = if op == Op::Matches {
        let pattern = value.as_str().ok_or_else(|| format!("\"matches\" on \"{column}\" takes a regular expression as text."))?;
        Some(RegexBuilder::new(pattern).case_insensitive(true).size_limit(1 << 20).build().map_err(|e| format!("The pattern for \"{column}\" is not a valid regular expression: {e}"))?)
    } else {
        None
    };
    let seconds = if matches!(op, Op::OlderThan | Op::NewerThan) {
        Some(parse_duration(&value).ok_or_else(|| format!("\"{op_text}\" on \"{column}\" takes a duration such as \"30m\", \"2h\" or \"1d\"."))?)
    } else {
        None
    };
    Ok(Cond::Test { column, op, value, regex, seconds })
}

#[derive(Clone, Debug)]
pub struct Rule {
    pub level: Level,
    pub cond: Cond,
    pub row: bool,
    pub column: Option<String>,
    pub message: Option<String>,
    pub advice: Option<String>,
}

/// A monitor's spec, checked: everything a check needs, with nothing left to fail at run time but the data.
#[derive(Clone, Debug)]
pub struct Monitor {
    pub title: Option<String>,
    pub summary: Option<String>,
    /// How often, or 0 when only `times` say when.
    pub every_secs: u64,
    /// Exact times of day (minutes past midnight, sorted): "once a day at 07:30", "at 07:30, 12:00 and 18:00".
    pub times: Vec<u16>,
    pub window: Option<(u16, u16)>,
    /// Monday first.
    pub days: Option<[bool; 7]>,
    pub source: Source,
    pub rows_path: Option<String>,
    pub columns: Vec<Column>,
    pub key: Option<String>,
    pub rules: Vec<Rule>,
    pub when_empty: Level,
    pub when_clear: Level,
    pub details: Option<Source>,
    pub notify_from: Level,
    pub timeout_secs: u64,
    pub runbook: Option<String>,
}

const DAY_NAMES: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

fn parse_source(value: &Value, what: &str) -> Result<Source, String> {
    let Some(object) = value.as_object() else { return Err(format!("The {what} is an object: {{\"tool\", \"args\"}}, {{\"sqlite\", \"sql\"}} or {{\"files\", \"sql\"}}.")) };
    let absolute = |p: &str| Path::new(p).is_absolute() || p.starts_with("\\\\");
    if let Some(tool) = object.get("tool") {
        let tool = tool.as_str().unwrap_or("");
        if tool.is_empty() || tool.len() > 128 || !tool.chars().all(|c| c.is_ascii_alphanumeric() || "_-.:".contains(c)) {
            return Err(format!("\"{tool}\" is not a tool name."));
        }
        let args = object.get("args").cloned().unwrap_or_else(|| json!({}));
        if !args.is_object() {
            return Err(format!("The {what}'s \"args\" is an object of the tool's parameters."));
        }
        return Ok(Source::Tool { tool: tool.to_string(), args });
    }
    let sql = || -> Result<String, String> {
        let sql = object.get("sql").and_then(Value::as_str).map(str::trim).unwrap_or("");
        if sql.is_empty() {
            return Err(format!("The {what} needs \"sql\": the query that gives the rows."));
        }
        Ok(sql.to_string())
    };
    if let Some(path) = object.get("sqlite") {
        let path = path.as_str().unwrap_or("");
        if !absolute(path) {
            return Err(format!("\"sqlite\" is the database file's full path; \"{path}\" is not one."));
        }
        return Ok(Source::Sqlite { path: path.to_string(), sql: sql()? });
    }
    if let Some(files) = object.get("files").or_else(|| object.get("file")) {
        let list: Vec<(String, String)> = match files {
            Value::String(p) => vec![("data".into(), p.clone())],
            Value::Array(items) => items
                .iter()
                .enumerate()
                .map(|(i, item)| match item {
                    Value::String(p) => Ok((if i == 0 { "data".to_string() } else { format!("data{}", i + 1) }, p.clone())),
                    Value::Object(o) => {
                        let path = o.get("path").and_then(Value::as_str).unwrap_or("").to_string();
                        let name = o.get("name").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("data{}", i + 1));
                        Ok((name, path))
                    }
                    _ => Err("Each file is a path, or {\"name\", \"path\"}.".to_string()),
                })
                .collect::<Result<_, _>>()?,
            _ => return Err("\"files\" is a path or a list of them.".into()),
        };
        if list.is_empty() || list.len() > 10 {
            return Err("A monitor reads 1 to 10 files.".into());
        }
        for (name, path) in &list {
            if !absolute(path) {
                return Err(format!("\"{path}\" is not a full path."));
            }
            if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(format!("\"{name}\" is not a table name - letters, digits and _."));
            }
        }
        return Ok(Source::Files { files: list, sql: sql()? });
    }
    Err(format!("The {what} names a \"tool\", a \"sqlite\" database or \"files\"."))
}

/// The spec from a monitor block's JSON, checked whole: every problem is a sentence naming the field.
pub fn compile(block: &str) -> Result<Monitor, String> {
    let raw: RawSpec = serde_json::from_str(block).map_err(|e| format!("The monitor block is not valid: {e}"))?;
    let every_secs = match &raw.every {
        None | Some(Value::Null) => 0,
        Some(value) => {
            let secs = parse_duration(value).ok_or("\"every\" is how often to check: \"5m\", \"1h\", \"1d\" (at least a minute).")?;
            if !(60..=7 * 86_400).contains(&secs) {
                return Err("\"every\" must be between one minute and a week.".into());
            }
            secs
        }
    };
    let mut times: Vec<u16> = match &raw.at {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(one)) => vec![clock_minutes(one).filter(|m| *m < 1440).ok_or_else(|| format!("\"at\" is a time of day like \"07:30\"; \"{one}\" is not."))?],
        Some(Value::Array(list)) => list
            .iter()
            .map(|v| v.as_str().and_then(clock_minutes).filter(|m| *m < 1440).ok_or_else(|| format!("\"at\" holds times of day like \"07:30\"; {v} is not one.")))
            .collect::<Result<_, _>>()?,
        Some(other) => return Err(format!("\"at\" is a time like \"07:30\" or a list of them, not {other}.")),
    };
    times.sort_unstable();
    times.dedup();
    if every_secs == 0 && times.is_empty() {
        return Err("Say when to check: \"every\" (\"15m\") for an interval, \"at\" (\"07:30\" or [\"07:30\", \"18:00\"]) for times of day, or both.".into());
    }
    if times.len() > 48 {
        return Err("\"at\" has at most 48 times; for more, use \"every\".".into());
    }
    let window = match raw.active_hours.as_deref() {
        None => None,
        Some(text) => Some(parse_window(text).ok_or_else(|| format!("\"activeHours\" is \"07:00-19:00\"; \"{text}\" is not."))?),
    };
    let days = match &raw.days {
        None => None,
        Some(list) => {
            let mut set = [false; 7];
            for day in list {
                let at = DAY_NAMES.iter().position(|d| day.to_ascii_lowercase().starts_with(d)).ok_or_else(|| format!("\"{day}\" is not a day - mon, tue, wed, thu, fri, sat, sun."))?;
                set[at] = true;
            }
            if !set.iter().any(|d| *d) {
                return Err("\"days\" names no day.".into());
            }
            Some(set)
        }
    };
    let source = parse_source(&raw.source, "source")?;
    // A drill-down: its tool args and SQL are filled from the double-clicked row (`{name}`).
    let details = raw.details.as_ref().map(|d| parse_source(d, "details source")).transpose()?;
    for column in &raw.columns {
        if column.key.trim().is_empty() {
            return Err("A column has no \"key\".".into());
        }
    }
    let mut rules = Vec::new();
    for (i, rule) in raw.rules.iter().enumerate() {
        let cond = parse_cond(&rule.when, 0).map_err(|e| format!("Rule {} ({}): {e}", i + 1, rule.level.word()))?;
        let row = match rule.highlight.as_deref() {
            None => rule.column.is_none() && cond.column().is_none(),
            Some("row") => true,
            Some("cell") => false,
            Some(other) => return Err(format!("Rule {}: highlight is \"row\" or \"cell\", not \"{other}\".", i + 1)),
        };
        let column = rule.column.clone().or_else(|| cond.column().map(String::from));
        if !row && column.is_none() {
            return Err(format!("Rule {}: a cell highlight needs \"column\" - the cell to colour.", i + 1));
        }
        rules.push(Rule { level: rule.level, cond, row, column, message: rule.message.clone(), advice: rule.advice.clone().filter(|a| !a.trim().is_empty()) });
    }
    if rules.len() > 50 {
        return Err("A monitor has at most 50 rules.".into());
    }
    Ok(Monitor {
        title: raw.title.filter(|t| !t.trim().is_empty()),
        summary: raw.summary.filter(|t| !t.trim().is_empty()),
        every_secs,
        times,
        window,
        days,
        source,
        rows_path: raw.rows,
        columns: raw.columns,
        key: raw.key,
        rules,
        when_empty: raw.when_empty.unwrap_or(Level::Green),
        when_clear: raw.when_clear.unwrap_or(Level::Green),
        details,
        notify_from: raw.notify.unwrap_or(Level::Amber),
        timeout_secs: raw.timeout_seconds.unwrap_or(120).clamp(5, 900),
        runbook: raw.runbook.filter(|r| !r.trim().is_empty()),
    })
}

impl Monitor {
    /// Whether now is inside the monitor's active hours and days. Outside them it neither runs nor goes stale.
    pub fn active(&self, local: LocalNow) -> bool {
        if let Some(days) = self.days {
            // A window past midnight belongs to the day it started.
            let day = match self.window {
                Some((start, end)) if start > end && local.minutes < end => (local.weekday + 6) % 7,
                _ => local.weekday,
            };
            if !days[day as usize] {
                return false;
            }
        }
        self.window.map(|w| in_window(w, local.minutes)).unwrap_or(true)
    }

    fn day_allowed(&self, weekday: u8) -> bool {
        self.days.map(|d| d[weekday as usize % 7]).unwrap_or(true)
    }

    /// Whether a check is due now, and the slot it belongs to - what team members claim, so a slot runs
    /// once across the team. An interval's slot is its number since 1970; a time of day's is its instant.
    /// `at` times run on their days whatever `activeHours` says (they are explicit); the interval keeps to
    /// the window. A time missed while Fire Code was closed is not made up the next day.
    pub fn due_slot(&self, last_run: Option<i64>, now: i64, local: LocalNow) -> Option<i64> {
        if !self.times.is_empty() && self.day_allowed(local.weekday) {
            let midnight = now - (local.minutes as i64) * 60 - (now + local.offset_secs).rem_euclid(60);
            if let Some(t) = self.times.iter().rev().find(|t| **t <= local.minutes) {
                let slot = midnight + (*t as i64) * 60;
                if last_run.map(|l| l < slot).unwrap_or(true) {
                    return Some(slot);
                }
            }
        }
        // An interval runs once per window of the clock (10:00-10:10, 10:10-10:20 ... counted from UTC), not
        // "every N after the last run": every member's Fire Code then agrees which window is due, so the team
        // claim settles it every time. Timed from each machine's own last run, starts crept apart and two members
        // could land either side of a window's edge, each claim a different window, and both run.
        if self.every_secs > 0 && self.active(local) {
            let every = self.every_secs as i64;
            let slot = now.div_euclid(every);
            if last_run.map(|l| l < slot * every).unwrap_or(true) {
                return Some(slot);
            }
        }
        None
    }

    /// When the next check is expected, for the tile: the interval's next, or the next time of day.
    pub fn next_run(&self, last_run: Option<i64>, now: i64, local: LocalNow) -> Option<i64> {
        // The next window's start (see due_slot).
        let by_interval = (self.every_secs > 0).then(|| last_run.map(|l| (l.div_euclid(self.every_secs as i64) + 1) * self.every_secs as i64).unwrap_or(now));
        let midnight = now - (local.minutes as i64) * 60 - (now + local.offset_secs).rem_euclid(60);
        let by_time = (0..8).find_map(|d: i64| {
            let weekday = ((local.weekday as i64 + d) % 7) as u8;
            if !self.day_allowed(weekday) {
                return None;
            }
            self.times.iter().map(|t| midnight + d * 86_400 + (*t as i64) * 60).find(|at| *at > now)
        });
        match (by_interval, by_time) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// How long without a check before its data counts as stale (purple).
    pub fn stale_after(&self) -> i64 {
        if self.every_secs > 0 {
            self.every_secs as i64 * 3 + 120
        } else {
            // Times of day: the longest gap between them, plus a grace.
            let mut gap = 0i64;
            for (i, t) in self.times.iter().enumerate() {
                let next = self.times.get(i + 1).map(|n| *n as i64).unwrap_or(self.times[0] as i64 + 1440);
                gap = gap.max(next - *t as i64);
            }
            gap * 60 + 3600
        }
    }
}

// ─── Rows ───────────────────────────────────────────────────────────────────

pub type Row = Map<String, Value>;

/// Rows from whatever a source gave: a list of records, an object holding one (at `path`, or `rows`,
/// `items`, `data`, `results`, or its first list), `{columns, rows: [[...]]}`, or a list of plain values.
pub fn rows_from(value: &Value, path: Option<&str>) -> Result<Vec<Row>, String> {
    let mut at = value;
    if let Some(path) = path.filter(|p| !p.trim().is_empty()) {
        for part in path.split('.') {
            at = match at {
                Value::Object(o) => o.get(part).ok_or_else(|| format!("The answer has no \"{part}\" (rows: \"{path}\")."))?,
                Value::Array(a) => part.parse::<usize>().ok().and_then(|i| a.get(i)).ok_or_else(|| format!("\"{part}\" in \"{path}\" is not an index of the list."))?,
                _ => return Err(format!("\"{path}\" leads into a plain value, not a list.")),
            };
        }
    }
    if let Value::Object(o) = at {
        // {columns, rows: [[...]]}: what the SQLite and table helpers answer.
        if let (Some(Value::Array(columns)), Some(Value::Array(rows))) = (o.get("columns"), o.get("rows")) {
            if rows.iter().all(Value::is_array) {
                let names: Vec<String> = columns.iter().map(|c| c.as_str().map(String::from).or_else(|| c.get("name").and_then(Value::as_str).map(String::from)).unwrap_or_default()).collect();
                return Ok(rows
                    .iter()
                    .take(MAX_ROWS)
                    .map(|r| names.iter().cloned().zip(r.as_array().into_iter().flatten().cloned()).collect())
                    .collect());
            }
        }
        let inner = ["rows", "items", "data", "results", "records", "jobs", "alerts"].iter().find_map(|k| o.get(*k).filter(|v| v.is_array())).or_else(|| o.values().find(|v| v.as_array().map(|a| a.iter().any(Value::is_object)).unwrap_or(false)));
        return match inner {
            Some(list) => rows_from(list, None),
            // One record is one row.
            None => Ok(vec![o.clone()]),
        };
    }
    match at {
        Value::Array(items) => Ok(items
            .iter()
            .take(MAX_ROWS)
            .map(|item| match item {
                Value::Object(o) => o.clone(),
                other => {
                    let mut row = Map::new();
                    row.insert("value".into(), other.clone());
                    row
                }
            })
            .collect()),
        Value::Null => Ok(Vec::new()),
        other => {
            let mut row = Map::new();
            row.insert("value".into(), other.clone());
            Ok(vec![row])
        }
    }
}

/// Rows from a tool's text answer: its JSON (a Python tool's printed output after it set aside), or, for
/// a tool that answers in prose, one row per line so a rule can still look for a word.
pub fn rows_from_text(text: &str, path: Option<&str>) -> Result<Vec<Row>, String> {
    let body = text.split("\n\n--- stdout ---\n").next().unwrap_or(text).trim();
    match serde_json::from_str::<Value>(body) {
        Ok(value) => rows_from(&value, path),
        Err(_) => Ok(body
            .lines()
            .filter(|l| !l.trim().is_empty())
            .take(MAX_ROWS)
            .map(|l| {
                let mut row = Map::new();
                row.insert("line".into(), Value::String(l.to_string()));
                row
            })
            .collect()),
    }
}

/// The columns to show: the monitor's own, or every field the first rows have, in the order first seen.
pub fn columns_for(monitor: &Monitor, rows: &[Row]) -> Vec<Column> {
    if !monitor.columns.is_empty() {
        return monitor.columns.clone();
    }
    default_columns(rows)
}

/// Every field the first rows have, in the order first seen - for rows no monitor describes (a drill-down).
pub fn default_columns(rows: &[Row]) -> Vec<Column> {
    let mut seen: Vec<String> = Vec::new();
    for row in rows.iter().take(50) {
        for key in row.keys() {
            if !seen.contains(key) && seen.len() < MAX_DEFAULT_COLUMNS {
                seen.push(key.clone());
            }
        }
    }
    seen.into_iter().map(|key| Column { key, label: None, format: None, width: None }).collect()
}

// ─── Rules ──────────────────────────────────────────────────────────────────

fn text_of(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn number_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::Bool(_) | Value::Null => None,
        Value::String(s) => {
            let cleaned: String = s.trim().trim_end_matches('%').chars().filter(|c| *c != ',' && *c != ' ').collect();
            if cleaned.is_empty() {
                return None;
            }
            cleaned.parse().ok()
        }
        _ => None,
    }
}

fn is_empty(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.trim().is_empty(),
        Some(Value::Array(a)) => a.is_empty(),
        _ => false,
    }
}

fn compare(cell: &Value, wanted: &Value, offset: i64) -> Option<std::cmp::Ordering> {
    if let (Some(a), Some(b)) = (number_of(cell), number_of(wanted)) {
        return a.partial_cmp(&b);
    }
    if let (Some(a), Some(b)) = (parse_datetime(cell, offset), parse_datetime(wanted, offset)) {
        return Some(a.cmp(&b));
    }
    Some(text_of(cell).to_lowercase().cmp(&text_of(wanted).to_lowercase()))
}

fn equal(cell: &Value, wanted: &Value, offset: i64) -> bool {
    if let (Value::Bool(a), Value::Bool(b)) = (cell, wanted) {
        return a == b;
    }
    if let (Some(a), Some(b)) = (number_of(cell), number_of(wanted)) {
        return a == b;
    }
    let _ = offset;
    text_of(cell).trim().eq_ignore_ascii_case(text_of(wanted).trim())
}

/// A cell by key; a dotted key reads inside a nested object (`owner.name`).
pub fn cell<'a>(row: &'a Row, key: &str) -> Option<&'a Value> {
    if let Some(v) = row.get(key) {
        return Some(v);
    }
    let mut parts = key.split('.');
    let mut at = row.get(parts.next()?)?;
    for part in parts {
        at = at.get(part)?;
    }
    Some(at)
}

fn holds(cond: &Cond, row: &Row, now: i64, offset: i64) -> bool {
    match cond {
        Cond::All(list) => list.iter().all(|c| holds(c, row, now, offset)),
        Cond::Any(list) => list.iter().any(|c| holds(c, row, now, offset)),
        Cond::Not(inner) => !holds(inner, row, now, offset),
        Cond::Test { column, op, value, regex, seconds } => {
            let found = cell(row, column);
            match op {
                Op::Empty => return is_empty(found),
                Op::NotEmpty => return !is_empty(found),
                _ => {}
            }
            // A rule about a cell that is not there does not fire: absent is not "failed".
            let Some(found) = found.filter(|v| !v.is_null()) else { return matches!(op, Op::Ne | Op::NotIn | Op::NotContains) };
            let text = || text_of(found).to_lowercase();
            match op {
                Op::Eq => equal(found, value, offset),
                Op::Ne => !equal(found, value, offset),
                Op::Gt => compare(found, value, offset) == Some(std::cmp::Ordering::Greater),
                Op::Ge => matches!(compare(found, value, offset), Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)),
                Op::Lt => compare(found, value, offset) == Some(std::cmp::Ordering::Less),
                Op::Le => matches!(compare(found, value, offset), Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)),
                Op::Contains => text().contains(&text_of(value).to_lowercase()),
                Op::NotContains => !text().contains(&text_of(value).to_lowercase()),
                Op::StartsWith => text().starts_with(&text_of(value).to_lowercase()),
                Op::EndsWith => text().ends_with(&text_of(value).to_lowercase()),
                Op::Matches => regex.as_ref().map(|r| r.is_match(&text_of(found))).unwrap_or(false),
                Op::In => value.as_array().map(|list| list.iter().any(|v| equal(found, v, offset))).unwrap_or(false),
                Op::NotIn => value.as_array().map(|list| !list.iter().any(|v| equal(found, v, offset))).unwrap_or(true),
                Op::OlderThan => parse_datetime(found, offset).map(|t| now - t > seconds.unwrap_or(0) as i64).unwrap_or(false),
                Op::NewerThan => parse_datetime(found, offset).map(|t| now - t <= seconds.unwrap_or(0) as i64).unwrap_or(false),
                Op::Empty | Op::NotEmpty => unreachable!(),
            }
        }
    }
}

/// `{name} failed at {lastEnd}`, filled from the row; `{}` names that are not there stay as written.
pub fn fill_template(template: &str, row: &Row) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) if !after[..close].contains('{') => {
                let key = &after[..close];
                match cell(row, key.trim()) {
                    Some(v) => out.push_str(&text_of(v)),
                    None => {
                        out.push('{');
                        out.push_str(key);
                        out.push('}');
                    }
                }
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    /// The level acknowledged: the alert counts again if it gets worse than this.
    pub level: Level,
    pub at: i64,
    /// Acknowledged until then; absent means while the alert lasts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    /// Stable across checks for the same rule, row and cell: what an acknowledgement is kept against.
    pub id: String,
    pub row: usize,
    pub key: String,
    pub level: Level,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    /// The whole row is coloured, not only the cell.
    pub whole_row: bool,
    pub message: String,
    pub acknowledged: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    pub level: Level,
    pub columns: Vec<Column>,
    pub rows: Vec<Row>,
    pub alerts: Vec<Alert>,
    /// Alerts not acknowledged, by level word.
    pub counts: BTreeMap<String, usize>,
    pub headline: String,
}

fn row_key(monitor: &Monitor, row: &Row, index: usize) -> String {
    monitor.key.as_deref().and_then(|k| cell(row, k)).map(text_of).filter(|k| !k.is_empty()).unwrap_or_else(|| format!("#{index}"))
}

/// Judges the rows. Every rule is tried on every row; a row can raise several alerts, and the monitor's
/// level is the worst alert nobody has acknowledged.
pub fn evaluate(monitor: &Monitor, rows: Vec<Row>, acks: &HashMap<String, Ack>, now: i64, offset: i64) -> Evaluation {
    let mut alerts = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let key = row_key(monitor, row, index);
        for (r, rule) in monitor.rules.iter().enumerate() {
            if !holds(&rule.cond, row, now, offset) {
                continue;
            }
            let id = format!("{r}|{key}|{}", if rule.row { "" } else { rule.column.as_deref().unwrap_or("") });
            let acknowledged = acks.get(&id).map(|a| a.level >= rule.level && a.until.map(|u| u > now).unwrap_or(true)).unwrap_or(false);
            let message = match &rule.message {
                Some(template) => fill_template(template, row),
                None => match &rule.column {
                    Some(c) => format!("{key}: {c} is {}", text_of(cell(row, c).unwrap_or(&Value::Null))),
                    None => format!("{key}: {}", rule.level.meaning()),
                },
            };
            alerts.push(Alert { id, row: index, key: key.clone(), level: rule.level, column: rule.column.clone(), whole_row: rule.row, message, acknowledged });
        }
    }
    let mut counts = BTreeMap::new();
    for alert in alerts.iter().filter(|a| !a.acknowledged) {
        *counts.entry(alert.level.word().to_string()).or_insert(0) += 1;
    }
    let worst = alerts.iter().filter(|a| !a.acknowledged).map(|a| a.level).max();
    let level = match worst {
        Some(level) => level,
        None if rows.is_empty() => monitor.when_empty,
        None => monitor.when_clear,
    };
    let headline = headline(&alerts, rows.len(), level);
    Evaluation { level, columns: columns_for(monitor, &rows), rows, alerts, counts, headline }
}

fn headline(alerts: &[Alert], rows: usize, level: Level) -> String {
    let open: Vec<&Alert> = alerts.iter().filter(|a| !a.acknowledged).collect();
    if open.is_empty() {
        let acked = alerts.len();
        return match (rows, acked) {
            (0, _) => "No rows".into(),
            (_, 0) => format!("All clear · {rows} row{}", if rows == 1 { "" } else { "s" }),
            _ => format!("All clear · {acked} acknowledged"),
        };
    }
    let worst = open.iter().filter(|a| a.level == level).collect::<Vec<_>>();
    if open.len() == 1 {
        return open[0].message.clone();
    }
    let mut parts = Vec::new();
    for l in LEVELS {
        let n = open.iter().filter(|a| a.level == l).count();
        if n > 0 {
            parts.push(format!("{n} {}", match l {
                Level::Red => "failing",
                Level::Amber => "warning",
                Level::Purple => "unknown",
                Level::Blue => "info",
                Level::Green => "ok",
                Level::Grey => "other",
            }));
        }
    }
    let first = worst.first().map(|a| format!(" - {}", a.message)).unwrap_or_default();
    format!("{}{first}", parts.join(" · "))
}

// ─── Finding monitors ───────────────────────────────────────────────────────

/// A folder monitors are looked for in, and whether what is there is the team's or the user's own.
#[derive(Clone, Debug)]
pub struct Folder {
    pub path: PathBuf,
    pub team: bool,
    /// Where it came from, for the tile: "personal", a codebase's name, "bucket", "team repository".
    pub origin: String,
}

#[derive(Clone, Debug)]
pub struct Found {
    pub name: String,
    pub description: String,
    pub file: PathBuf,
    pub team: bool,
    pub origin: String,
    pub hash: String,
    pub block: String,
    pub monitor: Result<Monitor, String>,
    /// Who wrote it and who saved it last, from its frontmatter.
    pub labels: Labels,
}

impl Found {
    pub fn title(&self) -> String {
        self.monitor.as_ref().ok().and_then(|m| m.title.clone()).unwrap_or_else(|| self.name.clone())
    }
    pub fn summary(&self) -> String {
        self.monitor.as_ref().ok().and_then(|m| m.summary.clone()).unwrap_or_else(|| self.description.clone())
    }
}

fn frontmatter(text: &str) -> (Option<String>, Option<String>, &str) {
    let normal = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = normal.strip_prefix("---") else { return (None, None, normal) };
    let rest = rest.trim_start_matches(['\r', ' ']).strip_prefix('\n').unwrap_or(rest);
    let Some(end) = rest.find("\n---") else { return (None, None, normal) };
    let (head, body) = (&rest[..end], &rest[end + 4..]);
    let mut name = None;
    let mut description = None;
    for line in head.lines() {
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
            match key.trim() {
                "name" => name = Some(value),
                "description" => description = Some(value),
                _ => {}
            }
        }
    }
    (name, description, body)
}

/// The ` ```monitor ` block of a skill, when it has one. Only the first counts.
pub fn monitor_block(body: &str) -> Option<String> {
    let mut lines = body.lines();
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") && trimmed.trim_start_matches('`').trim().split_whitespace().any(|w| w.eq_ignore_ascii_case("monitor")) {
            let mut block = String::new();
            for inner in lines.by_ref() {
                if inner.trim().starts_with("```") {
                    return Some(block.trim().to_string());
                }
                block.push_str(inner.trim_end_matches('\r'));
                block.push('\n');
            }
            return None;
        }
    }
    None
}

// ─── Who wrote it, and who changed it ───────────────────────────────────────

/// The labels Light Code stamps into a skill's frontmatter on every save (`sharing/attribution.ts`): who wrote it
/// (`author`, never replaced), and of the last save its `version`, time (`updated`) and person (`updated_by`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Labels {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// ISO 8601 as written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
}

impl Labels {
    /// The last save as epoch seconds, when the label reads as a time.
    pub fn updated_at(&self) -> Option<i64> {
        self.updated.as_ref().and_then(|u| parse_datetime(&Value::String(u.clone()), 0))
    }
    /// Who made the last save: who the label says, else the author.
    pub fn saved_by(&self) -> Option<String> {
        self.updated_by.clone().or_else(|| self.author.clone())
    }
}

/// The frontmatter's lines, and where they start and end in the text: None without frontmatter.
fn frontmatter_span(text: &str) -> Option<(usize, usize)> {
    let bom = if text.starts_with('\u{feff}') { '\u{feff}'.len_utf8() } else { 0 };
    let rest = &text[bom..];
    let after = rest.strip_prefix("---")?;
    let newline = after.find('\n')?;
    if !after[..newline].trim().is_empty() {
        return None;
    }
    let start = bom + 3 + newline + 1;
    let end = text[start..].find("\n---").map(|at| start + at)?;
    // The line ending before the closing fence stays outside, so a CRLF file stays CRLF.
    let end = if end > start && text.as_bytes()[end - 1] == b'\r' { end - 1 } else { end };
    Some((start, end))
}

pub fn labels(text: &str) -> Labels {
    let Some((start, end)) = frontmatter_span(text) else { return Labels::default() };
    let mut labels = Labels::default();
    for line in text[start..end].lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "author" => labels.author = Some(value),
            "version" => labels.version = value.parse().ok(),
            "updated" => labels.updated = Some(value),
            "updated_by" => labels.updated_by = Some(value),
            _ => {}
        }
    }
    labels
}

/// `2026-10-29T08:15:02Z`: the form `updated` takes, in UTC.
pub fn iso_utc(at: i64) -> String {
    let (y, m, d) = civil_from_days(at.div_euclid(86_400));
    let s = at.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", s / 3600, (s % 3600) / 60, s % 60)
}

/// A skill file as a save by `by` at `at` labels it - the same rule Light Code's own saves follow
/// (`stampRevision`): the version one more than the file's (a file without one counts as 1), the time and the
/// person replaced, the author left as it is. A label line that is not there is added at the end of the
/// frontmatter; a file without frontmatter is returned unchanged.
pub fn stamp_save(text: &str, by: &str, at: i64) -> String {
    let Some((start, end)) = frontmatter_span(text) else { return text.to_string() };
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let clean: String = by.chars().filter(|c| !matches!(c, '"' | '\'' | '\\' | '\r' | '\n')).take(100).collect();
    let version = labels(text).version.unwrap_or(1) + 1;
    let mut values: Vec<(&str, String)> = vec![("version", version.to_string()), ("updated", iso_utc(at))];
    if !clean.trim().is_empty() {
        values.push(("updated_by", clean.trim().to_string()));
    }
    let head = &text[start..end];
    let mut lines: Vec<String> = head.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
    for (key, value) in values {
        match lines.iter().position(|l| l.split_once(':').map(|(k, _)| k.trim() == key).unwrap_or(false)) {
            Some(i) => lines[i] = format!("{key}: {value}"),
            None => lines.push(format!("{key}: {value}")),
        }
    }
    format!("{}{}{}", &text[..start], lines.join(eol), &text[end..])
}

/// One saved version of a monitor, as this computer saw it arrive: the audit the grid window's Changes lists. Kept
/// in `revisions/<name>.jsonl`, and for a team monitor offered to the team's index as well, so every member sees
/// the same record however long their Fire Code was closed (`history.ts` `writeRevision`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    /// When it was saved: its `updated` label, else when the file last changed.
    pub at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    pub hash: String,
    /// What changed, in words.
    pub change: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
}

/// What a new version changed, from the block before it: which fields, or the text around the block.
pub fn describe_change(before: Option<&Revision>, block: &str, hash: &str) -> String {
    let Some(before) = before else { return "First seen on this computer".to_string() };
    if before.hash == hash {
        return "Its text changed (description, advice) - the monitor itself did not".to_string();
    }
    let parse = |b: &str| serde_json::from_str::<Map<String, Value>>(b).unwrap_or_default();
    let (old, new) = (parse(before.block.as_deref().unwrap_or("")), parse(block));
    let mut keys: Vec<&str> = new.keys().chain(old.keys()).map(String::as_str).filter(|k| old.get(*k) != new.get(*k)).collect();
    keys.sort();
    keys.dedup();
    match keys.as_slice() {
        [] => "The monitor changed".to_string(),
        keys if keys.iter().all(|k| SCHEDULE_KEYS.contains(k)) => format!("Schedule changed ({})", keys.join(", ")),
        keys => format!("Changed: {}", keys.join(", ")),
    }
}

/// The fields of a block that say when it runs - what the dashboard's schedule editor may change.
pub const SCHEDULE_KEYS: [&str; 4] = ["every", "at", "activeHours", "days"];

/// A skill file with its monitor's schedule replaced, and the new block. Everything else - the rest of the
/// file, the other fields of the block and their order, the file's line endings - stays as it was, so the
/// change a person makes is the only change. A field given as null, "" or [] is removed. The new block must
/// compile, or nothing is returned to write.
pub fn with_schedule(text: &str, schedule: &Map<String, Value>) -> Result<(String, String), String> {
    let (start, end) = block_span(text).ok_or("This skill has no ```monitor block to change.")?;
    let old: Value = serde_json::from_str(&text[start..end]).map_err(|e| format!("The monitor block is not JSON ({e}); edit the file instead."))?;
    let Value::Object(old) = old else { return Err("The monitor block is not a JSON object; edit the file instead.".into()) };
    let given = |key: &str| schedule.get(key).filter(|v| !(v.is_null() || v.as_str().map(|s| s.trim().is_empty()).unwrap_or(false) || v.as_array().map(Vec::is_empty).unwrap_or(false)));
    // Where the schedule sits: after the summary (where monitor_create puts it), else after the title, else first.
    let anchor = ["summary", "title"].iter().find(|k| old.contains_key(**k)).copied();
    let mut next = Map::new();
    let put_schedule = |next: &mut Map<String, Value>| {
        for key in SCHEDULE_KEYS {
            if let Some(value) = given(key) {
                next.insert(key.to_string(), value.clone());
            }
        }
    };
    if anchor.is_none() {
        put_schedule(&mut next);
    }
    for (key, value) in old {
        if SCHEDULE_KEYS.contains(&key.as_str()) {
            continue;
        }
        let here = anchor == Some(key.as_str());
        next.insert(key, value);
        if here {
            put_schedule(&mut next);
        }
    }
    let block = serde_json::to_string_pretty(&Value::Object(next)).map_err(|e| e.to_string())?;
    compile(&block)?;
    let crlf = text[..start].contains("\r\n");
    let written = if crlf { block.replace('\n', "\r\n") } else { block.clone() };
    let newline = if crlf { "\r\n" } else { "\n" };
    Ok((format!("{}{written}{newline}{}", &text[..start], &text[end..]), block))
}

/// Byte offsets of a skill file's monitor block: from the line after the opening fence to the start of the
/// closing fence line. The same fence rule `monitor_block` reads by.
fn block_span(text: &str) -> Option<(usize, usize)> {
    let mut offset = 0;
    let mut start = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        match start {
            None if trimmed.starts_with("```") && trimmed.trim_start_matches('`').trim().split_whitespace().any(|w| w.eq_ignore_ascii_case("monitor")) => {
                start = Some(offset + line.len());
            }
            Some(s) if trimmed.starts_with("```") => return Some((s, offset)),
            _ => {}
        }
        offset += line.len();
    }
    None
}

/// The approval key of a block: a changed spec is a different monitor to the person approving it.
pub fn hash_block(block: &str) -> String {
    let normal = block.replace("\r\n", "\n");
    let digest = Sha256::digest(normal.trim().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Reads one skill file as a monitor; None when it is an ordinary skill.
pub fn read_monitor(file: &Path, fallback_name: &str, folder: &Folder) -> Option<Found> {
    let text = std::fs::read_to_string(file).ok()?;
    let (name, description, body) = frontmatter(&text);
    let block = monitor_block(body)?;
    Some(Found {
        name: name.filter(|n| !n.is_empty()).unwrap_or_else(|| fallback_name.to_string()),
        description: description.unwrap_or_default(),
        file: file.to_path_buf(),
        team: folder.team,
        origin: folder.origin.clone(),
        hash: hash_block(&block),
        monitor: compile(&block),
        block,
        labels: labels(&text),
    })
}

/// Every monitor in the folders, the first folder winning a name - the same rule skills follow.
#[cfg(test)]
pub fn scan(folders: &[Folder]) -> Vec<Found> {
    scan_cached(folders, &mut ScanCache::default())
}

/// What a scan read last time, by file: its size and modified time, and the monitor in it (or none). A file
/// whose size and time have not changed is not read again - a scan every 30 seconds over a few hundred skills
/// costs a directory listing, not a few hundred file reads.
#[derive(Default)]
pub struct ScanCache {
    files: HashMap<PathBuf, (u64, std::time::SystemTime, Option<Found>)>,
}

pub fn scan_cached(folders: &[Folder], cache: &mut ScanCache) -> Vec<Found> {
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut found: Vec<Found> = Vec::new();
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(&folder.path) else { continue };
        let mut candidates: Vec<(PathBuf, String)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                for inner in ["SKILL.md", "skill.md"] {
                    let file = path.join(inner);
                    if file.is_file() {
                        candidates.push((file, name.clone()));
                        break;
                    }
                }
            } else if let Some(stem) = name.strip_suffix(".md") {
                candidates.push((path, stem.to_string()));
            }
        }
        candidates.sort();
        for (file, fallback) in candidates {
            let stamp = std::fs::metadata(&file).ok().map(|m| (m.len(), m.modified().unwrap_or(std::time::UNIX_EPOCH)));
            let monitor = match (stamp, cache.files.get(&file)) {
                (Some((len, time)), Some((cached_len, cached_time, cached))) if *cached_len == len && *cached_time == time => cached.clone(),
                (Some((len, time)), _) => {
                    let read = read_monitor(&file, &fallback, folder);
                    cache.files.insert(file.clone(), (len, time, read.clone()));
                    read
                }
                (None, _) => None,
            };
            seen.push(file);
            // The folder decides team or personal, so a cached monitor takes this folder's.
            if let Some(mut monitor) = monitor {
                monitor.team = folder.team;
                monitor.origin = folder.origin.clone();
                if !found.iter().any(|f| f.name == monitor.name) {
                    found.push(monitor);
                }
            }
        }
    }
    // Files that are gone are forgotten, so the cache is never larger than the folders.
    cache.files.retain(|path, _| seen.contains(path));
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

// ─── Settings and per-monitor state ─────────────────────────────────────────

/// How Windows is told about a level. In order of how hard it tries to get attention.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Nothing at all: the tile still shows it.
    Off,
    /// The count on Fire Code's Monitoring button and title bar, no notification.
    Dashboard,
    /// A notification without sound.
    Silent,
    /// A notification with its sound, and the taskbar button flashes.
    Toast,
    /// Stays on screen until dismissed, with the reminder sound.
    Urgent,
    /// Stays on screen with a looping alarm until dismissed.
    Alarm,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    /// The codebase whose settings (MCP servers, Python, credentials) the background executor uses.
    pub executor: Option<String>,
    pub red: Mode,
    pub amber: Mode,
    pub purple: Mode,
    pub blue: Mode,
    pub green: Mode,
    /// Told again while a monitor stays amber or red, this often. 0 = once.
    pub repeat_minutes: u32,
    /// Told when a monitor that was amber or red is clear again.
    pub recovery: bool,
    /// `22:00-07:00`: only red gets through then (when `quiet_lets_red_through`), and as a silent notification otherwise only counted.
    pub quiet_hours: Option<String>,
    pub quiet_lets_red_through: bool,
    /// More folders to look for monitor skills in.
    pub extra_folders: Vec<String>,
    /// Days of check history kept - here, and this person's own checks in the team's OpenSearch index.
    pub retention_days: u32,
    /// The search connection (in the executor codebase's settings) holding the team's history. Without
    /// one, team monitors do not run: the user's rule - no OpenSearch, no team monitoring.
    pub team_store: Option<String>,
    /// The index the whole team shares. Everyone must name the same one.
    pub team_index: String,
    /// The dashboard's Stop: no check starts by itself until Start. Run now still works, colleagues' checks still
    /// show. Kept across restarts - a stop that undid itself when Fire Code restarted would not be one.
    pub scheduler_stopped: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            enabled: false,
            executor: None,
            red: Mode::Urgent,
            amber: Mode::Toast,
            purple: Mode::Silent,
            blue: Mode::Dashboard,
            green: Mode::Off,
            repeat_minutes: 60,
            recovery: true,
            quiet_hours: None,
            quiet_lets_red_through: true,
            extra_folders: Vec::new(),
            retention_days: 90,
            team_store: None,
            team_index: "fire-code-monitoring".into(),
            scheduler_stopped: false,
        }
    }
}

impl Settings {
    pub fn mode_for(&self, level: Level) -> Mode {
        match level {
            Level::Red => self.red,
            Level::Amber => self.amber,
            Level::Purple => self.purple,
            Level::Blue => self.blue,
            Level::Green => self.green,
            Level::Grey => Mode::Off,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorState {
    /// The block hash approved to run on this machine.
    pub approved: Option<String>,
    pub paused: bool,
    /// No notifications until then (epoch seconds).
    pub snooze_until: Option<i64>,
    /// Replaces the level's mode for this monitor.
    pub mode: Option<Mode>,
    /// The least severe level that notifies; default the monitor's own `notify`.
    pub notify_from: Option<Level>,
    pub acks: HashMap<String, Ack>,
    /// What was last told, and when.
    pub notified_level: Option<Level>,
    pub notified_at: Option<i64>,
}

/// What one check found, kept as the monitor's latest result.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub at: i64,
    pub duration_ms: u64,
    pub level: Level,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub headline: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluation: Option<Evaluation>,
    /// The last check that read data, for staleness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<i64>,
    /// Who ran it, when a team member's check is the newest; absent for this computer's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    /// Only the alerted rows are here - a team member's check, or one read back from history.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
}

/// An alert as history keeps it: what fired, and the row it fired on (only alerted rows are kept).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredAlert {
    pub id: String,
    pub level: Level,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    pub message: String,
    #[serde(default)]
    pub row: Row,
}

/// One check, as history keeps it - here for a personal monitor, in the team's OpenSearch index for a team
/// one (the same shape as `monitoring/history.ts` CheckDocument). Lines from before 0.60 had only the
/// first three fields and still read.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckRecord {
    pub at: i64,
    pub level: Level,
    /// Open alerts in this check.
    #[serde(default)]
    pub alerts: usize,
    #[serde(default)]
    pub headline: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub row_count: usize,
    #[serde(default)]
    pub duration_ms: u64,
    /// Who ran it, for a team monitor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(default)]
    pub found: Vec<StoredAlert>,
    /// The whole grid this check read, kept on the computer that ran it (`Store::save_grid`), by its content's
    /// hash - so a check that read the same as the one before costs nothing more.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid: Option<String>,
}

impl CheckRecord {
    /// The check a run produced: summary and alerted rows only (the user's choice).
    pub fn from_run(record: &RunRecord) -> CheckRecord {
        let found = record
            .evaluation
            .as_ref()
            .map(|e| {
                e.alerts
                    .iter()
                    .map(|a| StoredAlert { id: a.id.clone(), level: a.level, key: a.key.clone(), column: a.column.clone(), message: a.message.clone(), row: e.rows.get(a.row).cloned().unwrap_or_default() })
                    .collect()
            })
            .unwrap_or_default();
        CheckRecord {
            at: record.at,
            level: record.level,
            alerts: record.evaluation.as_ref().map(|e| e.counts.values().sum()).unwrap_or(0),
            headline: record.headline.clone(),
            error: record.error.clone(),
            row_count: record.evaluation.as_ref().map(|e| e.rows.len()).unwrap_or(0),
            duration_ms: record.duration_ms,
            by: record.by.clone(),
            found,
            grid: None,
        }
    }

    /// The grid a check from history - or a colleague's team check - can show: the alerted rows only.
    pub fn evaluation(&self, monitor: &Monitor) -> Evaluation {
        let mut rows: Vec<Row> = Vec::new();
        let mut keys: Vec<String> = Vec::new();
        let mut alerts = Vec::new();
        for a in &self.found {
            let at = match keys.iter().position(|k| k == &a.key) {
                Some(at) => at,
                None => {
                    keys.push(a.key.clone());
                    rows.push(a.row.clone());
                    rows.len() - 1
                }
            };
            alerts.push(Alert { id: a.id.clone(), row: at, key: a.key.clone(), level: a.level, column: a.column.clone(), whole_row: a.column.is_none(), message: a.message.clone(), acknowledged: false });
        }
        let mut counts = BTreeMap::new();
        for a in &alerts {
            *counts.entry(a.level.word().to_string()).or_insert(0) += 1;
        }
        Evaluation { level: self.level, columns: columns_for(monitor, &rows), rows, alerts, counts, headline: self.headline.clone() }
    }
}

/// Days since 1970-01-01 to a civil date - the other way from `days_from_civil`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `2026-10-25` and `14:05`, in local time.
pub fn local_date_time(at: i64, offset: i64) -> (String, String) {
    let local = at + offset;
    let (y, m, d) = civil_from_days(local.div_euclid(86_400));
    let s = local.rem_euclid(86_400);
    (format!("{y:04}-{m:02}-{d:02}"), format!("{:02}:{:02}", s / 3600, (s % 3600) / 60))
}

/// An alert across a monitor's history: new, ongoing, recurring at a time, intermittent, or cleared.
/// Asked for: "agent should be able to check the history of alert to see if it is a repeating one or a new
/// issue or happens for past few days". The grid's explanation and the agent's monitor_history both use it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlertPattern {
    pub id: String,
    pub key: String,
    pub level: Level,
    pub message: String,
    /// new, ongoing, recurring, intermittent, cleared
    pub verdict: String,
    pub summary: String,
    pub first_seen: i64,
    pub last_seen: i64,
    /// Checks it was in, of `checks` (those since it was first seen).
    pub occurrences: usize,
    pub checks: usize,
    /// How many separate times it appeared (it was clear in between).
    pub episodes: usize,
    pub active: bool,
    pub days: Vec<DayCount>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DayCount {
    pub date: String,
    pub count: usize,
}

pub fn alert_patterns(records: &[CheckRecord], key: Option<&str>, alert: Option<&str>, now: i64, offset: i64) -> Vec<AlertPattern> {
    let mut checks: Vec<&CheckRecord> = records.iter().filter(|r| r.error.is_none()).collect();
    checks.sort_by_key(|r| r.at);
    let mut ids: Vec<(String, String)> = Vec::new();
    for r in &checks {
        for a in &r.found {
            if key.map(|k| a.key == k).unwrap_or(true) && alert.map(|x| a.id == x).unwrap_or(true) && !ids.iter().any(|(id, _)| id == &a.id) {
                ids.push((a.id.clone(), a.key.clone()));
            }
        }
    }
    let mut out = Vec::new();
    for (id, key) in ids {
        let present: Vec<bool> = checks.iter().map(|r| r.found.iter().any(|a| a.id == id)).collect();
        let Some(first) = present.iter().position(|p| *p) else { continue };
        let last = present.iter().rposition(|p| *p).unwrap_or(first);
        let since_first = &present[first..];
        let occurrences = since_first.iter().filter(|p| **p).count();
        let mut starts: Vec<i64> = Vec::new();
        for (i, p) in present.iter().enumerate() {
            if *p && (i == 0 || !present[i - 1]) {
                starts.push(checks[i].at);
            }
        }
        let episodes = starts.len();
        let active = present.last().copied().unwrap_or(false);
        let (level, message) = checks[last].found.iter().find(|a| a.id == id).map(|a| (a.level, a.message.clone())).unwrap_or((Level::Grey, String::new()));
        let mut days: Vec<DayCount> = Vec::new();
        for (i, p) in present.iter().enumerate() {
            if *p {
                let (date, _) = local_date_time(checks[i].at, offset);
                match days.iter_mut().find(|d| d.date == date) {
                    Some(d) => d.count += 1,
                    None => days.push(DayCount { date, count: 1 }),
                }
            }
        }
        let first_seen = checks[first].at;
        let last_seen = checks[last].at;
        let (first_date, first_time) = local_date_time(first_seen, offset);
        let (last_date, last_time) = local_date_time(last_seen, offset);
        let streak = present.iter().rev().take_while(|p| **p).count();
        // The hour episodes usually start in, when most do: "fails every night around 02:00".
        let mut hours = [0usize; 24];
        for s in &starts {
            hours[((s + offset).rem_euclid(86_400) / 3600) as usize] += 1;
        }
        // The hour with most starts within an hour either side; a tie goes to the hour itself holding more.
        let (top_hour, top) = (0..24).fold((0usize, 0usize), |best, h| {
            let around = hours[h] + hours[(h + 23) % 24] + hours[(h + 1) % 24];
            if around > best.1 || (around == best.1 && hours[h] > hours[best.0]) {
                (h, around)
            } else {
                best
            }
        });
        let usual = if episodes >= 3 && top * 10 >= episodes * 6 { format!(", usually starting around {top_hour:02}:00") } else { String::new() };
        let now_note = if active { "; happening now" } else { "" };
        let (verdict, summary) = if episodes == 1 && active && now - first_seen <= 86_400 {
            ("new", format!("first seen {first_date} {first_time}; in every check since ({streak} in a row)"))
        } else if episodes == 1 && active {
            ("ongoing", format!("ongoing since {first_date} {first_time}: {streak} checks in a row, over {} day(s)", days.len()))
        } else if episodes >= 2 && days.len() >= 3 {
            ("recurring", format!("came back {episodes} times, on {} different days since {first_date}{usual}{now_note}", days.len()))
        } else if episodes >= 2 {
            ("intermittent", format!("came and went {episodes} times since {first_date} {first_time}{now_note}"))
        } else {
            ("cleared", format!("seen from {first_date} {first_time} to {last_date} {last_time} ({occurrences} checks); clear since"))
        };
        out.push(AlertPattern {
            id,
            key,
            level,
            message,
            verdict: verdict.to_string(),
            summary,
            first_seen,
            last_seen,
            occurrences,
            checks: since_first.len(),
            episodes,
            active,
            days,
        });
    }
    out
}


#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Telling {
    Worse,
    StillBad,
    Recovered,
}

/// Whether to tell the user, and how - from the level a check found and what was told before.
pub fn should_notify(
    monitor: &Monitor,
    level: Level,
    state: &MonitorState,
    settings: &Settings,
    now: i64,
    local: LocalNow,
) -> Option<(Mode, Telling)> {
    if state.snooze_until.map(|u| u > now).unwrap_or(false) {
        return None;
    }
    let from = state.notify_from.unwrap_or(monitor.notify_from);
    let last = state.notified_level.unwrap_or(Level::Green);
    let telling = if level > last && level >= from && level > Level::Green {
        Telling::Worse
    } else if level == last && level >= from && level >= Level::Amber && settings.repeat_minutes > 0 && state.notified_at.map(|t| now - t >= settings.repeat_minutes as i64 * 60).unwrap_or(true) {
        Telling::StillBad
    } else if level <= Level::Blue && last >= Level::Amber && last >= from && settings.recovery {
        Telling::Recovered
    } else {
        return None;
    };
    let mut mode = match telling {
        // Good news is told quietly, and not at all where the bad news was not told either.
        Telling::Recovered => settings.mode_for(last).min(Mode::Silent),
        _ => state.mode.unwrap_or_else(|| settings.mode_for(level)),
    };
    // A repeat never sounds an alarm again: it is a reminder, not a new emergency.
    if telling == Telling::StillBad && mode > Mode::Toast {
        mode = Mode::Toast;
    }
    if let Some(window) = settings.quiet_hours.as_deref().and_then(parse_window) {
        if in_window(window, local.minutes) && !(level == Level::Red && settings.quiet_lets_red_through && telling != Telling::Recovered) {
            mode = mode.min(Mode::Dashboard);
        }
    }
    (mode > Mode::Off).then_some((mode, telling))
}

// ─── Storage ────────────────────────────────────────────────────────────────

/// `<data>/monitoring`: settings.json, state.json (per monitor), results/<name>.json, history/<name>.jsonl.
#[derive(Clone)]
pub struct Store {
    pub root: PathBuf,
}

fn safe_file(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

fn write_json(file: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let temp = file.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temp, text).map_err(|e| format!("Could not write {}: {e}", temp.display()))?;
    std::fs::rename(&temp, file).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Could not save {}: {e}", file.display())
    })
}

impl Store {
    pub fn new(root: PathBuf) -> Store {
        Store { root }
    }
    pub fn settings(&self) -> Settings {
        std::fs::read_to_string(self.root.join("settings.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        write_json(&self.root.join("settings.json"), settings)
    }
    pub fn states(&self) -> HashMap<String, MonitorState> {
        std::fs::read_to_string(self.root.join("state.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    pub fn save_states(&self, states: &HashMap<String, MonitorState>) -> Result<(), String> {
        write_json(&self.root.join("state.json"), states)
    }
    fn result_file(&self, name: &str) -> PathBuf {
        self.root.join("results").join(format!("{}.json", safe_file(name)))
    }
    pub fn result(&self, name: &str) -> Option<RunRecord> {
        std::fs::read_to_string(self.result_file(name)).ok().and_then(|t| serde_json::from_str(&t).ok())
    }
    pub fn save_result(&self, name: &str, record: &RunRecord) -> Result<(), String> {
        write_json(&self.result_file(name), record)
    }
    /// Team checks run while the team's history could not be reached: offered to it when it can be again.
    pub fn offline_queue(&self) -> Vec<(String, i64, Value)> {
        std::fs::read_to_string(self.root.join("offline-queue.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    pub fn save_offline_queue(&self, queue: &[(String, i64, Value)]) {
        let file = self.root.join("offline-queue.json");
        if queue.is_empty() {
            let _ = std::fs::remove_file(file);
        } else {
            let _ = write_json(&file, &queue);
        }
    }
    fn history_file(&self, name: &str) -> PathBuf {
        self.root.join("history").join(format!("{}.jsonl", safe_file(name)))
    }
    /// The most recent `limit` checks, oldest first. A line that will not read is skipped, not fatal.
    pub fn history(&self, name: &str, limit: usize) -> Vec<CheckRecord> {
        let text = std::fs::read_to_string(self.history_file(name)).unwrap_or_default();
        let points: Vec<CheckRecord> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        let skip = points.len().saturating_sub(limit);
        points.into_iter().skip(skip).collect()
    }
    /// The last `limit` checks' times and levels, from the end of the file only - for the sparklines, so
    /// drawing the dashboard never reads a whole history.
    pub fn history_tail(&self, name: &str, limit: usize) -> Vec<(i64, Level)> {
        use std::io::{Read, Seek, SeekFrom};
        let Ok(mut file) = std::fs::File::open(self.history_file(name)) else { return Vec::new() };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let start = len.saturating_sub(256 * 1024);
        let _ = file.seek(SeekFrom::Start(start));
        let mut text = String::new();
        let _ = file.read_to_string(&mut text);
        // A read that began mid-line drops that first, partial, line.
        let body = if start > 0 { text.split_once('\n').map(|(_, rest)| rest).unwrap_or("") } else { text.as_str() };
        #[derive(Deserialize)]
        struct Point {
            at: i64,
            level: Level,
        }
        let points: Vec<(i64, Level)> = body.lines().filter_map(|l| serde_json::from_str::<Point>(l).ok()).map(|p| (p.at, p.level)).collect();
        let skip = points.len().saturating_sub(limit);
        points.into_iter().skip(skip).collect()
    }
    /// Checks since `since`, oldest first.
    pub fn history_since(&self, name: &str, since: i64) -> Vec<CheckRecord> {
        self.history(name, usize::MAX).into_iter().filter(|r| r.at >= since).collect()
    }
    /// Appends a check. Appended, not rewritten, so recording stays cheap; a file past 20 MB keeps its
    /// newer half, so even a monitor checking every minute cannot grow it without end between cleanups.
    pub fn record_history(&self, name: &str, record: &CheckRecord) {
        use std::io::Write;
        let file = self.history_file(name);
        let _ = std::fs::create_dir_all(file.parent().unwrap_or(&self.root));
        if let Ok(mut handle) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
            let _ = writeln!(handle, "{}", serde_json::to_string(record).unwrap_or_default());
        }
        if std::fs::metadata(&file).map(|m| m.len() > 20 * 1024 * 1024).unwrap_or(false) {
            let text = std::fs::read_to_string(&file).unwrap_or_default();
            let lines: Vec<&str> = text.lines().collect();
            let _ = write_lines(&file, &lines[lines.len() / 2..]);
        }
    }
    /// Removes checks older than `before` from every monitor's history here. How many went.
    /// One monitor's checks older than `before` gone here, its kept grids with them. How many went.
    pub fn prune_monitor(&self, name: &str, before: i64) -> usize {
        let path = self.history_file(name);
        let Ok(text) = std::fs::read_to_string(&path) else { return 0 };
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let kept: Vec<&str> = lines.iter().copied().filter(|l| serde_json::from_str::<CheckRecord>(l).map(|r| r.at >= before).unwrap_or(false)).collect();
        let removed = lines.len() - kept.len();
        if removed > 0 {
            let _ = if kept.is_empty() { std::fs::remove_file(&path).map_err(|e| e.to_string()) } else { write_lines(&path, &kept) };
            self.prune_grids(&safe_file(name), GRIDS_CAP);
        }
        removed
    }

    pub fn prune(&self, before: i64) -> usize {
        let mut removed = 0;
        for entry in std::fs::read_dir(self.root.join("history")).into_iter().flatten().flatten() {
            let path = entry.path();
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let lines: Vec<&str> = text.lines().collect();
            let kept: Vec<&str> = lines.iter().copied().filter(|l| serde_json::from_str::<CheckRecord>(l).map(|r| r.at >= before).unwrap_or(false)).collect();
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if kept.len() != lines.len() {
                removed += lines.len() - kept.len();
                let _ = if kept.is_empty() { std::fs::remove_file(&path).map_err(|e| e.to_string()) } else { write_lines(&path, &kept) };
            }
            self.prune_grids(&stem, GRIDS_CAP);
        }
        removed
    }
    /// Keeps only the newest `keep` checks of a monitor here. Rewritten only once the file holds twice that,
    /// so the common append stays an append.
    pub fn keep_last(&self, name: &str, keep: usize) {
        let path = self.history_file(name);
        let Ok(text) = std::fs::read_to_string(&path) else { return };
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.len() <= keep.saturating_mul(2) {
            return;
        }
        let _ = write_lines(&path, &lines[lines.len() - keep..]);
        self.prune_grids(&safe_file(name), GRIDS_CAP);
    }
    /// One check gone from a monitor's history here (and its kept grid, unless another check names it). How many went.
    pub fn delete_check(&self, name: &str, at: i64) -> usize {
        let path = self.history_file(name);
        let Ok(text) = std::fs::read_to_string(&path) else { return 0 };
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let kept: Vec<&str> = lines.iter().copied().filter(|l| serde_json::from_str::<CheckRecord>(l).map(|r| r.at != at).unwrap_or(true)).collect();
        let removed = lines.len() - kept.len();
        if removed > 0 {
            let _ = if kept.is_empty() { std::fs::remove_file(&path).map_err(|e| e.to_string()) } else { write_lines(&path, &kept) };
            self.prune_grids(&safe_file(name), GRIDS_CAP);
        }
        removed
    }

    fn revisions_file(&self, name: &str) -> PathBuf {
        self.root.join("revisions").join(format!("{}.jsonl", safe_file(name)))
    }
    /// A monitor's changes as seen here, oldest first.
    pub fn revisions(&self, name: &str) -> Vec<Revision> {
        std::fs::read_to_string(self.revisions_file(name)).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }
    pub fn add_revision(&self, name: &str, revision: &Revision) {
        use std::io::Write;
        let file = self.revisions_file(name);
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let (Ok(line), Ok(mut out)) = (serde_json::to_string(revision), std::fs::OpenOptions::new().create(true).append(true).open(&file)) {
            let _ = writeln!(out, "{line}");
        }
    }
    /// A deleted monitor's changes go with it.
    pub fn delete_revisions(&self, name: &str) {
        let _ = std::fs::remove_file(self.revisions_file(name));
    }

    /// One monitor's history, last result and kept grids here, gone.
    pub fn delete_history(&self, name: &str) {
        let _ = std::fs::remove_file(self.history_file(name));
        let _ = std::fs::remove_file(self.result_file(name));
        let _ = std::fs::remove_dir_all(self.grids_dir(&safe_file(name)));
    }

    fn grids_dir(&self, safe: &str) -> PathBuf {
        self.root.join("grids").join(safe)
    }

    /// Keeps a check's whole grid, named by its content: written once, however many checks read the same.
    pub fn save_grid(&self, name: &str, e: &Evaluation) -> Option<String> {
        let text = serde_json::to_string(e).ok()?;
        let hash: String = Sha256::digest(text.as_bytes()).iter().take(12).map(|b| format!("{b:02x}")).collect();
        let dir = self.grids_dir(&safe_file(name));
        let file = dir.join(format!("{hash}.json"));
        if !file.exists() {
            std::fs::create_dir_all(&dir).ok()?;
            let temp = dir.join(format!("{hash}.tmp-{}", std::process::id()));
            std::fs::write(&temp, text).ok()?;
            std::fs::rename(&temp, &file).ok()?;
        }
        Some(hash)
    }

    /// A grid fetched from the team (a colleague's check), kept here under the hash its check names.
    pub fn save_grid_as(&self, name: &str, hash: &str, e: &Evaluation) {
        if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return;
        }
        let dir = self.grids_dir(&safe_file(name));
        let _ = std::fs::create_dir_all(&dir);
        let _ = write_json(&dir.join(format!("{hash}.json")), e);
    }

    /// A kept grid, by the hash its check names; None when it is not kept here (a colleague's check, or cleaned up).
    pub fn grid(&self, name: &str, hash: &str) -> Option<Evaluation> {
        if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        serde_json::from_str(&std::fs::read_to_string(self.grids_dir(&safe_file(name)).join(format!("{hash}.json"))).ok()?).ok()
    }

    /// Grids no check in the history names any more go; past `cap` bytes the oldest go too, so one monitor's grids
    /// cannot grow without end however its data changes.
    fn prune_grids(&self, safe: &str, cap: u64) {
        let dir = self.grids_dir(safe);
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        let history = std::fs::read_to_string(self.root.join("history").join(format!("{safe}.jsonl"))).unwrap_or_default();
        let named: std::collections::HashSet<String> = history.lines().filter_map(|l| serde_json::from_str::<CheckRecord>(l).ok()?.grid).collect();
        let mut kept: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if !named.contains(&stem) {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            let meta = entry.metadata().ok();
            kept.push((meta.as_ref().and_then(|m| m.modified().ok()).unwrap_or(std::time::UNIX_EPOCH), meta.map(|m| m.len()).unwrap_or(0), path));
        }
        let mut total: u64 = kept.iter().map(|k| k.1).sum();
        kept.sort_by_key(|k| k.0);
        for (_, size, path) in kept {
            if total <= cap {
                break;
            }
            let _ = std::fs::remove_file(&path);
            total = total.saturating_sub(size);
        }
    }
}

/// At most this much of one monitor's kept grids (History's "as it was"); the oldest go first past it.
const GRIDS_CAP: u64 = 200 * 1024 * 1024;

fn write_lines(file: &Path, lines: &[&str]) -> Result<(), String> {
    let temp = file.with_extension(format!("tmp-{}", std::process::id()));
    let mut text = lines.join("\n");
    text.push('\n');
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_stamps_the_labels_of_a_save() {
        let file = "---\r\nname: disk\r\ndescription: d\r\nauthor: ana\r\nversion: 3\r\n---\r\n\r\n```monitor\r\n{}\r\n```\r\n";
        assert_eq!(labels(file), Labels { author: Some("ana".into()), version: Some(3), updated: None, updated_by: None });
        let at = days_from_civil(2026, 10, 29) * 86_400 + 8 * 3600 + 15 * 60 + 2;
        let stamped = stamp_save(file, "bo", at);
        let l = labels(&stamped);
        assert_eq!((l.author.as_deref(), l.version, l.updated.as_deref(), l.updated_by.as_deref()), (Some("ana"), Some(4), Some("2026-10-29T08:15:02Z"), Some("bo")));
        assert_eq!(l.updated_at(), Some(at));
        // The rest of the file, its line endings included, is as it was.
        assert!(stamped.ends_with("---\r\n\r\n```monitor\r\n{}\r\n```\r\n"));
        assert!(!stamped.replace("\r\n", "").contains('\n'));
        // A second save replaces the labels rather than adding more.
        let again = stamp_save(&stamped, "chen", at + 60);
        assert_eq!(again.matches("updated_by:").count(), 1);
        assert_eq!(labels(&again).version, Some(5));
        assert_eq!(stamp_save("no frontmatter\n", "bo", at), "no frontmatter\n");
    }

    #[test]
    fn says_what_a_new_version_changed() {
        let first = Revision { at: 1, by: None, author: None, version: Some(1), hash: "a".into(), change: String::new(), block: Some(r#"{"every":"5m","source":{"sqlite":"x"}}"#.into()) };
        assert_eq!(describe_change(None, "{}", "a"), "First seen on this computer");
        assert!(describe_change(Some(&first), "{}", "a").starts_with("Its text changed"));
        assert_eq!(describe_change(Some(&first), r#"{"every":"10m","source":{"sqlite":"x"}}"#, "b"), "Schedule changed (every)");
        assert_eq!(describe_change(Some(&first), r#"{"every":"10m","source":{"sqlite":"y"}}"#, "c"), "Changed: every, source");
    }

    fn row(value: Value) -> Row {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn a_schedule_edit_changes_the_schedule_and_nothing_else() {
        let file = "---\r\nname: batch\r\ndescription: x\r\n---\r\n# Batch\r\n\r\n```monitor\r\n{\r\n  \"title\": \"Batch\",\r\n  \"summary\": \"Jobs\",\r\n  \"every\": \"15m\",\r\n  \"source\": { \"tool\": \"py__jobs\" },\r\n  \"rules\": []\r\n}\r\n```\r\n\r\nAfter.\r\n";
        let schedule = json!({ "every": "10m", "activeHours": "08:00-18:00", "days": ["mon", "fri"], "at": null });
        let (text, block) = with_schedule(file, schedule.as_object().unwrap()).unwrap();
        let keys: Vec<String> = serde_json::from_str::<Map<String, Value>>(&block).unwrap().keys().cloned().collect();
        assert_eq!(keys, ["title", "summary", "every", "activeHours", "days", "source", "rules"]);
        assert!(text.starts_with("---\r\nname: batch\r\ndescription: x\r\n---\r\n# Batch\r\n\r\n```monitor\r\n{\r\n  \"title\""));
        assert!(text.ends_with("}\r\n```\r\n\r\nAfter.\r\n"));
        assert!(!text.replace("\r\n", "").contains('\n'), "line endings kept");
        // What a scan reads back is exactly the block, so its approval matches.
        assert_eq!(hash_block(&monitor_block(&text).unwrap()), hash_block(&block));
        // Once a day at a time instead of an interval.
        let daily = json!({ "every": "", "activeHours": null, "days": [], "at": "07:30" });
        let (_, block) = with_schedule(&text, daily.as_object().unwrap()).unwrap();
        let spec: Map<String, Value> = serde_json::from_str(&block).unwrap();
        assert_eq!(spec.get("at"), Some(&json!("07:30")));
        assert!(!spec.contains_key("every") && !spec.contains_key("days"));
        // A schedule that cannot run is refused, so nothing is written.
        assert!(with_schedule(file, json!({ "every": "10s" }).as_object().unwrap()).is_err());
        assert!(with_schedule("# no block\n", json!({ "every": "5m" }).as_object().unwrap()).is_err());
    }

    fn monitor(block: Value) -> Monitor {
        compile(&block.to_string()).unwrap()
    }

    #[test]
    fn levels_read_their_everyday_names_and_order_by_severity() {
        assert_eq!(Level::parse("Failure"), Some(Level::Red));
        assert_eq!(Level::parse("warning"), Some(Level::Amber));
        assert_eq!(Level::parse("info"), Some(Level::Blue));
        assert_eq!(Level::parse("stale"), Some(Level::Purple));
        assert!(Level::Red > Level::Amber && Level::Amber > Level::Purple && Level::Purple > Level::Blue && Level::Blue > Level::Green && Level::Green > Level::Grey);
        assert_eq!(serde_json::to_string(&Level::Amber).unwrap(), "\"amber\"");
    }

    #[test]
    fn durations_and_times_read_the_ways_people_write_them() {
        assert_eq!(parse_duration(&json!("15m")), Some(900));
        assert_eq!(parse_duration(&json!("2h")), Some(7200));
        assert_eq!(parse_duration(&json!("1d")), Some(86_400));
        assert_eq!(parse_duration(&json!(5)), Some(300));
        assert_eq!(parse_duration(&json!("soon")), None);
        let utc = parse_datetime(&json!("2026-10-25T14:05:00Z"), 3600).unwrap();
        assert_eq!(parse_datetime(&json!("2026-10-25T15:05:00+01:00"), 0), Some(utc));
        // AutoSys's own format, local time.
        assert_eq!(parse_datetime(&json!("10/25/2026 15:05:00"), 3600), Some(utc));
        assert_eq!(parse_datetime(&json!(utc), 0), Some(utc));
        assert_eq!(parse_datetime(&json!(utc * 1000), 0), Some(utc));
        assert_eq!(parse_datetime(&json!("not a date"), 0), None);
    }

    #[test]
    fn active_hours_follow_the_clock_and_a_night_window_belongs_to_its_start_day() {
        let m = monitor(json!({ "every": "5m", "activeHours": "22:00-06:00", "days": ["fri"], "source": { "tool": "py__x" } }));
        assert!(m.active(LocalNow { weekday: 4, minutes: 23 * 60, offset_secs: 0 }));
        // Saturday 02:00 is still Friday night.
        assert!(m.active(LocalNow { weekday: 5, minutes: 120, offset_secs: 0 }));
        assert!(!m.active(LocalNow { weekday: 5, minutes: 23 * 60, offset_secs: 0 }));
        assert!(!m.active(LocalNow { weekday: 4, minutes: 12 * 60, offset_secs: 0 }));
    }

    #[test]
    fn checks_run_every_n_minutes_at_times_of_day_on_days_and_not_before_a_time() {
        let midnight = days_from_civil(2026, 10, 26) * 86_400; // a Monday
        let at = |minutes: u16| (midnight + minutes as i64 * 60, LocalNow { weekday: 0, minutes, offset_secs: 0 });
        // Once a day at 07:30, weekdays only.
        let daily = monitor(json!({ "at": "07:30", "days": ["mon", "tue", "wed", "thu", "fri"], "source": { "tool": "py__x" } }));
        let (now, local) = at(7 * 60 + 29);
        assert_eq!(daily.due_slot(Some(midnight - 86_400), now, local), None);
        let (now, local) = at(7 * 60 + 31);
        let slot = daily.due_slot(Some(midnight - 86_400), now, local).unwrap();
        assert_eq!(slot, midnight + 450 * 60);
        // Ran at 07:31: not again today.
        assert_eq!(daily.due_slot(Some(now), now + 3600, LocalNow { minutes: 8 * 60 + 31, ..local }), None);
        assert_eq!(daily.next_run(Some(now), now, local), Some(midnight + 86_400 + 450 * 60));
        // Not on a Saturday.
        assert_eq!(daily.due_slot(None, now, LocalNow { weekday: 5, ..local }), None);
        // Several times of day.
        let three = monitor(json!({ "at": ["18:00", "07:30", "12:00"], "source": { "tool": "py__x" } }));
        assert_eq!(three.times, vec![450, 720, 1080]);
        let (now, local) = at(12 * 60 + 5);
        assert_eq!(three.due_slot(Some(midnight + 450 * 60), now, local), Some(midnight + 720 * 60));
        // Every 15 minutes, not before 09:00.
        let morning = monitor(json!({ "every": "15m", "activeHours": "09:00-", "source": { "tool": "py__x" } }));
        let (now, local) = at(8 * 60 + 50);
        assert_eq!(morning.due_slot(None, now, local), None);
        let (now, local) = at(9 * 60 + 1);
        assert_eq!(morning.due_slot(None, now, local), Some(now / 900));
        // Once per window of the clock: a check in this window (09:00-09:15) means not due; one in the last window does.
        assert_eq!(morning.due_slot(Some(now - 30), now, local), None);
        assert_eq!(morning.due_slot(Some(now - 300), now, local), Some(now / 900));
        assert_eq!(morning.next_run(Some(now - 30), now, local), Some((now / 900 + 1) * 900));
        // Saying neither is a sentence, not a default.
        assert!(compile(&json!({ "source": { "tool": "py__x" } }).to_string()).unwrap_err().contains("Say when to check"));
        assert!(compile(&json!({ "at": "25:00", "source": { "tool": "py__x" } }).to_string()).is_err());
        assert_eq!(three.stale_after(), (13 * 60 + 30) * 60 + 3600);
    }

    #[test]
    fn two_members_who_started_at_different_times_agree_on_every_window() {
        // Asked: A has a check every 10 minutes; B gets it later and starts at another time. Both must claim the
        // same window, every time, so the team claim lets exactly one of them run it.
        let ten = monitor(json!({ "every": "10m", "source": { "tool": "py__x" } }));
        let window = 600;
        let base = 1_800_000_000 - 1_800_000_000 % window;
        let local = |now: i64| LocalNow { minutes: ((now % 86_400) / 60) as u16, weekday: 2, offset_secs: 0 };
        // A ran at 10:03 of a window; B arrives at 10:06 knowing nothing yet: B asks for the same window, and loses it.
        let a_ran = base + 180;
        let b_now = base + 360;
        assert_eq!(ten.due_slot(None, b_now, local(b_now)), Some(base / window));
        assert_eq!(ten.due_slot(Some(a_ran), b_now, local(b_now)), None, "once B has read A's check, nothing is due");
        // Across the next edges, whatever second each machine looks at, both name the same window - including
        // either side of an edge, where the old "10 minutes after my last run" rule had them claim different ones.
        for (a_looks, b_looks) in [(base + window, base + window + 2), (base + 2 * window - 1, base + 2 * window - 1), (base + 2 * window, base + 2 * window + 1)] {
            let a = ten.due_slot(Some(a_ran), a_looks, local(a_looks));
            let b = ten.due_slot(Some(a_ran), b_looks, local(b_looks));
            assert_eq!(a, b, "A at {a_looks}, B at {b_looks}");
        }
    }

    #[test]
    fn a_bad_spec_is_one_sentence_naming_the_field() {
        let error = |b: Value| compile(&b.to_string()).unwrap_err();
        assert!(error(json!({ "every": "5m", "source": {} })).contains("\"tool\""));
        assert!(error(json!({ "every": "10s", "source": { "tool": "py__x" } })).contains("one minute"));
        assert!(error(json!({ "every": "5m", "source": { "sqlite": "relative.db", "sql": "select 1" } })).contains("full path"));
        assert!(error(json!({ "every": "5m", "source": { "tool": "py__x" }, "rules": [{ "level": "red", "when": { "column": "s", "op": "~" } }] })).contains("not an operator"));
        assert!(error(json!({ "every": "5m", "source": { "tool": "py__x" }, "rules": [{ "level": "red", "when": { "column": "s", "op": "matches", "value": "(" } }] })).contains("regular expression"));
        assert!(error(json!({ "every": "5m", "source": { "tool": "py__x" }, "rules": [{ "level": "purplish", "when": { "column": "s" } }] })).contains("not an alert level"));
        assert!(error(json!({ "every": "5m", "source": { "tool": "py__x" }, "colour": "x" })).contains("unknown field"));
    }

    #[test]
    fn rows_come_out_of_every_shape_a_source_answers_in() {
        assert_eq!(rows_from(&json!([{ "a": 1 }, { "a": 2 }]), None).unwrap().len(), 2);
        assert_eq!(rows_from(&json!({ "count": 2, "jobs": [{ "a": 1 }] }), None).unwrap()[0]["a"], json!(1));
        assert_eq!(rows_from(&json!({ "deep": { "list": [{ "a": 1 }] } }), Some("deep.list")).unwrap().len(), 1);
        let table = rows_from(&json!({ "columns": ["name", "n"], "rows": [["x", 1], ["y", 2]] }), None).unwrap();
        assert_eq!(table[1]["name"], json!("y"));
        let named = rows_from(&json!({ "columns": [{ "name": "n", "type": "i64" }], "rows": [[3]] }), None).unwrap();
        assert_eq!(named[0]["n"], json!(3));
        assert_eq!(rows_from(&json!([1, 2]), None).unwrap()[1]["value"], json!(2));
        // A Python tool's answer with its printed output after it.
        assert_eq!(rows_from_text("[{\"a\":1}]\n\n--- stdout ---\nhello", None).unwrap().len(), 1);
        assert_eq!(rows_from_text("JOB_A: SUCCESS\nJOB_B: FAILURE", None).unwrap()[1]["line"], json!("JOB_B: FAILURE"));
        assert!(rows_from(&json!({ "a": 1 }), Some("missing")).is_err());
    }

    fn jobs() -> Monitor {
        monitor(json!({
            "every": "15m",
            "key": "name",
            "source": { "tool": "py__jobs" },
            "rules": [
                { "level": "red", "when": { "column": "status", "op": "in", "value": ["FAILURE", "TERMINATED"] }, "message": "{name} failed" },
                { "level": "amber", "when": { "all": [{ "column": "status", "op": "==", "value": "RUNNING" }, { "column": "minutes", "op": ">", "value": 60 }] }, "column": "minutes" },
                { "level": "blue", "when": { "column": "note", "op": "notEmpty" }, "highlight": "row" }
            ]
        }))
    }

    #[test]
    fn rules_colour_cells_and_rows_and_the_worst_alert_is_the_level() {
        let rows = vec![
            row(json!({ "name": "A", "status": "success" })),
            row(json!({ "name": "B", "status": "FAILURE" })),
            row(json!({ "name": "C", "status": "RUNNING", "minutes": "75" })),
            row(json!({ "name": "D", "status": "SUCCESS", "note": "rerun" })),
        ];
        let e = evaluate(&jobs(), rows, &HashMap::new(), 0, 0);
        assert_eq!(e.level, Level::Red);
        assert_eq!(e.alerts.len(), 3);
        let failed = &e.alerts[0];
        assert_eq!((failed.key.as_str(), failed.column.as_deref(), failed.whole_row, failed.message.as_str()), ("B", Some("status"), false, "B failed"));
        assert_eq!(e.alerts[1].column.as_deref(), Some("minutes"));
        assert!(e.alerts[2].whole_row);
        assert_eq!(e.counts.get("red"), Some(&1));
        assert!(e.headline.starts_with("1 failing · 1 warning · 1 info"), "{}", e.headline);
    }

    #[test]
    fn an_acknowledged_alert_stops_counting_until_it_gets_worse_or_expires() {
        let m = jobs();
        let rows = || vec![row(json!({ "name": "B", "status": "FAILURE" }))];
        let mut acks = HashMap::new();
        acks.insert("0|B|status".to_string(), Ack { level: Level::Red, at: 0, until: Some(100), note: None });
        let quiet = evaluate(&m, rows(), &acks, 50, 0);
        assert_eq!(quiet.level, Level::Green);
        assert!(quiet.alerts[0].acknowledged);
        assert_eq!(evaluate(&m, rows(), &acks, 150, 0).level, Level::Red);
        acks.insert("0|B|status".to_string(), Ack { level: Level::Amber, at: 0, until: None, note: None });
        assert_eq!(evaluate(&m, rows(), &acks, 50, 0).level, Level::Red);
    }

    #[test]
    fn empty_and_clear_take_the_levels_the_monitor_gives_them() {
        let m = monitor(json!({ "every": "5m", "source": { "tool": "py__x" }, "whenEmpty": "purple", "whenClear": "blue" }));
        assert_eq!(evaluate(&m, vec![], &HashMap::new(), 0, 0).level, Level::Purple);
        assert_eq!(evaluate(&m, vec![row(json!({ "a": 1 }))], &HashMap::new(), 0, 0).level, Level::Blue);
    }

    #[test]
    fn operators_compare_numbers_dates_and_text_as_people_expect() {
        let t = |when: Value, r: Value| holds(&parse_cond(&when, 0).unwrap(), &row(r), 10_000, 0);
        assert!(t(json!({ "column": "n", "op": ">=", "value": 10 }), json!({ "n": "1,000" })));
        assert!(t(json!({ "column": "n", "op": "<", "value": "9" }), json!({ "n": 8.5 })));
        assert!(t(json!({ "column": "s", "op": "==", "value": "failure" }), json!({ "s": " FAILURE " })));
        assert!(t(json!({ "column": "s", "op": "contains", "value": "fail" }), json!({ "s": "it FAILED" })));
        assert!(t(json!({ "column": "s", "op": "matches", "value": "^ora-\\d+" }), json!({ "s": "ORA-00942 table missing" })));
        assert!(t(json!({ "column": "at", "op": "olderThan", "value": "1h" }), json!({ "at": 5000 })) == false);
        assert!(t(json!({ "column": "at", "op": "olderThan", "value": "1h" }), json!({ "at": "1970-01-01T00:00:00Z" })));
        assert!(t(json!({ "column": "owner.name", "op": "==", "value": "ann" }), json!({ "owner": { "name": "Ann" } })));
        assert!(t(json!({ "not": { "column": "s", "op": "in", "value": ["OK", "SUCCESS"] } }), json!({ "s": "FAILURE" })));
        // A missing cell does not fire a rule about it - absent is not failed.
        assert!(!t(json!({ "column": "s", "op": "==", "value": "FAILURE" }), json!({ "x": 1 })));
        assert!(t(json!({ "column": "s", "op": "empty" }), json!({ "s": "  " })));
    }

    #[test]
    fn templates_fill_from_the_row_and_leave_unknown_names_alone() {
        let r = row(json!({ "name": "PAY", "n": 3, "o": { "id": "x" } }));
        assert_eq!(fill_template("{name} failed {n} times ({o.id}) {missing} {", &r), "PAY failed 3 times (x) {missing} {");
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let file = dir.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fire-monitor-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn monitors_are_skills_with_a_monitor_block_and_the_first_folder_wins_a_name() {
        let d = temp("scan");
        let spec = "```monitor\n{ \"every\": \"5m\", \"source\": { \"tool\": \"py__jobs\" } }\n```\n";
        write(&d, "personal/batch.md", &format!("---\nname: batch\ndescription: Mine\n---\n\nText\n\n{spec}"));
        write(&d, "team/batch.md", &format!("---\nname: batch\ndescription: Theirs\n---\n{spec}"));
        write(&d, "team/disk/SKILL.md", &format!("---\nname: disk\ndescription: Disk space\n---\n```json monitor\n{{ \"every\": \"1h\", \"source\": {{ \"tool\": \"py__disk\" }} }}\n```\n"));
        write(&d, "team/plain.md", "---\nname: plain\ndescription: Just a skill\n---\nNo block here.\n");
        let folders = [
            Folder { path: d.join("personal"), team: false, origin: "personal".into() },
            Folder { path: d.join("team"), team: true, origin: "shop".into() },
        ];
        let found = scan(&folders);
        assert_eq!(found.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["batch", "disk"]);
        assert_eq!((found[0].description.as_str(), found[0].team), ("Mine", false));
        assert!(found[1].team && found[1].monitor.is_ok());
        // The approval key is the block: CRLF in a colleague's copy is the same monitor.
        assert_eq!(hash_block("{ \"a\": 1 }\r\n"), hash_block("{ \"a\": 1 }\n"));
        assert_ne!(hash_block("{ \"a\": 1 }"), hash_block("{ \"a\": 2 }"));
    }

    #[test]
    fn notifications_follow_the_users_levels_quiet_hours_and_snooze() {
        let m = jobs();
        let s = Settings::default();
        let day = LocalNow { weekday: 1, minutes: 600, offset_secs: 0 };
        let fresh = MonitorState::default();
        assert_eq!(should_notify(&m, Level::Red, &fresh, &s, 1000, day), Some((Mode::Urgent, Telling::Worse)));
        assert_eq!(should_notify(&m, Level::Amber, &fresh, &s, 1000, day), Some((Mode::Toast, Telling::Worse)));
        // Below the monitor's notify level (amber by default): only counted on the tile.
        assert_eq!(should_notify(&m, Level::Blue, &fresh, &s, 1000, day), None);
        let told = MonitorState { notified_level: Some(Level::Red), notified_at: Some(1000), ..Default::default() };
        assert_eq!(should_notify(&m, Level::Red, &told, &s, 1000 + 1800, day), None);
        // A reminder an hour on, never as loud as the first time.
        assert_eq!(should_notify(&m, Level::Red, &told, &s, 1000 + 3600, day), Some((Mode::Toast, Telling::StillBad)));
        assert_eq!(should_notify(&m, Level::Green, &told, &s, 2000, day).map(|n| n.1), Some(Telling::Recovered));
        let snoozed = MonitorState { snooze_until: Some(5000), ..Default::default() };
        assert_eq!(should_notify(&m, Level::Red, &snoozed, &s, 1000, day), None);
        let quiet = Settings { quiet_hours: Some("22:00-07:00".into()), ..Settings::default() };
        let night = LocalNow { weekday: 1, minutes: 120, offset_secs: 0 };
        assert_eq!(should_notify(&m, Level::Amber, &fresh, &quiet, 1000, night), Some((Mode::Dashboard, Telling::Worse)));
        assert_eq!(should_notify(&m, Level::Red, &fresh, &quiet, 1000, night), Some((Mode::Urgent, Telling::Worse)));
        let muted = MonitorState { mode: Some(Mode::Off), ..Default::default() };
        assert_eq!(should_notify(&m, Level::Red, &muted, &s, 1000, day), None);
        let loud = MonitorState { mode: Some(Mode::Alarm), ..Default::default() };
        assert_eq!(should_notify(&m, Level::Amber, &loud, &s, 1000, day), Some((Mode::Alarm, Telling::Worse)));
    }

    fn check(at: i64, alerts: &[(&str, &str)]) -> CheckRecord {
        CheckRecord {
            at,
            level: if alerts.is_empty() { Level::Green } else { Level::Red },
            alerts: alerts.len(),
            headline: String::new(),
            error: None,
            row_count: 3,
            duration_ms: 1,
            by: None,
            found: alerts.iter().map(|(id, key)| StoredAlert { id: id.to_string(), level: Level::Red, key: key.to_string(), column: None, message: format!("{key} failed"), row: row(json!({ "job": key })) }).collect(),
            grid: None,
        }
    }

    #[test]
    fn an_alerts_history_says_new_ongoing_recurring_intermittent_or_cleared() {
        let day = 86_400;
        let hour = 3600;
        let base = days_from_civil(2026, 10, 1) * day;
        // New: first seen an hour ago, in every check since.
        let new = [check(base, &[]), check(base + hour, &[("0|A|", "A")]), check(base + 2 * hour, &[("0|A|", "A")])];
        let p = &alert_patterns(&new, None, None, base + 2 * hour, 0)[0];
        assert_eq!((p.verdict.as_str(), p.occurrences, p.active), ("new", 2, true));
        // Ongoing: present in every check for three days.
        let ongoing: Vec<CheckRecord> = (0..12).map(|i| check(base + i * 6 * hour, &[("0|B|", "B")])).collect();
        let p = &alert_patterns(&ongoing, None, None, base + 3 * day, 0)[0];
        assert_eq!(p.verdict, "ongoing");
        assert!(p.summary.contains("12 checks in a row"), "{}", p.summary);
        // Recurring: every night around 02:00 for four nights, clear in between.
        let mut nightly = Vec::new();
        for d in 0..4 {
            nightly.push(check(base + d * day + 2 * hour, &[("0|C|", "C")]));
            nightly.push(check(base + d * day + 9 * hour, &[]));
        }
        let p = &alert_patterns(&nightly, None, None, base + 4 * day, 0)[0];
        assert_eq!((p.verdict.as_str(), p.episodes, p.days.len()), ("recurring", 4, 4));
        assert!(p.summary.contains("usually starting around 02:00"), "{}", p.summary);
        // Intermittent: twice in one day. Cleared: once, gone since.
        let flapping = [check(base, &[("0|D|", "D")]), check(base + hour, &[]), check(base + 2 * hour, &[("0|D|", "D")])];
        assert_eq!(alert_patterns(&flapping, None, None, base + 3 * hour, 0)[0].verdict, "intermittent");
        let cleared = [check(base, &[("0|E|", "E")]), check(base + hour, &[])];
        assert_eq!(alert_patterns(&cleared, None, None, base + 2 * hour, 0)[0].verdict, "cleared");
        // Filtered to one row's key.
        assert_eq!(alert_patterns(&[check(base, &[("0|A|", "A"), ("0|B|", "B")])], Some("B"), None, base, 0).len(), 1);
        assert_eq!(local_date_time(base + 2 * hour + 5 * 60, 3600), ("2026-10-01".to_string(), "03:05".to_string()));
    }

    #[test]
    fn a_check_keeps_only_the_alerted_rows_and_shows_them_again() {
        let m = jobs();
        let rows = vec![row(json!({ "name": "A", "status": "SUCCESS" })), row(json!({ "name": "B", "status": "FAILURE" }))];
        let e = evaluate(&m, rows, &HashMap::new(), 0, 0);
        let run = RunRecord { at: 5, duration_ms: 1, level: e.level, error: None, headline: e.headline.clone(), evaluation: Some(e), last_success_at: Some(5), by: None, partial: false };
        let kept = CheckRecord::from_run(&run);
        assert_eq!((kept.row_count, kept.found.len()), (2, 1));
        assert_eq!(kept.found[0].row["name"], json!("B"));
        let shown = kept.evaluation(&m);
        assert_eq!((shown.rows.len(), shown.alerts[0].row, shown.level), (1, 0, Level::Red));
        // Lines written before 0.60 still read.
        let old: CheckRecord = serde_json::from_str(r#"{"at":1,"level":"green","alerts":0}"#).unwrap();
        assert!(old.found.is_empty());
    }

    #[test]
    fn retention_removes_old_checks_and_leaves_the_rest() {
        let d = temp("prune");
        let store = Store::new(d);
        for at in [10, 20, 30] {
            store.record_history("m", &check(at, &[]));
        }
        assert_eq!(store.prune(25), 2);
        assert_eq!(store.history("m", 10).iter().map(|r| r.at).collect::<Vec<_>>(), vec![30]);
        store.delete_history("m");
        assert!(store.history("m", 10).is_empty());
    }

    #[test]
    fn one_monitors_history_older_than_a_time_goes_and_the_rest_stays() {
        let store = Store::new(temp("older"));
        for at in [10, 20, 30] {
            store.record_history("m", &check(at, &[]));
            store.record_history("other", &check(at, &[]));
        }
        assert_eq!(store.prune_monitor("m", 25), 2);
        assert_eq!(store.history("m", 10).iter().map(|r| r.at).collect::<Vec<_>>(), vec![30]);
        assert_eq!(store.history("other", 10).len(), 3, "other monitors are untouched");
    }

    #[test]
    fn a_checks_whole_grid_is_kept_once_and_goes_with_its_history() {
        let store = Store::new(temp("grids"));
        let e = Evaluation { level: Level::Green, columns: Vec::new(), rows: vec![row(json!({ "job": "A" }))], alerts: Vec::new(), counts: BTreeMap::new(), headline: "ok".into() };
        // Two checks that read the same: one file.
        let first = store.save_grid("m", &e).unwrap();
        assert_eq!(store.save_grid("m", &e).as_deref(), Some(first.as_str()));
        assert_eq!(store.grid("m", &first).map(|g| g.rows.len()), Some(1));
        assert!(store.grid("m", "../../etc").is_none(), "only a hash names a grid");
        let mut c = check(10, &[]);
        c.grid = Some(first.clone());
        store.record_history("m", &c);
        store.record_history("m", &check(20, &[]));
        // Deleting the one check that named it takes the grid with it.
        assert_eq!(store.delete_check("m", 10), 1);
        assert_eq!(store.history("m", 10).iter().map(|r| r.at).collect::<Vec<_>>(), vec![20]);
        assert!(store.grid("m", &first).is_none());
    }

    #[test]
    fn a_team_monitor_keeps_only_its_newest_checks_here() {
        // The team's whole history is in its index, once; each member keeps a short tail, not a full copy.
        let store = Store::new(temp("keep"));
        for at in 1..=10 {
            store.record_history("m", &check(at, &[]));
            store.keep_last("m", 3);
        }
        let kept: Vec<i64> = store.history("m", 100).iter().map(|r| r.at).collect();
        assert!(kept.len() <= 6, "never more than twice the tail: {kept:?}");
        assert_eq!(kept.last(), Some(&10));
        assert!(kept.contains(&8) && kept.contains(&9));
    }

    #[test]
    fn the_store_keeps_results_state_and_a_bounded_history() {
        let d = temp("store");
        let store = Store::new(d.clone());
        assert!(!store.settings().enabled);
        store.save_settings(&Settings { enabled: true, ..Settings::default() }).unwrap();
        assert!(store.settings().enabled);
        for i in 0..1005 {
            store.record_history("a/b", &CheckRecord { at: i, level: Level::Green, alerts: 0, headline: String::new(), error: None, row_count: 0, duration_ms: 0, by: None, found: Vec::new(), grid: None });
        }
        let h = store.history("a/b", 10_000);
        assert_eq!((h.len(), h.last().unwrap().at), (1005, 1004));
        assert_eq!(store.history("a/b", 10).len(), 10);
        let record = RunRecord { at: 1, duration_ms: 2, level: Level::Red, error: None, headline: "x".into(), evaluation: None, last_success_at: Some(1), by: None, partial: false };
        store.save_result("a/b", &record).unwrap();
        assert_eq!(store.result("a/b").unwrap().level, Level::Red);
    }
}
