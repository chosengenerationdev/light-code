import type { ConfigScope, ConfigStore } from '@light-code/core'

/**
 * Settings an administrator publishes to everyone, for collections keyed by name.
 *
 * ## The idea, which is already proven for profiles
 *
 * **The key carries the scope.** A search connection called `shared:team-search` is the
 * administrator's; `team-search` is your own. Nothing keeps a separate list of what is shared, so
 * there is no second place to drift from the first — which is the failure shape this project pays
 * for most often.
 *
 * It is also the only design that works at the point where it matters. A `SecretStore` is handed a
 * *reference* and nothing else: it cannot ask whose connection is being saved. With the scope in
 * the key, `search:shared:team-search:password` routes itself.
 *
 * ## Reads merge, writes strip
 *
 * A user's own file never gains a shared entry. If it could, removing one centrally would leave a
 * copy behind in everyone's config — an entry nobody can edit and nobody remembers creating. So
 * the merge happens on the way out and is undone on the way in, and the user's file stays a record
 * of their own decisions only.
 *
 * ## What this is not
 *
 * Not a permission. A shared entry is read-only in the interface and the bridge refuses an
 * administrator-only message from a normal user, but §14 is unchanged: every session's commands
 * still run as the service account, so this locks down *configuration*, not privilege.
 */
export const SHARED_PREFIX = 'shared:'

export function isSharedKey(key: string): boolean {
  return key.startsWith(SHARED_PREFIX)
}

export function toSharedKey(key: string): string {
  return isSharedKey(key) ? key : `${SHARED_PREFIX}${key}`
}

export function fromSharedKey(key: string): string {
  return isSharedKey(key) ? key.slice(SHARED_PREFIX.length) : key
}

/**
 * A secret reference belonging to something shared.
 *
 * References are `<kind>:<id>:<field>` (§15), so a shared entry's reference carries the prefix in
 * its *second* segment and routing needs nothing else. Written against the shape rather than
 * against a list of kinds, so a collection added later routes correctly without this being
 * remembered — the omission would be silent, and the symptom would be one user's password written
 * into another user's file.
 */
export function isSharedSecretReference(ref: string): boolean {
  const parts = ref.split(':')
  return parts.length >= 3 && parts[1] === 'shared'
}

/** One collection that can hold shared entries, named by the config key that holds it. */
export interface SharedCollection {
  /** The config key, e.g. `vectorStores`. */
  key: string
  /**
   * Keys inside the entry holding a secret reference, rewritten so they carry the prefix too.
   *
   * Without this the entry would be presented as `shared:x` while its `passwordRef` still said
   * `search:x:password` — reading the administrator's connection out of the user's own secrets
   * file, where it is not, and reporting no password on a connection that has one.
   */
  refFields?: readonly string[]
  /** Builds a reference for one field of one entry, so the rewrite matches what the bridge reads. */
  refFor?: (id: string, field: string) => string
}

type Record_ = Record<string, unknown>

/**
 * A user's config with the administrator's entries folded in.
 *
 * Wraps the real store rather than changing core, for the same reason `SharedProfileConfigStore`
 * does: "some of these are not yours" is a shared-server idea, and the bridge is shared with the
 * extension, which has one user and no such concept.
 */
export class SharedEntriesConfigStore implements ConfigStore {
  constructor(
    private readonly inner: ConfigStore,
    private readonly collections: readonly SharedCollection[],
    private readonly shared: () => Record<string, Record<string, unknown>>,
  ) {}

  async read(scope: ConfigScope): Promise<string | undefined> {
    const raw = await this.inner.read(scope)
    // Only user scope carries these; a workspace cannot supply them at all (invariant 5), so
    // workspace config is passed through untouched.
    if (scope !== 'user') return raw

    let parsed: Record_
    try {
      parsed = raw === undefined ? {} : (JSON.parse(raw) as Record_)
    } catch {
      // A file that will not parse is the loader's problem to report. Passing it through keeps
      // the eventual error about the actual mistake rather than about this.
      return raw
    }

    const shared = this.shared()
    let changed = false
    for (const collection of this.collections) {
      const entries = shared[collection.key]
      if (entries === undefined || Object.keys(entries).length === 0) continue

      const own = isRecord(parsed[collection.key]) ? (parsed[collection.key] as Record_) : {}
      const presented: Record_ = {}
      for (const [id, entry] of Object.entries(entries)) {
        presented[toSharedKey(id)] = present(entry, toSharedKey(id), collection)
      }
      /*
       * Shared first, then the user's own with any stale shared copy dropped.
       *
       * The filter is not defensive padding: a config file written by an older build, or edited by
       * hand, can hold one. Presenting both would show the entry twice with the administrator's
       * version losing to a copy nobody can see the origin of.
       */
      const ownOnly = Object.fromEntries(Object.entries(own).filter(([id]) => !isSharedKey(id)))
      parsed[collection.key] = { ...presented, ...ownOnly }
      changed = true
    }

    return changed ? JSON.stringify(parsed) : raw
  }

  async write(scope: ConfigScope, contents: string): Promise<void> {
    if (scope !== 'user') return this.inner.write(scope, contents)

    let parsed: Record_
    try {
      parsed = JSON.parse(contents) as Record_
    } catch {
      return this.inner.write(scope, contents)
    }

    for (const collection of this.collections) {
      const own = parsed[collection.key]
      if (!isRecord(own)) continue
      parsed[collection.key] = Object.fromEntries(
        Object.entries(own as Record_).filter(([id]) => !isSharedKey(id)),
      )
    }

    return this.inner.write(scope, JSON.stringify(parsed))
  }

  watch(scope: ConfigScope, onChange: () => void): () => void {
    return this.inner.watch(scope, onChange)
  }
}

/** The entry as a user sees it: prefixed id, and secret references pointing at the shared store. */
function present(entry: unknown, presentedId: string, collection: SharedCollection): unknown {
  if (!isRecord(entry)) return entry
  const copy: Record_ = { ...(entry as Record_) }
  if (collection.refFields === undefined || collection.refFor === undefined) return copy
  for (const field of collection.refFields) {
    // Rewritten only where one exists: writing a reference for a credential that was never set
    // would make the panel report a password on a connection that has none.
    if (typeof copy[field] === 'string') copy[field] = collection.refFor(presentedId, field)
  }
  return copy
}

function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
