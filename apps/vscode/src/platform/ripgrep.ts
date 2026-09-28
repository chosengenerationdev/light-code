import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '@light-code/core'

/**
 * Locates the `rg` executable.
 *
 * Two sources, in order:
 *
 * 1. **`dist/bin/rg` inside the extension**, put there by `esbuild.mjs` at package time.
 *    This is what a published install uses. The binary is platform-specific, so the VSIX
 *    is built per target (`vsce package --target win32-x64`, …) and carries exactly one.
 * 2. **`@vscode/ripgrep`**, for running from source with <kbd>F5</kbd>, where `dist/bin`
 *    has not been populated.
 *
 * Why this is not simply an import in core: `@vscode/ripgrep` resolves its binary through
 * `createRequire(import.meta.url)`, so it cannot be bundled — it has to stay external, and
 * an external `require` in the bundle is only satisfiable if the package is inside the
 * VSIX. It is not. That combination made the *published* extension fail to activate at all
 * with `MODULE_NOT_FOUND`, while build, typecheck, and `vsce package` all succeeded.
 *
 * **The require below must stay inside this function.** An external import at module scope
 * is hoisted to a top-level `require` in the bundle, which is precisely the failure above;
 * a call expression in a function body stays where it is and can be caught.
 *
 * Returning `undefined` degrades the two ripgrep-backed tools with a clear message rather
 * than taking the extension down with it.
 */
/**
 * A resolver that answers where ripgrep is *now*, re-resolving when the last answer has gone.
 *
 * ## The failure this exists for
 *
 * Reported from real use: `search_files` intermittently failing with `rg.exe ENOENT`, curing
 * itself after a window reload. The path was resolved once at activation and held for the life
 * of the session, on the stated assumption that it could not change while running.
 *
 * It changes. A VS Code extension is installed into a **version-stamped** folder
 * (`publisher.name-0.86.0`), and installing a newer build writes a new folder, marks the old
 * one in the extensions directory's `.obsolete` file and deletes it — while the extension host
 * that activated against the old one carries on. Its absolute path now points inside a folder
 * that is being removed. Confirmed on a real install: five older versions of this extension
 * were listed as obsolete, each having carried its own `dist/bin/rg.exe`.
 *
 * That is also why it looked random. It needs an update to land mid-session, and the next
 * reload hides the evidence.
 *
 * ## Why it re-resolves rather than simply re-checking
 *
 * The new folder is a *different absolute path*, so noticing the old one is gone is not enough
 * — there is a working binary on disk and the answer has to be recomputed to find it.
 *
 * The cheap check comes first: one `existsSync` per turn against a cached answer, and the full
 * search only when that fails. A missing binary is reported once rather than on every turn,
 * which is what the single resolution at activation was protecting and is worth keeping.
 */
export interface RipgrepResolverOptions {
  /**
   * VS Code's own install folder (`vscode.env.appRoot`). VS Code ships a ripgrep for its own
   * search, so it is a second binary to fall back on — and one the machine's policy already lets
   * run, because Ctrl+Shift+F would not work otherwise.
   */
  appRoot?: string
  /** Whether a binary actually starts. Replaced in tests, whose binaries are placeholder files. */
  canRun?: (candidate: string) => boolean
}

export function createRipgrepResolver(
  extensionPath: string,
  logger?: Logger,
  options: RipgrepResolverOptions = {},
): () => string | undefined {
  let cached: string | undefined
  let reportedMissing = false
  const canRun = memoiseRunnable(options.canRun ?? ripgrepRuns, logger)

  return (): string | undefined => {
    // Still where it was: the overwhelmingly common case, and one stat.
    if (cached !== undefined && fs.existsSync(cached)) return cached

    if (cached !== undefined) {
      logger?.warn(
        'ripgrep has moved since this session started — looking for it again',
        `was ${cached}`,
      )
      // A fresh search may well find it, so the "missing" report is armed again.
      reportedMissing = false
    }

    cached = resolveRipgrepPath(extensionPath, logger, !reportedMissing, { ...options, canRun })
    if (cached === undefined) reportedMissing = true
    return cached
  }
}

/**
 * Runs `rg --version` and says whether it worked.
 *
 * Existing is not the same as running. On a managed Windows machine, application control
 * (AppLocker, WDAC) or antivirus commonly refuses to start programs under the user profile —
 * which is exactly where VS Code installs extensions — so our `rg.exe` is present and every
 * spawn of it fails. Checking by running it lets the resolver move on to a copy that is allowed.
 */
function ripgrepRuns(candidate: string): boolean {
  try {
    const result = spawnSync(candidate, ['--version'], { timeout: 10_000, windowsHide: true })
    return result.error === undefined && result.status === 0
  } catch {
    return false
  }
}

/** One check per path for the life of the session; a refused binary is named once in the log. */
function memoiseRunnable(check: (candidate: string) => boolean, logger?: Logger): (candidate: string) => boolean {
  const known = new Map<string, boolean>()
  return (candidate) => {
    const previous = known.get(candidate)
    if (previous !== undefined) return previous
    const runs = check(candidate)
    known.set(candidate, runs)
    if (!runs) logger?.warn('a ripgrep binary exists but would not start — trying the next one', candidate)
    return runs
  }
}

export function resolveRipgrepPath(
  extensionPath: string,
  logger?: Logger,
  report = true,
  options: RipgrepResolverOptions = {},
): string | undefined {
  const canRun = options.canRun ?? ripgrepRuns
  const executable = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const binDir = path.join(extensionPath, 'dist', 'bin')

  // A universal VSIX carries every platform under its own subdirectory; a platform-specific
  // one carries a single binary at the top of `bin`. Both layouts ship, so both are checked.
  for (const candidate of [
    path.join(binDir, `${process.platform}-${process.arch}`, executable),
    path.join(binDir, executable),
  ]) {
    if (fs.existsSync(candidate)) {
      // A tarball extracted on Windows and repackaged loses the executable bit, and the
      // marketplace does not restore it. Cheap to reassert; silently unrunnable otherwise.
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(candidate, 0o755)
        } catch {
          // Read-only install location — if it was already executable this is harmless.
        }
      }
      if (canRun(candidate)) return candidate
    }
  }

  /*
   * A sibling install of this same extension.
   *
   * Only reached once the folder this session was activated from has stopped holding a binary,
   * which happens when a newer build is installed over it: VS Code writes a *new*
   * version-stamped folder, marks this one in the extensions directory's `.obsolete` file, and
   * removes it — while this extension host carries on with an absolute path into it.
   *
   * So noticing the binary has gone is not enough to recover; the working one is in a folder
   * with a different name. `rg` is a standalone binary invoked with long-standing flags, so a
   * neighbouring version's copy is as good as our own, and the alternative is a dead search
   * tool until the window is reloaded.
   */
  for (const sibling of siblingRipgrepCandidates(extensionPath, executable)) {
    if (!canRun(sibling)) continue
    logger?.warn('using ripgrep from another install of this extension', sibling)
    return sibling
  }

  for (const bundled of vscodeRipgrepCandidates(options.appRoot, executable)) {
    if (!fs.existsSync(bundled) || !canRun(bundled)) continue
    logger?.warn('using the ripgrep that ships with VS Code', bundled)
    return bundled
  }

  try {
    // Must stay a lazy call expression rather than an import: an import is hoisted to a
    // top-level require in the bundle, which is what broke activation for every install.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rgPath } = require('@vscode/ripgrep') as { rgPath: string }
    if (typeof rgPath === 'string' && fs.existsSync(rgPath) && canRun(rgPath)) return rgPath
    if (report) logger?.warn('@vscode/ripgrep resolved a path that does not exist', String(rgPath))
  } catch (error) {
    // `report` is false once this has already been said: the resolver runs every turn now, and
    // a line per turn about the same missing binary buries everything else in the channel.
    if (report) {
      logger?.warn(
        'no runnable ripgrep was found — list_files and search_files will use the built-in search',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  return undefined
}

/**
 * The newest neighbouring install of this extension that still carries a ripgrep binary.
 *
 * Extension folders are named `publisher.name-<version>`, optionally with a platform target, so
 * the siblings of this one are its other installed versions. Sorted newest-first numerically —
 * a string sort puts `0.9.0` above `0.86.0`, which would prefer an ancient build.
 *
 * Exported for the test: the defect being guarded against is one that only appears when a folder
 * disappears, which no test of the happy path can see.
 */
export function siblingRipgrep(extensionPath: string, executable: string): string | undefined {
  return siblingRipgrepCandidates(extensionPath, executable)[0]
}

/** Every neighbouring install's binary that exists, newest first. */
export function siblingRipgrepCandidates(extensionPath: string, executable: string): string[] {
  const parent = path.dirname(extensionPath)
  const self = path.basename(extensionPath)
  // Everything up to the trailing version, e.g. `chosengeneration.light-code-vscode`.
  const family = self.replace(/-\d+\.\d+\.\d+.*$/, '')
  if (family === self || family.length === 0) return []

  let entries: string[]
  try {
    entries = fs.readdirSync(parent)
  } catch {
    // No readable extensions directory — nothing to recover from, and not an error worth raising.
    return []
  }

  const found: string[] = []
  const candidates = entries
    .filter((entry) => entry !== self && entry.startsWith(`${family}-`))
    .map((entry) => ({ entry, version: versionKey(entry.slice(family.length + 1)) }))
    .sort((a, b) => compareVersions(b.version, a.version))

  for (const { entry } of candidates) {
    for (const candidate of [
      path.join(parent, entry, 'dist', 'bin', `${process.platform}-${process.arch}`, executable),
      path.join(parent, entry, 'dist', 'bin', executable),
    ]) {
      if (fs.existsSync(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * Where VS Code keeps the ripgrep its own search runs, across the layouts it has shipped.
 *
 * The folder is stamped with VS Code's commit, so a VS Code update moves it the same way an update
 * of ours moves our copy; the resolver's existence check notices either.
 */
export function vscodeRipgrepCandidates(appRoot: string | undefined, executable: string): string[] {
  if (appRoot === undefined || appRoot.length === 0) return []
  const unpacked = path.join(appRoot, 'node_modules.asar.unpacked', '@vscode')
  return [
    path.join(unpacked, 'ripgrep-universal', 'bin', `${process.platform}-${process.arch}`, executable),
    path.join(unpacked, 'ripgrep', 'bin', executable),
    path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', executable),
  ]
}

/** The leading numeric parts of a version, so `0.86.0-win32-x64` orders by `[0, 86, 0]`. */
function versionKey(rest: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(rest)
  return match === null ? [0, 0, 0] : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
