//! Branch folders: several branches of one codebase open at once, each a chat tab working in its own
//! folder (git worktrees). The same rules as Light Code's `packages/core/src/git/worktrees.ts`, which the
//! host uses to set a new folder up: folders go beside the repository (`<repo>.worktrees/<branch>`) unless
//! `branches.folder` says where; git itself refuses one branch in two folders and a folder with
//! uncommitted work; closing a folder never deletes the branch. Every git call takes its arguments as a
//! list, never through a shell, and a branch name that git would not accept is refused before it is used.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(args: &[&str], cwd: &Path) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|_| "git could not be started - is it installed and on PATH?".to_string())?;
    if !output.status.success() {
        let text = String::from_utf8_lossy(if output.stderr.is_empty() { &output.stdout } else { &output.stderr }).trim().to_string();
        return Err(if text.is_empty() { format!("git {} failed", args.first().unwrap_or(&"")) } else { text });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct OpenFolder {
    pub branch: String,
    pub path: String,
    pub main: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Branches {
    pub local: Vec<String>,
    /// Remote branches (as `origin/name`) with no local branch of that name.
    pub remote: Vec<String>,
    pub open: Vec<OpenFolder>,
    pub current: Option<String>,
    /// Where a new branch starts by default: the main branch (the remote's default, else main, else master),
    /// only failing those the branch checked out. Asked for: "by default it should clone from main or master".
    #[serde(rename = "defaultBranch")]
    pub default_branch: Option<String>,
    /// The repository has no commits yet: git makes a branch with the first commit, so there is nothing
    /// to open or start from. Reported, so the dialog can say so rather than show an empty list.
    #[serde(rename = "noCommits")]
    pub no_commits: bool,
}

pub fn list(repo: &Path) -> Result<Branches, String> {
    let lines = |text: String| text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect::<Vec<_>>();
    let mut local = lines(git(&["for-each-ref", "--format=%(refname:short)", "refs/heads/"], repo)?);
    local.sort();
    let mut remote: Vec<String> = lines(git(&["for-each-ref", "--format=%(refname:short)", "refs/remotes/"], repo)?)
        .into_iter()
        .filter(|name| !name.ends_with("/HEAD") && name.contains('/'))
        .filter(|name| !local.iter().any(|l| Some(l.as_str()) == name.split_once('/').map(|(_, rest)| rest)))
        .collect();
    remote.sort();
    let mut open = Vec::new();
    let mut path: Option<String> = None;
    for line in git(&["worktree", "list", "--porcelain"], repo)?.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p.replace('/', "\\"));
        } else if let (Some(b), Some(p)) = (line.strip_prefix("branch refs/heads/"), path.as_ref()) {
            open.push(OpenFolder { branch: b.to_string(), path: p.clone(), main: open.is_empty() });
        }
    }
    let current = git(&["rev-parse", "--abbrev-ref", "HEAD"], repo).ok().map(|s| s.trim().to_string()).filter(|s| s != "HEAD");
    let has = |name: &str| -> Option<String> {
        if local.iter().any(|l| l == name) {
            return Some(name.to_string());
        }
        remote.iter().find(|r| r.split_once('/').map(|(_, rest)| rest) == Some(name)).cloned()
    };
    let from_remote = git(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo).ok().map(|h| h.trim().to_string()).filter(|h| !h.is_empty()).map(|head| {
        let name = head.split_once('/').map(|(_, rest)| rest.to_string()).unwrap_or_else(|| head.clone());
        has(&name).unwrap_or(head)
    });
    let default_branch = from_remote.or_else(|| has("main")).or_else(|| has("master")).or_else(|| current.clone());
    let no_commits = git(&["rev-parse", "--verify", "--quiet", "HEAD"], repo).is_err();
    Ok(Branches { local, remote, open, current, default_branch, no_commits })
}

/// Refuses a name git would refuse, or one that could be read as an option.
pub fn check_name(repo: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') || name.trim() != name {
        return Err(format!("\"{name}\" is not a branch name git accepts."));
    }
    git(&["check-ref-format", "--branch", name], repo).map(|_| ()).map_err(|_| format!("\"{name}\" is not a branch name git accepts."))
}

/// `feature/login` -> `feature-login`; an `origin/` prefix is dropped.
pub fn folder_name(branch: &str) -> String {
    let branch = branch.strip_prefix("origin/").unwrap_or(branch);
    let name: String = branch.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_whitespace() { '-' } else { c }).collect();
    let name = name.trim_matches('-').to_string();
    if name.is_empty() { "branch".into() } else { name }
}

/// Beside the repository (`<repo>.worktrees/<branch>`), or under a folder the user chose; never an existing folder.
pub fn folder_for(repo: &Path, branch: &str, chosen: Option<&str>) -> PathBuf {
    let repo_name = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    let base = match chosen.map(str::trim).filter(|c| !c.is_empty()) {
        Some(root) => PathBuf::from(root).join(&repo_name),
        None => repo.parent().unwrap_or(repo).join(format!("{repo_name}.worktrees")),
    };
    let mut folder = base.join(folder_name(branch));
    let mut n = 2;
    while folder.exists() {
        folder = base.join(format!("{}-{n}", folder_name(branch)));
        n += 1;
    }
    folder
}

/// Opens a branch in a new folder: a local branch, a remote one (checked out tracking it), or - with
/// `from` - a new branch made from `from`. Returns the folder and the local branch name.
pub fn add(repo: &Path, branch: &str, from: Option<&str>, folder: &Path) -> Result<(PathBuf, String), String> {
    if let Some(parent) = folder.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let folder_text = folder.to_string_lossy().into_owned();
    if let Some(from) = from {
        check_name(repo, branch)?;
        git(&["worktree", "add", "-b", branch, "--", &folder_text, from], repo)?;
        return Ok((folder.to_path_buf(), branch.to_string()));
    }
    let known = list(repo)?;
    if known.local.iter().any(|b| b == branch) {
        git(&["worktree", "add", "--", &folder_text, branch], repo)?;
        return Ok((folder.to_path_buf(), branch.to_string()));
    }
    if known.remote.iter().any(|b| b == branch) {
        let local = branch.split_once('/').map(|(_, rest)| rest).unwrap_or(branch);
        check_name(repo, local)?;
        git(&["worktree", "add", "--track", "-b", local, "--", &folder_text, branch], repo)?;
        return Ok((folder.to_path_buf(), local.to_string()));
    }
    Err(format!("There is no branch \"{branch}\" here. Fetch first, or make it a new branch from another."))
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStatus {
    pub uncommitted: usize,
    pub unpushed: Option<usize>,
    pub no_upstream: bool,
}

pub fn status(folder: &Path) -> Result<FolderStatus, String> {
    let uncommitted = git(&["status", "--porcelain"], folder)?.lines().filter(|l| !l.trim().is_empty()).count();
    match git(&["rev-list", "--count", "@{upstream}..HEAD"], folder) {
        Ok(count) => Ok(FolderStatus { uncommitted, unpushed: count.trim().parse().ok(), no_upstream: false }),
        Err(_) => Ok(FolderStatus { uncommitted, unpushed: None, no_upstream: true }),
    }
}

/// Removes a branch folder - never the branch, never the main checkout. Without `force` git refuses a folder
/// with uncommitted or untracked changes.
pub fn remove(repo: &Path, folder: &Path, force: bool) -> Result<(), String> {
    let known = list(repo)?;
    let wanted = folder.to_string_lossy().to_lowercase().replace('/', "\\");
    let target = known.open.iter().find(|o| o.path.to_lowercase() == wanted.trim_end_matches('\\'));
    if target.map(|o| o.main) == Some(true) {
        return Err("That is the repository's main checkout, which is never removed.".into());
    }
    let folder_text = folder.to_string_lossy().into_owned();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push("--");
    args.push(&folder_text);
    git(&args, repo)?;
    let _ = git(&["worktree", "prune"], repo);
    Ok(())
}

/// Marks a new branch folder for its one-time setup, beside git's own record of the worktree (never in the
/// folder); the Light Code host in the new tab copies the listed files and runs the setup command.
pub fn mark_for_setup(folder: &Path) -> Result<(), String> {
    let dot_git = std::fs::read_to_string(folder.join(".git")).map_err(|e| format!("Could not read {}: {e}", folder.join(".git").display()))?;
    let git_dir = dot_git.lines().find_map(|l| l.strip_prefix("gitdir:")).map(str::trim).ok_or("Not a branch folder.")?;
    let git_dir = folder.join(git_dir);
    std::fs::write(git_dir.join("light-code-setup-pending"), "").map_err(|e| format!("Could not mark {} for setup: {e}", folder.display()))
}

/// `branches.folder` from a codebase's Light Code settings, where branch folders go when it is set.
pub fn chosen_root(config_file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(config_file).ok()?;
    let value: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    value.get("branches")?.get("folder")?.as_str().map(str::to_string).filter(|s| !s.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str], cwd: &Path) {
        assert!(Command::new("git").args(args).current_dir(cwd).output().unwrap().status.success(), "git {args:?}");
    }

    fn repo() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("fc-branches-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let repo = root.join("payments");
        std::fs::create_dir_all(&repo).unwrap();
        run(&["init", "-b", "main"], &repo);
        run(&["config", "user.email", "t@example.com"], &repo);
        run(&["config", "user.name", "T"], &repo);
        std::fs::write(repo.join("app.txt"), "v1\n").unwrap();
        run(&["add", "."], &repo);
        run(&["commit", "-m", "first"], &repo);
        run(&["branch", "feature/login"], &repo);
        (root, repo)
    }

    #[test]
    fn opens_lists_and_closes_a_branch_folder_without_touching_the_branch() {
        let (root, repo) = repo();
        let folder = folder_for(&repo, "feature/login", None);
        assert_eq!(folder, root.join("payments.worktrees").join("feature-login"));
        let (made, branch) = add(&repo, "feature/login", None, &folder).unwrap();
        assert_eq!(branch, "feature/login");
        assert!(made.join("app.txt").is_file());
        mark_for_setup(&made).unwrap();
        let listed = list(&repo).unwrap();
        assert_eq!(listed.open.len(), 2);
        assert!(listed.open[0].main && !listed.open[1].main);
        assert_eq!(listed.current.as_deref(), Some("main"));
        assert_eq!(listed.default_branch.as_deref(), Some("main"));

        std::fs::write(made.join("new.txt"), "x").unwrap();
        assert_eq!(status(&made).unwrap(), FolderStatus { uncommitted: 1, unpushed: None, no_upstream: true });
        assert!(remove(&repo, &made, false).is_err(), "git refuses a folder with uncommitted work");
        remove(&repo, &made, true).unwrap();
        assert!(!made.exists());
        assert!(list(&repo).unwrap().local.contains(&"feature/login".to_string()));
        assert!(remove(&repo, &repo, false).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn makes_a_new_branch_and_refuses_names_git_would_not_take() {
        let (root, repo) = repo();
        let folder = folder_for(&repo, "PAY-12-fix", None);
        add(&repo, "PAY-12-fix", Some("main"), &folder).unwrap();
        assert!(list(&repo).unwrap().local.contains(&"PAY-12-fix".to_string()));
        assert!(add(&repo, "--upload-pack=evil", Some("main"), &root.join("x")).is_err());
        assert!(add(&repo, "PAY-12-fix", None, &folder_for(&repo, "PAY-12-fix", None)).is_err(), "one branch, one folder");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn says_when_the_repository_has_no_commits_yet() {
        let root = std::env::temp_dir().join(format!("fc-empty-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        run(&["init", "-b", "master"], &root);
        let listed = list(&root).unwrap();
        assert!(listed.no_commits);
        assert!(listed.local.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn names_folders() {
        assert_eq!(folder_name("feature/login"), "feature-login");
        assert_eq!(folder_name("origin/release/2.0"), "release-2.0");
    }
}
