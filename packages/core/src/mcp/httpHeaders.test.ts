import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import type { SecretStore } from '../platform/secrets.js'
import { interpolateSecrets, McpConnection, unauthorizedHint } from './client.js'
import type { McpServerConfig } from './types.js'

/**
 * Whether a configured header actually reaches an HTTP MCP server — measured on a real socket.
 *
 * Reported from real use: a server another client talked to happily answered 401 here, with a
 * plain token in the header. Reading the SDK says the headers are merged in; this test is what
 * stops that being an assumption. It records every request a loopback server receives and
 * refuses any without the expected `Authorization`, the way a real server would.
 */

const noSecrets: SecretStore = {
  get: async () => undefined,
  set: async () => {},
  delete: async () => {},
  backend: () => 'memory',
} as unknown as SecretStore

let server: Server | undefined
afterEach(async () => {
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())))
  server = undefined
})

/** A minimal Streamable HTTP server: answers initialize and tools/list, 401 without the token. */
async function startServer(expected: string): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = []
  server = createServer((request, response) => {
    seen.push(request.headers)
    if (request.headers['authorization'] !== expected) {
      response.writeHead(401, { 'www-authenticate': 'Bearer' }).end('unauthorised')
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString()))
    request.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method: string }
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
          : { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/mcp`, seen }
}

describe('HTTP MCP headers', () => {
  it('sends a plain configured token on every request, and connects', async () => {
    const { url, seen } = await startServer('Bearer plain-token')
    const config = { url, type: 'streamable-http', headers: { Authorization: 'Bearer plain-token' } } as McpServerConfig
    const connection = new McpConnection('t', config, noSecrets, () => {})
    await connection.connect()
    expect((await connection.listTools()).map((tool) => tool.name)).toEqual(['echo'])
    await connection.close()
    expect(seen.length).toBeGreaterThan(0)
    for (const headers of seen) expect(headers['authorization']).toBe('Bearer plain-token')
  })

  it('sends it with no type set too, where the SSE fallback exists', async () => {
    const { url, seen } = await startServer('Bearer plain-token')
    const config = { url, headers: { Authorization: 'Bearer plain-token' } } as McpServerConfig
    const connection = new McpConnection('t', config, noSecrets, () => {})
    await connection.connect()
    await connection.close()
    for (const headers of seen) expect(headers['authorization']).toBe('Bearer plain-token')
  })

  it('reports both failures when the SSE retry also fails, not only the second', async () => {
    const { url } = await startServer('Bearer right')
    const logs: string[] = []
    const config = { url, headers: { Authorization: 'Bearer wrong' } } as McpServerConfig
    const connection = new McpConnection('t', config, noSecrets, () => {}, (line) => logs.push(line))
    await expect(connection.connect()).rejects.toThrow(/Streamable HTTP failed: .*Retried as SSE, which also failed/)
    expect(logs.join('\n')).toContain('The server answered 401')
  })
})

describe('references in headers and env', () => {
  const stored: SecretStore = { ...noSecrets, get: async (name: string) => (name === 'tok' ? 's3cret' : undefined) } as SecretStore

  it('resolves ${env:NAME} as Roo Code and Cline configs write it', async () => {
    expect(await interpolateSecrets({ Authorization: 'Bearer ${env:MCP_TOKEN}' }, noSecrets, { env: { MCP_TOKEN: 'abc' } })).toEqual({
      Authorization: 'Bearer abc',
    })
    await expect(interpolateSecrets({ A: '${env:MISSING}' }, noSecrets, { env: {} })).rejects.toThrow(/not set in the environment/)
  })

  it('refuses a reference it does not understand rather than sending it literally', async () => {
    await expect(interpolateSecrets({ Authorization: 'Bearer ${input:token}' }, noSecrets)).rejects.toThrow(/does not resolve/)
  })

  /* A cloned repository's server connects when the panel opens: it must not be able to read your secrets. */
  it('resolves nothing for a server the repository defined', async () => {
    expect(await interpolateSecrets({ A: '${secret:tok}' }, stored)).toEqual({ A: 's3cret' })
    await expect(interpolateSecrets({ A: '${secret:tok}' }, stored, { repositoryDefined: true })).rejects.toThrow(/\.lightcode\/config\.json/)
    await expect(interpolateSecrets({ A: '${env:PATH}' }, stored, { repositoryDefined: true })).rejects.toThrow(/may not read/)
    // A literal value is the repository's own business.
    expect(await interpolateSecrets({ A: 'literal' }, stored, { repositoryDefined: true })).toEqual({ A: 'literal' })
  })
})

describe('the 401 hint', () => {
  it('spots a bare token and a doubled scheme, and never prints a value', () => {
    const bare = unauthorizedHint({ url: 'https://x', headers: { Authorization: 'abc123' } } as McpServerConfig)
    expect(bare).toContain('bare token')
    expect(bare).not.toContain('abc123')
    expect(unauthorizedHint({ url: 'https://x', headers: { Authorization: 'Bearer Bearer abc' } } as McpServerConfig)).toContain('Bearer Bearer')
    expect(unauthorizedHint({ url: 'https://x', headers: { Authorization: 'Bearer abc' } } as McpServerConfig)).not.toContain('bare token')
  })
})
