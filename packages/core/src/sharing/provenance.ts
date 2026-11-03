import { execFile } from 'node:child_process'
import path from 'node:path'

/**
 * Who changed a skill or tool, and when, from the place that actually knows: its version history.
 *
 * Asked for after "updated by" showed the wrong person: a file's own labels (`sharing/attribution.ts`)
 * say who saved it only when the last save was Light Code's, and say nothing of an edit made in an
 * editor, a merge, or a colleague's commit. So the history wins - the team repository's commits in
 * Bitbucket when the file is kept there, else `git log` when it sits in a git checkout - and the
 * labels are what is left when neither knows.
 */
export interface FileCommit {
  /** Commit id, shortened for display. */
  id: string
  by: string
  email?: string | undefined
  /** Epoch seconds. */
  at: number
  message: string
}

export interface FileHistory {
  source: 'bitbucket' | 'git'
  /** Newest first. */
  commits: FileCommit[]
  /** The file has changes here that no commit holds yet: the newest commit is not the last change. */
  uncommitted?: boolean
  /** Where it lives in that history, for the reader. */
  where: string
}

const SEPARATOR = '\u001f'

function git(args: readonly string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', [...args], { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout)
    })
  })
}

/** One commit line of `git log --format=%h%x1f%an%x1f%ae%x1f%at%x1f%s`. */
export function parseGitLog(text: string): FileCommit[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(SEPARATOR))
    .filter((parts) => parts.length >= 5 && parts[0] !== '')
    .map(([id, by, email, at, ...message]) => ({ id: id ?? '', by: by ?? '', ...(email ? { email } : {}), at: Number(at), message: message.join(SEPARATOR) }))
    .filter((c) => Number.isFinite(c.at))
}

/**
 * The file's history in the git checkout it sits in, newest first, or undefined when it is in none (or git is
 * absent). Read only: `log` and `status`, with `--no-optional-locks` so a status never takes the index lock a
 * person's own commit needs.
 */
export async function gitFileHistory(file: string, limit = 50): Promise<FileHistory | undefined> {
  const dir = path.dirname(file)
  const top = (await git(['rev-parse', '--show-toplevel'], dir))?.trim()
  if (top === undefined || top === '') return undefined
  const log = await git(['--no-optional-locks', 'log', `-n${String(limit)}`, '--follow', `--format=%h${'%x1f'}%an${'%x1f'}%ae${'%x1f'}%at${'%x1f'}%s`, '--', path.basename(file)], dir)
  if (log === undefined) return undefined
  const commits = parseGitLog(log)
  if (commits.length === 0) return undefined
  const status = await git(['--no-optional-locks', 'status', '--porcelain', '--', path.basename(file)], dir)
  return { source: 'git', commits, ...(status !== undefined && status.trim() !== '' ? { uncommitted: true } : {}), where: path.relative(top, file).split(path.sep).join('/') }
}
