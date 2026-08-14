import fs from 'node:fs/promises'
import path from 'node:path'

export class PathConfinementError extends Error {
  constructor(
    readonly requestedPath: string,
    readonly root: string,
  ) {
    super(
      `"${requestedPath}" resolves outside the workspace root "${root}". ` +
        'To read files elsewhere — a network share, a log directory — add the folder under ' +
        'Settings → Approvals → Folders it may read.',
    )
    this.name = 'PathConfinementError'
  }
}

function normalizeForComparison(resolvedPath: string): string {
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
}

/**
 * Resolves symlinks and drive-relative/UNC/`\\?\`-prefixed paths as far as they exist.
 * Falls back to resolving the nearest existing ancestor for paths that don't exist yet
 * (e.g. a new file about to be written), so confinement can still be checked before creation.
 */
async function realpathAllowingMissing(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(target)
    if (parent === target) throw error
    const realParent = await realpathAllowingMissing(parent)
    return path.join(realParent, path.basename(target))
  }
}

/**
 * Confines `requestedPath` to `root`: resolves symlinks *and* compares case-insensitively
 * on Windows. Prefix-matching the *unresolved* path is the classic bug this avoids —
 * see CLAUDE.md §16. Throws `PathConfinementError` if the resolved path escapes root.
 */
export async function confine(requestedPath: string, root: string): Promise<string> {
  return confineToAny(requestedPath, [root])
}

/**
 * Confines to the first of several roots that contains the path.
 *
 * The extra roots exist for reading outside the workspace — a network share full of logs is the
 * case that prompted it, and on Windows that is a UNC path which no amount of workspace-relative
 * resolution will ever reach.
 *
 * Every root is realpath'd, so a symlink inside the workspace pointing at a share is judged by
 * where it lands rather than where it sits. `roots` must already be the *allowed* set: this
 * function decides containment, never policy.
 */
export async function confineToAny(requestedPath: string, roots: readonly string[]): Promise<string> {
  const realTarget = await realpathAllowingMissing(requestedPath)
  const normalizedTarget = normalizeForComparison(path.resolve(realTarget))

  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = await fs.realpath(root)
    } catch {
      // A configured share that is not mounted right now is skipped rather than fatal — the
      // other roots still work, and the path simply will not match this one.
      continue
    }
    const normalizedRoot = normalizeForComparison(path.resolve(realRoot))
    if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep)) {
      return realTarget
    }
  }

  throw new PathConfinementError(requestedPath, roots[0] ?? '')
}

export { realpathAllowingMissing, normalizeForComparison }
