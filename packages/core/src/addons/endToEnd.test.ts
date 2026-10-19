import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { McpRegistry } from '../mcp/registry.js'
import type { McpServersConfig } from '../mcp/types.js'
import type { SecretStore } from '../platform/secrets.js'
import { addonServerEntry, discoverAddons, runnableServers } from './discover.js'

/**
 * An add-on, installed, enabled, and giving the agent a tool - through the real MCP registry, the
 * real SDK on both ends and a real child process. The unit tests prove the rules; this proves that
 * a package following the documented contract becomes a callable tool.
 */
const require = createRequire(import.meta.url)
const sdkServer = url.pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js').replace(/[\\/]cjs[\\/]/, `${path.sep}esm${path.sep}`)).href
const sdkStdio = url.pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js').replace(/[\\/]cjs[\\/]/, `${path.sep}esm${path.sep}`)).href
const zod = url.pathToFileURL(require.resolve('zod')).href

const secrets: SecretStore = {
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
  clear: async () => undefined,
  backendName: () => 'none',
}

let root: string
let registry: McpRegistry | undefined
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-addon-e2e-'))
})
afterEach(async () => {
  await registry?.closeAll()
  await fs.rm(root, { recursive: true, force: true })
})

describe('an installed add-on', () => {
  it('becomes tools the agent can call once enabled', async () => {
    const dir = path.join(root, 'node_modules', 'light-code-addon-hello')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'light-code-addon-hello', version: '1.0.0', type: 'module', lightCode: { addon: { main: 'server.js', displayName: 'Hello' } } }),
    )
    // The example add-on's server, with its imports pointed at this repository's copies.
    await fs.writeFile(
      path.join(dir, 'server.js'),
      [
        `import { McpServer } from '${sdkServer}'`,
        `import { StdioServerTransport } from '${sdkStdio}'`,
        `import { z } from '${zod}'`,
        `const server = new McpServer({ name: 'hello', version: '1.0.0' })`,
        `server.registerTool('greet', { description: 'Greets someone by name.', inputSchema: { name: z.string() } },`,
        "  async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }))",
        `await server.connect(new StdioServerTransport())`,
      ].join('\n'),
    )

    const { addons, problems } = await discoverAddons([path.join(root, 'node_modules')])
    expect(problems).toEqual([])
    const servers: McpServersConfig = { [addons[0]!.server]: addonServerEntry(addons[0]!) }

    registry = new McpRegistry(secrets, { onStateChanged: () => {} })
    await registry.configure(runnableServers(servers, addons, { execPath: process.execPath, electron: false }))
    await registry.ensureConnected()

    const tool = registry.enabledTools().find((candidate) => candidate.name === 'addon-hello__greet')
    expect(tool, JSON.stringify(registry.enabledTools().map((t) => t.name))).toBeDefined()
    const result = await tool!.execute({ name: 'Ada' }, {} as never)
    expect(JSON.stringify(result)).toContain('Hello, Ada!')
  }, 30_000)
})
