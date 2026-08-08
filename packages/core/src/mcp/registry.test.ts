import { describe, expect, it } from 'vitest'
import type { SecretStore } from '../platform/secrets.js'
import { interpolateSecrets } from './client.js'
import { McpRegistry } from './registry.js'

class FakeSecretStore implements SecretStore {
  private readonly values = new Map<string, string>()
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.values.set(k, v)
  }
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
    return 'fake'
  }
}

function registry(secrets = new FakeSecretStore()): McpRegistry {
  return new McpRegistry(secrets, { onStateChanged: () => {} })
}

describe('interpolateSecrets', () => {
  it('resolves a ${secret:NAME} reference from the store', async () => {
    const secrets = new FakeSecretStore({ 'mcp:github:token': 'ghp_real' })
    const result = await interpolateSecrets({ GITHUB_TOKEN: '${secret:mcp:github:token}' }, secrets)
    expect(result).toEqual({ GITHUB_TOKEN: 'ghp_real' })
  })

  it('leaves plain values untouched', async () => {
    const result = await interpolateSecrets({ LOG_LEVEL: 'debug' }, new FakeSecretStore())
    expect(result).toEqual({ LOG_LEVEL: 'debug' })
  })

  it('fails loudly rather than passing the placeholder through as a literal', async () => {
    await expect(interpolateSecrets({ TOKEN: '${secret:missing}' }, new FakeSecretStore())).rejects.toThrow(
      /is not stored/i,
    )
  })
})

describe('McpRegistry enable/disable', () => {
  it('reports a disabled server as disabled without connecting', async () => {
    const mcp = registry()
    await mcp.configure({ a: { command: 'node', disabled: true } })

    expect(mcp.states_()).toEqual([{ name: 'a', status: 'disabled', toolNames: [] }])
    // No tools are contributed, so nothing reaches the system prompt.
    expect(mcp.enabledTools()).toEqual([])
  })

  it('tracks configured servers as idle until first use', async () => {
    const mcp = registry()
    await mcp.configure({ a: { command: 'node' }, b: { url: 'https://example.com/mcp' } })

    expect(mcp.states_().map((s) => [s.name, s.status])).toEqual([
      ['a', 'idle'],
      ['b', 'idle'],
    ])
  })

  it('forgets a server removed from config', async () => {
    const mcp = registry()
    await mcp.configure({ a: { command: 'node' }, b: { command: 'node' } })
    await mcp.configure({ a: { command: 'node' } })

    expect(mcp.states_().map((s) => s.name)).toEqual(['a'])
  })

  it('warns about package-runner commands, and only those', async () => {
    const mcp = registry()
    await mcp.configure({
      fetched: { command: 'npx', args: ['-y', 'some-server'] },
      local: { command: 'node', args: ['server.js'] },
    })

    expect(mcp.warningsFor('fetched')[0]).toMatch(/downloads the server from the network/i)
    expect(mcp.warningsFor('local')).toEqual([])
  })
})
