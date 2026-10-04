//! Agent reports, read for Fire Code's own Markdown viewer.
//!
//! A scheduled run or a `notify` call writes its findings to a report file in that codebase's data
//! folder, and the notification's "Open report" used to hand it to whatever Windows associates with
//! `.md` - often Notepad, or nothing at all. Fire Code shows it itself now.
//!
//! Only files inside Fire Code's data folder are read, and only text ones: the path arrives in a host's
//! notification line or a link inside a report, and neither should be able to make the page read
//! an arbitrary file. Anything else is refused, and the page offers the default app instead.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_BYTES: u64 = 4 * 1024 * 1024;

fn is_report(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("md" | "markdown" | "txt" | "html" | "htm")
    )
}

/// The file, resolved and checked to be a report inside one of `roots`: Fire Code's data folder, where
/// notify writes, and the codebases' own folders, where an agent writes an HTML report.
pub fn allowed(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    let real = fs::canonicalize(path).map_err(|_| format!("The report {path} was not found."))?;
    let inside = roots.iter().filter_map(|r| fs::canonicalize(r).ok()).any(|base| real.starts_with(&base));
    if !inside || !is_report(&real) {
        return Err(format!("{path} is not an agent report Fire Code can show. Open it with its own app instead."));
    }
    Ok(real)
}

/// A canonical path as people write it: without the `\\?\` prefix canonicalize adds on Windows.
pub fn plain(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

pub fn read(roots: &[PathBuf], path: &str) -> Result<(PathBuf, String), String> {
    let real = allowed(roots, path)?;
    let size = fs::metadata(&real).map(|m| m.len()).unwrap_or(0);
    if size > MAX_BYTES {
        return Err(format!("{path} is {} MB - too large to show here. Open it with its own app.", size / 1_048_576));
    }
    let bytes = fs::read(&real).map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok((real, String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').to_string()))
}

/// How the page shows it.
pub fn kind(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html" | "htm") => "html",
        Some("txt") => "text",
        _ => "markdown",
    }
}

/// `%XX` decoded, for the report address the page asks for. Invalid sequences stay as written.
pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// The policy an HTML report is served under: its own styles and embedded images, and nothing
/// else - no script, no request anywhere, no form, and a sandbox that gives it no origin at all.
pub const HTML_REPORT_POLICY: &str =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; sandbox";

/// A codebase's reports, every chat's, newest first: (path, file name, modified ms).
pub fn list(project_dir: &Path) -> Vec<(String, String, u64)> {
    let mut found = Vec::new();
    walk(project_dir, 0, &mut found);
    found.sort_by(|a, b| b.2.cmp(&a.2));
    found.truncate(200);
    found
}

fn walk(dir: &Path, depth: usize, found: &mut Vec<(String, String, u64)>) {
    // Reports sit a few levels down (chats/<n>/users/<id>/reports); nothing worth reading is deeper.
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !matches!(name.as_str(), "webview" | "tool-results" | "tasks" | "checkpoints" | "node_modules" | ".venv") {
                walk(&path, depth + 1, found);
            }
        } else if is_report(&path) && path.parent().and_then(|p| p.file_name()).map(|n| n == "reports").unwrap_or(false) {
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            found.push((path.to_string_lossy().to_string(), entry.file_name().to_string_lossy().to_string(), modified));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_reports_inside_sun_and_nothing_else() {
        let root = std::env::temp_dir().join(format!("fire-code-reports-{}", std::process::id()));
        let reports = root.join("projects").join("p1").join("reports");
        fs::create_dir_all(&reports).unwrap();
        fs::write(reports.join("nightly.md"), "\u{feff}# Nightly\n\nAll good.").unwrap();
        fs::write(root.join("vault.key"), "secret").unwrap();
        let outside = std::env::temp_dir().join(format!("fire-code-outside-{}.md", std::process::id()));
        fs::write(&outside, "# not ours").unwrap();

        let (_, text) = read(&[root.clone()], &reports.join("nightly.md").to_string_lossy()).unwrap();
        assert!(text.starts_with("# Nightly"));
        assert!(read(&[root.clone()], &root.join("vault.key").to_string_lossy()).is_err(), "not a report");
        assert!(read(&[root.clone()], &outside.to_string_lossy()).is_err(), "outside Fire Code's folder");
        let sneaky = format!("{}\\..\\..\\..\\..\\{}", reports.display(), outside.file_name().unwrap().to_string_lossy());
        assert!(read(&[root.clone()], &sneaky).is_err(), "climbing out with ..");

        let listed = list(&root.join("projects").join("p1"));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].1, "nightly.md");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&outside);
    }
}

#[cfg(test)]
mod decode_tests {
    #[test]
    fn decodes_the_address_the_page_builds() {
        assert_eq!(super::percent_decode("C%3A%5Cdata%5Creport%20one.html"), r"C:\data\report one.html");
        assert_eq!(super::percent_decode("50%"), "50%");
        assert_eq!(super::percent_decode("%zz"), "%zz");
    }
}
