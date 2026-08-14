import { describe, expect, it } from 'vitest'
import type { SecretStore } from '../platform/secrets.js'
import { interpolateSecrets } from './client.js'
import { connectionSignature, McpRegistry } from './registry.js'

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

function registry(alwaysAllowed: string[] = [], secrets = new FakeSecretStore()): McpRegistry {
  return new McpRegistry(secrets, { onStateChanged: () => {} }, undefined, () => alwaysAllowed)
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

    expect(mcp.states_()).toEqual([{ name: 'a', status: 'disabled', enabled: false, tools: [], logs: [] }])
    // No tools are contributed, so nothing reaches the system prompt.
    expect(mcp.enabledTools()).toEqual([])
  })

  it('tracks configured servers as idle until first use', async () => {
    const mcp = registry()
    await mcp.configure({ a: { command: 'node' }, b: { url: 'https://example.com/mcp' } })

    expect(mcp.states_().map((s) => [s.name, s.status, s.enabled])).toEqual([
      ['a', 'idle', true],
      ['b', 'idle', true],
    ])
  })

  it('forgets a server removed from config', async () => {
    const mcp = registry()
    await mcp.configure({ a: { command: 'node' }, b: { command: 'node' } })
    await mcp.configure({ a: { command: 'node' } })

    expect(mcp.states_().map((s) => s.name)).toEqual(['a'])
  })

  it('re-enabling a server restores it to idle rather than leaving it disabled', async () => {
    const mcp = registry()
    await mcp.configure({ a: { command: 'node', disabled: true } })
    expect(mcp.states_()[0]?.status).toBe('disabled')

    await mcp.configure({ a: { command: 'node' } })
    expect(mcp.states_()[0]).toMatchObject({ status: 'idle', enabled: true })
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

/**
 * Which config changes justify tearing down a running server.
 *
 * A real bug, found in office use: setting a tool to Always or Never writes `disabledTools`
 * into the server's entry, the whole-entry comparison saw a difference, and the connection was
 * dropped mid-session. It stayed down until the next turn, so from the outside changing a
 * permission simply killed the server.
 */
describe('connectionSignature', () => {
  const server = { command: 'node', args: ['server.js'], env: { TOKEN: 'x' } }

  it('ignores a tool being disabled — that is policy, not a connection detail', () => {
    expect(connectionSignature({ ...server, disabledTools: ['dangerous'] })).toBe(connectionSignature(server))
  })

  it('ignores the disabled flag, which is handled deliberately elsewhere', () => {
    expect(connectionSignature({ ...server, disabled: true })).toBe(connectionSignature(server))
  })

  it('still notices a changed command, argument or environment', () => {
    expect(connectionSignature({ ...server, command: 'python' })).not.toBe(connectionSignature(server))
    expect(connectionSignature({ ...server, args: ['other.js'] })).not.toBe(connectionSignature(server))
    expect(connectionSignature({ ...server, env: { TOKEN: 'y' } })).not.toBe(connectionSignature(server))
  })

  it('still notices a changed URL on an HTTP server', () => {
    const http = { url: 'https://a.example/mcp' }
    expect(connectionSignature({ ...http, url: 'https://b.example/mcp' })).not.toBe(connectionSignature(http))
    expect(connectionSignature({ ...http, disabledTools: ['x'] })).toBe(connectionSignature(http))
  })

  /** A server that has gone must always compare as different, so it is disconnected. */
  it('treats a removed server as different from any real one', () => {
    expect(connectionSignature(undefined)).not.toBe(connectionSignature(server))
  })

  /** Adding then clearing a permission must return to the original signature, not drift. */
  it('round-trips when a permission is set and then removed', () => {
    const withPolicy = { ...server, disabledTools: ['a'] }
    const cleared = { ...withPolicy, disabledTools: [] }
    expect(connectionSignature(cleared)).toBe(connectionSignature(server))
  })
})
