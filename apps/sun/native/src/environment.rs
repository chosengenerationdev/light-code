//! Fire Code's own environment for every agent it starts: folders put in front of PATH, and variables.
//!
//! Set once in Fire Code's Settings rather than per codebase, because these describe the machine - the
//! folder an internal tool is installed in, the proxy, the region - not a project. A value can come
//! from a saved credential, so a token is not written into Fire Code's state file in plain text.
//!
//! What reaches what: the host process gets all of it, and so does every command an agent runs
//! (they inherit the host's environment). Python tools and MCP servers are given a minimal,
//! allow-listed environment by design (CLAUDE.md §13, §11): PATH reaches them, other variables do
//! not unless their own settings name them. The page says so.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::vault::Vault;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub name: String,
    /// A plain value. Exactly one of this and `credential` is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// A saved credential's field, `id#field` - resolved each time an agent starts, never stored here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// Names Fire Code sets itself, or that would undo something it relies on.
fn reserved(name: &str) -> Option<&'static str> {
    let upper = name.to_ascii_uppercase();
    if upper == "PATH" {
        Some("Add folders to PATH in the list above instead - a variable would replace the whole PATH.")
    } else if upper.starts_with("FIRE_CODE_") || upper.starts_with("SUN_LIGHT_CODE_") || upper == "LIGHT_CODE_RIPGREP" {
        Some("Fire Code sets this one itself.")
    } else {
        None
    }
}

/// Refuses what would be saved wrong, naming the entry. Missing folders are allowed - a share may
/// be offline right now - and are reported separately by `folder_status`.
pub fn validate(path_prefix: &[String], env: &[EnvVar]) -> Result<(), String> {
    for folder in path_prefix {
        let folder = folder.trim();
        if folder.is_empty() {
            return Err("A PATH entry is empty. Remove it, or type a folder.".into());
        }
        if folder.contains(';') {
            return Err(format!("\"{folder}\" contains ';'. Add each folder as its own entry."));
        }
        if !Path::new(&expand(folder)).is_absolute() {
            return Err(format!("\"{folder}\" is not a full path. Use one like C:\\tools\\bin or %USERPROFILE%\\bin."));
        }
    }
    let mut seen: Vec<String> = Vec::new();
    for var in env {
        let name = var.name.trim();
        let valid = !name.is_empty()
            && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            return Err(format!("\"{name}\" is not a variable name: letters, digits and _, not starting with a digit."));
        }
        if let Some(why) = reserved(name) {
            return Err(format!("{name}: {why}"));
        }
        // Windows variable names ignore case, so two spellings are one variable.
        if seen.iter().any(|s| s.eq_ignore_ascii_case(name)) {
            return Err(format!("{name} is listed twice."));
        }
        seen.push(name.to_string());
        match (&var.value, &var.credential) {
            (Some(_), None) => {}
            (None, Some(c)) if c.contains('#') => {}
            (None, Some(_)) => return Err(format!("{name}: choose which part of the saved credential to use.")),
            _ => return Err(format!("{name}: give it a value or choose a saved credential.")),
        }
    }
    Ok(())
}

/// `%NAME%` replaced from Fire Code's own environment, as cmd would; an unknown name is left as written.
pub fn expand(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(value) => out.push_str(&value),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Each folder as typed, expanded, and whether it exists now - for the settings page.
pub fn folder_status(path_prefix: &[String]) -> Vec<serde_json::Value> {
    path_prefix
        .iter()
        .map(|f| {
            let expanded = expand(f.trim());
            serde_json::json!({ "path": f, "expanded": expanded, "exists": Path::new(&expanded).is_dir() })
        })
        .collect()
}

/// What an agent is started with.
pub struct Resolved {
    pub vars: Vec<(String, String)>,
    /// The whole PATH: the folders first, then Fire Code's own. None when no folders are set.
    pub path: Option<String>,
    /// Variables left out, and why - a deleted credential, say. Said once, not per agent.
    pub problems: Vec<String>,
}

/// Everything an agent is started with, in the order it is applied: what the startup script left,
/// then the variables listed here (so a listed one wins over the script's), then the PATH folders
/// in front of whichever PATH the script left - or Fire Code's own when it changed none.
pub fn resolve(path_prefix: &[String], env: &[EnvVar], vault: &Vault, script: &[(String, String)]) -> Resolved {
    let mut vars: Vec<(String, String)> = script.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("PATH")).cloned().collect();
    let script_path = script.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v.clone());
    let mut problems = Vec::new();
    for var in env {
        match (&var.value, &var.credential) {
            (Some(value), _) => vars.push((var.name.trim().to_string(), value.clone())),
            (None, Some(pointer)) => {
                let (id, field) = pointer.split_once('#').unwrap_or((pointer.as_str(), "value"));
                match vault.value(id, field) {
                    Some(value) => vars.push((var.name.trim().to_string(), value)),
                    None => problems.push(format!(
                        "{} was not set: its saved credential no longer has a {field}. Choose another in Settings → Environment.",
                        var.name.trim()
                    )),
                }
            }
            (None, None) => {}
        }
    }
    let folders: Vec<String> = path_prefix.iter().map(|f| expand(f.trim())).filter(|f| !f.is_empty()).collect();
    let path = if folders.is_empty() {
        script_path
    } else {
        let current = script_path.unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
        let mut all = folders.join(";");
        if !current.is_empty() {
            all.push(';');
            all.push_str(&current);
        }
        Some(all)
    };
    Resolved { vars, path, problems }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn var(name: &str, value: Option<&str>, credential: Option<&str>) -> EnvVar {
        EnvVar { name: name.into(), value: value.map(Into::into), credential: credential.map(Into::into) }
    }

    #[test]
    fn accepts_ordinary_entries() {
        let folders = vec![r"C:\tools\bin".to_string(), r"%USERPROFILE%\bin".to_string()];
        let env = vec![var("HTTPS_PROXY", Some("http://proxy:8080"), None), var("API_TOKEN", None, Some("c1#value"))];
        assert_eq!(validate(&folders, &env), Ok(()));
    }

    #[test]
    fn refuses_what_would_go_wrong_quietly() {
        assert!(validate(&[r"tools\bin".into()], &[]).unwrap_err().contains("full path"));
        assert!(validate(&[r"C:\a;C:\b".into()], &[]).unwrap_err().contains(';'));
        assert!(validate(&[], &[var("Path", Some("x"), None)]).unwrap_err().contains("replace the whole PATH"));
        assert!(validate(&[], &[var("FIRE_CODE_HOME", Some("x"), None)]).is_err());
        assert!(validate(&[], &[var("1ST", Some("x"), None)]).is_err());
        assert!(validate(&[], &[var("A", Some("1"), None), var("a", Some("2"), None)]).unwrap_err().contains("twice"));
        assert!(validate(&[], &[var("A", None, None)]).is_err());
        assert!(validate(&[], &[var("A", Some("1"), Some("c#value"))]).is_err());
    }

    #[test]
    fn expands_like_cmd() {
        std::env::set_var("FIRE_CODE_TEST_DIR", r"D:\x");
        assert_eq!(expand(r"%FIRE_CODE_TEST_DIR%\bin"), r"D:\x\bin");
        assert_eq!(expand(r"%NO_SUCH_VARIABLE_HERE%\bin"), r"%NO_SUCH_VARIABLE_HERE%\bin");
        assert_eq!(expand("100%"), "100%");
    }
}

// ─── The startup script ──────────────────────────────────────────────────────
//
// A .cmd/.bat or .ps1 the user names (Settings → Environment), run once when Fire Code starts. Whatever
// environment it leaves behind - variables it sets, folders it adds to PATH - is captured and given
// to every agent Fire Code starts, so a team's existing "setenv" script works unchanged instead of being
// retyped as a list. It runs in its own shell, so it cannot change Fire Code itself: only the difference
// it makes to the environment is taken.

const MARKER: &str = "===SUN-CODE-ENV===";
const SCRIPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// What a script left: variables that are new or changed from Fire Code's own environment.
#[derive(Clone, Debug, Default)]
pub struct ScriptEnv {
    pub vars: Vec<(String, String)>,
    pub exit_code: i32,
    /// The script's own output, last lines, for the page when something went wrong.
    pub output_tail: String,
}

/// Names a shell sets for itself; carrying them over would be noise, not configuration.
fn shell_noise(name: &str) -> bool {
    name.starts_with('=')
        || ["PROMPT", "PS1", "PWD", "OLDPWD", "SHLVL", "_", "PSMODULEPATH"].iter().any(|n| n.eq_ignore_ascii_case(name))
}

pub fn check_script(path: &str) -> Result<(), String> {
    let expanded = expand(path.trim());
    let lower = expanded.to_ascii_lowercase();
    if !(lower.ends_with(".cmd") || lower.ends_with(".bat") || lower.ends_with(".ps1")) {
        return Err("The startup script must be a .cmd, .bat or .ps1 file.".into());
    }
    if !Path::new(&expanded).is_file() {
        return Err(format!("The startup script {expanded} was not found."));
    }
    Ok(())
}

/// Runs the script and returns what it changed. Blocking: called from a background thread.
pub fn run_script(path: &str) -> Result<ScriptEnv, String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    check_script(path)?;
    let script = expand(path.trim());
    let folder = Path::new(&script).parent().map(|p| p.to_path_buf()).unwrap_or_else(std::env::temp_dir);
    let mut command = if script.to_ascii_lowercase().ends_with(".ps1") {
        // Dot-sourced, so $env: changes it makes stay in this session; then every variable, once.
        let quoted = script.replace('\'', "''");
        let mut c = Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]).arg(format!(
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $global:LASTEXITCODE=0; . '{quoted}'; \
             $code=$LASTEXITCODE; if ($null -eq $code) {{ $code=0 }}; '{MARKER} ' + $code; \
             Get-ChildItem env: | ForEach-Object {{ $_.Name + '=' + $_.Value }}"
        ));
        c
    } else {
        // `call` so the script's variables stay in this cmd; !ERRORLEVEL! is read after it ran.
        let mut c = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
        c.raw_arg(format!("/d /v:on /s /c \"chcp 65001>nul & call \"{script}\" & echo {MARKER} !ERRORLEVEL! & set\""));
        c
    };
    command
        .current_dir(&folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|e| format!("Could not run the startup script: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("No output from the startup script.")?;
    let mut stderr = child.stderr.take().ok_or("No output from the startup script.")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let errors = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > SCRIPT_TIMEOUT => {
                // The whole tree: a script that started something and waits on it.
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000)
                    .status();
                let _ = child.wait();
                return Err(format!(
                    "The startup script did not finish within {} seconds and was stopped. A script that waits \
                     for input (pause, Read-Host) never finishes here - nobody can answer it.",
                    SCRIPT_TIMEOUT.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => return Err(format!("The startup script could not be watched: {e}")),
        }
    }
    let out = String::from_utf8_lossy(&reader.join().unwrap_or_default()).to_string();
    let err = String::from_utf8_lossy(&errors.join().unwrap_or_default()).to_string();
    parse_script_output(&out, &err, std::env::vars().collect())
}

/// Splits the script's own output from the environment dump after the marker, and keeps what
/// differs from `before` (case-insensitive names, as Windows has them).
pub fn parse_script_output(out: &str, err: &str, before: Vec<(String, String)>) -> Result<ScriptEnv, String> {
    let Some(at) = out.find(MARKER) else {
        let tail = tail_of(&format!("{out}\n{err}"));
        return Err(format!("The startup script stopped before it finished (it may call exit).\n{tail}"));
    };
    let script_output = &out[..at];
    let rest = &out[at + MARKER.len()..];
    let (code_line, dump) = rest.split_once('\n').unwrap_or((rest, ""));
    let exit_code = code_line.trim().parse::<i32>().unwrap_or(0);
    let mut vars: Vec<(String, String)> = Vec::new();
    for line in dump.lines() {
        let line = line.trim_end_matches('\r');
        let Some((name, value)) = line.split_once('=') else { continue };
        if name.is_empty() || shell_noise(name) {
            continue;
        }
        let unchanged = before.iter().any(|(k, v)| k.eq_ignore_ascii_case(name) && v == value);
        if !unchanged && !vars.iter().any(|(k, _)| k.eq_ignore_ascii_case(name)) {
            vars.push((name.to_string(), value.to_string()));
        }
    }
    Ok(ScriptEnv { vars, exit_code, output_tail: tail_of(&format!("{script_output}\n{err}")) })
}

fn tail_of(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(12)..].join("\n")
}

#[cfg(test)]
mod script_tests {
    use super::*;

    #[test]
    fn takes_only_what_the_script_changed() {
        let before = vec![("Path".to_string(), r"C:\Windows".to_string()), ("HOME".to_string(), "x".to_string())];
        let out = "Setting up tools\r\n===SUN-CODE-ENV=== 0\r\n=C:=C:\\work\r\nHOME=x\r\nPATH=C:\\tools;C:\\Windows\r\nTEAM_REGION=emea\r\nPROMPT=$P$G\r\n";
        let env = parse_script_output(out, "", before).unwrap();
        assert_eq!(
            env.vars,
            vec![("PATH".to_string(), r"C:\tools;C:\Windows".to_string()), ("TEAM_REGION".to_string(), "emea".to_string())]
        );
        assert_eq!(env.exit_code, 0);
        assert!(env.output_tail.contains("Setting up tools"));
    }

    #[test]
    fn a_script_that_exits_early_is_reported() {
        assert!(parse_script_output("partial", "boom", vec![]).unwrap_err().contains("boom"));
    }

    /// Both shells for real: the variables a script sets, and a folder it puts on PATH.
    #[test]
    fn real_scripts_in_both_shells() {
        let dir = std::env::temp_dir().join(format!("fire-code-script-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cmd = dir.join("set env.cmd");
        std::fs::write(&cmd, "@echo off\r\necho preparing\r\nset SUN_SCRIPT_TEST=from cmd\r\nset PATH=C:\\sun-script-test;%PATH%\r\n").unwrap();
        let env = run_script(&cmd.to_string_lossy()).unwrap();
        assert!(env.vars.contains(&("SUN_SCRIPT_TEST".to_string(), "from cmd".to_string())), "{:?}", env.vars);
        assert!(env.vars.iter().any(|(k, v)| k.eq_ignore_ascii_case("PATH") && v.starts_with(r"C:\sun-script-test;")));
        let ps = dir.join("set env.ps1");
        std::fs::write(&ps, "Write-Output 'preparing'\r\n$env:SUN_SCRIPT_TEST = 'from powershell'\r\n$env:Path = 'C:\\sun-ps-test;' + $env:Path\r\n").unwrap();
        let env = run_script(&ps.to_string_lossy()).unwrap();
        assert!(env.vars.contains(&("SUN_SCRIPT_TEST".to_string(), "from powershell".to_string())), "{:?}", env.vars);
        assert!(env.vars.iter().any(|(k, v)| k.eq_ignore_ascii_case("PATH") && v.starts_with(r"C:\sun-ps-test;")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
