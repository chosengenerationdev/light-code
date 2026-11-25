import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FetchHttpClient } from '../platform/http.js'
import type { SecretStore } from '../platform/secrets.js'
import { McpConnection } from './client.js'
import type { McpServerConfig } from './types.js'

/**
 * Reported: an HTTP MCP server failed in Fire Code with "unable to verify the first certificate" and worked in VS Code -
 * the SDK's global fetch used whatever the process trusted. HTTP servers now go out through Light Code's own client,
 * with the certificate settings. A real HTTPS MCP server here, with a certificate nobody trusts (made with openssl).
 */

const noSecrets = { get: async () => undefined, set: async () => {}, delete: async () => {}, backend: () => 'memory' } as unknown as SecretStore
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let server: Server | undefined
let url = ''
let cert = Buffer.alloc(0)
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mcp-tls-'))

beforeAll(async () => {
  if (!hasOpenssl) return
  const keyPath = path.join(folder, 'key.pem')
  const certPath = path.join(folder, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
  cert = fs.readFileSync(certPath)
  server = createServer({ key: fs.readFileSync(keyPath), cert }, (request, response) => {
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
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tls', version: '1' } }
          : { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
  url = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`
})

afterAll(async () => {
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())))
  fs.rmSync(folder, { recursive: true, force: true })
})

describe.skipIf(!hasOpenssl)('an HTTPS MCP server with a certificate nobody trusts', () => {
  const config = (): McpServerConfig => ({ url, type: 'streamable-http' }) as McpServerConfig
  const client = new FetchHttpClient()

  it('is refused by default', async () => {
    const connection = new McpConnection('t', config(), noSecrets, () => {}, () => {}, undefined, { fetch: client.fetchFunction({}) })
    await expect(connection.connect()).rejects.toThrow()
  })

  it('connects when told not to verify it', async () => {
    const connection = new McpConnection('t', config(), noSecrets, () => {}, () => {}, undefined, { fetch: client.fetchFunction({ rejectUnauthorized: false }) })
    await connection.connect()
    expect((await connection.listTools()).map((tool) => tool.name)).toEqual(['echo'])
    await connection.close()
  })

  it('connects when its CA is trusted', async () => {
    const connection = new McpConnection('t', config(), noSecrets, () => {}, () => {}, undefined, { fetch: client.fetchFunction({ ca: [cert] }) })
    await connection.connect()
    expect((await connection.listTools()).map((tool) => tool.name)).toEqual(['echo'])
    await connection.close()
  })
})
