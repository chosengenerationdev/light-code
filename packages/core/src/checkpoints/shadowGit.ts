import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface Checkpoint {
  /** The shadow-git commit hash this snapshot can be restored from. */
  commit: string
  createdAt: number
}

interface GitResult {
  stdout: string
  stderr: string
  code: number
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof (error as { code?: unknown }).code !== 'number') {
        reject(error) // git missing or failed to spawn at all
        return
      }
      resolve({ stdout, stderr, code: (error as { code?: number } | null)?.code ?? 0 })
    })
  })
}

/**
 * Snapshots the workspace before the first edit of a task so it can be rolled back.
 * Borrowed from Roo (CLAUDE.md §8) — cheap insurance, and it pairs with the deliberately
 * strict `apply_diff` matching: a rejected edit costs a retry, a misapplied one costs data.
 *
 * Uses a **separate git directory** with the workspace as its work tree, so the user's own
 * repository — its index, branches, stash, and history — is never touched. That is the
 * whole reason for the `--git-dir`/`--work-tree` split rather than committing in place.
 */
export class ShadowGit {
  constructor(
    private readonly workspaceRoot: string,
    /** Somewhere outside the workspace — the host passes a path under global storage. */
    private readonly shadowDir: string,
  ) {}

  private gitArgs(args: string[]): string[] {
    // A snapshot keeps bytes exactly as they were. Without this the user's global core.autocrlf
    // (true on most Windows installs) turned every LF file into CRLF on rollback.
    return ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '--git-dir', this.shadowDir, '--work-tree', this.workspaceRoot, ...args]
  }

  /**
   * The workspace's own .gitattributes would still apply eol and filter rules; in the shadow repo's
   * info/attributes, which outranks them, everything is just bytes. Written on every snapshot so a
   * shadow repo made by an older version gets it too.
   */
  private async keepBytes(): Promise<void> {
    const file = path.join(this.shadowDir, 'info', 'attributes')
    try {
      if ((await fs.readFile(file, 'utf8')).includes('* -text')) return
    } catch {
      // Not there yet.
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '* -text -filter -diff\n')
  }

  /** Safe to call repeatedly; only the first call does any work. */
  async init(): Promise<void> {
    if (await this.isInitialized()) return

    await fs.mkdir(path.dirname(this.shadowDir), { recursive: true })
    await runGit(['init', '--bare', this.shadowDir], this.workspaceRoot)

    // Identity is set locally so the snapshot never depends on (or is attributed to) the
    // user's global git config.
    await runGit(this.gitArgs(['config', 'user.name', 'Light Code']), this.workspaceRoot)
    await runGit(this.gitArgs(['config', 'user.email', 'light-code@localhost']), this.workspaceRoot)
    // The workspace's own .gitignore still applies, so node_modules and friends stay out.
    await runGit(this.gitArgs(['config', 'core.excludesFile', '']), this.workspaceRoot)
  }

  private async isInitialized(): Promise<boolean> {
    try {
      await fs.access(path.join(this.shadowDir, 'HEAD'))
      return true
    } catch {
      return false
    }
  }

  async snapshot(): Promise<Checkpoint> {
    await this.init()
    await this.keepBytes()
    await runGit(this.gitArgs(['add', '-A']), this.workspaceRoot)

    // `--allow-empty` so a snapshot with no changes since the last one still yields a
    // commit to roll back to, rather than silently failing.
    const commit = await runGit(
      this.gitArgs(['commit', '--allow-empty', '-m', `checkpoint ${new Date().toISOString()}`]),
      this.workspaceRoot,
    )
    if (commit.code !== 0 && !commit.stdout.includes('nothing to commit')) {
      throw new Error(`Could not create checkpoint: ${commit.stderr || commit.stdout}`)
    }

    const head = await runGit(this.gitArgs(['rev-parse', 'HEAD']), this.workspaceRoot)
    if (head.code !== 0) {
      throw new Error(`Could not read checkpoint commit: ${head.stderr}`)
    }
    return { commit: head.stdout.trim(), createdAt: Date.now() }
  }

  /**
   * Restores tracked files to the snapshot. Files created *after* the snapshot are removed
   * too — otherwise "rollback" would leave the workspace in a state that never existed.
   */
  async restore(checkpoint: Checkpoint): Promise<void> {
    const restore = await runGit(this.gitArgs(['restore', '--source', checkpoint.commit, '--worktree', '.']), this.workspaceRoot)
    if (restore.code !== 0) {
      throw new Error(`Could not roll back to checkpoint: ${restore.stderr || restore.stdout}`)
    }
    await runGit(this.gitArgs(['clean', '-fd']), this.workspaceRoot)
  }

  /**
   * Restores only these files to the snapshot - for a codebase several chats share (Sun Code),
   * where restoring everything would undo another chat's work too. A file that did not exist at the
   * snapshot is removed, as the whole-workspace restore removes it. Paths outside the workspace are
   * skipped: the snapshot never held them. Returns what was restored and what was removed.
   */
  async restoreFiles(checkpoint: Checkpoint, files: readonly string[]): Promise<{ restored: string[]; removed: string[] }> {
    const restored: string[] = []
    const removed: string[] = []
    for (const file of files) {
      const relative = path.relative(this.workspaceRoot, file)
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue
      const spec = relative.split(path.sep).join('/')
      const existed = await runGit(this.gitArgs(['cat-file', '-e', `${checkpoint.commit}:${spec}`]), this.workspaceRoot)
      if (existed.code === 0) {
        const result = await runGit(this.gitArgs(['restore', '--source', checkpoint.commit, '--worktree', '--', spec]), this.workspaceRoot)
        if (result.code !== 0) throw new Error(`Could not roll back ${spec}: ${result.stderr || result.stdout}`)
        restored.push(spec)
      } else {
        await fs.rm(file, { force: true })
        removed.push(spec)
      }
    }
    return { restored, removed }
  }

  /** Whether `git` is on PATH at all — checkpoints degrade to unavailable, not to a crash. */
  static async isGitAvailable(): Promise<boolean> {
    try {
      const result = await runGit(['--version'], process.cwd())
      return result.code === 0
    } catch {
      return false
    }
  }
}
