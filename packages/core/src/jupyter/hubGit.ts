import path from 'node:path'
import type { HubRuntime } from './tools.js'

/**
 * Git for a JupyterHub codebase, run ON the hub (Fire Code's commit, push and pull buttons, and the
 * sidebar counts).
 *
 * Asked for directly: "fire code should be able to run git commands in hub, to take git actions". A
 * hub codebase's workspace is a local copy without the repository - the repository, its remote and
 * its credentials live on the hub - so Fire Code's own git, which runs here, saw nothing to manage.
 * These run in the codebase's hub kernel instead, the way `hub_run` does.
 *
 * - **Arguments are a list, never a shell string.** A commit message is typed by a person and can be
 *   written by the model ("Write with agent"); it reaches git only as a JSON string literal inside
 *   a Python argument list, so no quoting in it can become a second command (§16's rule).
 * - **Local edits go to the hub first.** Every agent edit is saved as it lands, but an edit made
 *   outside the agent waits for `hub_sync push`; committing on the hub without it would commit a
 *   version older than the one on screen. A save the hub refuses (it changed there) stops the
 *   commit, and says which file.
 * - **Pull fetches the result here afterwards**, so the copy matches what git just brought in.
 * - **The answer comes back behind a marker**, never read off the output: a kernel prints whatever
 *   its libraries like on the same channel (§12l).
 */

export interface HubGitCounts {
  added: number
  modified: number
  deleted: number
  branch?: string
  ahead: number
  behind: number
  upstream: boolean
  files: string[]
}

export type HubGitResult = { ok: true; text: string; counts?: HubGitCounts } | { ok: false; text: string }

const MARKER = '__LC_HUBGIT__'
const LISTED = 40

/** A Python literal for a string or a list of them. JSON is valid Python for both. */
const py = (value: unknown): string => JSON.stringify(value)

/**
 * The Python that runs `op`. Pure, so the exact code is testable: everything model- or user-typed
 * appears only inside `py(...)`.
 */
export function hubGitCode(op: 'status' | 'commit' | 'pull', folders: readonly string[], message?: string): string {
  return [
    'import json as _lc_json, os as _lc_os, subprocess as _lc_sp',
    `_lc_home = globals().setdefault('_lc_home', _lc_os.getcwd())`,
    'def _lc_git(cwd, args, timeout=60):',
    "    env = dict(_lc_os.environ, GIT_TERMINAL_PROMPT='0')",
    '    try:',
    "        r = _lc_sp.run(['git', '--no-optional-locks', *args], cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)",
    "        return {'ok': r.returncode == 0, 'out': r.stdout, 'err': r.stderr}",
    '    except Exception as e:',
    "        return {'ok': False, 'out': '', 'err': str(e)}",
    '_lc_repos = []',
    `for _lc_f in ${py(folders)}:`,
    "    _lc_t = _lc_git(_lc_os.path.join(_lc_home, _lc_f), ['rev-parse', '--show-toplevel'], 20)",
    "    if _lc_t['ok'] and _lc_t['out'].strip() not in _lc_repos:",
    "        _lc_repos.append(_lc_t['out'].strip())",
    '_lc_res = []',
    'for _lc_r in _lc_repos:',
    "    _lc_x = {'repo': _lc_r}",
    ...(op === 'status'
      ? ["    _lc_x['status'] = _lc_git(_lc_r, ['status', '--porcelain=v1', '-z', '--branch', '-unormal'], 30)"]
      : op === 'pull'
        ? ["    _lc_x['pull'] = _lc_git(_lc_r, ['pull', '--ff-only'], 180)"]
        : [
            "    _lc_x['add'] = _lc_git(_lc_r, ['add', '-A'])",
            `    _lc_x['commit'] = _lc_git(_lc_r, ['commit', '-m', ${py(message ?? '')}])`,
            "    _lc_x['tracks'] = _lc_git(_lc_r, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 20)['ok']",
            "    if _lc_x['tracks']:",
            "        _lc_x['push'] = _lc_git(_lc_r, ['push'], 180)",
            '    else:',
            "        _lc_b = _lc_git(_lc_r, ['rev-parse', '--abbrev-ref', 'HEAD'], 20)['out'].strip()",
            "        _lc_x['push'] = _lc_git(_lc_r, ['push', '-u', 'origin', _lc_b], 180)",
          ]),
    '    _lc_res.append(_lc_x)',
    `print(${py(`\n${MARKER}`)} + _lc_json.dumps(_lc_res))`,
  ].join('\n')
}

interface GitRun {
  ok: boolean
  out: string
  err: string
}
interface RepoResult {
  repo: string
  status?: GitRun
  pull?: GitRun
  add?: GitRun
  commit?: GitRun
  tracks?: boolean
  push?: GitRun
}

/** `git status --porcelain=v1 -z --branch`, counted - the same reading as Fire Code's `git.rs`. */
export function parsePorcelain(output: string): HubGitCounts {
  const counts: HubGitCounts = { added: 0, modified: 0, deleted: 0, ahead: 0, behind: 0, upstream: false, files: [] }
  const fields = output.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] as string
    if (entry.length < 3) continue
    if (entry.startsWith('## ')) {
      const head = entry.slice(3).replace(/^No commits yet on /, '')
      counts.upstream = head.includes('...')
      const number = (word: string): number => Number(new RegExp(`${word}\\s+(\\d+)`).exec(head)?.[1] ?? 0)
      counts.ahead = number('ahead')
      counts.behind = number('behind')
      counts.branch = head.split('...')[0]?.split(' ')[0] ?? head
      continue
    }
    const x = entry[0] as string
    const y = entry[1] as string
    const file = entry.slice(3)
    let sign: string
    if (x === '?' || x === 'A') {
      counts.added++
      sign = '+'
    } else if (x === 'D' || y === 'D') {
      counts.deleted++
      sign = '-'
    } else {
      counts.modified++
      sign = '~'
    }
    // A rename carries its old name in the next field.
    if (x === 'R' || x === 'C') i++
    if (counts.files.length < LISTED) counts.files.push(`${sign} ${file}`)
  }
  return counts
}

function gist(run: GitRun | undefined): string {
  const text = `${run?.err ?? ''}\n${run?.out ?? ''}`
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .pop() ?? 'no output'
  )
}

async function runOnHub(runtime: HubRuntime, code: string, signal?: AbortSignal): Promise<RepoResult[] | string> {
  const output = await runtime.kernel.run(code, { timeoutMs: 600_000, ...(signal !== undefined ? { signal } : {}) })
  if (output.error !== undefined) return `${output.error.name}: ${output.error.value}`
  if (output.timedOut === true) return 'git on the hub did not finish in time.'
  const at = output.text.lastIndexOf(MARKER)
  if (at < 0) return 'The hub kernel did not report a result.'
  try {
    return JSON.parse(output.text.slice(at + MARKER.length).trim()) as RepoResult[]
  } catch {
    return 'The hub kernel reported a result that could not be read.'
  }
}

const NOT_A_REPO = 'None of the hub folders is inside a git repository.'

/** Counts across every repository the hub folders belong to; files are prefixed when there are several. */
export async function hubGitStatus(runtime: HubRuntime, signal?: AbortSignal): Promise<HubGitResult> {
  const results = await runOnHub(runtime, hubGitCode('status', runtime.mirror.folders.map((f) => f.remote)), signal)
  if (typeof results === 'string') return { ok: false, text: results }
  if (results.length === 0) return { ok: false, text: NOT_A_REPO }
  const total: HubGitCounts = { added: 0, modified: 0, deleted: 0, ahead: 0, behind: 0, upstream: true, files: [] }
  for (const repo of results) {
    if (repo.status?.ok !== true) continue
    const one = parsePorcelain(repo.status.out)
    total.added += one.added
    total.modified += one.modified
    total.deleted += one.deleted
    total.ahead += one.ahead
    total.behind += one.behind
    total.upstream &&= one.upstream
    if (total.branch === undefined && one.branch !== undefined) total.branch = one.branch
    const prefix = results.length > 1 ? `${path.posix.basename(repo.repo)}/` : ''
    for (const file of one.files) if (total.files.length < LISTED) total.files.push(`${file.slice(0, 2)}${prefix}${file.slice(2)}`)
  }
  return { ok: true, text: '', counts: total }
}

/** Saves local edits to the hub, then commits everything changed and pushes, in each repository. */
export async function hubGitCommitPush(runtime: HubRuntime, message: string, signal?: AbortSignal): Promise<HubGitResult> {
  const trimmed = message.trim()
  if (trimmed.length === 0) return { ok: false, text: 'Write a commit message first.' }

  const pending = await runtime.mirror.pending()
  for (const change of pending.filter((p) => p.kind !== 'deleted')) {
    const saved = await runtime.mirror.push(path.join(runtime.mirror.root, ...change.local.split('/')), signal)
    if (!saved.saved) return { ok: false, text: `Nothing was committed: ${change.local} could not be saved to the hub first (${saved.message}).` }
  }
  const deletedHere = pending.filter((p) => p.kind === 'deleted').length

  const results = await runOnHub(runtime, hubGitCode('commit', runtime.mirror.folders.map((f) => f.remote), trimmed), signal)
  if (typeof results === 'string') return { ok: false, text: results }
  if (results.length === 0) return { ok: false, text: NOT_A_REPO }
  const lines: string[] = []
  let ok = true
  for (const repo of results) {
    const name = results.length > 1 ? `${path.posix.basename(repo.repo)}: ` : ''
    const committed = repo.commit?.ok === true
    const nothing = /nothing to commit/.test(`${repo.commit?.out ?? ''}${repo.commit?.err ?? ''}`)
    if (repo.add?.ok !== true) {
      ok = false
      lines.push(`${name}git add failed on the hub: ${gist(repo.add)}`)
    } else if (!committed && !nothing) {
      ok = false
      lines.push(`${name}git commit failed on the hub: ${gist(repo.commit)}`)
    } else if (repo.push?.ok !== true) {
      ok = false
      lines.push(`${name}${committed ? 'Committed on the hub, but the push failed' : 'Nothing new to commit, and the push failed'}: ${gist(repo.push)}`)
    } else {
      lines.push(`${name}${committed ? 'Committed and pushed from the hub.' : 'Nothing new to commit; pushed the waiting commits.'}`)
    }
  }
  if (deletedHere > 0) {
    lines.push(`${String(deletedHere)} file(s) deleted here are still on the hub, so they were not part of the commit.`)
  }
  return { ok, text: lines.join(' ') }
}

/** `git pull --ff-only` on the hub, then the changes are fetched into the local copy. */
export async function hubGitPull(runtime: HubRuntime, signal?: AbortSignal): Promise<HubGitResult> {
  const results = await runOnHub(runtime, hubGitCode('pull', runtime.mirror.folders.map((f) => f.remote)), signal)
  if (typeof results === 'string') return { ok: false, text: results }
  if (results.length === 0) return { ok: false, text: NOT_A_REPO }
  const lines: string[] = []
  let ok = true
  for (const repo of results) {
    const name = results.length > 1 ? `${path.posix.basename(repo.repo)}: ` : ''
    const all = `${repo.pull?.out ?? ''}${repo.pull?.err ?? ''}`
    if (repo.pull?.ok === true) lines.push(`${name}${/Already up.to.date/i.test(all) ? 'Already up to date.' : 'Pulled on the hub.'}`)
    else {
      ok = false
      lines.push(
        /Not possible to fast-forward|diverged/.test(all)
          ? `${name}The hub's branch and the remote have both changed, so nothing was pulled. Merge or rebase there (hub_run shell).`
          : /would be overwritten/.test(all)
            ? `${name}Uncommitted changes on the hub to files the remote also changed - commit them first. Nothing was pulled.`
            : `${name}git pull failed on the hub: ${gist(repo.pull)}`,
      )
    }
  }
  const fetched = await runtime.mirror.pull(signal).catch(() => undefined)
  if (fetched !== undefined && fetched.fetched.length + fetched.removed.length > 0) {
    lines.push(`Copied ${String(fetched.fetched.length + fetched.removed.length)} changed file(s) here.`)
  }
  if (fetched !== undefined && fetched.conflicts.length > 0) {
    lines.push(`Kept as they are here (changed on both sides): ${fetched.conflicts.slice(0, 10).join(', ')}.`)
  }
  return { ok, text: lines.join(' ') }
}

/** What changed on the hub, for "Write with agent": `git status --short` and the diff, per repository. */
export async function hubGitDiff(runtime: HubRuntime, signal?: AbortSignal): Promise<{ status: string; diff: string } | string> {
  const folders = runtime.mirror.folders.map((f) => f.remote)
  const code = hubGitCode('status', folders).replace(
    "    _lc_x['status'] = _lc_git(_lc_r, ['status', '--porcelain=v1', '-z', '--branch', '-unormal'], 30)",
    [
      "    _lc_x['status'] = _lc_git(_lc_r, ['status', '--short', '--untracked-files=normal'], 30)",
      "    _lc_d = _lc_git(_lc_r, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--stat', '--patch'], 60)",
      "    _lc_x['pull'] = _lc_d if _lc_d['ok'] else _lc_git(_lc_r, ['diff', '--no-color', '--no-ext-diff', '--stat', '--patch'], 60)",
    ].join('\n'),
  )
  const results = await runOnHub(runtime, code, signal)
  if (typeof results === 'string') return results
  if (results.length === 0) return NOT_A_REPO
  return {
    status: results.map((r) => r.status?.out ?? '').join('\n'),
    diff: results.map((r) => r.pull?.out ?? '').join('\n'),
  }
}
