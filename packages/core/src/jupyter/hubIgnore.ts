import { ignoreDecision, parseIgnoreFile, type IgnoreRule } from '../tools/nativeSearch.js'

/**
 * `.hubignore`: files and folders a JupyterHub codebase never syncs (Fire Code).
 *
 * Asked for directly, for an Angular project in a hub folder: "a feature like .gitignore, say
 * .hubignore, where files and folders will not be synced to hub". A project's build output and
 * caches (`dist/`, `.angular/`, `coverage/`) are thousands of files that are rebuilt on whichever
 * side needs them, and copying them both ways costs minutes per sync and can hit the hub's quota.
 *
 * - **gitignore syntax**, parsed by the same code that reads `.gitignore` for the built-in search
 *   (`tools/nativeSearch.ts`), so a rule means here what it means there: `#` comments, `*`, `**`,
 *   a trailing `/` for folders only, a leading `/` for this folder only, `!` to bring one back.
 * - **In any folder**, applying to what is under it, as `.gitignore` does. Read from this machine's
 *   copy when there is one - an edit here applies before it reaches the hub - otherwise from the hub.
 * - **The built-in skips are the starting point**, not a separate list: dot-files and dot-folders,
 *   `node_modules`, `.git`, virtualenvs and Python caches are skipped unless a `!` line says
 *   otherwise (`!.editorconfig`). The `.hubignore` file itself is always synced, so the hub and every
 *   other machine follow the same rules.
 * - **An ignored folder is not entered at all**, as in git: nothing inside it can be brought back.
 */

export const HUBIGNORE = '.hubignore'

/** Never synced unless a `!` line brings them back: machine state and caches. */
export const BUILT_IN_SKIPS = new Set([
  '.ipynb_checkpoints',
  '__pycache__',
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
])

/** Skipped before any `.hubignore` rule is read. */
export function skippedByDefault(name: string): boolean {
  if (name === HUBIGNORE) return false
  return name.startsWith('.') || BUILT_IN_SKIPS.has(name)
}

/** The rules in force at one folder: the built-in skips plus every `.hubignore` from the top down. */
export class HubIgnore {
  constructor(private readonly rules: readonly IgnoreRule[] = []) {}

  /** These rules plus a `.hubignore` read in the folder `base` (relative to the synced folder, `/`-separated). */
  with(text: string, base: string): HubIgnore {
    return new HubIgnore([...this.rules, ...parseIgnoreFile(text, base)])
  }

  /** Whether a path inside the synced folder (`/`-separated) is left out. */
  ignores(relative: string, isDirectory: boolean): boolean {
    const name = relative.split('/').pop() ?? relative
    if (name === HUBIGNORE) return false
    return ignoreDecision(this.rules, relative, isDirectory, skippedByDefault(name))
  }

  get empty(): boolean {
    return this.rules.length === 0
  }
}

