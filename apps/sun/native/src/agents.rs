//! One codebase's agent asking another's (`packages/core/src/agents/codebaseAgents.ts`).
//!
//! Asked for: "agent from one code base can talk to another agent that's in another code base to get help or do
//! certain things". Each chat's host already has a private line to Fire Code (its stdin and `light-code-monitor:`
//! stdout lines), so nothing new listens anywhere: an ask arrives on that line, Fire Code opens a new tab on the
//! other codebase - without taking the screen - and hands it the request on the new host's line; the tab's answer
//! comes back the same way and goes to the asker.
//!
//! The tab is visible on purpose: the other agent may change its codebase, and asks for its approvals there.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use wry::WebView;

use crate::{send, state, App};

/// How many asks deep a chain may go: an agent working for another may ask a third, not without end.
const MAX_DEPTH: u64 = 3;

#[derive(Default)]
pub struct Agents {
    /// Asks being worked on, by task id.
    tasks: HashMap<String, Task>,
    /// Requests for tabs whose host is not up yet (the startup script may hold it), by chat key.
    queued: HashMap<String, Vec<Value>>,
    next: u64,
    /// Tabs whose answer went back, to archive once they have finished saving (`archive_answered_agent_tabs`).
    answered: Vec<(String, Instant)>,
}

/// Long enough for the tab's agent to finish saving its chat after it answered.
const ARCHIVE_AFTER: Duration = Duration::from_secs(3);
/// A tab you were looking at when it answered is archived once you leave it - but not after this long.
const ARCHIVE_GIVE_UP: Duration = Duration::from_secs(24 * 3600);

struct Task {
    asker: String,
    asker_generation: u64,
    /// The asker's own id for the ask, echoed back so its tool call resolves.
    request: Value,
    /// The tab working on it.
    target: String,
    title: String,
    target_name: String,
}

impl App {
    /// An agent line from a chat's host; false when it is not one (monitoring's, then).
    pub fn agent_line(&mut self, from: &str, generation: u64, payload: &Value, webview: &WebView) -> bool {
        match payload.get("type").and_then(Value::as_str) {
            Some("agentAsk") => {
                self.agent_ask(from, generation, payload, webview);
                true
            }
            Some("agentDone") => {
                self.agent_done(from, payload, webview);
                true
            }
            _ => false,
        }
    }

    fn agent_ask(&mut self, from: &str, generation: u64, payload: &Value, webview: &WebView) {
        let request = payload.get("id").cloned().unwrap_or(Value::Null);
        let wanted = payload.get("codebase").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
        let message = payload.get("message").and_then(Value::as_str).unwrap_or("").to_string();
        let depth = payload.get("depth").and_then(Value::as_u64).unwrap_or(1);
        let names = state::mention_names(&self.state.projects);
        let asker_project = state::project_of(from).to_string();
        let asker_name = names.iter().find(|(id, _)| *id == asker_project).map(|(_, n)| n.clone()).unwrap_or_else(|| "another codebase".into());
        let others: Vec<&(String, String)> = names.iter().filter(|(id, _)| *id != asker_project).collect();

        let refuse = |app: &App, text: String| app.agent_reply(from, generation, &request, false, &text, None);
        if message.trim().is_empty() {
            return refuse(self, "The request was empty.".into());
        }
        if depth > MAX_DEPTH {
            return refuse(self, format!("Requests between agents stop {MAX_DEPTH} levels deep."));
        }
        let Some((target_project, target_name)) = others.iter().find(|(_, n)| n.to_lowercase() == wanted).map(|(id, n)| (id.clone(), n.clone())) else {
            let listed = others.iter().map(|(_, n)| format!("\"{n}\"")).collect::<Vec<_>>().join(", ");
            return refuse(self, format!("No other codebase called \"{wanted}\". The others are: {}.", if listed.is_empty() { "none".to_string() } else { listed }));
        };

        let first_line = message.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        let mut short: String = first_line.chars().take(36).collect();
        if first_line.chars().count() > 36 {
            short.push('…');
        }
        let title = format!("From {asker_name}: {short}");
        let Some(key) = self.new_chat_with(&target_project, None, Some(title.clone()), false, webview) else {
            return refuse(self, format!("A chat could not be opened on \"{target_name}\"."));
        };

        self.agents.next += 1;
        let id = format!("t{}", self.agents.next);
        let task = json!({ "type": "agentTask", "id": id, "from": asker_name, "message": message, "depth": depth });
        let sent = self.runtime.get(&key).and_then(|rt| rt.process.as_ref()).map(|p| p.send_line(&task)).unwrap_or(false);
        if !sent {
            self.agents.queued.entry(key.clone()).or_default().push(task);
        }
        self.agents.tasks.insert(
            id,
            Task { asker: from.to_string(), asker_generation: generation, request, target: key, title: title.clone(), target_name: target_name.clone() },
        );
        send(
            webview,
            json!({ "type": "notice", "level": "info", "text": format!("The agent in {asker_name} asked the agent in {target_name} - it is working in the new tab \"{title}\".") }),
        );
    }

    fn agent_done(&mut self, from: &str, payload: &Value, webview: &WebView) {
        let Some(id) = payload.get("id").and_then(Value::as_str) else { return };
        // Only the tab the task was given to may answer it.
        if self.agents.tasks.get(id).map(|t| t.target.as_str()) != Some(from) {
            return;
        }
        let Some(task) = self.agents.tasks.remove(id) else { return };
        let ok = payload.get("ok") == Some(&Value::Bool(true));
        let waiting = payload.get("waiting") == Some(&Value::Bool(true));
        let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
        self.agent_reply(&task.asker, task.asker_generation, &task.request, ok, text, Some(&task.title));
        /*
         * Archived silently once answered (asked for), so request tabs do not pile up - it stays in History. Not when
         * it stopped to ask you something (the work goes on there) or failed (you will want to see why).
         */
        if ok && !waiting {
            self.agents.answered.push((task.target.clone(), Instant::now()));
        }
        send(webview, json!({ "type": "notice", "level": "info", "text": format!("The agent in {} answered (\"{}\").", task.target_name, task.title) }));
    }

    fn agent_reply(&self, asker: &str, generation: u64, request: &Value, ok: bool, text: &str, chat: Option<&str>) {
        let Some(rt) = self.runtime.get(asker) else { return };
        if rt.generation != generation {
            return;
        }
        if let Some(process) = &rt.process {
            let mut reply = json!({ "type": "agentReply", "id": request, "ok": ok, "text": text });
            if let Some(chat) = chat {
                reply["chat"] = json!(chat);
            }
            process.send_line(&reply);
        }
    }

    /// Archives the tabs that answered, once saved - not one you are looking at, nor one you have since carried on in.
    pub fn archive_answered_agent_tabs(&mut self, webview: &WebView) {
        if self.agents.answered.is_empty() {
            return;
        }
        let now = Instant::now();
        let mut due: Vec<String> = Vec::new();
        let mut keep: Vec<(String, Instant)> = Vec::new();
        for (key, at) in std::mem::take(&mut self.agents.answered) {
            if now.duration_since(at) < ARCHIVE_AFTER {
                keep.push((key, at));
                continue;
            }
            if now.duration_since(at) > ARCHIVE_GIVE_UP {
                continue;
            }
            // Gone already (closed by hand), or you carried on talking to it: left as it is.
            let Some(rt) = self.runtime.get(&key) else { continue };
            if rt.agent != "idle" {
                continue;
            }
            if self.active.as_deref() == Some(key.as_str()) {
                keep.push((key, at));
                continue;
            }
            due.push(key);
        }
        self.agents.answered = keep;
        for key in due {
            self.close_chat(&key, true, webview);
        }
    }

    /// The tab's host is up: what it was asked before it was is sent now.
    pub fn flush_agent_tasks(&mut self, key: &str) {
        let Some(lines) = self.agents.queued.remove(key) else { return };
        let Some(process) = self.runtime.get(key).and_then(|rt| rt.process.as_ref()) else {
            self.agents.queued.insert(key.to_string(), lines);
            return;
        };
        for line in &lines {
            process.send_line(line);
        }
    }

    /// A host stopped: a task it was working on gets an answer saying so; asks it was waiting on are dropped.
    pub fn agent_host_exited(&mut self, key: &str, _webview: &WebView) {
        self.agents.queued.remove(key);
        let ended: Vec<String> = self.agents.tasks.iter().filter(|(_, t)| t.target == key).map(|(id, _)| id.clone()).collect();
        for id in ended {
            if let Some(task) = self.agents.tasks.remove(&id) {
                let text = format!("The agent in {} stopped before it answered (its tab \"{}\" was closed or its agent stopped).", task.target_name, task.title);
                self.agent_reply(&task.asker, task.asker_generation, &task.request, false, &text, Some(&task.title));
            }
        }
        self.agents.tasks.retain(|_, t| t.asker != key);
    }
}
