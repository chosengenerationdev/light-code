import type { ConfigScope, ConfigStore, ProviderProfile, SecretStore } from '@light-code/core'
import { describe, expect, it } from 'vitest'

import {
  isSharedProfileId,
  isSharedSecretRef,
  RoutedSecretStore,
  SharedProfileConfigStore,
} from './sharedProfiles.js'

function profile(id: string, label = id): ProviderProfile {
  return {
    id,
    label,
    wireFormat: 'openai',
    baseUrl: 'https://gateway.internal/v1',
    model: 'gpt-4o',
    auth: { type: 'apiKey', apiKeyRef: `profile:${id}:apiKey` },
  } as ProviderProfile
}

/** An in-memory `ConfigStore`, so the decorator is exercised rather than the filesystem. */
class MemoryConfigStore implements ConfigStore {
  constructor(public contents: Partial<Record<ConfigScope, string>> = {}) {}
  async read(scope: ConfigScope): Promise<string | undefined> {
    return this.contents[scope]
  }
  async write(scope: ConfigScope, value: string): Promise<void> {
    this.contents[scope] = value
  }
  watch(): () => void {
    return () => undefined
  }
}

const shared = { profiles: [profile('gateway', 'Corporate gateway')], defaultProfileId: 'gateway' }

async function readUser(store: ConfigStore): Promise<Record<string, unknown>> {
  const raw = await store.read('user')
  return raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>)
}

describe('what a user sees in their profile list', () => {
  it('includes the administrator’s, and their own', async () => {
    const inner = new MemoryConfigStore({ user: JSON.stringify({ profiles: [profile('mine', 'My key')] }) })
    const merged = await readUser(new SharedProfileConfigStore(inner, () => shared))

    expect((merged['profiles'] as ProviderProfile[]).map((entry) => entry.id)).toEqual(['shared:gateway', 'mine'])
  })

  it('works for a user who has no config file at all', async () => {
    const merged = await readUser(new SharedProfileConfigStore(new MemoryConfigStore(), () => shared))
    expect((merged['profiles'] as ProviderProfile[]).map((entry) => entry.id)).toEqual(['shared:gateway'])
  })

  /**
   * The administrator's default is for someone who has not chosen — every new user. It must not
   * override a choice already made.
   */
  it('applies the administrator’s default only when the user has not picked', async () => {
    const fresh = await readUser(new SharedProfileConfigStore(new MemoryConfigStore(), () => shared))
    expect(fresh['activeProfileId']).toBe('shared:gateway')

    const chosen = new MemoryConfigStore({
      user: JSON.stringify({ profiles: [profile('mine')], activeProfileId: 'mine' }),
    })
    expect((await readUser(new SharedProfileConfigStore(chosen, () => shared)))['activeProfileId']).toBe('mine')
  })

  /** Otherwise removing a shared profile leaves every session pointing at something gone. */
  it('ignores a default naming a profile that no longer exists', async () => {
    const store = new SharedProfileConfigStore(new MemoryConfigStore(), () => ({
      profiles: [profile('gateway')],
      defaultProfileId: 'deleted-last-week',
    }))
    expect((await readUser(store))['activeProfileId']).toBeUndefined()
  })

  it('passes the workspace scope through untouched', async () => {
    const inner = new MemoryConfigStore({ workspace: '{"modeId":"ask"}' })
    const store = new SharedProfileConfigStore(inner, () => shared)
    expect(await store.read('workspace')).toBe('{"modeId":"ask"}')
  })

  /** A file that will not parse is the loader's problem to report; its message should survive. */
  it('leaves an unparseable file for the loader to complain about', async () => {
    const inner = new MemoryConfigStore({ user: '{ broken' })
    expect(await new SharedProfileConfigStore(inner, () => shared).read('user')).toBe('{ broken')
  })
})

describe('what gets written back', () => {
  /**
   * The rule that makes the prefix worth having. A shared profile copied into a user's file would
   * linger after the administrator removed it — a profile nobody can edit and nobody remembers
   * creating.
   */
  it('never writes a shared profile into the user’s file', async () => {
    const inner = new MemoryConfigStore()
    const store = new SharedProfileConfigStore(inner, () => shared)

    // What the UI would send back after the merged list was rendered and one entry edited.
    await store.write(
      'user',
      JSON.stringify({ profiles: [profile('shared:gateway'), profile('mine')], activeProfileId: 'mine' }),
    )

    const written = JSON.parse(inner.contents.user ?? '{}') as { profiles: ProviderProfile[] }
    expect(written.profiles.map((entry) => entry.id)).toEqual(['mine'])
  })

  it('keeps everything else the user saved', async () => {
    const inner = new MemoryConfigStore()
    await new SharedProfileConfigStore(inner, () => shared).write(
      'user',
      JSON.stringify({ profiles: [], modeId: 'junior', activeProfileId: 'shared:gateway' }),
    )
    const written = JSON.parse(inner.contents.user ?? '{}') as Record<string, unknown>
    expect(written['modeId']).toBe('junior')
    // Selecting a shared profile is a legitimate choice and is theirs to record.
    expect(written['activeProfileId']).toBe('shared:gateway')
  })
})

describe('telling the two apart', () => {
  it('recognises a shared id and a shared secret reference', () => {
    expect(isSharedProfileId('shared:gateway')).toBe(true)
    expect(isSharedProfileId('gateway')).toBe(false)
    expect(isSharedSecretRef('profile:shared:gateway:apiKey')).toBe(true)
    expect(isSharedSecretRef('profile:mine:apiKey')).toBe(false)
  })

  it('rewrites a shared profile’s secret reference so it routes to the shared store', async () => {
    const merged = await readUser(new SharedProfileConfigStore(new MemoryConfigStore(), () => shared))
    const first = (merged['profiles'] as ProviderProfile[])[0]
    expect(first?.auth).toMatchObject({ apiKeyRef: 'profile:shared:gateway:apiKey' })
    expect(isSharedSecretRef((first?.auth as { apiKeyRef: string }).apiKeyRef)).toBe(true)
  })
})

class MemorySecretStore implements SecretStore {
  constructor(public readonly values = new Map<string, string>()) {}
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key)
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
  async clear(): Promise<void> {
    this.values.clear()
  }
  backendName(): string {
    return 'memory'
  }
}

describe('which store a secret lands in', () => {
  it('sends a shared profile’s key to the shared store and everything else to the user’s', async () => {
    const own = new MemorySecretStore()
    const sharedSecrets = new MemorySecretStore()
    const routed = new RoutedSecretStore(own, sharedSecrets)

    await routed.set('profile:shared:gateway:apiKey', 'admin-key')
    await routed.set('profile:mine:apiKey', 'my-key')

    expect(sharedSecrets.values.get('profile:shared:gateway:apiKey')).toBe('admin-key')
    expect(own.values.get('profile:mine:apiKey')).toBe('my-key')
    expect(await routed.get('profile:shared:gateway:apiKey')).toBe('admin-key')
  })

  /**
   * "Clear all stored secrets" is offered to every user, and an administrator's key is not theirs
   * to destroy — one person tidying up would otherwise break the gateway for everybody.
   */
  it('clears only the user’s own', async () => {
    const own = new MemorySecretStore(new Map([['profile:mine:apiKey', 'my-key']]))
    const sharedSecrets = new MemorySecretStore(new Map([['profile:shared:gateway:apiKey', 'admin-key']]))

    await new RoutedSecretStore(own, sharedSecrets).clear()

    expect(own.values.size).toBe(0)
    expect(sharedSecrets.values.get('profile:shared:gateway:apiKey')).toBe('admin-key')
  })
})
