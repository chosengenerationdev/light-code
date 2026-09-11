import { describe, expect, it } from 'vitest'

import type { ConfigScope, ConfigStore } from '@light-code/core'

import { isSharedSecretReference, SharedEntriesConfigStore } from './sharedEntries.js'
import { isSharedSecretRef } from './sharedProfiles.js'

/**
 * Publishing a setting to everyone, for collections keyed by name.
 *
 * Asked for with one case in mind: a search cluster's username and password, configured once
 * rather than by every person separately — which in practice means a password passed round in a
 * message.
 *
 * The design under test is that **the key carries the scope**. There is no list of what is shared,
 * so there is no second place to drift from the first; and a `SecretStore` is handed a reference
 * and nothing else, so the scope has to be *in* that reference for routing to be possible at all.
 */
class FakeStore implements ConfigStore {
  constructor(
    public contents: Record<ConfigScope, string | undefined> = {
      user: undefined,
      workspace: undefined,
    },
  ) {}
  async read(scope: ConfigScope): Promise<string | undefined> {
    return this.contents[scope]
  }
  async write(scope: ConfigScope, contents: string): Promise<void> {
    this.contents[scope] = contents
  }
  watch(): () => void {
    return () => {}
  }
}

const COLLECTIONS = [
  {
    key: 'vectorStores',
    refFields: ['usernameRef', 'passwordRef'],
    refFor: (id: string, field: string) =>
      `search:${id}:${field === 'usernameRef' ? 'username' : 'password'}`,
  },
  { key: 'mcpServers' },
] as const

function store(
  own: Record<string, unknown>,
  shared: Record<string, Record<string, unknown>>,
): { wrapper: SharedEntriesConfigStore; inner: FakeStore } {
  const inner = new FakeStore({ user: JSON.stringify(own), workspace: undefined })
  return { wrapper: new SharedEntriesConfigStore(inner, COLLECTIONS, () => shared), inner }
}

async function readUser(wrapper: SharedEntriesConfigStore): Promise<Record<string, never>> {
  return JSON.parse((await wrapper.read('user')) ?? '{}') as Record<string, never>
}

describe('a shared search connection', () => {
  const shared = {
    vectorStores: {
      team: {
        kind: 'opensearch',
        label: 'Team OpenSearch',
        url: 'https://search.internal:9200',
        usernameRef: 'search:team:username',
        passwordRef: 'search:team:password',
      },
    },
  }

  it('appears in a user config beside their own, under a prefixed key', async () => {
    const { wrapper } = store({ vectorStores: { mine: { kind: 'qdrant', label: 'Mine' } } }, shared)
    const config = (await readUser(wrapper)) as unknown as { vectorStores: Record<string, unknown> }

    expect(Object.keys(config.vectorStores)).toEqual(['shared:team', 'mine'])
  })

  /**
   * The reference has to carry the prefix, or the credential is looked for in the wrong file.
   *
   * The bridge derives `search:<id>:password` from the id, so this follows automatically — but
   * the *stored* reference is rewritten too, so the entry is not internally inconsistent for
   * whatever reads it next.
   */
  it('points its credentials at the shared store', async () => {
    const { wrapper } = store({}, shared)
    const config = (await readUser(wrapper)) as unknown as {
      vectorStores: Record<string, { usernameRef: string; passwordRef: string }>
    }
    const entry = config.vectorStores['shared:team']

    expect(entry?.usernameRef).toBe('search:shared:team:username')
    expect(entry?.passwordRef).toBe('search:shared:team:password')
    expect(isSharedSecretReference(entry?.passwordRef ?? '')).toBe(true)
  })

  /** A connection with no password must not be presented as having one. */
  it('does not invent a reference for a credential that was never set', async () => {
    const { wrapper } = store({}, { vectorStores: { open: { kind: 'chroma', url: 'http://x' } } })
    const config = (await readUser(wrapper)) as unknown as {
      vectorStores: Record<string, Record<string, unknown>>
    }
    expect(config.vectorStores['shared:open']).not.toHaveProperty('passwordRef')
  })

  /**
   * The user's own file never gains a shared entry.
   *
   * If it could, removing one centrally would leave a copy behind in everyone's config — an entry
   * nobody can edit and nobody remembers creating.
   */
  it('is stripped on the way back in, so it never lands in the user file', async () => {
    const { wrapper, inner } = store({}, shared)
    const config = await readUser(wrapper)
    await wrapper.write('user', JSON.stringify(config))

    const written = JSON.parse(inner.contents.user ?? '{}') as {
      vectorStores: Record<string, unknown>
    }
    expect(Object.keys(written.vectorStores)).toEqual([])
  })

  it('keeps the user own entries when writing', async () => {
    const { wrapper, inner } = store({ vectorStores: { mine: { kind: 'qdrant' } } }, shared)
    await wrapper.write('user', (await wrapper.read('user')) ?? '{}')

    const written = JSON.parse(inner.contents.user ?? '{}') as {
      vectorStores: Record<string, unknown>
    }
    expect(Object.keys(written.vectorStores)).toEqual(['mine'])
  })

  /*
   * A file written by an older build, or edited by hand, can hold one. Presenting both would show
   * the entry twice with the administrator's version losing to a copy of unknown origin.
   */
  it('drops a stale shared copy already sitting in the user file', async () => {
    const { wrapper } = store(
      { vectorStores: { 'shared:team': { kind: 'opensearch', label: 'Stale copy' } } },
      shared,
    )
    const config = (await readUser(wrapper)) as unknown as {
      vectorStores: Record<string, { label: string }>
    }
    expect(config.vectorStores['shared:team']?.label).toBe('Team OpenSearch')
  })

  it('leaves workspace config alone, which cannot supply these at all', async () => {
    const inner = new FakeStore({ user: '{}', workspace: '{"vectorStores":{"x":{}}}' })
    const wrapper = new SharedEntriesConfigStore(inner, COLLECTIONS, () => shared)
    expect(await wrapper.read('workspace')).toBe('{"vectorStores":{"x":{}}}')
  })

  it('passes an unparseable file through, so the loader reports the real mistake', async () => {
    const inner = new FakeStore({ user: '{ not json', workspace: undefined })
    const wrapper = new SharedEntriesConfigStore(inner, COLLECTIONS, () => shared)
    expect(await wrapper.read('user')).toBe('{ not json')
  })
})

describe('MCP servers share the same mechanism', () => {
  it('merges and strips exactly as connections do', async () => {
    const shared = { mcpServers: { filesystem: { command: 'mcp-fs' } } }
    const { wrapper, inner } = store({ mcpServers: { mine: { command: 'x' } } }, shared)

    const config = (await readUser(wrapper)) as unknown as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(config.mcpServers)).toEqual(['shared:filesystem', 'mine'])

    await wrapper.write('user', JSON.stringify(config))
    const written = JSON.parse(inner.contents.user ?? '{}') as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(written.mcpServers)).toEqual(['mine'])
  })
})

/**
 * One owner of "is this reference shared".
 *
 * `isSharedSecretRef` tested `profile:shared:` literally, which was right while profiles were the
 * only shared thing. A second collection would have routed its credentials to the wrong file —
 * silently, and the symptom would be one person's password written into another's.
 */
describe('routing a secret reference', () => {
  it('recognises every shared collection, not only profiles', () => {
    expect(isSharedSecretRef('profile:shared:gw:apiKey')).toBe(true)
    expect(isSharedSecretRef('search:shared:team:password')).toBe(true)
    expect(isSharedSecretRef('mcp:shared:fs:token')).toBe(true)
  })

  it('leaves a personal reference alone, including one that merely mentions the word', () => {
    expect(isSharedSecretRef('profile:gw:apiKey')).toBe(false)
    expect(isSharedSecretRef('search:team:password')).toBe(false)
    // The prefix is a whole segment, not a substring: a connection somebody called "shared-notes"
    // is theirs, and routing it to the administrator's file would hide their own password.
    expect(isSharedSecretRef('search:shared-notes:password')).toBe(false)
  })
})
