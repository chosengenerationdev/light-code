import path from 'node:path'
import { normalizeForComparison } from '../fs/confine.js'
import type { ToolExecutionContext } from './types.js'

/**
 * "Changed since you read it" - the safeguard that lets several agents share one codebase.
 *
 * Sun Code runs a separate agent per chat, and two of them (or an agent and the person, or
 * any other program) can edit the same file. `apply_diff` already fails safely when its search text
 * is gone, but `write_to_file` replaces the whole file, so an agent working from an old read would
 * silently put back what somebody else just changed. So every read records the file's modification
 * time and size, and a write refuses when they no longer match: read it again, then edit.
 *
 * A stamp, not a hash, because it is checked on every write and a hash means reading the file;
 * mtime plus size misses only a same-size rewrite within one timestamp tick.
 */

async function stamp(context: ToolExecutionContext, realPath: string): Promise<string | undefined> {
  try {
    const s = await context.fs.stat(realPath)
    return `${String(s.mtimeMs)}:${String(s.size)}`
  } catch {
    return undefined
  }
}

/** Marks a file read this session and remembers what it looked like then. */
export async function recordRead(context: ToolExecutionContext, realPath: string): Promise<void> {
  const key = normalizeForComparison(realPath)
  context.readFiles.add(key)
  const now = await stamp(context, realPath)
  if (context.readStamps !== undefined && now !== undefined) context.readStamps.set(key, now)
}

/** A sentence when the file changed after this session last read or wrote it; undefined otherwise. */
export async function changedSinceRead(context: ToolExecutionContext, realPath: string, shown: string): Promise<string | undefined> {
  const known = context.readStamps?.get(normalizeForComparison(realPath))
  if (known === undefined) return undefined
  const now = await stamp(context, realPath)
  if (now === undefined || now === known) return undefined
  return (
    `"${shown}" changed after you last read it — another chat, the user or another program edited it. ` +
    'Read it again with read_file, then make your edit against what is there now.'
  )
}

/**
 * Files this session read that a shell command names and that have changed since - another chat,
 * the user or another program edited them. Matched on the full path, the workspace-relative path
 * (either slash) or the bare file name standing on its own, case-insensitively.
 *
 * The edit tools check one file they were given; a command can change any file it names, through
 * `sed -i`, a redirect or a script, so without this an agent working from a stale read overwrote
 * another chat's change with a command where its edit tool would have been refused.
 */
export async function staleFilesNamedIn(context: ToolExecutionContext, command: string): Promise<string[]> {
  if (context.readStamps === undefined || context.readStamps.size === 0) return []
  const text = command.toLowerCase()
  const root = normalizeForComparison(context.workspaceRoot)
  const stands = (needle: string): boolean => {
    if (needle.length < 3) return false
    let at = text.indexOf(needle)
    while (at !== -1) {
      const before = at === 0 ? ' ' : (text[at - 1] ?? ' ')
      const after = text[at + needle.length] ?? ' '
      if (/[\s"'=<>|&;(/\\]/.test(before) && /[\s"'<>|&;)]/.test(after)) return true
      at = text.indexOf(needle, at + 1)
    }
    return false
  }
  const stale: string[] = []
  for (const [key, known] of context.readStamps) {
    const relative = path.relative(root, key)
    const names = [key, relative, relative.split(path.sep).join('/'), path.basename(key)].map((n) => n.toLowerCase())
    if (!names.some(stands)) continue
    try {
      const s = await context.fs.stat(key)
      if (`${String(s.mtimeMs)}:${String(s.size)}` !== known) stale.push(relative.split(path.sep).join('/'))
    } catch {
      // Gone: the command cannot overwrite what is not there.
    }
  }
  return stale
}

/** After a successful write: the file is now as this session left it, and it changed it. */
export async function recordWrite(context: ToolExecutionContext, realPath: string): Promise<void> {
  await recordRead(context, realPath)
  context.changedFiles?.add(realPath)
}
