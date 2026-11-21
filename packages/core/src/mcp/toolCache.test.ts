import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SecretStore } from '../platform/secrets.js'
import { McpRegistry } from './registry.js'
import { fileMcpToolCache } from './toolCache.js'
import type { McpServersConfig } from './types.js'

/**
 * Reported: a Fire Code chat took minutes to answer after a crash or a sleep, because every chat is its own
 * host and each waited for every MCP server to start before its first reply. These run a real server (the
 * SDK on both ends, a real child process) that is slow to start, through two registries sharing one cache
 * file - the second chat of a codebase.
 */
const require = createRequire(import.meta.url)
const esm = (name: string): string => url.pathToFileURL(require.resolve(name).replace(/[\\/]cjs[\\/]/, `${path.sep}esm${path.sep}`)).href
const zod = url.pathToFileURL(require.resolve('zod')).href

const secrets: SecretStore = {
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
  clear: async () => undefined,
  backendName: () => 'none',
}

let root: string
const registries: McpRegistry[] = []
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-mcp-cache-'))
})
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.closeAll()))
  await fs.rm(root, { recursive: true, force: true })
})

async function slowServer(delayMs: number): Promise<McpServersConfig> {
  const file = path.join(root, 'server.mjs')
  await fs.writeFile(
    file,
    [
      `import { McpServer } from '${esm('@modelcontextprotocol/sdk/server/mcp.js')}'`,
      `import { StdioServerTransport } from '${esm('@modelcontextprotocol/sdk/server/stdio.js')}'`,
      `import { z } from '${zod}'`,
      `await new Promise((r) => setTimeout(r, ${String(delayMs)}))`,
      `const server = new McpServer({ name: 'slow', version: '1.0.0' })`,
      `server.registerTool('greet', { description: 'Greets someone by name.', inputSchema: { name: z.string() } },`,
      "  async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }))",
      `await server.connect(new StdioServerTransport())`,
    ].join('\n'),
  )
  return { slow: { command: process.execPath, args: [file] } }
}

function registry(cacheFile: string): McpRegistry {
  const created = new McpRegistry(secrets, { onStateChanged: () => {} }, undefined, () => [], undefined, async () => false, fileMcpToolCache(cacheFile))
  registries.push(created)
  return created
}

describe('the shared MCP tool list', () => {
  it('lets a second session offer and call a slow server\'s tools without waiting for it to start first', async () => {
    const servers = await slowServer(1500)
    const cacheFile = path.join(root, 'mcp-tools.json')

    const first = registry(cacheFile)
    await first.configure(servers)
    expect(first.enabledTools()).toEqual([])
    await first.ensureReady()
    expect(first.enabledTools().map((tool) => tool.name)).toEqual(['slow__greet'])
    // Written in the background once the server listed its tools.
    await expect.poll(async () => (await fs.readFile(cacheFile, 'utf8').catch(() => '')).includes('greet')).toBe(true)

    const second = registry(cacheFile)
    await second.configure(servers)
    // Offered at once, from the list the first session saw.
    expect(second.enabledTools().map((tool) => tool.name)).toEqual(['slow__greet'])
    const before = Date.now()
    const still = await second.ensureReady()
    expect(Date.now() - before).toBeLessThan(1000)
    expect(still).toEqual(['slow'])
    // A call waits for the server, then reaches it.
    const result = await second.enabledTools()[0]!.execute({ name: 'Ada' }, {} as never)
    expect(JSON.stringify(result)).toContain('Hello, Ada!')
  }, 30_000)

  it('is not used once the server\'s connection settings change', async () => {
    const servers = await slowServer(0)
    const cacheFile = path.join(root, 'mcp-tools.json')
    const first = registry(cacheFile)
    await first.configure(servers)
    await first.ensureReady()
    await expect.poll(async () => (await fs.readFile(cacheFile, 'utf8').catch(() => '')).includes('greet')).toBe(true)

    const second = registry(cacheFile)
    await second.configure({ slow: { ...servers.slow!, env: { CHANGED: '1' } } as McpServersConfig[string] })
    expect(second.enabledTools()).toEqual([])
  }, 30_000)

  it('starts a server once when two callers ask at the same time', async () => {
    const servers = await slowServer(300)
    const started: string[] = []
    const reg = new McpRegistry(secrets, { onStateChanged: () => {} }, { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined } as never)
    registries.push(reg)
    await reg.configure(servers)
    const spy = reg as unknown as { connect: (name: string, config: unknown) => Promise<void> }
    const original = spy.connect.bind(reg)
    spy.connect = async (name, config) => {
      started.push(name)
      return original(name, config)
    }
    await Promise.all([reg.ensureConnected(), reg.ensureReady(), reg.connectServer('slow')])
    expect(started).toEqual(['slow'])
  }, 30_000)
})
