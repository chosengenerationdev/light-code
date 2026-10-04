//! What has changed in a codebase, for the sidebar: new, modified and deleted files from
//! `git status`, and the branch.
//!
//! Run off the UI thread, one codebase at a time, with `--no-optional-locks` - a status that took
//! the index lock would make the user's own `git commit` (or VS Code's) fail with "index.lock
//! exists" at random, which is far worse than a count that is a few seconds old. A folder that is
//! not a repository, a missing `git`, or one that takes too long all mean "no counts", never an
//! error: this is a glance, not a tool.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct GitCounts {
    /// Untracked files and folders, and files staged as new.
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub branch: Option<String>,
}

/// `git status --porcelain=v1 -z --branch` output, counted.
pub fn parse(output: &[u8]) -> GitCounts {
    let mut counts = GitCounts::default();
    let text = String::from_utf8_lossy(output);
    let mut fields = text.split('\0');
    while let Some(entry) = fields.next() {
        if entry.len() < 3 {
            continue;
        }
        if let Some(head) = entry.strip_prefix("## ") {
            // "main...origin/main [ahead 1]", "No commits yet on main", "HEAD (no branch)"
            let name = head.strip_prefix("No commits yet on ").unwrap_or(head);
            let name = name.split("...").next().unwrap_or(name).split(' ').next().unwrap_or(name);
            counts.branch = Some(name.to_string());
            continue;
        }
        let bytes = entry.as_bytes();
        let (x, y) = (bytes[0] as char, bytes[1] as char);
        match (x, y) {
            ('?', '?') => counts.added += 1,
            ('!', '!') => {}
            // Unmerged: both sides changed it - shown as modified, which is what it needs.
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => counts.modified += 1,
            ('A', _) => counts.added += 1,
            ('D', _) | (_, 'D') => counts.deleted += 1,
            ('R', _) | ('C', _) => {
                counts.modified += 1;
                // A rename or copy is followed by the path it came from, as its own field.
                fields.next();
            }
            _ => counts.modified += 1,
        }
    }
    counts
}

/// The counts for a folder, or None when it is not a repository, git is missing, or it took too long.
pub fn status(folder: &str) -> Option<GitCounts> {
    if !Path::new(folder).is_dir() {
        return None;
    }
    let mut child = Command::new("git")
        .args(["--no-optional-locks", "-C", folder, "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal"])
        // Never a prompt for credentials or a pager: there is nobody to answer either.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(exit)) => {
                let bytes = reader.join().unwrap_or_default();
                return exit.success().then(|| parse(&bytes));
            }
            Ok(None) if started.elapsed() > Duration::from_secs(20) => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_each_kind_of_change() {
        let out = b"## main...origin/main [ahead 2]\0?? notes.txt\0?? new-folder/\0A  staged.py\0 M edited.rs\0M  staged-edit.rs\0MM both.rs\0 D gone.txt\0D  removed.txt\0R  new-name.rs\0old-name.rs\0UU conflict.rs\0";
        let c = parse(out);
        assert_eq!(c.branch.as_deref(), Some("main"));
        assert_eq!(c.added, 3, "two untracked, one staged as new");
        assert_eq!(c.modified, 5, "edited, staged edit, both, the rename, the conflict");
        assert_eq!(c.deleted, 2);
    }

    #[test]
    fn a_clean_repository_and_a_brand_new_one() {
        assert_eq!(parse(b"## main...origin/main\0"), GitCounts { branch: Some("main".into()), ..Default::default() });
        assert_eq!(parse(b"## No commits yet on trunk\0?? a.txt\0").branch.as_deref(), Some("trunk"));
    }

    #[test]
    fn a_real_repository() {
        let dir = std::env::temp_dir().join(format!("sun-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| Command::new("git").arg("-C").arg(&dir).args(args).output().map(|o| o.status.success()).unwrap_or(false);
        if !git(&["init", "-q"]) {
            return; // No git on this machine: nothing to check.
        }
        git(&["config", "user.email", "t@example.invalid"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("kept.txt"), "1").unwrap();
        std::fs::write(dir.join("gone.txt"), "1").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "first"]);
        std::fs::write(dir.join("kept.txt"), "2").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::write(dir.join("fresh.txt"), "new").unwrap();
        let c = status(&dir.to_string_lossy()).expect("a repository");
        assert_eq!((c.added, c.modified, c.deleted), (1, 1, 1));
        assert!(status(&std::env::temp_dir().join("sun-git-not-a-repo-xyz").to_string_lossy()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
