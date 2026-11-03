//! `fire-fs watch`: one observer agent - the Auditor or the Anti Hallucinator - as its own process.
//!
//! Asked for in these words: each "should run with its own context", "keep it as a separate process",
//! "use rust", and "when context limit hits, it should automatically handoff and start new process".
//!
//! ## The one place outside core that calls a model (invariant 2's recorded exception)
//!
//! The user chose Rust for the model calls knowing the cost. What is kept in core on purpose, so this file
//! is a transport and not a second implementation of auth:
//!
//! - **Auth headers are asked for before every call** (`needAuth`) and answered by the host from the same
//!   `AuthStrategy` the chat uses - API key header per wire format, Apigee token refresh, single flight. A
//!   401 asks once more with `force` (the host refreshes) and is then reported, never looped.
//! - **TLS material comes from the host's one resolver** (`resolveConnectionTls` via the strategy): the CA
//!   roots, the client certificate and key as PEM, and whether to verify. Windows' own store is trusted too.
//! - **The URL is the profile's base URL.** Nothing here has a default endpoint (invariant 3), and no proxy
//!   is used - the gateway connection in core does not use one either.
//!
//! ## Protocol (one JSON object per line, both ways)
//!
//! In: `start` (once: role, model, system prompt, window, handoff), `event`, `flush`, `auth` (an answer to
//! `needAuth`), `stop`. Out: `ready`, `needAuth`, `result` (the model's parsed reply), `usage`, `error`,
//! `handoff` (context is past its threshold: carries the running state; then this process exits).
//!
//! ## Why the handoff cannot fail at the limit
//!
//! Every reply the model gives carries `state`: its own short running notes. The handoff is that state,
//! already in hand - nothing has to be written when the context is full. The host starts the next process
//! with it, and also does so from the last state it saw if this process dies.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// Past this share of the window the process hands off. Leaves room for the next batch and the reply.
const HANDOFF_AT: f64 = 0.7;
/// One batch is at most this many characters of events; older ones in an oversized batch are shortened.
const MAX_BATCH_CHARS: usize = 24_000;
/// Events kept waiting while the model is unreachable; the oldest are dropped past this, and said so.
const MAX_PENDING: usize = 400;
const AUTH_WAIT: Duration = Duration::from_secs(30);

pub(crate) fn out(value: Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

pub(crate) fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Role {
    Auditor,
    Guard,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Wire {
    OpenAi,
    Anthropic,
    Gemini,
}

pub(crate) struct Model {
    pub(crate) wire: Wire,
    pub(crate) base: String,
    pub(crate) model: String,
    pub(crate) max_tokens: u64,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) client: reqwest::blocking::Client,
}

/// The parts of `start` that do not need a network: checked by the tests.
#[derive(Debug)]
struct Plan {
    role: Role,
    wire: Wire,
    window: u64,
}

/// The wire format a `start` names, for any role.
pub(crate) fn wire_of(model: &Value) -> Result<Wire, String> {
    match s(model, "wire") {
        "openai" => Ok(Wire::OpenAi),
        "anthropic" => Ok(Wire::Anthropic),
        "gemini" => Ok(Wire::Gemini),
        other => Err(format!("This process cannot call a \"{other}\" model: choose a profile that talks OpenAI, Anthropic or Gemini.")),
    }
}

fn plan(start: &Value) -> Result<Plan, String> {
    let role = match s(start, "role") {
        "auditor" => Role::Auditor,
        "guard" => Role::Guard,
        other => return Err(format!("Unknown observer role \"{other}\".")),
    };
    let model = start.get("model").ok_or("The start message names no model.")?;
    let wire = match s(model, "wire") {
        "openai" => Wire::OpenAi,
        "anthropic" => Wire::Anthropic,
        "gemini" => Wire::Gemini,
        other => return Err(format!("The observer cannot call a \"{other}\" model: choose a profile that talks OpenAI, Anthropic or Gemini.")),
    };
    let base = s(model, "baseUrl");
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(format!("\"{base}\" is not an http(s) address."));
    }
    if s(model, "model").is_empty() {
        return Err("The profile names no model.".into());
    }
    let window = start.get("window").and_then(Value::as_u64).unwrap_or(32_000).max(4_000);
    Ok(Plan { role, wire, window })
}

pub(crate) fn build_model(start: &Value, wire: Wire) -> Result<Model, String> {
    let model = &start["model"];
    let tls = model.get("tls").cloned().unwrap_or(Value::Null);
    let mut builder = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .tls_built_in_native_certs(true)
        .no_proxy()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(model.get("timeoutSeconds").and_then(Value::as_u64).unwrap_or(180)));
    if let Some(cas) = tls.get("ca").and_then(Value::as_array) {
        for pem in cas.iter().filter_map(Value::as_str) {
            // Node's merged list carries every public root as well; one rustls cannot parse is skipped, not fatal.
            if let Ok(found) = reqwest::Certificate::from_pem_bundle(pem.as_bytes()) {
                for cert in found {
                    builder = builder.add_root_certificate(cert);
                }
            }
        }
    }
    let cert = s(&tls, "cert");
    let key = s(&tls, "key");
    if !cert.is_empty() && !key.is_empty() {
        let identity = reqwest::Identity::from_pem(format!("{cert}\n{key}").as_bytes())
            .map_err(|e| format!("The client certificate could not be used by the observer: {e}"))?;
        builder = builder.identity(identity);
    }
    if tls.get("rejectUnauthorized").and_then(Value::as_bool) == Some(false) {
        builder = builder.danger_accept_invalid_certs(true);
    }
    let client = builder.build().map_err(|e| format!("Could not set up the connection: {e}"))?;
    let headers = model
        .get("headers")
        .and_then(Value::as_object)
        .map(|h| h.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
        .unwrap_or_default();
    Ok(Model {
        wire,
        base: s(model, "baseUrl").trim_end_matches('/').to_string(),
        model: s(model, "model").to_string(),
        max_tokens: model.get("maxTokens").and_then(Value::as_u64).unwrap_or(2048).clamp(256, 16_384),
        headers,
        client,
    })
}

/// The URL and body for one request. Pure, so each wire format's shape is pinned by a test.
fn request_body(wire: Wire, base: &str, model: &str, max_tokens: u64, system: &str, turns: &[(bool, String)]) -> (String, Value) {
    match wire {
        Wire::OpenAi => {
            let mut messages = vec![json!({ "role": "system", "content": system })];
            messages.extend(turns.iter().map(|(user, text)| json!({ "role": if *user { "user" } else { "assistant" }, "content": text })));
            (format!("{base}/chat/completions"), json!({ "model": model, "messages": messages, "max_tokens": max_tokens, "stream": false }))
        }
        Wire::Anthropic => {
            let messages: Vec<Value> = turns.iter().map(|(user, text)| json!({ "role": if *user { "user" } else { "assistant" }, "content": text })).collect();
            (format!("{base}/messages"), json!({ "model": model, "system": system, "messages": messages, "max_tokens": max_tokens }))
        }
        Wire::Gemini => {
            let contents: Vec<Value> = turns.iter().map(|(user, text)| json!({ "role": if *user { "user" } else { "model" }, "parts": [{ "text": text }] })).collect();
            let model_path: String = model.chars().map(|c| if c.is_ascii_alphanumeric() || "-._".contains(c) { c.to_string() } else { format!("%{:02X}", c as u32) }).collect();
            (
                format!("{base}/models/{model_path}:generateContent"),
                json!({ "systemInstruction": { "parts": [{ "text": system }] }, "contents": contents, "generationConfig": { "maxOutputTokens": max_tokens } }),
            )
        }
    }
}

/// The reply's text and the prompt's size, when the provider said.
fn read_reply(wire: Wire, body: &Value) -> (String, Option<u64>) {
    match wire {
        Wire::OpenAi => (
            body["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string(),
            body["usage"]["prompt_tokens"].as_u64(),
        ),
        Wire::Anthropic => {
            let text = body["content"].as_array().map(|parts| parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("")).unwrap_or_default();
            let usage = &body["usage"];
            let input = usage["input_tokens"].as_u64().map(|n| n + usage["cache_read_input_tokens"].as_u64().unwrap_or(0) + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0));
            (text, input)
        }
        Wire::Gemini => {
            let text = body["candidates"][0]["content"]["parts"].as_array().map(|parts| parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("")).unwrap_or_default();
            (text, body["usageMetadata"]["promptTokenCount"].as_u64())
        }
    }
}

/// The first JSON object in a reply, with any `<think>` block removed first. None when there is none.
fn json_in(reply: &str) -> Option<Value> {
    let mut text = reply.to_string();
    while let (Some(a), Some(b)) = (text.find("<think>"), text.find("</think>")) {
        if b < a {
            break;
        }
        text.replace_range(a..b + "</think>".len(), "");
    }
    let bytes = text.as_bytes();
    let mut start = 0;
    while let Some(offset) = text[start..].find('{') {
        let begin = start + offset;
        let (mut depth, mut in_str, mut escaped) = (0i32, false, false);
        for (i, &c) in bytes.iter().enumerate().skip(begin) {
            if in_str {
                if escaped {
                    escaped = false;
                } else if c == b'\\' {
                    escaped = true;
                } else if c == b'"' {
                    in_str = false;
                }
                continue;
            }
            match c {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        if let Ok(v) = serde_json::from_str::<Value>(&text[begin..=i]) {
                            if v.is_object() {
                                return Some(v);
                            }
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
        start = begin + 1;
    }
    None
}

pub(crate) fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}… [{} more characters]", text.chars().count() - max)
}

/// The events of one batch as text, newest kept whole: older ones are shortened to fit.
fn batch_text(events: &[Value]) -> String {
    let lines: Vec<String> = events.iter().map(|e| e.to_string()).collect();
    let total: usize = lines.iter().map(String::len).sum();
    if total <= MAX_BATCH_CHARS {
        return lines.join("\n");
    }
    let mut budget = MAX_BATCH_CHARS;
    let mut kept: Vec<String> = Vec::new();
    for line in lines.iter().rev() {
        let take = if line.len() <= budget / 2 || kept.is_empty() { line.len().min(budget) } else { 400.min(budget) };
        kept.push(shorten(line, take));
        budget = budget.saturating_sub(take);
        if budget < 200 {
            break;
        }
    }
    let dropped = lines.len() - kept.len();
    kept.reverse();
    let mut text = kept.join("\n");
    if dropped > 0 {
        text = format!("[{dropped} older events in this batch were left out to fit]\n{text}");
    }
    text
}

/// Whether a batch should go now: the guard reviews at every step boundary, the auditor in batches.
fn due(role: Role, pending: &[Value], oldest: Option<Instant>, force: bool) -> bool {
    if pending.is_empty() {
        return false;
    }
    if force {
        return true;
    }
    let last = s(pending.last().unwrap(), "kind");
    match role {
        Role::Guard => matches!(last, "toolResult" | "assistant" | "turnEnd"),
        Role::Auditor => last == "turnEnd" || pending.len() >= 12 || oldest.map_or(false, |t| t.elapsed() >= Duration::from_secs(30)),
    }
}

fn estimate(system: &str, turns: &[(bool, String)]) -> u64 {
    ((system.len() + turns.iter().map(|(_, t)| t.len()).sum::<usize>()) / 4) as u64
}

pub fn run() {
    let (tx, rx) = channel::<Value>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(&line) {
                Ok(v) => {
                    if tx.send(v).is_err() {
                        break;
                    }
                }
                Err(e) => out(json!({ "type": "error", "message": format!("A line from the host was not JSON: {e}") })),
            }
        }
        // stdin closed: the host is gone, so this process goes too.
        let _ = tx.send(json!({ "type": "stop" }));
    });
    let start = match rx.recv() {
        Ok(v) if s(&v, "type") == "start" => v,
        _ => {
            out(json!({ "type": "error", "message": "The first message must be start." }));
            return;
        }
    };
    let plan = match plan(&start) {
        Ok(p) => p,
        Err(e) => {
            out(json!({ "type": "error", "fatal": true, "message": e }));
            return;
        }
    };
    let model = match build_model(&start, plan.wire) {
        Ok(m) => m,
        Err(e) => {
            out(json!({ "type": "error", "fatal": true, "message": e }));
            return;
        }
    };
    let mut system = s(&start, "system").to_string();
    let handoff = s(&start, "handoff");
    if !handoff.is_empty() {
        system.push_str("\n\n## Handoff from your previous instance\nYou are continuing the same job; its context was full. Its running notes and recent findings:\n");
        system.push_str(handoff);
    }
    out(json!({ "type": "ready", "pid": std::process::id() }));
    Worker { plan, model, system, turns: Vec::new(), pending: Vec::new(), oldest: None, state: String::new(), auth_id: 0, backoff_until: None, failures: 0 }.serve(&rx);
}

struct Worker {
    plan: Plan,
    model: Model,
    system: String,
    turns: Vec<(bool, String)>,
    pending: Vec<Value>,
    oldest: Option<Instant>,
    state: String,
    auth_id: u64,
    backoff_until: Option<Instant>,
    failures: u32,
}

enum Flow {
    Go,
    Stop,
}

impl Worker {
    fn take(&mut self, message: Value) -> Flow {
        match s(&message, "type") {
            "event" => {
                if self.pending.is_empty() {
                    self.oldest = Some(Instant::now());
                }
                self.pending.push(message.get("event").cloned().unwrap_or(Value::Null));
                if self.pending.len() > MAX_PENDING {
                    let drop = self.pending.len() - MAX_PENDING;
                    self.pending.drain(..drop);
                    self.pending.insert(0, json!({ "kind": "note", "text": format!("{drop} earlier events were dropped while the model could not be reached.") }));
                }
                Flow::Go
            }
            "stop" => Flow::Stop,
            _ => Flow::Go,
        }
    }

    fn serve(mut self, rx: &Receiver<Value>) {
        loop {
            let mut force = false;
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(message) => {
                    if s(&message, "type") == "flush" {
                        force = true;
                    } else if let Flow::Stop = self.take(message) {
                        return;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if self.backoff_until.map_or(false, |t| Instant::now() < t) {
                continue;
            }
            if due(self.plan.role, &self.pending, self.oldest, force) {
                match self.review(rx) {
                    Ok(Flow::Stop) => return,
                    Ok(Flow::Go) => {}
                    Err(()) => {}
                }
            }
        }
    }

    /// Asks the host for fresh auth headers; other messages that arrive meanwhile are kept, not lost.
    fn auth(&mut self, rx: &Receiver<Value>, force: bool) -> Result<Vec<(String, String)>, String> {
        self.auth_id += 1;
        let id = self.auth_id;
        out(json!({ "type": "needAuth", "id": id, "force": force }));
        let deadline = Instant::now() + AUTH_WAIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("The host did not supply credentials in time.".into());
            }
            match rx.recv_timeout(left) {
                Ok(m) if s(&m, "type") == "auth" && m.get("id").and_then(Value::as_u64) == Some(id) => {
                    if let Some(e) = m.get("error").and_then(Value::as_str) {
                        return Err(e.to_string());
                    }
                    return Ok(m
                        .get("headers")
                        .and_then(Value::as_object)
                        .map(|h| h.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
                        .unwrap_or_default());
                }
                Ok(m) => {
                    if let Flow::Stop = self.take(m) {
                        return Err("stop".into());
                    }
                }
                Err(_) => return Err("The host did not supply credentials in time.".into()),
            }
        }
    }

    fn call(&mut self, rx: &Receiver<Value>, turns: &[(bool, String)]) -> Result<(String, Option<u64>), String> {
        let (url, body) = request_body(self.model.wire, &self.model.base, &self.model.model, self.model.max_tokens, &self.system, turns);
        let mut force = false;
        for attempt in 0..2 {
            let auth = self.auth(rx, force)?;
            let mut request = self.model.client.post(&url).header("Content-Type", "application/json");
            if self.model.wire == Wire::Anthropic {
                request = request.header("anthropic-version", "2023-06-01");
            }
            for (k, v) in auth.iter().chain(self.model.headers.iter()) {
                request = request.header(k.as_str(), v.as_str());
            }
            let response = request.body(body.to_string()).send().map_err(|e| describe_send_error(&url, &e))?;
            let status = response.status().as_u16();
            let text = response.text().unwrap_or_default();
            if status == 401 && attempt == 0 {
                // Once: the host's strategy refreshes a token it can refresh, and a key that is wrong stays wrong.
                force = true;
                continue;
            }
            if !(200..300).contains(&status) {
                return Err(format!("{url} answered HTTP {status}: {}", shorten(&text, 400)));
            }
            let body: Value = serde_json::from_str(&text).map_err(|_| format!("{url} did not answer with JSON: {}", shorten(&text, 200)))?;
            return Ok(read_reply(self.model.wire, &body));
        }
        Err(format!("{url} refused the credentials twice (HTTP 401)."))
    }

    fn review(&mut self, rx: &Receiver<Value>) -> Result<Flow, ()> {
        let events: Vec<Value> = std::mem::take(&mut self.pending);
        self.oldest = None;
        let prompt = format!(
            "New events from the main agent ({} of them), one JSON object per line:\n{}\n\nAnswer with the JSON object described in your instructions, and nothing else.",
            events.len(),
            batch_text(&events)
        );
        let mut turns = self.turns.clone();
        turns.push((true, prompt.clone()));
        match self.call(rx, &turns) {
            Ok((reply, reported)) => {
                self.failures = 0;
                self.backoff_until = None;
                let parsed = json_in(&reply);
                if let Some(state) = parsed.as_ref().and_then(|p| p.get("state")).and_then(Value::as_str) {
                    if !state.trim().is_empty() {
                        self.state = shorten(state.trim(), 2_000);
                    }
                }
                out(json!({ "type": "result", "events": events.len(), "reply": parsed.clone().unwrap_or(Value::Null), "raw": if parsed.is_none() { shorten(&reply, 2_000) } else { String::new() } }));
                self.turns.push((true, prompt));
                self.turns.push((false, reply));
                let tokens = reported.unwrap_or_else(|| estimate(&self.system, &self.turns));
                out(json!({ "type": "usage", "tokens": tokens, "window": self.plan.window, "estimated": reported.is_none() }));
                if tokens as f64 >= HANDOFF_AT * self.plan.window as f64 {
                    // The rest of what is pending goes to the next process, through the host.
                    let rest: Vec<Value> = std::mem::take(&mut self.pending);
                    out(json!({ "type": "handoff", "state": self.state, "tokens": tokens, "pending": rest }));
                    return Ok(Flow::Stop);
                }
                Ok(Flow::Go)
            }
            Err(e) if e == "stop" => Ok(Flow::Stop),
            Err(e) => {
                // Kept for the next try, in front of anything that arrived meanwhile.
                let mut back = events;
                back.append(&mut self.pending);
                self.pending = back;
                self.oldest = Some(Instant::now());
                self.failures += 1;
                let wait = (15u64 << self.failures.min(5)).min(600);
                self.backoff_until = Some(Instant::now() + Duration::from_secs(wait));
                out(json!({ "type": "error", "message": e, "retryInSeconds": wait }));
                Err(())
            }
        }
    }
}

/// A sentence naming what failed, not reqwest's chain of causes.
pub(crate) fn describe_send_error(url: &str, e: &reqwest::Error) -> String {
    let mut reason = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(inner) = source {
        reason = inner.to_string();
        source = inner.source();
    }
    let hint = if e.is_timeout() {
        " - it did not answer in time"
    } else if reason.contains("certificate") || reason.contains("UnknownIssuer") {
        " - the server's certificate is not trusted; add its root in Settings → Network, as for the chat"
    } else if e.is_connect() {
        " - the connection could not be made"
    } else {
        ""
    };
    format!("Could not reach {url}{hint}: {reason}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_start_is_checked_before_anything_connects() {
        let ok = json!({ "role": "guard", "window": 100000, "model": { "wire": "anthropic", "baseUrl": "https://gw.example/v1", "model": "m" } });
        let p = plan(&ok).unwrap();
        assert_eq!(p.role, Role::Guard);
        assert_eq!(p.wire, Wire::Anthropic);
        assert_eq!(p.window, 100000);
        assert!(plan(&json!({ "role": "x", "model": {} })).is_err());
        assert!(plan(&json!({ "role": "auditor", "model": { "wire": "vscode-lm", "baseUrl": "https://a", "model": "m" } })).unwrap_err().contains("OpenAI, Anthropic or Gemini"));
        assert!(plan(&json!({ "role": "auditor", "model": { "wire": "openai", "baseUrl": "file:///x", "model": "m" } })).is_err());
        assert!(plan(&json!({ "role": "auditor", "model": { "wire": "openai", "baseUrl": "https://a", "model": "" } })).is_err());
    }

    #[test]
    fn each_wire_format_gets_its_own_shape() {
        let turns = vec![(true, "events".to_string()), (false, "{}".to_string()), (true, "more".to_string())];
        let (url, body) = request_body(Wire::OpenAi, "https://g/v1", "gpt", 900, "sys", &turns);
        assert_eq!(url, "https://g/v1/chat/completions");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][2]["role"], "assistant");
        assert_eq!(body["stream"], false);
        let (url, body) = request_body(Wire::Anthropic, "https://g/v1", "claude", 900, "sys", &turns);
        assert_eq!(url, "https://g/v1/messages");
        assert_eq!(body["system"], "sys");
        assert_eq!(body["messages"].as_array().unwrap().len(), 3);
        assert_eq!(body["max_tokens"], 900);
        let (url, body) = request_body(Wire::Gemini, "https://g/v1beta", "gemini 2", 900, "sys", &turns);
        assert_eq!(url, "https://g/v1beta/models/gemini%202:generateContent");
        assert_eq!(body["contents"][1]["role"], "model");
    }

    #[test]
    fn replies_are_read_per_wire_format() {
        let (t, n) = read_reply(Wire::OpenAi, &json!({ "choices": [{ "message": { "content": "hi" } }], "usage": { "prompt_tokens": 12 } }));
        assert_eq!((t.as_str(), n), ("hi", Some(12)));
        let (t, n) = read_reply(Wire::Anthropic, &json!({ "content": [{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }], "usage": { "input_tokens": 5, "cache_read_input_tokens": 7 } }));
        assert_eq!((t.as_str(), n), ("ab", Some(12)));
        let (t, n) = read_reply(Wire::Gemini, &json!({ "candidates": [{ "content": { "parts": [{ "text": "g" }] } }], "usageMetadata": { "promptTokenCount": 3 } }));
        assert_eq!((t.as_str(), n), ("g", Some(3)));
    }

    #[test]
    fn the_json_in_a_reply_is_found_past_prose_and_thinking() {
        assert_eq!(json_in("<think>{not this}</think>Sure: {\"verdict\":\"ok\",\"state\":\"a } b\"} done").unwrap()["state"], "a } b");
        assert_eq!(json_in("```json\n{\"a\":{\"b\":1}}\n```").unwrap()["a"]["b"], 1);
        assert!(json_in("no json here").is_none());
        assert_eq!(json_in("{broken {\"ok\":true}").unwrap()["ok"], true);
    }

    #[test]
    fn the_guard_reviews_at_step_boundaries_and_the_auditor_in_batches() {
        let call = vec![json!({ "kind": "toolCall" })];
        let result = vec![json!({ "kind": "toolCall" }), json!({ "kind": "toolResult" })];
        assert!(!due(Role::Guard, &call, Some(Instant::now()), false));
        assert!(due(Role::Guard, &result, Some(Instant::now()), false));
        assert!(!due(Role::Auditor, &result, Some(Instant::now()), false));
        assert!(due(Role::Auditor, &[json!({ "kind": "turnEnd" })], Some(Instant::now()), false));
        assert!(due(Role::Auditor, &vec![json!({ "kind": "x" }); 12], Some(Instant::now()), false));
        assert!(due(Role::Auditor, &call, Some(Instant::now()), true));
        assert!(!due(Role::Auditor, &[], None, true));
    }

    #[test]
    fn an_oversized_batch_keeps_the_newest_events_whole() {
        let mut events: Vec<Value> = (0..200).map(|i| json!({ "kind": "toolResult", "i": i, "text": "x".repeat(400) })).collect();
        events.push(json!({ "kind": "assistant", "text": "THE NEWEST" }));
        let text = batch_text(&events);
        assert!(text.len() <= MAX_BATCH_CHARS + 2_000);
        assert!(text.contains("THE NEWEST"));
        assert!(text.starts_with('['));
    }
}
