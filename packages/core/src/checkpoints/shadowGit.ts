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
    return ['--git-dir', this.shadowDir, '--work-tree', this.workspaceRoot, ...args]
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
