//! One Light Code Node host per codebase, each in its own Windows job object.
//!
//! The job is what makes stopping a codebase *complete*: the host spawns MCP servers, a Python
//! worker, ripgrep and shell commands, and `child.kill()` reaches none of them (CLAUDE.md §16).
//! Terminating the job takes the whole tree. It is also created with KILL_ON_JOB_CLOSE, so if Sun
//! itself is killed the OS closes the handle and every process it started goes with it - nothing is
//! left running behind a window that is gone.
//!
//! The job doubles as the memory meter: it knows every process in the tree, so one query answers
//! "what does this codebase cost" without walking parent ids.

use serde::Deserialize;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// What the host process tells Sun, read from its stdout.
pub enum HostEvent {
    Url { id: String, generation: u64, url: String },
    Notify { id: String, message: String, level: String, report_path: Option<String> },
    Exited { id: String, generation: u64, code: Option<i32>, tail: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotifyLine {
    message: String,
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    report_path: Option<String>,
}

pub struct HostProcess {
    job: HANDLE,
}

// The job handle is used from the main thread and the memory sampler; both only call thread-safe
// kernel functions on it.
unsafe impl Send for HostProcess {}

impl HostProcess {
    /// Every process in this codebase's tree, ended at once.
    pub fn stop(&self) {
        unsafe {
            TerminateJobObject(self.job, 1);
        }
    }

    /// Working-set bytes summed over the whole tree: the host, its MCP servers, its Python worker.
    pub fn memory(&self) -> u64 {
        job_memory(self.job)
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        unsafe {
            // KILL_ON_JOB_CLOSE: closing the last handle ends the tree. Dropping a host means it is done.
            TerminateJobObject(self.job, 1);
            CloseHandle(self.job);
        }
    }
}

pub struct LaunchSpec {
    pub id: String,
    pub generation: u64,
    pub node: PathBuf,
    pub host_script: PathBuf,
    pub workspace: String,
    pub data_dir: PathBuf,
    pub config_file: String,
    pub secrets_file: PathBuf,
    pub log_file: PathBuf,
    pub frame_ancestor: String,
    /// rg.exe shipped beside Sun, so search needs nothing downloaded at install.
    pub ripgrep: Option<PathBuf>,
    /// The vault key, written to the host's stdin and nowhere else.
    pub vault_key: String,
    pub credentials_file: PathBuf,
    /// Reach beyond the codebase (Settings); and the parallel file helper, when it is beside Sun.
    pub reach_anywhere: bool,
    pub fast_fs: Option<PathBuf>,
    /// Sun's environment (Settings → Environment): variables, and the whole PATH when folders are
    /// put in front of it. Applied before Sun's own variables, so neither can replace those.
    pub env: Vec<(String, String)>,
    pub path: Option<String>,
}

pub fn launch(spec: LaunchSpec, send: impl Fn(HostEvent) + Send + Sync + 'static) -> Result<HostProcess, String> {
    fs::create_dir_all(&spec.data_dir).map_err(|e| format!("Could not create {}: {e}", spec.data_dir.display()))?;
    if !spec.host_script.is_file() {
        return Err(format!(
            "The Light Code host was not found at {}. Reinstall with npm i -g @chosengeneration/sun-code.",
            spec.host_script.display()
        ));
    }

    let mut command = Command::new(&spec.node);
    command
        .arg(&spec.host_script)
        .arg("--workspace")
        .arg(&spec.workspace)
        .arg("--data-dir")
        .arg(&spec.data_dir)
        .arg("--config-file")
        .arg(&spec.config_file)
        .arg("--secrets-file")
        .arg(&spec.secrets_file)
        .arg("--secrets-key-stdin")
        .arg("--credentials-file")
        .arg(&spec.credentials_file)
        .arg("--print-url")
        .arg("--no-open")
        .arg("--desktop-notify")
        // Long enough to survive a slow first paint; the link is single-use and never leaves Sun.
        .arg("--handoff-seconds")
        .arg("120")
        .arg("--allow-frame-ancestor")
        .arg(&spec.frame_ancestor)
        // Several chats may work in this folder at once: rollback restores only this chat's files,
        // and an edit made from a stale read is refused.
        .arg("--shared-workspace")
        .current_dir(&spec.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // No console window flashing up per codebase.
        .creation_flags(CREATE_NO_WINDOW);
    if spec.reach_anywhere {
        command.arg("--reach-anywhere");
    }
    if let Some(helper) = &spec.fast_fs {
        command.arg("--fast-fs").arg(helper);
    }
    for (name, value) in &spec.env {
        command.env(name, value);
    }
    if let Some(path) = &spec.path {
        // Windows names are case-insensitive, so this replaces "Path" as well.
        command.env("PATH", path);
    }
    if let Some(rg) = &spec.ripgrep {
        command.env("LIGHT_CODE_RIPGREP", rg);
    }

    let mut child = command.spawn().map_err(|e| {
        format!("Could not start Node ({}): {e}. Is Node.js installed and on PATH?", spec.node.display())
    })?;

    // The key, on stdin and then closed: not an argument (visible in the process list) and not a
    // variable (inherited by every command the agent runs).
    if let Some(mut stdin) = child.stdin.take() {
        let _ = writeln!(stdin, "{}", spec.vault_key);
    }

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        let _ = child.kill();
        return Err("Windows refused to create a job object for the agent process.".into());
    }
    unsafe {
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.id());
        if !process.is_null() {
            // Assigned before Node has finished starting, so everything it spawns is born inside.
            AssignProcessToJobObject(job, process);
            CloseHandle(process);
        }
    }

    let log = Arc::new(Mutex::new(open_log(&spec.log_file)));
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let send = Arc::new(send);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut readers = Vec::new();
    if let Some(stdout) = stdout {
        let (log, tail, send, id, generation) = (log.clone(), tail.clone(), send.clone(), spec.id.clone(), spec.generation);
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(url) = line.strip_prefix("light-code-url: ") {
                    send(HostEvent::Url { id: id.clone(), generation, url: url.trim().to_string() });
                    // The URL carries a one-time token; it is not written to the log.
                    record(&log, &tail, "light-code-url: (launch link, not logged)");
                    continue;
                }
                if let Some(json) = line.strip_prefix("light-code-notify: ") {
                    if let Ok(n) = serde_json::from_str::<NotifyLine>(json) {
                        send(HostEvent::Notify {
                            id: id.clone(),
                            message: n.message,
                            level: n.level.unwrap_or_else(|| "info".into()),
                            report_path: n.report_path,
                        });
                    }
                }
                record(&log, &tail, &line);
            }
        }));
    }
    if let Some(stderr) = stderr {
        let (log, tail) = (log.clone(), tail.clone());
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                record(&log, &tail, &line);
            }
        }));
    }

    {
        let (send, id, generation, tail) = (send.clone(), spec.id.clone(), spec.generation, tail.clone());
        std::thread::spawn(move || {
            let status = child.wait().ok();
            for reader in readers {
                let _ = reader.join();
            }
            let tail = tail.lock().map(|t| t.join("\n")).unwrap_or_default();
            send(HostEvent::Exited { id, generation, code: status.and_then(|s| s.code()), tail });
        });
    }

    Ok(HostProcess { job })
}

fn open_log(file: &PathBuf) -> Option<File> {
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // One run per file: the previous run's log is kept beside it, so a crash and its restart can
    // both be read.
    let _ = fs::rename(file, file.with_extension("previous.log"));
    OpenOptions::new().create(true).write(true).truncate(true).open(file).ok()
}

fn record(log: &Arc<Mutex<Option<File>>>, tail: &Arc<Mutex<Vec<String>>>, line: &str) {
    // The host's banner repeats the launch link for a person to paste. Its token is single-use,
    // but it is still a credential until spent, and a log is the last place it should sit.
    let redacted;
    let line = if let Some(at) = line.find("#t=") {
        redacted = format!("{}#t=(redacted)", &line[..at]);
        redacted.as_str()
    } else {
        line
    };
    if let Ok(mut guard) = log.lock() {
        if let Some(file) = guard.as_mut() {
            let _ = writeln!(file, "{line}");
        }
    }
    if let Ok(mut t) = tail.lock() {
        t.push(line.to_string());
        if t.len() > 40 {
            t.remove(0);
        }
    }
}

fn job_memory(job: HANDLE) -> u64 {
    // Header (two u32) followed by up to 255 process ids.
    #[repr(C)]
    struct PidList {
        assigned: u32,
        in_list: u32,
        ids: [usize; 256],
    }
    let mut list: PidList = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicProcessIdList,
            &mut list as *mut _ as *mut _,
            std::mem::size_of::<PidList>() as u32,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return 0;
    }
    let mut total = 0u64;
    for &pid in list.ids.iter().take(list.in_list as usize) {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
            if process.is_null() {
                continue;
            }
            let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            if K32GetProcessMemoryInfo(process, &mut counters, counters.cb) != 0 {
                total += counters.WorkingSetSize as u64;
            }
            CloseHandle(process);
        }
    }
    total
}
