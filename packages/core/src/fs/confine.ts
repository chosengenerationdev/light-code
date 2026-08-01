import fs from 'node:fs/promises'
import path from 'node:path'

export class PathConfinementError extends Error {
  constructor(readonly requestedPath: string, readonly root: string) {
    super(`"${requestedPath}" resolves outside the workspace root "${root}"`)
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
  const realRoot = await fs.realpath(root)
  const realTarget = await realpathAllowingMissing(requestedPath)

  const normalizedRoot = normalizeForComparison(path.resolve(realRoot))
  const normalizedTarget = normalizeForComparison(path.resolve(realTarget))

  const withinRoot =
    normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep)

  if (!withinRoot) {
    throw new PathConfinementError(requestedPath, root)
  }

  return realTarget
}

export { realpathAllowingMissing, normalizeForComparison }
