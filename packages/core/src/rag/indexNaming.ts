import crypto from 'node:crypto'
import path from 'node:path'

/**
 * The name Light Code writes a workspace's index under, when nobody has chosen one.
 *
 * ## Why the owner is part of it
 *
 * It used to be the workspace path alone, hashed. That is collision-free between *projects* and
 * not between *people*: two colleagues who both clone to `C:\dev\payments` — which a standardised
 * build makes likely rather than exotic — derived the same name and wrote to the same index. §12e
 * requires everyone to write to their own, because sharing one means each person's re-index
 * disturbs everyone else's.
 *
 * Owner filtering would still have attributed hits correctly (§12e pushes it into the engine
 * precisely because "two checkouts can be configured to share one"), so nothing would have looked
 * broken. It would simply have been slower and noisier for everybody, permanently, with no symptom
 * pointing at the cause.
 *
 * ## Why it is readable *and* hashed
 *
 * Both, deliberately. The slug is there because the schema's own complaint about the derived name
 * was that it is "collision-free but unreadable — on a shared cluster the person looking at the
 * index list has no way to tell whose `light-code-a3f2…` it is". The digest is there because two
 * different owners can reduce to the same slug, and a readable name that collides is worse than an
 * unreadable one that does not.
 *
 * ## What changing this costs, and why it was still worth doing
 *
 * Every derived name changes, so the manifest — keyed `index@storeId` — no longer matches and the
 * next index run re-embeds from scratch. The old index stays in the cluster until somebody deletes
 * it. That cost is paid once; the alternative is paying it later, when more people have indexes to
 * rebuild. An explicitly configured `embedder.indexName` is untouched, and the aliases are
 * untouched, so team search keeps working across the change.
 */

/** Used when no prefix is configured. Kept here so the derivation has one owner. */
export const DEFAULT_INDEX_PREFIX = 'light-code'

/** `DOMAIN\user` and `user@host` both name one person; this keeps the part that identifies them. */
const DOMAIN_OR_PATH = /[\\/]/

/**
 * One person, spelled one way.
 *
 * Shared by the slug and the digest so the two cannot disagree about who somebody is. Lowercased,
 * because a Windows login is case-insensitive and `Ana` must not earn a second index from `ana`.
 * Punctuation is **kept**, because that is exactly what tells `A Smith` from `a.smith` — two
 * strings the slug flattens together and the digest must not.
 */
function normaliseOwner(owner: string): string {
  return (owner.split(DOMAIN_OR_PATH).pop()?.split('@')[0] ?? '').trim().toLowerCase()
}

/**
 * An owner reduced to something an index name may contain.
 *
 * Index names are lowercase and narrow across all three backends, and an OS user name is none of
 * those things. A domain prefix is dropped rather than encoded: it is the same person on every
 * machine they log into, and keeping it would make one person two indexes depending on how they
 * signed in.
 *
 * Returns undefined when nothing usable survives, and the caller then falls back to the shape this
 * had before — a name with a stray separator where a person should be is worse than no person.
 */
export function ownerSlug(owner: string | undefined): string | undefined {
  if (owner === undefined) return undefined
  const slug = normaliseOwner(owner)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : undefined
}

export interface IndexNameInput {
  /** Replaces `light-code` at the front. A team namespace, shared deliberately. */
  prefix?: string | undefined
  /** `identity.owner`, or the OS user name. Absent means this falls back to the old shape. */
  owner?: string | undefined
  /** Absolute path to the workspace. */
  workspaceRoot: string
}

/**
 * `<prefix>-<owner>-<digest>`, or `<prefix>-<digest>` when there is no owner to name.
 *
 * The path is resolved and case-folded before hashing, per §16: Windows hands the same folder back
 * spelled more than one way, and a name that changed with the spelling would re-embed for nothing.
 */
export function deriveIndexName(input: IndexNameInput): string {
  const prefix = input.prefix ?? DEFAULT_INDEX_PREFIX
  const slug = ownerSlug(input.owner)
  const root = path.resolve(input.workspaceRoot).toLowerCase()

  /*
   * The **normalised owner** goes into the digest, not the slug.
   *
   * Hashing the slug was the first version, and it was wrong in exactly the way this guards
   * against: `A Smith` and `a.smith` both reduce to `a-smith`, so the two collided in the digest as
   * well as in the name — a readable name that misleads, which is the worst of the options. Caught
   * by its own test rather than by reasoning about it.
   *
   * The separator is a character no owner or path can contain, so `ab` + `c` cannot hash the same
   * as `a` + `bc`.
   */
  const identity = input.owner === undefined ? '' : normaliseOwner(input.owner)
  const digest = crypto
    .createHash('sha256')
    .update(`${identity}\u0000${root}`)
    .digest('hex')
    .slice(0, 16)

  return slug === undefined ? `${prefix}-${digest}` : `${prefix}-${slug}-${digest}`
}
