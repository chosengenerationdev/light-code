import { describe, expect, it } from 'vitest'
import type { SecretStore } from '../platform/secrets.js'
import { CredentialPointerStore, credentialChoices, describePointer } from './credentials.js'
import { secretSlots } from './slots.js'

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>()
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

describe('saved credentials', () => {
  it('a setting holding a pointer reads the credential it points at', async () => {
    const inner = new MemoryStore()
    inner.values.set('credential:ldap#password', 'hunter2')
    inner.values.set('search:corp:password', 'credential:ldap#password')
    const store = new CredentialPointerStore(inner)
    expect(await store.get('search:corp:password')).toBe('hunter2')
  })

  it('so replacing the credential once changes every setting that uses it', async () => {
    const inner = new MemoryStore()
    inner.values.set('credential:ldap#password', 'old')
    inner.values.set('a', 'credential:ldap#password')
    inner.values.set('b', 'credential:ldap#password')
    const store = new CredentialPointerStore(inner)
    await store.set('credential:ldap#password', 'new')
    expect([await store.get('a'), await store.get('b')]).toEqual(['new', 'new'])
  })

  it('a pointer used as a key, as an MCP ${secret:…} does, reads the credential', async () => {
    const inner = new MemoryStore()
    inner.values.set('credential:gh#value', 'ghp_x')
    expect(await new CredentialPointerStore(inner).get('credential:gh#value')).toBe('ghp_x')
  })

  it('follows one hop only: a credential whose value looks like a pointer is just a value', async () => {
    const inner = new MemoryStore()
    inner.values.set('credential:odd#value', 'credential:other#value')
    inner.values.set('credential:other#value', 'should not be reached')
    inner.values.set('slot', 'credential:odd#value')
    expect(await new CredentialPointerStore(inner).get('slot')).toBe('credential:other#value')
  })

  it('a deleted credential reads as missing, not as the pointer text', async () => {
    const inner = new MemoryStore()
    inner.values.set('profile:gw:apiKey', 'credential:gone#value')
    expect(await new CredentialPointerStore(inner).get('profile:gw:apiKey')).toBeUndefined()
  })

  it('offers a login as its password and its username, and labels them', () => {
    const credentials = [
      { id: 'ldap', label: 'Corp LDAP', kind: 'login' as const },
      { id: 'ds', label: 'DeepSeek', kind: 'secret' as const },
    ]
    expect(credentialChoices(credentials).map((c) => c.label)).toEqual([
      'Corp LDAP — password',
      'Corp LDAP — username',
      'DeepSeek',
    ])
    expect(describePointer('credential:ldap#username', credentials)).toBe('Corp LDAP — username')
  })
})

describe('secretSlots', () => {
  it('finds every reference a config holds, labelled for a person', () => {
    const slots = secretSlots({
      profiles: [{ id: 'gw', label: 'Corp gateway', auth: { type: 'apiKey', apiKeyRef: 'profile:gw:apiKey' } }],
      vectorStores: { corp: { label: 'Team cluster', usernameRef: 'search:corp:username', passwordRef: 'search:corp:password' } },
      jira: { site: 'https://jira.example', tokenRef: 'jira:token' },
      python: { env: { DB_PASSWORD: { secret: true }, REGION: 'eu' } },
      mcpServers: { github: { command: 'npx', env: { GITHUB_TOKEN: '${secret:github-token}', HOME: '${env:HOME}' } } },
    })
    expect(slots).toEqual(
      expect.arrayContaining([
        { key: 'profile:gw:apiKey', label: 'Corp gateway: API key' },
        { key: 'search:corp:password', label: 'Team cluster: password' },
        { key: 'search:corp:username', label: 'Team cluster: username' },
        { key: 'jira:token', label: 'Jira: token' },
        { key: 'python:env:DB_PASSWORD', label: 'Python variable DB_PASSWORD' },
        { key: 'github-token', label: 'MCP server github: github-token' },
      ]),
    )
    expect(slots).toHaveLength(6)
  })

  it('skips environment references, which are not secret storage', () => {
    expect(secretSlots({ profiles: [{ label: 'x', headers: [{ name: 'X', valueRef: 'env:TOKEN' }] }] })).toEqual([])
  })
})
