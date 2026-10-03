//! The Windows pieces: notifications under Sun's own name, the user's accent colour, and handing
//! paths to Explorer, VS Code or the default app.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::os::windows::process::CommandExt;
use tauri_winrt_notification::{Duration, Toast};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

pub const APP_ID: &str = "ChosenGeneration.SunCode";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Lets Windows show notifications as "Sun Code" with its icon.
///
/// An npm-installed program has no Start-menu shortcut to carry an identity, and without one a toast
/// is either refused or shown as coming from PowerShell. Registering the id under the user's own
/// classes is the documented route for an unpackaged desktop app and needs no administrator.
pub fn register_app_identity(icon: &Path) {
    if let Ok((key, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(format!("Software\\Classes\\AppUserModelId\\{APP_ID}")) {
        let _ = key.set_value("DisplayName", &"Sun Code");
        let _ = key.set_value("IconUri", &icon.to_string_lossy().to_string());
        let _ = key.set_value("IconBackgroundColor", &"00000000");
    }
    let wide: Vec<u16> = APP_ID.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr());
    }
}

/// A notification naming the codebase. `on_click` receives the button's action, or `None` for a
/// click on the notification itself.
pub fn notify(
    title: &str,
    body: &str,
    detail: Option<&str>,
    icon: &Path,
    buttons: &[(&str, &str)],
    on_click: impl Fn(Option<String>) + Send + 'static,
) {
    let mut toast = Toast::new(APP_ID).title(title).text1(body).duration(Duration::Short);
    if let Some(detail) = detail {
        toast = toast.text2(detail);
    }
    if icon.is_file() {
        toast = toast.icon(icon, tauri_winrt_notification::IconCrop::Square, "Sun Code");
    }
    for (label, action) in buttons {
        toast = toast.add_button(label, action);
    }
    let toast = toast.on_activated(move |action| {
        on_click(action);
        Ok(())
    });
    // A notification that fails to show is not worth failing anything else for: the sidebar already
    // shows the same state.
    let _ = toast.show();
}

/// The Windows accent colour as `#rrggbb`, read where Windows keeps it.
pub fn accent_colour() -> Option<String> {
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Microsoft\\Windows\\DWM").ok()?;
    let value: u32 = key.get_value("AccentColor").ok()?;
    // Stored as 0xAABBGGRR.
    let (r, g, b) = (value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff);
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

pub fn open_in_explorer(path: &str) {
    let _ = Command::new("explorer.exe").arg(path).spawn();
}

/// Opens with whatever Windows associates with the file - a report in the Markdown viewer, a log in
/// Notepad. Through `rundll32` so no shell parses the path.
pub fn open_with_default_app(path: &str) {
    let _ = Command::new("rundll32.exe").arg("url.dll,FileProtocolHandler").arg(path).spawn();
}

/// VS Code's `code` is a `.cmd` shim, which only a shell can run. The folder is one the user picked
/// in a dialog, never model text, and is passed as its own quoted argument.
pub fn open_in_vscode(path: &str) -> bool {
    Command::new("cmd.exe")
        .arg("/d")
        .arg("/c")
        .arg("code")
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok()
}

/// Node: the one npm used to install Sun when the launcher says so, otherwise whatever is on PATH.
pub fn node_executable() -> PathBuf {
    std::env::var_os("SUN_CODE_NODE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("node.exe"))
}

/// The Light Code host bundled beside the exe, or a development build of it.
pub fn host_script() -> PathBuf {
    if let Some(explicit) = std::env::var_os("SUN_CODE_HOST") {
        return PathBuf::from(explicit);
    }
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    let packaged = exe_dir.join("host").join("light-code.cjs");
    if packaged.is_file() {
        return packaged;
    }
    // `cargo run` from apps/sun/native: target/<profile>/ -> apps/host/dist/cli.cjs
    exe_dir.join("..").join("..").join("..").join("..").join("host").join("dist").join("cli.cjs")
}

/// sun-fs.exe, the parallel file helper, packed beside the exe (or built beside it in development).
pub fn fast_fs() -> Option<PathBuf> {
    let helper = std::env::current_exe().ok()?.parent()?.join("sun-fs.exe");
    helper.is_file().then_some(helper)
}

/// rg.exe packed beside the exe by the build.
pub fn bundled_ripgrep() -> Option<PathBuf> {
    let rg = std::env::current_exe().ok()?.parent()?.join("rg.exe");
    rg.is_file().then_some(rg)
}

/// The source archive built with the package (CLAUDE.md §12w), or `None` in a development build.
pub fn source_archive() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    [exe_dir.join("source.zip"), exe_dir.join("..").join("..").join("..").join("..").join("vscode").join("dist").join("source.zip")]
        .into_iter()
        .find(|p| p.is_file())
}

/// True when another Sun is already running for this user; that window is brought forward.
///
/// Two Suns would each start an agent for the same codebase - two hosts writing one task history
/// and one config - so the second launch hands over to the first instead. A named mutex is the
/// Windows way to ask; it disappears with the process, so a crash never leaves Sun unable to start.
pub fn hand_over_to_running_instance(home: &Path) -> bool {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE};
    // Per data folder: a second Sun with its own SUN_CODE_HOME (a test, a second profile)
    // shares nothing with the first and may run beside it.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in home.to_string_lossy().to_lowercase().bytes() {
        hash = (hash ^ byte as u64).wrapping_mul(0x100000001b3);
    }
    let name: Vec<u16> = format!("Local\\SunCode.{hash:016x}").encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        // Deliberately never closed: it must live exactly as long as this process.
        let mutex = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if mutex.is_null() || GetLastError() != ERROR_ALREADY_EXISTS {
            return false;
        }
        let title: Vec<u16> = "Sun Code".encode_utf16().chain(std::iter::once(0)).collect();
        let window = FindWindowW(std::ptr::null(), title.as_ptr());
        if !window.is_null() {
            if IsIconic(window) != 0 {
                ShowWindow(window, SW_RESTORE);
            }
            SetForegroundWindow(window);
        }
        true
    }
}

/// A plain error box, for failures that happen before there is a window to show them in.
pub fn fatal(message: &str) -> ! {
    rfd::MessageDialog::new()
        .set_title("Sun Code")
        .set_description(message)
        .set_level(rfd::MessageLevel::Error)
        .show();
    std::process::exit(1)
}

/// Standard base64, for the icon pixels the page sends. Small enough not to be worth a crate.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    };
    let bytes: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace() && *b != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= value(c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes_base64() {
        assert_eq!(super::base64_decode("aGVsbG8=").as_deref(), Some(&b"hello"[..]));
        assert_eq!(super::base64_decode("AAEC/w==").as_deref(), Some(&[0u8, 1, 2, 255][..]));
        assert_eq!(super::base64_decode("**"), None);
    }
}

/// Standard base64 with padding, for the vault envelope.
pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}
