import type { ConfigScope, ConfigStore, ProviderProfile, SecretStore } from '@light-code/core'

/**
 * Administrator-provided provider profiles, merged into every user's list.
 *
 * ## Why the ids are prefixed
 *
 * A user's profiles live in their own config file and an administrator's live in the shared one,
 * and the merged view has to be unambiguous in both directions: which entries may this user edit,
 * and which of them must never be written back into their file. An id prefix answers both with a
 * string comparison and makes a collision impossible — without it, an administrator adding a
 * profile whose id happened to match one of a user's would silently delete theirs on the next
 * save.
 *
 * The prefix exists only in the merged view. The shared file stores ordinary ids, so an
 * administrator editing them never sees it.
 */
const SHARED_PREFIX = 'shared:'

export function isSharedProfileId(id: string): boolean {
  return id.startsWith(SHARED_PREFIX)
}

export function toSharedProfileId(id: string): string {
  return `${SHARED_PREFIX}${id}`
}

export function fromSharedProfileId(id: string): string {
  return isSharedProfileId(id) ? id.slice(SHARED_PREFIX.length) : id
}

/**
 * A secret reference belonging to a shared profile.
 *
 * References are `profile:<id>:apiKey` (§15), so a shared profile's carries the prefix through and
 * routing is decided by the reference alone. That matters because the secret store is handed the
 * reference and nothing else — it cannot ask which profile is being saved.
 */
export function isSharedSecretRef(ref: string): boolean {
  return ref.startsWith(`profile:${SHARED_PREFIX}`)
}

/** The shared profiles as a user sees them: prefixed, and therefore recognisable as not theirs. */
export function presentSharedProfiles(profiles: readonly ProviderProfile[]): ProviderProfile[] {
  return profiles.map((profile) => ({
    ...profile,
    id: toSharedProfileId(profile.id),
    ...(profile.auth.type === 'apiKey' && profile.auth.apiKeyRef !== undefined
      ? { auth: { ...profile.auth, apiKeyRef: `profile:${toSharedProfileId(profile.id)}:apiKey` } }
      : {}),
  }))
}

/**
 * A user's config with the administrator's profiles folded in.
 *
 * Wraps the real store rather than changing core, because "some of these profiles are not yours"
 * is a shared-server idea and the bridge is shared with the extension, which has one user.
 *
 * Reads merge; writes strip. A user saving their list writes only their own entries, so a shared
 * profile can never be copied into a user's file and then linger after the administrator removes
 * it — which would leave a profile nobody can edit and nobody remembers creating.
 */
export class SharedProfileConfigStore implements ConfigStore {
  constructor(
    private readonly inner: ConfigStore,
    private readonly shared: () => { profiles: ProviderProfile[]; defaultProfileId?: string },
  ) {}

  async read(scope: ConfigScope): Promise<string | undefined> {
    const raw = await this.inner.read(scope)
    // Only the user scope carries profiles worth merging; workspace config cannot supply them at
    // all (invariant 5), so it is passed through untouched.
    if (scope !== 'user') return raw

    const shared = this.shared()
    const presented = presentSharedProfiles(shared.profiles)
    if (presented.length === 0) return raw

    let parsed: Record<string, unknown>
    try {
      parsed = raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>)
    } catch {
      // A user's file that will not parse is the loader's problem to report, not this one's.
      // Passing it through unchanged keeps the error message about the actual mistake.
      return raw
    }

    const own = Array.isArray(parsed['profiles']) ? (parsed['profiles'] as ProviderProfile[]) : []
    /*
     * Shared first, so a fresh user opening the panel sees what the organisation provides before
     * an empty space where their own would go.
     */
    const merged = [...presented, ...own.filter((profile) => !isSharedProfileId(profile.id))]

    const activeId = typeof parsed['activeProfileId'] === 'string' ? parsed['activeProfileId'] : undefined
    /*
     * The administrator's default applies to someone who has not chosen — which is every new
     * user. It does not override a choice, and it is dropped if it names a profile that no longer
     * exists, so removing a shared profile cannot leave every session pointing at nothing.
     */
    const resolvedActive =
      activeId !== undefined && merged.some((profile) => profile.id === activeId)
        ? activeId
        : shared.defaultProfileId !== undefined &&
            merged.some((profile) => profile.id === toSharedProfileId(shared.defaultProfileId ?? ''))
          ? toSharedProfileId(shared.defaultProfileId)
          : activeId

    return JSON.stringify({
      ...parsed,
      profiles: merged,
      ...(resolvedActive !== undefined ? { activeProfileId: resolvedActive } : {}),
    })
  }

  async write(scope: ConfigScope, contents: string): Promise<void> {
    if (scope !== 'user') return this.inner.write(scope, contents)

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(contents) as Record<string, unknown>
    } catch {
      return this.inner.write(scope, contents)
    }

    if (Array.isArray(parsed['profiles'])) {
      parsed['profiles'] = (parsed['profiles'] as ProviderProfile[]).filter(
        (profile) => !isSharedProfileId(profile.id),
      )
    }
    return this.inner.write(scope, JSON.stringify(parsed, null, 2))
  }

  watch(scope: ConfigScope, onChange: () => void): () => void {
    return this.inner.watch(scope, onChange)
  }
}

/**
 * Routes a secret by which profile it belongs to.
 *
 * A shared profile's API key is the administrator's and lives in the shared store; everything else
 * is the user's own. Decided from the reference, because that is all a secret store is given.
 *
 * **This is storage, not secrecy.** Both files are readable by the account every session runs as,
 * so a user's assistant can read the administrator's key by opening the file. Keeping them apart
 * means an administrator's key survives a user clearing their own secrets, and that the two are
 * not confused — it does not mean one is hidden from the other.
 */
export class RoutedSecretStore implements SecretStore {
  constructor(
    private readonly own: SecretStore,
    private readonly shared: SecretStore,
  ) {}

  private storeFor(key: string): SecretStore {
    return isSharedSecretRef(key) ? this.shared : this.own
  }

  async get(key: string): Promise<string | undefined> {
    return this.storeFor(key).get(key)
  }

  async set(key: string, value: string): Promise<void> {
    return this.storeFor(key).set(key, value)
  }

  async delete(key: string): Promise<void> {
    return this.storeFor(key).delete(key)
  }

  /**
   * Clears the user's own only.
   *
   * "Clear all stored secrets" is offered to every user, and an administrator's key is not theirs
   * to destroy — one person tidying up would otherwise break the gateway for everybody. An
   * administrator clears the shared ones from the shared store.
   */
  async clear(): Promise<void> {
    return this.own.clear()
  }

  backendName(): string {
    return this.own.backendName()
  }
}
