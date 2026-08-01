import path from 'node:path'
import { normalizeForComparison, realpathAllowingMissing } from './confine.js'

/**
 * Hard deny list for cert/key paths (invariant 6). Resolved paths are compared —
 * not raw ones — so a symlink can't be used to read a denied file under a different
 * name. Every file-reading tool must consult this before returning content.
 */
export class PathDenylist {
  private readonly deniedRealPaths = new Set<string>()

  async add(rawPath: string): Promise<void> {
    const real = await realpathAllowingMissing(rawPath)
    this.deniedRealPaths.add(normalizeForComparison(path.resolve(real)))
  }

  async isDenied(rawPath: string): Promise<boolean> {
    const real = await realpathAllowingMissing(rawPath)
    const normalized = normalizeForComparison(path.resolve(real))
    for (const denied of this.deniedRealPaths) {
      if (normalized === denied || normalized.startsWith(denied + path.sep)) return true
    }
    return false
  }
}
