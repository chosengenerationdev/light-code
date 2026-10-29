import { execFile } from 'node:child_process'
import { constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Several branches of one repository open at once, each in its own folder (git worktrees).
 *
 * Asked for: "work in different branches under same repo from same machine ... run and test the changes in
 * different branches too". Git has done this since 2.5: \`git worktree add\` makes a second working folder
 * on another branch, sharing the repository's history, and git itself refuses to open one branch twice or
 * to remove a folder with uncommitted work. Light Code adds where the folder goes, a one-time setup in it,
 * and a close that checks first. Nothing here reaches the network: a remote branch is checked out from
 * what is already fetched.
 *
 * Every git call passes arguments as a list (never a shell), so a branch name can never become a command.
 */

export interface WorktreeInfo {
  path: string
  /** The branch checked out there; undefined for a detached HEAD. */
  branch?: string | undefined
  head?: string | undefined
  /** The repository's main checkout (the first worktree git lists). */
  main: boolean
  /** The folder is gone but git still lists it - \`git worktree prune\` forgets it. */
  missing?: boolean | undefined
}

export interface WorktreeStatus {
  /** Files changed and not committed, including new ones. */
  uncommitted: number
  /** Commits not on the branch's upstream; undefined when it has none. */
  unpushed?: number | undefined
  /** No upstream at all: nothing has ever been pushed from this branch. */
  noUpstream?: boolean | undefined
}

export class GitError extends Error {}

function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null) {
        if (typeof (error as { code?: unknown }).code !== 'number') {
          reject(new GitError('git could not be started - is it installed and on PATH?'))
          return
        }
        reject(new GitError((stderr || stdout || error.message).trim()))
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * The repository's main checkout when \`folder\` is a linked worktree; undefined for the main checkout itself
 * or a folder that is not in git. Synchronous and file-only (no git run): it is read once when a session
 * starts, to file this branch's approvals and codebase instructions under the repository they belong to.
 *
 * A linked worktree's \`.git\` is a file - \`gitdir: <repo>/.git/worktrees/<name>\` - whose folder holds
 * \`commondir\` pointing back at the repository's \`.git\`.
 */
export function mainCheckoutOf(folder: string): string | undefined {
  try {
    const dotGit = path.join(folder, '.git')
    if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return undefined
    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
    if (match?.[1] === undefined) return undefined
    const gitDir = path.resolve(folder, match[1].trim())
    const common = path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim())
    return path.basename(common) === '.git' ? path.dirname(common) : undefined
  } catch {
    return undefined
  }
}

/** The branch checked out in a folder, read from git's own files; undefined when detached or not git. */
export function currentBranchOf(folder: string): string | undefined {
  try {
    const dotGit = path.join(folder, '.git')
    let gitDir = dotGit
    if (!statSync(dotGit).isDirectory()) {
      const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
      if (match?.[1] === undefined) return undefined
      gitDir = path.resolve(folder, match[1].trim())
    }
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : undefined
  } catch {
    return undefined
  }
}

/** Every worktree of the repository \`folder\` belongs to, main checkout first. */
export async function listWorktrees(folder: string): Promise<WorktreeInfo[]> {
  const out = await git(['worktree', 'list', '--porcelain'], folder)
  const worktrees: WorktreeInfo[] = []
  let current: Partial<WorktreeInfo> | undefined
  const flush = (): void => {
    if (current?.path !== undefined) worktrees.push({ path: current.path, main: worktrees.length === 0, ...current } as WorktreeInfo)
    current = undefined
  }
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: path.normalize(line.slice('worktree '.length)) }
    } else if (current !== undefined && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (current !== undefined && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (current !== undefined && line.startsWith('prunable')) {
      current.missing = true
    }
  }
  flush()
  return worktrees.map((each, index) => ({ ...each, main: index === 0 }))
}

export interface BranchList {
  local: string[]
  /** Remote branches without a local branch of the same name, as \`origin/name\`. */
  remote: string[]
}

export async function listBranches(folder: string): Promise<BranchList> {
  const local = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], folder)).split(/\r?\n/).filter(Boolean)
  const remote = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/'], folder))
    .split(/\r?\n/)
    .filter((name) => name.length > 0 && !name.endsWith('/HEAD') && name.includes('/'))
    .filter((name) => !local.includes(name.slice(name.indexOf('/') + 1)))
  return { local: local.sort(), remote: remote.sort() }
}

/** Refuses a branch name git would refuse, or one that could be read as an option. */
export async function checkBranchName(folder: string, name: string): Promise<void> {
  if (name.startsWith('-') || name.trim() !== name || name.length === 0) throw new GitError(`"${name}" is not a branch name git accepts.`)
  try {
    await git(['check-ref-format', '--branch', name], folder)
  } catch {
    throw new GitError(`"${name}" is not a branch name git accepts.`)
  }
}

/** A folder name for a branch: \`feature/login\` -> \`feature-login\`. */
export function branchFolderName(branch: string): string {
  return branch.replace(/^[^/]+\/(?=.)/, (prefix) => (prefix === 'origin/' ? '' : prefix)).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'
}

/**
 * Where a branch's folder goes: \`<parent of the main checkout>/<repo>.worktrees/<branch>\` - beside the
 * repository, never inside it, so the repository's own status stays clean - or under a folder the user chose.
 */
export function worktreeFolderFor(mainCheckout: string, branch: string, chosenRoot?: string): string {
  const base = chosenRoot !== undefined && chosenRoot.trim().length > 0
    ? path.join(path.resolve(chosenRoot), path.basename(mainCheckout))
    : path.join(path.dirname(mainCheckout), `${path.basename(mainCheckout)}.worktrees`)
  let folder = path.join(base, branchFolderName(branch))
  for (let n = 2; existsSync(folder); n++) folder = path.join(base, `${branchFolderName(branch)}-${String(n)}`)
  return folder
}

/**
 * Opens a branch in a new folder. \`branch\` is a local branch, a remote one (\`origin/name\`, checked out as a
 * local branch tracking it), or - with \`from\` - a new branch made from \`from\`.
 */
export async function addWorktree(options: {
  repo: string
  branch: string
  from?: string | undefined
  folder: string
}): Promise<{ folder: string; branch: string }> {
  const { repo, folder } = options
  await fs.mkdir(path.dirname(folder), { recursive: true })
  if (options.from !== undefined) {
    await checkBranchName(repo, options.branch)
    await git(['worktree', 'add', '-b', options.branch, '--', folder, options.from], repo)
    return { folder, branch: options.branch }
  }
  const branches = await listBranches(repo)
  if (branches.local.includes(options.branch)) {
    await git(['worktree', 'add', '--', folder, options.branch], repo)
    return { folder, branch: options.branch }
  }
  if (branches.remote.includes(options.branch)) {
    const local = options.branch.slice(options.branch.indexOf('/') + 1)
    await checkBranchName(repo, local)
    await git(['worktree', 'add', '--track', '-b', local, '--', folder, options.branch], repo)
    return { folder, branch: local }
  }
  throw new GitError(`There is no branch "${options.branch}" here. Fetch first, or make it a new branch from another.`)
}

/** What closing a branch folder would lose: uncommitted files, and commits not pushed. */
export async function worktreeStatus(folder: string): Promise<WorktreeStatus> {
  const changed = (await git(['status', '--porcelain'], folder)).split(/\r?\n/).filter(Boolean).length
  try {
    const counts = (await git(['rev-list', '--count', '@{upstream}..HEAD'], folder)).trim()
    return { uncommitted: changed, unpushed: Number(counts) || 0 }
  } catch {
    return { uncommitted: changed, noUpstream: true }
  }
}

/**
 * Removes a branch folder - never the branch. Without \`force\`, git itself refuses a folder with uncommitted
 * or untracked changes; the caller shows \`worktreeStatus\` first and asks before forcing.
 */
export async function removeWorktree(repo: string, folder: string, force = false): Promise<void> {
  const worktrees = await listWorktrees(repo)
  const target = worktrees.find((each) => samePath(each.path, folder))
  if (target === undefined) throw new GitError(`${folder} is not a branch folder of this repository.`)
  if (target.main) throw new GitError('That is the repository\'s main checkout, which is never removed.')
  await git(['worktree', 'remove', ...(force ? ['--force'] : []), '--', target.path], repo)
  await git(['worktree', 'prune'], repo).catch(() => undefined)
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string): string => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value))
  return norm(a) === norm(b)
}

/** Waiting for its one-time setup: written beside git's own record of the worktree, never in the folder. */
export function setupMarkerFor(folder: string): string | undefined {
  try {
    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(path.join(folder, '.git'), 'utf8'))
    return match?.[1] === undefined ? undefined : path.join(path.resolve(folder, match[1].trim()), 'light-code-setup-pending')
  } catch {
    return undefined
  }
}

/**
 * Files git does not track that a branch needs to run (a local \`.env\`), copied from the main checkout.
 * Each name is relative to the checkout and must stay inside it; one already in the branch folder is kept.
 */
export async function copySetupFiles(mainCheckout: string, folder: string, names: readonly string[]): Promise<{ copied: string[]; skipped: string[] }> {
  const copied: string[] = []
  const skipped: string[] = []
  for (const name of names) {
    const from = path.resolve(mainCheckout, name)
    const to = path.resolve(folder, name)
    const inside = (root: string, target: string): boolean => {
      const relative = path.relative(root, target)
      return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
    }
    if (!inside(mainCheckout, from) || !inside(folder, to)) {
      skipped.push(`${name} (outside the checkout)`)
      continue
    }
    try {
      await fs.mkdir(path.dirname(to), { recursive: true })
      if ((await fs.stat(from)).isDirectory()) {
        // A folder (.vscode): every file in it, never replacing one the branch already has (a committed copy wins).
        await fs.cp(from, to, { recursive: true, force: false, errorOnExist: false })
      } else {
        await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL)
      }
      copied.push(name)
    } catch (error) {
      const code = (error as { code?: string }).code
      skipped.push(`${name} (${code === 'EEXIST' ? 'already there' : code === 'ENOENT' ? 'not in the main checkout' : String(code)})`)
    }
  }
  return { copied, skipped }
}

/**
 * The repository a folder belongs to, as its main checkout - the same answer from the main checkout, from a
 * branch folder, or from a folder inside either. Undefined when the folder is not in git.
 */
export async function repositoryOf(folder: string): Promise<string | undefined> {
  try {
    const top = path.normalize((await git(['rev-parse', '--show-toplevel'], folder)).trim())
    return mainCheckoutOf(top) ?? top
  } catch {
    return undefined
  }
}

/** Marks a new branch folder as waiting for its one-time setup (copy files, run the setup command). */
export async function markForSetup(folder: string): Promise<void> {
  const marker = setupMarkerFor(folder)
  if (marker !== undefined) await fs.writeFile(marker, '', 'utf8')
}

/**
 * Where a new branch starts by default: the repository's main branch - the one the remote marks as its
 * default (origin/HEAD), else main, else master - and only failing those, the branch checked out. Asked for:
 * "by default it should clone from main or master branch". Returns a local branch when there is one, else
 * the remote one (origin/main).
 */
export async function defaultBaseBranch(repo: string): Promise<string | undefined> {
  const branches = await listBranches(repo).catch(() => ({ local: [] as string[], remote: [] as string[] }))
  const has = (name: string): string | undefined =>
    branches.local.includes(name) ? name : branches.remote.find((remote) => remote.slice(remote.indexOf('/') + 1) === name)
  try {
    const head = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo)).trim()
    const name = head.slice(head.indexOf('/') + 1)
    const found = has(name) ?? (head.length > 0 ? head : undefined)
    if (found !== undefined) return found
  } catch {
    // No remote, or its HEAD was never recorded: fall back to the usual names.
  }
  return has('main') ?? has('master') ?? currentBranchOf(repo)
}
