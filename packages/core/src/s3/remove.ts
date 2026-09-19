import { normalisePrefix } from './keys.js'
import type { S3Target } from './tools.js'

/**
 * Removing a skill from a bucket.
 *
 * Asked for directly, and it is the one operation here that can destroy something other people
 * depend on — a skill in a shared bucket is on every colleague's next sync. Everything else in
 * `s3/` is GET and PUT; this module is the only caller of `S3Client.remove`, and the shape of the
 * feature is arranged so that nothing gets here by accident.
 *
 * ## Two steps, because the second one cannot be taken back
 *
 * `skillKeysInBucket` lists what would go and changes nothing. `removeSkillFromBucket` deletes
 * **exactly the keys it is given** — the ones the user was shown and agreed to. That is invariant
 * 8 applied to a delete: the confirmation is the literal list of objects, not a count and not a
 * description, and what runs is what was on screen.
 *
 * It also fails in the safe direction. A colleague adding `name/images/new.png` between the
 * preview and the confirmation means that file survives — the user is left with an orphan, which
 * is visible and fixable, rather than having deleted something nobody showed them.
 *
 * ## Why the keys are re-checked here
 *
 * They arrive from the UI, and "the UI would not send that" is not a boundary. Every key is
 * checked against the mirror's own prefix and the skill's own name before anything is sent, so a
 * malformed or stale request cannot reach past the folder it was about.
 *
 * ## No tool calls this
 *
 * Deliberate. `delete_skill` is rooted at the writable folder and stays there. Deleting a
 * colleague's shared skill is not something a model should be able to initiate on its own
 * reasoning — the approval gate would show it, but the act belongs to a person opening the tab
 * and reading the list.
 */

export interface SkillKeysOptions {
  target: S3Target
  /** Folder within the connection's own prefix, as the mirror is configured. */
  prefix?: string
  /** The skill's name, as the tab lists it. */
  name: string
  signal?: AbortSignal
}

/**
 * The objects that make up one skill in the bucket.
 *
 * Both layouts §13 reads are covered: `name.md` written by `write_skill`, and `name/SKILL.md` with
 * anything beside it. The second is listed rather than assumed, because a folder skill can carry
 * pictures and reference files and a delete that left those behind would leave a folder that still
 * syncs, still looks like a skill to anyone browsing the bucket, and loads as nothing.
 *
 * Listed from the bucket rather than constructed, so what the user is shown is what is actually
 * there — including nothing, which is a real answer worth being able to give.
 */
export async function skillKeysInBucket(options: SkillKeysOptions): Promise<string[]> {
  const base = normalisePrefix(options.target.prefix)
  const where = normalisePrefix(`${base}${options.prefix ?? ''}`)
  const objects = await options.target.client.list(where, 1000, options.signal)

  return objects
    .map((object) => object.key)
    .filter((key) => belongsToSkill(key, where, options.name))
    .sort()
}

/**
 * Whether a key is part of this skill.
 *
 * Deliberately exact rather than a prefix test on the name. `deploy` must not match `deployment.md`
 * or `deployment/SKILL.md`, and that is not a hypothetical — short skill names that prefix longer
 * ones are the normal case, and a delete that took a neighbour with it would be discovered by
 * somebody else, later, with no way to tell what happened.
 */
export function belongsToSkill(key: string, where: string, name: string): boolean {
  if (!key.startsWith(where)) return false
  const relative = key.slice(where.length)
  if (relative === '') return false
  // The flat layout: exactly `name.md`, nothing else.
  if (relative.toLowerCase() === `${name.toLowerCase()}.md`) return true
  // The folder layout: `name/` and anything under it, but never `name-other/`.
  return relative.toLowerCase().startsWith(`${name.toLowerCase()}/`)
}

export interface RemoveSkillOptions {
  target: S3Target
  prefix?: string
  name: string
  /** Exactly the keys the user was shown and agreed to. */
  keys: readonly string[]
  signal?: AbortSignal
}

export interface RemoveSkillResult {
  removed: string[]
  /** Keys that could not be removed, with the reason. Reported, never thrown. */
  failed: { key: string; problem: string }[]
  /** Keys refused before being sent, because they were not this skill's to delete. */
  rejected: string[]
}

export async function removeSkillFromBucket(
  options: RemoveSkillOptions,
): Promise<RemoveSkillResult> {
  if (options.target.readOnly === true) {
    throw new Error(`${options.target.label} is configured read-only, so nothing can be deleted from it.`)
  }

  const base = normalisePrefix(options.target.prefix)
  const where = normalisePrefix(`${base}${options.prefix ?? ''}`)
  const result: RemoveSkillResult = { removed: [], failed: [], rejected: [] }

  for (const key of options.keys) {
    // Re-checked here, not trusted from the caller. See the note at the top of this file.
    if (!belongsToSkill(key, where, options.name)) {
      result.rejected.push(key)
      continue
    }
    try {
      await options.target.client.remove(key, options.signal)
      result.removed.push(key)
    } catch (error) {
      /*
       * One failure does not stop the rest.
       *
       * Half a folder skill removed is the state to avoid, and stopping at the first error is what
       * produces it: the remaining objects would be left with no report saying which. Every key is
       * attempted and every outcome is named.
       */
      result.failed.push({ key, problem: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
