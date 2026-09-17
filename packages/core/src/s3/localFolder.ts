import { createHash } from 'node:crypto'

/**
 * Where a mirrored bucket folder lands on this machine.
 *
 * ## Why storage rather than the workspace
 *
 * A mirror is a **cache**: the bucket is the source, and anything here can be deleted and fetched
 * again without losing work. Caches live under `storageDir`, beside tasks, spilled tool results
 * and reports, for the same reason those do — putting one in the workspace means it is committed
 * by somebody eventually, and a folder of files nobody wrote appearing in a diff is worse than a
 * folder nobody sees.
 *
 * It is stated in the panel rather than hidden, though. A folder whose location has to be guessed
 * is one people cannot inspect when a skill does not show up, and that is exactly when they want
 * to look.
 *
 * **Note this changes §13's reasoning for Python tools and does not weaken it.** That section
 * keeps `python.toolsDir` inside the workspace so changes land in git and get code-reviewed. A
 * mirrored tool is not reviewed that way — but it is also not *loaded*: the hash-pinned registry
 * refuses any `.py` that was not approved with its source shown. Git review is the secondary
 * mitigation there; approval is the one that actually gates execution, and it still runs.
 *
 * ## Why the prefix is part of the path
 *
 * Changing `skills.prefix` from `team/` to `platform/` gives a **fresh** folder rather than
 * merging the new files into the old ones. Merged, the skills from a prefix nobody has configured
 * any more would keep being loaded and indexed, with nothing anywhere to say why they were there —
 * and the sync never deletes, so they would stay for good. An abandoned folder is invisible and
 * costs disk; a phantom skill costs somebody an afternoon.
 *
 * Hashed rather than spelled out because a prefix is an arbitrary S3 key: it can contain
 * characters no filesystem accepts, and it can be long enough to break a Windows path on its own.
 */

/** Kinds of thing that can be mirrored. The folder name is the kind, so it reads plainly. */
export type MirrorKind = 'skills' | 'tools'

/**
 * `<storageDir>/s3/<connection>/<kind>-<prefix digest>`.
 *
 * Deterministic: the same connection and prefix always resolve to the same folder, so a sync
 * refreshes rather than accumulating a new copy each time the panel opens.
 */
export function mirrorFolder(options: {
  storageDir: string
  connectionId: string
  kind: MirrorKind
  prefix?: string
}): string {
  const connection = safeSegment(options.connectionId)
  const digest = createHash('sha256')
    .update((options.prefix ?? '').trim().toLowerCase())
    .digest('hex')
    .slice(0, 8)
  return join(options.storageDir, 's3', connection, `${options.kind}-${digest}`)
}

/**
 * A connection id made safe to be one path segment.
 *
 * Ids come from config, which people hand-edit, so one can contain a slash or a colon — and a
 * segment carrying a separator would silently write outside the folder this owns. Anything that is
 * not plainly safe is replaced, and a digest is appended so two ids that flatten to the same text
 * do not collide into one folder.
 */
function safeSegment(id: string): string {
  const cleaned = id
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    // Runs collapsed and the edges trimmed, so `///` becomes empty rather than `---` and an id
    // of only separators falls through to the readable default below.
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
  const suffix = createHash('sha256').update(id).digest('hex').slice(0, 6)
  return `${cleaned === '' ? 'connection' : cleaned}-${suffix}`
}

/* `/` throughout: these are joined with paths the host supplies and read back by the same code. */
function join(...parts: string[]): string {
  return parts.map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, '') : part)).join('/')
}
