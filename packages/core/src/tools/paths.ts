import path from 'node:path'
import { confine, PathConfinementError } from '../fs/confine.js'
import type { ToolExecutionContext } from './types.js'

export type ResolvedToolPath = { ok: true; realPath: string } | { ok: false; message: string }

/** Confines a tool-supplied path to the workspace and checks the cert/key denylist — invariants 5/6. */
export async function resolveToolPath(context: ToolExecutionContext, requestedPath: string): Promise<ResolvedToolPath> {
  const absolute = path.resolve(context.workspaceRoot, requestedPath)
  let realPath: string
  try {
    realPath = await confine(absolute, context.workspaceRoot)
  } catch (error) {
    if (error instanceof PathConfinementError) {
      return { ok: false, message: error.message }
    }
    throw error
  }

  if (await context.denylist.isDenied(realPath)) {
    return { ok: false, message: `Access to "${requestedPath}" is denied.` }
  }

  return { ok: true, realPath }
}
