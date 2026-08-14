import path from 'node:path'
import { confineToAny, PathConfinementError, realpathAllowingMissing } from '../fs/confine.js'
import type { ToolExecutionContext } from './types.js'

export type ResolvedToolPath = { ok: true; realPath: string } | { ok: false; message: string }

export interface ResolveOptions {
  /**
   * Set for a tool that writes.
   *
   * **Writing is confined to the workspace even when reading is not**, and that is not
   * timidity. Checkpoints are shadow-git snapshots of the workspace (§8), so an edit outside
   * it has no rollback at all — allowing writes to a configured share would silently remove
   * the safety net every other edit has, at exactly the moment it matters most.
   */
  write?: boolean
}

/** Confines a tool-supplied path and checks the cert/key denylist — invariants 5/6. */
export async function resolveToolPath(
  context: ToolExecutionContext,
  requestedPath: string,
  options: ResolveOptions = {},
): Promise<ResolvedToolPath> {
  const absolute = path.resolve(context.workspaceRoot, requestedPath)
  const roots =
    options.write === true ? [context.workspaceRoot] : [context.workspaceRoot, ...(context.readRoots ?? [])]

  let realPath: string
  try {
    realPath = await confineToAny(absolute, roots)
  } catch (error) {
    if (!(error instanceof PathConfinementError)) throw error

    /*
     * Outside every allowed root. Rather than refusing outright, ask — but only for a read,
     * and only when there is someone to ask.
     */
    const denied = { ok: false as const, message: error.message }
    if (options.write === true || context.requestPathAccess === undefined) return denied

    const outside = await realpathAllowingMissing(absolute)

    /*
     * The deny list is checked *before* asking, and that ordering is the point: a key or
     * certificate must not be something the user can be talked into approving. Invariant 6 is
     * absolute, not a default.
     */
    if (await context.denylist.isDenied(outside)) {
      return { ok: false, message: `Access to "${requestedPath}" is denied.` }
    }

    if (!(await context.requestPathAccess(outside))) {
      return { ok: false, message: `The user declined access to "${requestedPath}".` }
    }
    return { ok: true, realPath: outside }
  }

  if (await context.denylist.isDenied(realPath)) {
    return { ok: false, message: `Access to "${requestedPath}" is denied.` }
  }

  return { ok: true, realPath }
}
