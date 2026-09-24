import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Bringing skills and Python tools along when the folder they live in changes.
 *
 * Asked for directly: *"is it possible to sync tools and skills from previously used folder to
 * newly using folder or bucket?"* Changing `skills.dir` or `python.toolsDir` left everything
 * behind in the old one, and starting to use a bucket published only what you wrote *next* —
 * `onSaved` and `onToolSaved` fire on a write, so a folder of twenty existing skills stayed
 * invisible to the team for ever.
 *
 * ## Nothing is deleted, and nothing is overwritten
 *
 * A copy, never a move. The old folder is left exactly as it was, so a migration that went to the
 * wrong place costs nothing to undo — and a name that already exists at the destination is
 * **skipped and reported**, never replaced. The alternative is somebody's newer version being
 * silently replaced by the older one they were migrating away from, which is the worst possible
 * outcome of an operation whose whole point is not losing anything.
 *
 * ## Why a skill is a folder and a tool is a file
 *
 * A skill may be `name.md` or `name/SKILL.md` (§13), and the folder form carries its pictures and
 * its reference files — so migrating a skill means taking the whole directory when there is one.
 * A Python tool is always a single `.py`; its `.registry.json` belongs to the folder rather than
 * to the tool and is handled separately, by the caller, because approval is per machine and per
 * folder.
 */

export interface MigrationItem {
  /** The name a person would use: `deployment`, `fetch_ledger`. */
  name: string
  /** Absolute path of the file or folder to copy. */
  source: string
  /** Where it would land. */
  destination: string
  /** True when it is a directory (a skill with reference files). */
  directory: boolean
}

export interface MigrationPlan {
  copy: MigrationItem[]
  /** Names already present at the destination, which are left alone. */
  skip: string[]
}

export type MigrationKind = 'skills' | 'tools'

/** `deployment.md`, `deployment/SKILL.md`, `fetch_ledger.py` — the name in each case. */
function nameOf(entry: string, kind: MigrationKind): string {
  return kind === 'skills' ? entry.replace(/\.md$/i, '') : entry.replace(/\.py$/i, '')
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

async function namesAt(dir: string, kind: MigrationKind): Promise<Set<string>> {
  const found = new Set<string>()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    if (kind === 'skills') {
      if (entry.toLowerCase().endsWith('.md')) found.add(nameOf(entry, kind))
      else if (await isDirectory(path.join(dir, entry))) found.add(entry)
    } else if (entry.toLowerCase().endsWith('.py')) {
      found.add(nameOf(entry, kind))
    }
  }
  return found
}

/**
 * What a migration would do, without doing any of it.
 *
 * Separate from performing it for `previewImport`'s reason (§15): the first sight of what a
 * change does should not be the change having happened. The UI shows this and asks.
 */
export async function planMigration(options: {
  from: string
  to: string
  kind: MigrationKind
}): Promise<MigrationPlan> {
  const { from, to, kind } = options
  const copy: MigrationItem[] = []
  const skip: string[] = []

  if (path.resolve(from) === path.resolve(to)) return { copy, skip }

  const existing = await namesAt(to, kind)
  let entries: string[]
  try {
    entries = await fs.readdir(from)
  } catch {
    return { copy, skip }
  }

  for (const entry of entries) {
    // `.registry.json`, `.git` and friends. A tool's approval record belongs to its folder.
    if (entry.startsWith('.')) continue
    const source = path.join(from, entry)
    const directory = await isDirectory(source)

    if (kind === 'skills') {
      if (!directory && !entry.toLowerCase().endsWith('.md')) continue
      // A folder is only a skill when it holds one; anything else is somebody's notes.
      if (directory) {
        try {
          await fs.stat(path.join(source, 'SKILL.md'))
        } catch {
          continue
        }
      }
    } else if (directory || !entry.toLowerCase().endsWith('.py')) {
      continue
    }

    const name = directory ? entry : nameOf(entry, kind)
    if (existing.has(name)) {
      skip.push(name)
      continue
    }
    copy.push({ name, source, destination: path.join(to, entry), directory })
  }

  copy.sort((a, b) => a.name.localeCompare(b.name))
  skip.sort()
  return { copy, skip }
}

export interface MigrationResult {
  copied: string[]
  skipped: string[]
  failed: { name: string; problem: string }[]
}

/**
 * Performs a plan.
 *
 * Each item is attempted on its own and a failure is **reported rather than thrown**: on twenty
 * skills, one locked file must not cost the other nineteen. The same rule `handleSyncS3` follows,
 * for the same reason — a partial answer is useful and a blanket failure is not.
 */
export async function runMigration(plan: MigrationPlan): Promise<MigrationResult> {
  const copied: string[] = []
  const failed: { name: string; problem: string }[] = []

  for (const item of plan.copy) {
    try {
      await fs.mkdir(path.dirname(item.destination), { recursive: true })
      /*
       * `force: false` so an existing destination errors rather than being replaced. The plan
       * already skipped those, and this is the second lock: between planning and running, a sync
       * could have brought the same name down, and losing it here would be a deletion nobody
       * asked for or saw.
       */
      await fs.cp(item.source, item.destination, {
        recursive: item.directory,
        force: false,
        errorOnExist: true,
      })
      copied.push(item.name)
    } catch (error) {
      failed.push({ name: item.name, problem: error instanceof Error ? error.message : String(error) })
    }
  }

  return { copied, skipped: plan.skip, failed }
}

/** One line a person can read, for the toast and the panel. */
export function describeMigration(result: MigrationResult, kind: MigrationKind): string {
  const noun = kind === 'skills' ? 'skill' : 'tool'
  const parts = [`${String(result.copied.length)} ${noun}(s) copied`]
  if (result.skipped.length > 0) {
    parts.push(`${String(result.skipped.length)} already here (${result.skipped.join(', ')})`)
  }
  if (result.failed.length > 0) {
    parts.push(
      `${String(result.failed.length)} failed: ${result.failed
        .map((each) => `${each.name} (${each.problem})`)
        .join('; ')}`,
    )
  }
  return `${parts.join('; ')}.`
}
