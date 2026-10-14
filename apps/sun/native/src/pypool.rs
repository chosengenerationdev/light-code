//! A pool of Python processes running one library function many times in parallel.
//!
//! Asked for because of the GIL: the quants' pricing libraries are Python modules backed by DLLs, and
//! threads inside one interpreter take turns. Processes do not - each worker here is its own interpreter
//! with its own GIL, imports the library once, and takes calls from a shared queue, so N workers price
//! N trades at the same moment whatever the library does with the GIL. Rust's part is the orchestration:
//! starting the workers, handing out calls as each one finishes (a slow call never holds up the rest),
//! enforcing a per-call timeout by killing and restarting a stuck worker, and returning every result in
//! the order asked.
//!
//! The environment is given by the caller and nothing else is inherited (`env_clear`): Light Code
//! computes the same minimal environment its Python tools get, which never holds a provider's API key.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const WORKER: &str = include_str!("pypool_worker.py");
const MAX_CALLS: usize = 200_000;
const MAX_WORKERS: usize = 64;

fn s<'a>(r: &'a Value, key: &str) -> Option<&'a str> {
    r.get(key).and_then(Value::as_str)
}

fn dotted(name: &str) -> bool {
    !name.is_empty() && name.split('.').all(|part| {
        let mut chars = part.chars();
        matches!(chars.next(), Some(c) if c.is_alphabetic() || c == '_') && chars.all(|c| c.is_alphanumeric() || c == '_')
    })
}

struct Spec {
    python: PathBuf,
    env: Vec<(String, String)>,
    setup: Value,
    cwd: Option<PathBuf>,
}

/// One live worker: its process, its stdin, and a channel of the lines it writes to its answer stream.
struct Worker {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<Option<String>>,
    stderr: Arc<Mutex<String>>,
}

impl Worker {
    fn start(spec: &Spec, ready_timeout: Duration) -> Result<(Worker, Value), String> {
        let mut command = Command::new(&spec.python);
        command
            .args(["-u", "-X", "utf8", "-c", WORKER])
            .env_clear()
            .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|e| format!("Could not start Python ({}): {e}", spec.python.display()))?;
        let mut stdin = child.stdin.take().ok_or("Python has no stdin")?;
        let stdout = child.stdout.take().ok_or("Python has no stdout")?;
        let stderr_pipe = child.stderr.take().ok_or("Python has no stderr")?;
        // stderr must always be drained, or a chatty library fills the pipe and the worker stops dead.
        let stderr = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr_pipe);
            let mut buffer = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                let mut tail = sink.lock().unwrap();
                tail.push_str(&String::from_utf8_lossy(&buffer[..n]));
                if tail.len() > 8000 {
                    let cut = tail.len() - 6000;
                    let cut = (cut..tail.len()).find(|i| tail.is_char_boundary(*i)).unwrap_or(cut);
                    tail.drain(..cut);
                }
            }
        });
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => {
                        if tx.send(Some(l)).is_err() {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(None);
        });
        writeln!(stdin, "{}", spec.setup).map_err(|e| format!("Could not talk to Python: {e}"))?;
        let mut worker = Worker { child, stdin, lines, stderr };
        let ready = worker.receive(ready_timeout).map_err(|e| format!("{e} while importing {}", spec.setup["module"].as_str().unwrap_or("?")))?;
        if ready.get("ready").and_then(Value::as_bool) != Some(true) {
            let error = ready.get("error").and_then(Value::as_str).unwrap_or("unknown error").to_string();
            worker.kill();
            return Err(format!("Importing {} failed:\n{error}", spec.setup["module"].as_str().unwrap_or("?")));
        }
        Ok((worker, ready))
    }

    fn receive(&mut self, timeout: Duration) -> Result<Value, String> {
        match self.lines.recv_timeout(timeout) {
            Ok(Some(line)) => serde_json::from_str(&line).map_err(|_| format!("Python answered something that was not JSON: {}", line.chars().take(200).collect::<String>())),
            Ok(None) | Err(RecvTimeoutError::Disconnected) => {
                let _ = self.child.wait();
                let tail = self.stderr.lock().map(|t| t.trim().to_string()).unwrap_or_default();
                Err(format!("Python exited{}", if tail.is_empty() { String::new() } else { format!(":\n{}", tail.chars().rev().take(1500).collect::<String>().chars().rev().collect::<String>()) }))
            }
            Err(RecvTimeoutError::Timeout) => Err("timed out".into()),
        }
    }

    fn ask(&mut self, request: &Value, timeout: Duration) -> Result<Value, String> {
        writeln!(self.stdin, "{request}").map_err(|e| format!("Could not talk to Python: {e}"))?;
        self.receive(timeout)
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.kill();
    }
}

fn spec(r: &Value, function: Option<&str>) -> Result<Spec, String> {
    let python = PathBuf::from(s(r, "python").ok_or("Which Python? No interpreter was given.")?);
    let module = s(r, "module").ok_or("Which module? Give `module`.")?;
    if !dotted(module) {
        return Err(format!("\"{module}\" is not a Python module name."));
    }
    if let Some(f) = function {
        if !dotted(f) {
            return Err(format!("\"{f}\" is not a function name (dotted names like Class.method are fine)."));
        }
    }
    let paths: Vec<String> = r.get("paths").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
    for p in &paths {
        if !std::path::Path::new(p).is_dir() {
            return Err(format!("{p} is not a folder."));
        }
    }
    let env = r
        .get("env")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
        .unwrap_or_default();
    Ok(Spec {
        python,
        env,
        setup: json!({ "paths": paths, "module": module, "function": function }),
        cwd: s(r, "cwd").map(PathBuf::from).filter(|p| p.is_dir()),
    })
}

/// Module members, or one function's signature and documentation.
fn inspect(r: &Value, describe: Option<&str>) -> Result<Value, String> {
    let import_timeout = Duration::from_secs(r.get("importTimeoutSec").and_then(Value::as_u64).unwrap_or(120));
    let (mut worker, ready) = Worker::start(&spec(r, None)?, import_timeout)?;
    let request = match describe {
        Some(name) => {
            if !dotted(name) {
                return Err(format!("\"{name}\" is not a name."));
            }
            json!({ "describe": name })
        }
        None => json!({ "list": s(r, "filter").unwrap_or("") }),
    };
    let mut answer = worker.ask(&request, import_timeout)?;
    if let Some(error) = answer.get("error").and_then(Value::as_str) {
        return Err(error.to_string());
    }
    if let Value::Object(map) = &mut answer {
        map.insert("ok".into(), json!(true));
        map.insert("importMs".into(), ready["importMs"].clone());
        map.insert("python".into(), ready["python"].clone());
    }
    Ok(answer)
}

fn call(r: &Value) -> Result<Value, String> {
    let started = Instant::now();
    let function = s(r, "function").ok_or("Which function? Give `function`.")?;
    let calls: Vec<Value> = r.get("calls").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![json!({ "args": r.get("args").cloned().unwrap_or(json!([])), "kwargs": r.get("kwargs").cloned().unwrap_or(json!({})) })]);
    if calls.is_empty() {
        return Err("No calls given.".into());
    }
    if calls.len() > MAX_CALLS {
        return Err(format!("{} calls is more than one request takes ({MAX_CALLS}); split it.", calls.len()));
    }
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let workers = (r.get("workers").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(cores)).clamp(1, MAX_WORKERS).min(calls.len());
    let call_timeout = Duration::from_secs_f64(r.get("timeoutSec").and_then(Value::as_f64).unwrap_or(300.0).max(0.1));
    let import_timeout = Duration::from_secs(r.get("importTimeoutSec").and_then(Value::as_u64).unwrap_or(120));
    let spec = Arc::new(spec(r, Some(function))?);
    let calls = Arc::new(calls);
    let next = Arc::new(AtomicUsize::new(0));
    let results: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(vec![Value::Null; calls.len()]));
    let import_ms = Arc::new(Mutex::new(Vec::new()));
    let fatal: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let restarts = Arc::new(AtomicUsize::new(0));

    std::thread::scope(|scope| {
        for _ in 0..workers {
            let (spec, calls, next, results, import_ms, fatal, restarts) =
                (Arc::clone(&spec), Arc::clone(&calls), Arc::clone(&next), Arc::clone(&results), Arc::clone(&import_ms), Arc::clone(&fatal), Arc::clone(&restarts));
            scope.spawn(move || {
                let mut worker = match Worker::start(&spec, import_timeout) {
                    Ok((w, ready)) => {
                        import_ms.lock().unwrap().push(ready["importMs"].as_u64().unwrap_or(0));
                        Some(w)
                    }
                    Err(e) => {
                        fatal.lock().unwrap().get_or_insert(e);
                        None
                    }
                };
                loop {
                    if fatal.lock().unwrap().is_some() && worker.is_none() {
                        return;
                    }
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= calls.len() {
                        return;
                    }
                    let call = &calls[i];
                    let request = json!({ "i": i, "args": call.get("args").cloned().unwrap_or(json!([])), "kwargs": call.get("kwargs").cloned().unwrap_or(json!({})) });
                    let Some(w) = worker.as_mut() else {
                        results.lock().unwrap()[i] = json!({ "ok": false, "error": "no worker could start" });
                        continue;
                    };
                    let answer = w.ask(&request, call_timeout);
                    let result = match answer {
                        Ok(mut value) => {
                            if let Value::Object(map) = &mut value {
                                map.remove("i");
                            }
                            value
                        }
                        Err(e) => {
                            // A hung or crashed worker is replaced, so one bad call costs one call.
                            worker = None;
                            restarts.fetch_add(1, Ordering::SeqCst);
                            if let Ok((w, _)) = Worker::start(&spec, import_timeout) {
                                worker = Some(w);
                            }
                            let reason = if e == "timed out" { format!("timed out after {:.1}s; the worker was restarted", call_timeout.as_secs_f64()) } else { e };
                            json!({ "ok": false, "error": reason })
                        }
                    };
                    results.lock().unwrap()[i] = result;
                }
            });
        }
    });

    if let Some(e) = fatal.lock().unwrap().clone() {
        if results.lock().unwrap().iter().all(|r| r.get("ok") != Some(&json!(true))) {
            return Err(e);
        }
    }
    let results = Arc::try_unwrap(results).map(|m| m.into_inner().unwrap()).unwrap_or_default();
    let failed = results.iter().filter(|r| r.get("ok") != Some(&json!(true))).count();
    let imports = import_ms.lock().unwrap().clone();
    Ok(json!({
        "ok": true,
        "results": results,
        "calls": calls.len(),
        "failed": failed,
        "workers": workers,
        "restarts": restarts.load(Ordering::SeqCst),
        "importMs": imports.iter().max().copied().unwrap_or(0),
        "totalMs": started.elapsed().as_millis() as u64,
    }))
}

pub fn run(r: &Value) -> Result<Value, String> {
    match s(r, "action").unwrap_or("call") {
        "list" => inspect(r, None),
        "describe" => inspect(r, Some(s(r, "function").ok_or("Which function? Give `function`.")?)),
        "call" => call(r),
        other => Err(format!("Unknown action \"{other}\".")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn python() -> Option<String> {
        for candidate in ["python", "py"] {
            if Command::new(candidate).arg("--version").output().map(|o| o.status.success()).unwrap_or(false) {
                return Some(candidate.to_string());
            }
        }
        None
    }

    /// A stand-in for a pricing library: holds the GIL while it works (a pure-Python busy loop), so
    /// threads could not run it in parallel - processes can.
    fn library(dir: &std::path::Path) {
        std::fs::write(
            dir.join("fakeprice.py"),
            "import time\nprint('licence banner from the library')\n\
             def price(notional, rate=0.05):\n    end = time.perf_counter() + 0.2\n    while time.perf_counter() < end:\n        pass\n    return notional * rate\n\
             def boom(x):\n    raise ValueError('bad trade %s' % x)\n\
             def hang():\n    time.sleep(60)\n\
             class Curve:\n    \"\"\"A yield curve.\"\"\"\n    @staticmethod\n    def zero(t):\n        return 0.01 * t\n",
        )
        .unwrap();
    }

    fn request(dir: &std::path::Path, py: &str, extra: Value) -> Value {
        let mut r = json!({ "python": py, "module": "fakeprice", "paths": [dir], "env": { "PATH": std::env::var("PATH").unwrap_or_default(), "SYSTEMROOT": std::env::var("SYSTEMROOT").unwrap_or_default() } });
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        r
    }

    #[test]
    fn runs_calls_in_parallel_processes_in_order() {
        let Some(py) = python() else { return };
        let dir = std::env::temp_dir().join(format!("fire-pypool-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        library(&dir);
        let calls: Vec<Value> = (1..=16).map(|n| json!({ "args": [n * 100] })).collect();
        let started = Instant::now();
        let answer = run(&request(&dir, &py, json!({ "function": "price", "calls": calls, "workers": 8 }))).unwrap();
        let elapsed = started.elapsed();
        assert_eq!(answer["failed"], json!(0));
        assert_eq!(answer["results"][0]["value"], json!(5.0));
        assert_eq!(answer["results"][15]["value"], json!(80.0));
        // 16 calls of 0.2s each, GIL-bound: one process takes 3.2s; eight take about 0.4s plus start-up.
        assert!(elapsed < Duration::from_millis(2600), "not parallel: {elapsed:?}");

        let errors = run(&request(&dir, &py, json!({ "function": "boom", "calls": [{ "args": [7] }] }))).unwrap();
        assert_eq!(errors["failed"], json!(1));
        assert!(errors["results"][0]["error"].as_str().unwrap().contains("bad trade 7"));

        let hung = run(&request(&dir, &py, json!({ "function": "hang", "timeoutSec": 1 }))).unwrap();
        assert!(hung["results"][0]["error"].as_str().unwrap().contains("timed out"));

        let listed = run(&request(&dir, &py, json!({ "action": "list" }))).unwrap();
        let names: Vec<&str> = listed["members"].as_array().unwrap().iter().filter_map(|m| m["name"].as_str()).collect();
        assert!(names.contains(&"price") && names.contains(&"Curve"));
        let described = run(&request(&dir, &py, json!({ "action": "describe", "function": "price" }))).unwrap();
        assert!(described["described"]["signature"].as_str().unwrap().contains("rate=0.05"));
        let method = run(&request(&dir, &py, json!({ "function": "Curve.zero", "args": [3] }))).unwrap();
        assert_eq!(method["results"][0]["value"], json!(0.03));

        let missing = run(&request(&dir, &py, json!({ "module": "no_such_module", "function": "x" }))).unwrap_err();
        assert!(missing.contains("ModuleNotFoundError"), "{missing}");
        assert!(run(&request(&dir, &py, json!({ "function": "price; import os" }))).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
