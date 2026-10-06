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
    /// Commits not yet pushed, and commits on the remote not yet pulled (as of the last fetch).
    pub ahead: usize,
    pub behind: usize,
    /// Whether the branch tracks a remote one, so a push knows where to go.
    pub upstream: bool,
    /// What changed, one line each ("+ new.py", "~ edited.rs", "- gone.txt"), for the hover. Capped.
    pub files: Vec<String>,
}

/// How many file names the hover lists; the counts still cover everything.
const LISTED: usize = 40;

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
            counts.upstream = name.contains("...");
            let number = |word: &str| {
                name.split(word).nth(1).and_then(|rest| rest.trim_start().split(|c: char| !c.is_ascii_digit()).next()).and_then(|n| n.parse().ok()).unwrap_or(0)
            };
            counts.ahead = number("ahead");
            counts.behind = number("behind");
            let name = name.split("...").next().unwrap_or(name).split(' ').next().unwrap_or(name);
            counts.branch = Some(name.to_string());
            continue;
        }
        let bytes = entry.as_bytes();
        let (x, y) = (bytes[0] as char, bytes[1] as char);
        let path = &entry[3..];
        let sign = match (x, y) {
            ('?', '?') => {
                counts.added += 1;
                '+'
            }
            ('!', '!') => continue,
            // Unmerged: both sides changed it - shown as modified, which is what it needs.
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => {
                counts.modified += 1;
                '!'
            }
            ('A', _) => {
                counts.added += 1;
                '+'
            }
            ('D', _) | (_, 'D') => {
                counts.deleted += 1;
                '-'
            }
            ('R', _) | ('C', _) => {
                counts.modified += 1;
                // A rename or copy is followed by the path it came from, as its own field.
                fields.next();
                '~'
            }
            _ => {
                counts.modified += 1;
                '~'
            }
        };
        if counts.files.len() < LISTED {
            counts.files.push(format!("{sign} {path}"));
        }
    }
    counts
}

/// Runs git in a folder with no prompt and a time limit; the combined output, and whether it worked.
fn run(folder: &str, args: &[&str], limit: Duration) -> (bool, String) {
    let child = Command::new("git")
        .arg("-C")
        .arg(folder)
        .args(args)
        // A credential prompt in a terminal nobody can see would hang until the limit. Git's own
        // credential manager still shows its window on Windows, which is the user's to answer.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000)
        .spawn();
    let Ok(mut child) = child else { return (false, "git was not found on PATH.".into()) };
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_string(&mut text);
        }
        let mut e = String::new();
        if let Some(r) = err.as_mut() {
            let _ = r.read_to_string(&mut e);
        }
        format!("{text}{e}")
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(exit)) => return (exit.success(), reader.join().unwrap_or_default().trim().to_string()),
            Ok(None) if started.elapsed() > limit => {
                let _ = child.kill();
                return (false, format!("git {} took longer than {} s and was stopped.", args.first().unwrap_or(&""), limit.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return (false, e.to_string()),
        }
    }
}

/// The last line of git's output that says something - enough for a notice.
fn gist(output: &str) -> String {
    output.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("").to_string()
}

/// Commits everything changed with this message and pushes it. A message is required - an empty
/// one is refused rather than invented. With nothing to commit but commits waiting, it only pushes.
pub fn commit_and_push(folder: &str, message: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Write a commit message first.".into());
    }
    let (ok, out) = run(folder, &["add", "-A"], Duration::from_secs(60));
    if !ok {
        return Err(format!("git add failed: {}", gist(&out)));
    }
    let (committed, out) = run(folder, &["commit", "-m", message], Duration::from_secs(60));
    if !committed && !out.contains("nothing to commit") {
        return Err(format!("git commit failed: {}", gist(&out)));
    }
    let tracks = run(folder, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], Duration::from_secs(20)).0;
    let (pushed, out) = if tracks {
        run(folder, &["push"], Duration::from_secs(180))
    } else {
        // A new branch: push it to origin and track it, which is what the user would type next.
        let branch = run(folder, &["rev-parse", "--abbrev-ref", "HEAD"], Duration::from_secs(20)).1;
        run(folder, &["push", "-u", "origin", branch.trim()], Duration::from_secs(180))
    };
    if !pushed {
        let reason = gist(&out);
        return Err(if committed {
            format!("Committed, but the push failed: {reason}")
        } else {
            format!("Nothing new to commit, and the push failed: {reason}")
        });
    }
    Ok(if committed { "Committed and pushed.".into() } else { "Nothing new to commit; pushed the waiting commits.".into() })
}

/// Brings in the remote's changes, fast-forward only: it never makes a merge commit, and when the
/// branches have diverged it says so and changes nothing.
pub fn pull(folder: &str) -> Result<String, String> {
    let before = run(folder, &["rev-parse", "HEAD"], Duration::from_secs(20)).1;
    let (ok, out) = run(folder, &["pull", "--ff-only"], Duration::from_secs(180));
    if ok {
        if out.contains("Already up to date") {
            return Ok("Already up to date.".into());
        }
        // Said in people's words - how many commits arrived and what they touched - not git's last line.
        let after = run(folder, &["rev-parse", "HEAD"], Duration::from_secs(20)).1;
        let range = format!("{}..{}", before.trim(), after.trim());
        let commits: usize = run(folder, &["rev-list", "--count", &range], Duration::from_secs(20)).1.trim().parse().unwrap_or(0);
        let touched = out.lines().map(str::trim).find(|l| l.contains("changed")).unwrap_or("").to_string();
        return Ok(format!(
            "Pulled {commits} new commit{}{}.",
            if commits == 1 { "" } else { "s" },
            if touched.is_empty() { String::new() } else { format!(" ({touched})") }
        ));
    }
    if out.contains("Not possible to fast-forward") || out.contains("diverged") {
        return Err("Your branch and the remote have both changed, so nothing was pulled. Merge or rebase in a terminal or VS Code.".into());
    }
    if out.contains("would be overwritten") {
        return Err("Local changes to files the remote also changed - commit or stash them first. Nothing was pulled.".into());
    }
    Err(format!("git pull failed: {}", gist(&out)))
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
        assert_eq!((c.ahead, c.behind, c.upstream), (2, 0, true));
        assert_eq!(&c.files[..4], ["+ notes.txt", "+ new-folder/", "+ staged.py", "~ edited.rs"]);
        assert!(c.files.contains(&"- gone.txt".to_string()) && c.files.contains(&"~ new-name.rs".to_string()));
        assert_eq!(parse(b"## topic...origin/topic [ahead 1, behind 3]\0").behind, 3);
    }

    #[test]
    fn a_clean_repository_and_a_brand_new_one() {
        assert_eq!(parse(b"## main...origin/main\0"), GitCounts { branch: Some("main".into()), upstream: true, ..Default::default() });
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
        // Committing needs a message; pushing with no remote fails after the commit, and says so.
        assert!(commit_and_push(&dir.to_string_lossy(), "  ").is_err());
        let pushed = commit_and_push(&dir.to_string_lossy(), "test commit");
        assert!(pushed.unwrap_err().starts_with("Committed, but the push failed"));
        let c = status(&dir.to_string_lossy()).expect("a repository");
        assert_eq!((c.added, c.modified, c.deleted), (0, 0, 0), "everything was committed");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
