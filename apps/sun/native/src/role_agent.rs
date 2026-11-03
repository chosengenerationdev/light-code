//! `fire-fs agent`: one specialist of the agent team (tester, programmer, reviewer...) as its own process,
//! with its own context kept between consultations.
//!
//! Asked for: "each agent should have its own rust process and its own context, when context limit is hit
//! within that process, it should automatically handoff the key points from current session and start a new
//! session by itself. main agent's context should not include these subagents contexts."
//!
//! - **Its own context.** The conversation lives here, across every question the main agent asks this role in
//!   a chat; the main agent receives only the answer.
//! - **Tools stay Light Code's.** The model's tool calls are sent to the host (`needTool`), which runs each one
//!   through the same rules as before - reads free, anything else through the user's approval - and returns
//!   the result. This process runs nothing itself.
//! - **The handoff, by itself.** After an answer, past 70% of the window, it asks its own model for the key
//!   points while there is still room to ask, then starts a fresh conversation seeded with them. If that call
//!   fails, the last answers stand in. Nothing is asked at the limit, where it could not be answered.
//! - Model calls as in `observer.rs` (invariant 2's recorded exception): auth asked of the host per call, TLS
//!   material from the host's resolver, the profile's own URL, no proxy.
//!
//! In: `start` (role, model, system, window, tools in the wire's own shape), `ask` {id, prompt, maxSteps,
//! tools}, `toolResult` {callId, content}, `auth`, `cancel` {id}, `stop`. Out: `ready`, `needAuth`, `needTool`
//! {id, callId, name, arguments}, `step`, `answer` {id, text, steps, truncated}, `usage`, `handoff` {notes},
//! `error` {id?, message, fatal?}.

use crate::observer::{build_model, describe_send_error, out, s, shorten, wire_of, Model, Wire};
use serde_json::{json, Value};
use std::io::BufRead;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

const HANDOFF_AT: f64 = 0.7;
const WAIT: Duration = Duration::from_secs(600);

/// One model reply, read into what the loop needs.
#[derive(Debug, Default)]
pub(crate) struct Reply {
    pub text: String,
    /// (call id, tool name, arguments as JSON text)
    pub calls: Vec<(String, String, String)>,
    /// The reply as the wire wants it back in the conversation.
    pub message: Value,
    pub prompt_tokens: Option<u64>,
}

pub(crate) fn user_message(wire: Wire, text: &str) -> Value {
    match wire {
        Wire::Gemini => json!({ "role": "user", "parts": [{ "text": text }] }),
        _ => json!({ "role": "user", "content": text }),
    }
}

/// The request for the conversation so far. `choose_none` keeps the tools defined but forbids calling them:
/// a conversation that already holds tool calls must still declare the tools on Anthropic.
pub(crate) fn agent_body(wire: Wire, base: &str, model: &str, max_tokens: u64, system: &str, conv: &[Value], tools: &Value, choose_none: bool) -> (String, Value) {
    let has_tools = tools.as_array().map_or(false, |a| !a.is_empty());
    match wire {
        Wire::OpenAi => {
            let mut messages = vec![json!({ "role": "system", "content": system })];
            messages.extend(conv.iter().cloned());
            let mut body = json!({ "model": model, "messages": messages, "max_tokens": max_tokens, "stream": false });
            if has_tools {
                body["tools"] = tools.clone();
                body["tool_choice"] = json!(if choose_none { "none" } else { "auto" });
            }
            (format!("{base}/chat/completions"), body)
        }
        Wire::Anthropic => {
            let mut body = json!({ "model": model, "system": system, "messages": conv, "max_tokens": max_tokens });
            if has_tools {
                body["tools"] = tools.clone();
                body["tool_choice"] = json!({ "type": if choose_none { "none" } else { "auto" } });
            }
            (format!("{base}/messages"), body)
        }
        Wire::Gemini => {
            let model_path: String = model.chars().map(|c| if c.is_ascii_alphanumeric() || "-._".contains(c) { c.to_string() } else { format!("%{:02X}", c as u32) }).collect();
            let mut body = json!({ "systemInstruction": { "parts": [{ "text": system }] }, "contents": conv, "generationConfig": { "maxOutputTokens": max_tokens } });
            if has_tools {
                body["tools"] = tools.clone();
                body["toolConfig"] = json!({ "functionCallingConfig": { "mode": if choose_none { "NONE" } else { "AUTO" } } });
            }
            (format!("{base}/models/{model_path}:generateContent"), body)
        }
    }
}

pub(crate) fn read_agent_reply(wire: Wire, body: &Value, call_seq: &mut u64) -> Reply {
    match wire {
        Wire::OpenAi => {
            let message = &body["choices"][0]["message"];
            let text = message["content"].as_str().unwrap_or("").to_string();
            let calls: Vec<(String, String, String)> = message["tool_calls"]
                .as_array()
                .map(|calls| {
                    calls
                        .iter()
                        .map(|c| (s(c, "id").to_string(), s(&c["function"], "name").to_string(), c["function"]["arguments"].as_str().unwrap_or("{}").to_string()))
                        .collect()
                })
                .unwrap_or_default();
            // Rebuilt rather than echoed: some gateways refuse fields of their own (reasoning_content) sent back.
            let mut back = json!({ "role": "assistant", "content": if text.is_empty() && !calls.is_empty() { Value::Null } else { json!(text) } });
            if !calls.is_empty() {
                back["tool_calls"] = json!(calls.iter().map(|(id, name, args)| json!({ "id": id, "type": "function", "function": { "name": name, "arguments": args } })).collect::<Vec<_>>());
            }
            Reply { text, calls, message: back, prompt_tokens: body["usage"]["prompt_tokens"].as_u64() }
        }
        Wire::Anthropic => {
            let blocks: Vec<Value> = body["content"].as_array().cloned().unwrap_or_default().into_iter().filter(|b| matches!(s(b, "type"), "text" | "tool_use")).collect();
            let text = blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("");
            let calls = blocks.iter().filter(|b| s(b, "type") == "tool_use").map(|b| (s(b, "id").to_string(), s(b, "name").to_string(), b["input"].to_string())).collect();
            let usage = &body["usage"];
            let prompt = usage["input_tokens"].as_u64().map(|n| n + usage["cache_read_input_tokens"].as_u64().unwrap_or(0) + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0));
            Reply { text, calls, message: json!({ "role": "assistant", "content": blocks }), prompt_tokens: prompt }
        }
        Wire::Gemini => {
            let parts: Vec<Value> = body["candidates"][0]["content"]["parts"].as_array().cloned().unwrap_or_default();
            let text = parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("");
            // Gemini gives calls no id; one is made up here and mapped back by order (see `tool_results`).
            let calls = parts
                .iter()
                .filter_map(|p| p.get("functionCall"))
                .map(|c| {
                    *call_seq += 1;
                    (format!("g{call_seq}"), s(c, "name").to_string(), c["args"].to_string())
                })
                .collect();
            Reply { text, calls, message: json!({ "role": "model", "parts": parts }), prompt_tokens: body["usageMetadata"]["promptTokenCount"].as_u64() }
        }
    }
}

/// The results of one reply's calls, as the wire wants them, with `extra` (a closing instruction) added.
pub(crate) fn tool_results(wire: Wire, results: &[(String, String, String)], extra: Option<&str>) -> Vec<Value> {
    match wire {
        Wire::OpenAi => {
            let mut out: Vec<Value> = results.iter().map(|(id, _, content)| json!({ "role": "tool", "tool_call_id": id, "content": content })).collect();
            if let Some(text) = extra {
                out.push(json!({ "role": "user", "content": text }));
            }
            out
        }
        Wire::Anthropic => {
            let mut blocks: Vec<Value> = results.iter().map(|(id, _, content)| json!({ "type": "tool_result", "tool_use_id": id, "content": content })).collect();
            if let Some(text) = extra {
                blocks.push(json!({ "type": "text", "text": text }));
            }
            vec![json!({ "role": "user", "content": blocks })]
        }
        Wire::Gemini => {
            let mut parts: Vec<Value> = results.iter().map(|(_, name, content)| json!({ "functionResponse": { "name": name, "response": { "content": content } } })).collect();
            if let Some(text) = extra {
                parts.push(json!({ "text": text }));
            }
            vec![json!({ "role": "user", "parts": parts })]
        }
    }
}

fn estimate(system: &str, conv: &[Value]) -> u64 {
    ((system.len() + conv.iter().map(|m| m.to_string().len()).sum::<usize>()) / 4) as u64
}

struct Session {
    model: Model,
    system: String,
    base_system: String,
    window: u64,
    tools: Value,
    conv: Vec<Value>,
    answers: Vec<String>,
    call_seq: u64,
    auth_id: u64,
    handoffs: u32,
}

enum Waited {
    Got(Value),
    Cancelled,
    Stop,
    Timeout,
}

impl Session {
    /// Waits for one reply from the host; a `cancel` for `ask` or a `stop` ends the wait.
    fn wait(&self, rx: &Receiver<Value>, ask: u64, matches: &dyn Fn(&Value) -> bool) -> Waited {
        let deadline = Instant::now() + WAIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Waited::Timeout;
            }
            match rx.recv_timeout(left) {
                Ok(m) if s(&m, "type") == "stop" => return Waited::Stop,
                Ok(m) if s(&m, "type") == "cancel" && m["id"].as_u64() == Some(ask) => return Waited::Cancelled,
                Ok(m) if matches(&m) => return Waited::Got(m),
                // Anything else mid-question (a second ask) is a host mistake: the host queues asks per role.
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => return Waited::Timeout,
                Err(RecvTimeoutError::Disconnected) => return Waited::Stop,
            }
        }
    }

    fn headers(&mut self, rx: &Receiver<Value>, ask: u64, force: bool) -> Result<Vec<(String, String)>, String> {
        self.auth_id += 1;
        let id = self.auth_id;
        out(json!({ "type": "needAuth", "id": id, "force": force }));
        match self.wait(rx, ask, &|m| s(m, "type") == "auth" && m["id"].as_u64() == Some(id)) {
            Waited::Got(m) => {
                if let Some(e) = m.get("error").and_then(Value::as_str) {
                    return Err(e.to_string());
                }
                Ok(m["headers"].as_object().map(|h| h.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect()).unwrap_or_default())
            }
            Waited::Cancelled => Err("cancelled".into()),
            Waited::Stop => Err("stop".into()),
            Waited::Timeout => Err("The host did not supply credentials in time.".into()),
        }
    }

    fn call(&mut self, rx: &Receiver<Value>, ask: u64, conv: &[Value], choose_none: bool) -> Result<Reply, String> {
        let (url, body) = agent_body(self.model.wire, &self.model.base, &self.model.model, self.model.max_tokens, &self.system, conv, &self.tools, choose_none);
        let mut force = false;
        for attempt in 0..2 {
            let auth = self.headers(rx, ask, force)?;
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
                force = true;
                continue;
            }
            if !(200..300).contains(&status) {
                return Err(format!("{url} answered HTTP {status}: {}", shorten(&text, 400)));
            }
            let parsed: Value = serde_json::from_str(&text).map_err(|_| format!("{url} did not answer with JSON: {}", shorten(&text, 200)))?;
            return Ok(read_agent_reply(self.model.wire, &parsed, &mut self.call_seq));
        }
        Err(format!("{url} refused the credentials twice (HTTP 401)."))
    }

    /// One question, answered with as many tool calls as `max_steps` allows. The conversation is kept.
    fn ask(&mut self, rx: &Receiver<Value>, ask: &Value) -> Result<Value, String> {
        let id = ask["id"].as_u64().unwrap_or(0);
        let max_steps = ask["maxSteps"].as_u64().unwrap_or(5).min(40);
        let tools_allowed = ask["tools"].as_bool().unwrap_or(true) && self.tools.as_array().map_or(false, |a| !a.is_empty());
        let mut conv = self.conv.clone();
        conv.push(user_message(self.model.wire, s(ask, "prompt")));
        let mut steps = 0u64;
        let mut tokens = None;
        loop {
            let at_cap = steps >= max_steps || !tools_allowed;
            let reply = self.call(rx, id, &conv, at_cap)?;
            tokens = reply.prompt_tokens.or(tokens);
            conv.push(reply.message.clone());
            if reply.calls.is_empty() || at_cap {
                // Kept only once answered: a cancelled or failed question leaves the context as it was.
                self.conv = conv;
                self.answers.push(shorten(&reply.text, 1_500));
                if self.answers.len() > 6 {
                    self.answers.remove(0);
                }
                let used = tokens.unwrap_or_else(|| estimate(&self.system, &self.conv));
                out(json!({ "type": "usage", "tokens": used, "window": self.window, "estimated": tokens.is_none() }));
                return Ok(json!({ "type": "answer", "id": id, "text": reply.text, "steps": steps, "truncated": at_cap && steps > 0 && tools_allowed, "tokens": used }));
            }
            let mut results = Vec::new();
            for (call_id, name, arguments) in &reply.calls {
                out(json!({ "type": "needTool", "id": id, "callId": call_id, "name": name, "arguments": arguments }));
                let wanted = call_id.clone();
                let content = match self.wait(rx, id, &|m| s(m, "type") == "toolResult" && s(m, "callId") == wanted) {
                    Waited::Got(m) => s(&m, "content").to_string(),
                    Waited::Cancelled => return Err("cancelled".into()),
                    Waited::Stop => return Err("stop".into()),
                    Waited::Timeout => "The tool did not finish in time.".to_string(),
                };
                results.push((call_id.clone(), name.clone(), content));
                steps += 1;
                out(json!({ "type": "step", "id": id, "name": name }));
            }
            let closing = if steps >= max_steps { Some("That is all the looking up you can do. Answer now with what you have, and say plainly what you could not check.") } else { None };
            conv.extend(tool_results(self.model.wire, &results, closing));
        }
    }

    /// Past the threshold: the key points from its own model while there is room, then a fresh conversation.
    fn maybe_handoff(&mut self, rx: &Receiver<Value>, tokens: u64) {
        if (tokens as f64) < HANDOFF_AT * self.window as f64 {
            return;
        }
        let mut conv = self.conv.clone();
        conv.push(user_message(
            self.model.wire,
            "Your context is nearly full and a fresh session will take over as you. Write the key points it needs to continue your work: the task and what the user wants, decisions made, what you found and changed, what is still open. At most 300 words, plain text, no tool calls.",
        ));
        let notes = match self.call(rx, 0, &conv, true) {
            Ok(reply) if !reply.text.trim().is_empty() => shorten(reply.text.trim(), 3_000),
            // The summary could not be had: the last answers are the record instead.
            _ => format!("Your recent answers, newest last:\n{}", self.answers.iter().map(|a| format!("- {a}")).collect::<Vec<_>>().join("\n")),
        };
        self.handoffs += 1;
        self.conv.clear();
        self.system = format!("{}\n\n## Handoff from your previous session\nYour context filled and this session took over. Key points:\n{notes}", self.base_system);
        out(json!({ "type": "handoff", "notes": notes, "tokens": tokens, "handoffs": self.handoffs }));
    }
}

pub fn run() {
    let (tx, rx) = channel::<Value>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
        let _ = tx.send(json!({ "type": "stop" }));
    });
    let start = match rx.recv() {
        Ok(v) if s(&v, "type") == "start" => v,
        _ => {
            out(json!({ "type": "error", "fatal": true, "message": "The first message must be start." }));
            return;
        }
    };
    let model_spec = start.get("model").cloned().unwrap_or(Value::Null);
    let wire = match wire_of(&model_spec) {
        Ok(w) => w,
        Err(e) => {
            out(json!({ "type": "error", "fatal": true, "message": e }));
            return;
        }
    };
    let model = match build_model(&start, wire) {
        Ok(m) => m,
        Err(e) => {
            out(json!({ "type": "error", "fatal": true, "message": e }));
            return;
        }
    };
    let base_system = s(&start, "system").to_string();
    let handoff = s(&start, "handoff");
    let system = if handoff.is_empty() { base_system.clone() } else { format!("{base_system}\n\n## Handoff from your previous session\n{handoff}") };
    let mut session = Session {
        model,
        system,
        base_system,
        window: start["window"].as_u64().unwrap_or(32_000).max(4_000),
        tools: start.get("tools").cloned().unwrap_or(json!([])),
        conv: Vec::new(),
        answers: Vec::new(),
        call_seq: 0,
        auth_id: 0,
        handoffs: 0,
    };
    out(json!({ "type": "ready", "pid": std::process::id() }));
    loop {
        let message = match rx.recv() {
            Ok(m) => m,
            Err(_) => return,
        };
        match s(&message, "type") {
            "stop" => return,
            "ask" => {
                let id = message["id"].as_u64().unwrap_or(0);
                match session.ask(&rx, &message) {
                    Ok(answer) => {
                        let tokens = answer["tokens"].as_u64().unwrap_or(0);
                        out(answer);
                        session.maybe_handoff(&rx, tokens);
                    }
                    Err(e) if e == "stop" => return,
                    Err(e) if e == "cancelled" => out(json!({ "type": "error", "id": id, "message": "cancelled" })),
                    Err(e) => out(json!({ "type": "error", "id": id, "message": e })),
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_stay_declared_when_calling_them_is_forbidden() {
        let tools = json!([{ "name": "read_file" }]);
        let (_, body) = agent_body(Wire::Anthropic, "https://g", "m", 100, "sys", &[], &tools, true);
        assert_eq!(body["tool_choice"]["type"], "none");
        assert_eq!(body["tools"], tools);
        let (_, body) = agent_body(Wire::OpenAi, "https://g", "m", 100, "sys", &[], &tools, false);
        assert_eq!(body["tool_choice"], "auto");
        let (_, body) = agent_body(Wire::Gemini, "https://g", "m", 100, "sys", &[], &tools, true);
        assert_eq!(body["toolConfig"]["functionCallingConfig"]["mode"], "NONE");
        let (_, body) = agent_body(Wire::OpenAi, "https://g", "m", 100, "sys", &[], &json!([]), false);
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn tool_calls_are_read_and_answered_per_wire() {
        let mut seq = 0;
        let r = read_agent_reply(Wire::OpenAi, &json!({ "choices": [{ "message": { "content": null, "reasoning_content": "x", "tool_calls": [{ "id": "c1", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } }] } }] }), &mut seq);
        assert_eq!(r.calls, vec![("c1".to_string(), "read_file".to_string(), "{\"path\":\"a\"}".to_string())]);
        assert!(r.message.get("reasoning_content").is_none());
        assert_eq!(tool_results(Wire::OpenAi, &[("c1".into(), "read_file".into(), "text".into())], Some("answer now"))[1]["role"], "user");

        let r = read_agent_reply(Wire::Anthropic, &json!({ "content": [{ "type": "thinking", "thinking": "t" }, { "type": "text", "text": "Let me look." }, { "type": "tool_use", "id": "t1", "name": "read_file", "input": { "path": "a" } }], "usage": { "input_tokens": 9 } }), &mut seq);
        assert_eq!(r.text, "Let me look.");
        assert_eq!(r.calls[0].2, "{\"path\":\"a\"}");
        assert_eq!(r.message["content"].as_array().unwrap().len(), 2);
        let back = tool_results(Wire::Anthropic, &[("t1".into(), "read_file".into(), "text".into())], Some("now"));
        assert_eq!(back.len(), 1);
        assert_eq!(back[0]["content"][0]["tool_use_id"], "t1");
        assert_eq!(back[0]["content"][1]["text"], "now");

        let r = read_agent_reply(Wire::Gemini, &json!({ "candidates": [{ "content": { "parts": [{ "functionCall": { "name": "grep", "args": { "q": 1 } } }, { "functionCall": { "name": "ls", "args": {} } }] } }] }), &mut seq);
        assert_eq!(r.calls.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), vec!["g1", "g2"]);
        assert_eq!(tool_results(Wire::Gemini, &[("g1".into(), "grep".into(), "r".into())], None)[0]["parts"][0]["functionResponse"]["name"], "grep");
    }
}
