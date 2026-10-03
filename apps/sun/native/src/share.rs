//! Receives keys from the VS Code extension ("Light Code: Share API keys with Sun Light Code").
//!
//! VS Code keeps its keys in its own encrypted storage, which nothing else can read. The extension
//! can, so it sends them here, after the person confirmed the list of names. The channel is a named
//! pipe that only this Windows user can open: its access list names this user's SID and nothing
//! else, and remote clients are refused. No file holds the keys on the way.
//!
//! One JSON line in, one line out:
//!   -> {"type":"share","from":"VS Code","entries":[{"key":"profile:gw:apiKey","label":"…","value":"…"}]}
//!   <- {"ok":true,"stored":["DeepSeek: API key"]}

use serde::Deserialize;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};

use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW};
use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// The pipe's name: per Windows user, so two people on one machine never meet.
pub fn pipe_name() -> String {
    format!(r"\\.\pipe\sun-light-code.{}", std::env::var("USERNAME").unwrap_or_else(|_| "user".into()).to_lowercase())
}

#[derive(Deserialize)]
struct Request {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    key: String,
    label: String,
    value: String,
}

/// Serves until the process ends. `import` stores the keys and returns their labels; `received`
/// tells the window what arrived (names only).
pub fn serve(
    import: impl Fn(&[(String, String, String)]) -> Result<Vec<String>, String> + Send + 'static,
    received: impl Fn(String, Vec<String>) + Send + 'static,
) {
    std::thread::spawn(move || {
        let Some(sddl) = user_only_sddl() else { return };
        let name: Vec<u16> = pipe_name().encode_utf16().chain(std::iter::once(0)).collect();
        let mut first = true;
        loop {
            let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let sddl_wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
            if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl_wide.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) } == 0 {
                return;
            }
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            let pipe: HANDLE = unsafe {
                CreateNamedPipeW(
                    name.as_ptr(),
                    PIPE_ACCESS_DUPLEX | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 },
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    64 * 1024,
                    1024 * 1024,
                    0,
                    &attributes,
                )
            };
            unsafe {
                LocalFree(descriptor as _);
            }
            if pipe == INVALID_HANDLE_VALUE || pipe.is_null() {
                // Another Sun (a second data folder) already listens; one receiver is enough.
                return;
            }
            first = false;
            if unsafe { ConnectNamedPipe(pipe, std::ptr::null_mut()) } == 0 && std::io::Error::last_os_error().raw_os_error() != Some(535) {
                // 535 = ERROR_PIPE_CONNECTED: the client was already there, which is fine.
                unsafe {
                    CloseHandle(pipe);
                }
                continue;
            }
            let mut file = unsafe { File::from_raw_handle(pipe as _) };
            let reply = handle(&mut file, &import, &received);
            let _ = writeln!(file, "{reply}");
            let _ = file.flush();
            unsafe {
                DisconnectNamedPipe(file.as_raw_handle() as HANDLE);
            }
            drop(file);
        }
    });
}

fn handle(
    file: &mut File,
    import: &impl Fn(&[(String, String, String)]) -> Result<Vec<String>, String>,
    received: &impl Fn(String, Vec<String>),
) -> String {
    let mut line = String::new();
    let mut reader = BufReader::new(&*file).take(1024 * 1024);
    if reader.read_line(&mut line).is_err() {
        return serde_json::json!({ "ok": false, "error": "Nothing readable arrived." }).to_string();
    }
    let request: Request = match serde_json::from_str(&line) {
        Ok(r) => r,
        Err(_) => return serde_json::json!({ "ok": false, "error": "Sun did not understand the request." }).to_string(),
    };
    if request.kind != "share" {
        return serde_json::json!({ "ok": false, "error": "Unknown request." }).to_string();
    }
    let entries: Vec<(String, String, String)> = request.entries.into_iter().map(|e| (e.key, e.label, e.value)).collect();
    match import(&entries) {
        Ok(labels) => {
            received(request.from.unwrap_or_else(|| "another app".into()), labels.clone());
            serde_json::json!({ "ok": true, "stored": labels }).to_string()
        }
        Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
    }
}

trait Take {
    fn take(self, limit: u64) -> std::io::Take<Self>
    where
        Self: Sized;
}
impl<R: std::io::Read> Take for BufReader<R> {
    fn take(self, limit: u64) -> std::io::Take<Self> {
        std::io::Read::take(self, limit)
    }
}

/// An access list naming only the current user: full control for them, nothing for anyone else.
fn user_only_sddl() -> Option<String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut size = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
        let mut buffer = vec![0u8; size as usize];
        let ok = GetTokenInformation(token, TokenUser, buffer.as_mut_ptr() as _, size, &mut size);
        CloseHandle(token);
        if ok == 0 {
            return None;
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text: windows_sys::core::PWSTR = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return None;
        }
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text as _);
        Some(format!("D:P(A;;GA;;;{sid})"))
    }
}
