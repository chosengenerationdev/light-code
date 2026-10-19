import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import * as esbuild from 'esbuild'
import { Server, utils, type Connection } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { deliveryFor, possibleSecretRefs } from '../../../packages/core/src/addons/delivery.js'
import { addonServerEntry, discoverAddons, runnableServers } from '../../../packages/core/src/addons/discover.js'
import { addonSecretRef } from '../../../packages/core/src/addons/page.js'
import { McpRegistry } from '../../../packages/core/src/mcp/registry.js'
import type { SecretStore } from '../../../packages/core/src/platform/secrets.js'

/**
 * The add-on as `npm i -g` leaves it - the bundle, its package.json and its icon in a folder with no
 * node_modules - found and run by Light Code's own code: discovery reads its tab and icon, delivery
 * hands it the tab's values with the password resolved from secret storage, the MCP registry starts
 * it, and a tool call reaches an SSH server. Every piece is the shipped one.
 */
const here = path.dirname(url.fileURLToPath(import.meta.url))
const packageDir = path.resolve(here, '..')

let installRoot: string
let storage: string
let sshServer: Server
let sshPort: number
const commands: string[] = []

beforeAll(async () => {
  await esbuild.build({
    entryPoints: [path.join(packageDir, 'src', 'main.ts')],
    outfile: path.join(packageDir, 'dist', 'server.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['cpu-features', './crypto/build/Release/sshcrypto.node'],
    loader: { '.node': 'empty' },
    logLevel: 'silent',
  })
  installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-linux-installed-'))
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-linux-storage-'))
  const installed = path.join(installRoot, '@chosengeneration', 'light-code-addon-linux')
  for (const file of ['package.json', 'linux.svg', 'dist/server.cjs']) {
    fs.mkdirSync(path.dirname(path.join(installed, file)), { recursive: true })
    fs.copyFileSync(path.join(packageDir, file), path.join(installed, file))
  }

  sshServer = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client: Connection) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 's3cret' ? ctx.accept() : ctx.reject(['password'])))
    client.on('ready', () =>
      client.on('session', (acceptSession) => {
        acceptSession().on('exec', (accept, _reject, info) => {
          const stream = accept()
          commands.push(info.command)
          stream.write('Filesystem Size Used\n/dev/sda1 50G 20G\n')
          stream.exit(0)
          stream.end()
        })
      }),
    )
    client.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => sshServer.listen(0, '127.0.0.1', resolve))
  sshPort = (sshServer.address() as net.AddressInfo).port
}, 60_000)

afterAll(async () => {
  await new Promise<void>((resolve) => sshServer.close(() => resolve()))
  fs.rmSync(installRoot, { recursive: true, force: true })
  fs.rmSync(storage, { recursive: true, force: true })
})

describe('the installed add-on', () => {
  it('brings its own Linux tab and icon, and nothing else does', async () => {
    const { addons, problems } = await discoverAddons([installRoot])
    expect(problems).toEqual([])
    const [addon] = addons
    expect(addon?.server).toBe('addon-linux')
    expect(addon?.page?.title).toBe('Linux')
    expect(addon?.page?.records?.keyField).toBe('label')
    expect(addon?.icon).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(addon?.pageProblem).toBeUndefined()
    // Uninstalled, there is no add-on - and so no tab.
    expect((await discoverAddons([fs.mkdtempSync(path.join(os.tmpdir(), 'lc-empty-'))])).addons).toEqual([])
  })

  it('runs with what was entered on its tab, the password from secret storage, and answers the agent', async () => {
    const { addons } = await discoverAddons([installRoot])
    const addon = addons[0]!
    const settings = {
      records: [{ id: 'r1', values: { label: 'prod-web-1', host: '127.0.0.1', port: sshPort, username: 'ann', auth: 'password', notes: 'nginx and the app' } }],
    }
    const store = new Map([[addonSecretRef(addon.package, 'r1', 'password'), 's3cret']])
    const secrets: SecretStore = {
      get: async (key) => store.get(key),
      set: async () => undefined,
      delete: async () => undefined,
      clear: async () => undefined,
      backendName: () => 'test',
    }
    const stored = new Set(possibleSecretRefs(addon, settings).filter((ref) => store.has(ref)))
    const delivery = deliveryFor(storage, addon, settings, stored)
    fs.mkdirSync(path.dirname(delivery.file), { recursive: true })
    fs.writeFileSync(delivery.file, JSON.stringify(delivery.contents))
    // No password in the file Light Code writes; only the name of the variable that will hold it.
    expect(fs.readFileSync(delivery.file, 'utf8')).not.toContain('s3cret')

    const registry = new McpRegistry(secrets, { onStateChanged: () => {} })
    try {
      await registry.configure(
        runnableServers({ [addon.server]: addonServerEntry(addon) }, addons, { execPath: process.execPath, electron: false }, [], () => delivery.env),
      )
      await registry.ensureConnected()
      const names = registry.enabledTools().map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(['addon-linux__run', 'addon-linux__download', 'addon-linux__machines']))
      // The one tool that writes to a server is a button only: never in the model's list, so not
      // reachable through call_tool either - but the registry still reaches it for the tab.
      expect(names).not.toContain('addon-linux__setup_key')
      expect(registry.states_().find((server) => server.name === 'addon-linux')?.tools.map((tool) => tool.name)).not.toContain('setup_key')
      expect((await registry.callPanelTool('addon-linux', 'machines', {})).text).toContain('prod-web-1')
      await expect(registry.callPanelTool('addon-linux', 'no_such_tool', {})).rejects.toThrow(/offers no tool/)
      // Registered, and reachable by the button: an unknown label is answered without touching a machine.
      const hidden = await registry.callPanelTool('addon-linux', 'setup_key', { label: 'not-a-machine' })
      expect(hidden).toMatchObject({ isError: true })
      expect(hidden.text).toContain('No machine labelled "not-a-machine"')
      const run = registry.enabledTools().find((tool) => tool.name === 'addon-linux__run')!
      expect(run.description).toContain('prod-web-1')
      const result = await run.execute({ machine: 'prod-web-1', command: 'df -h' }, {} as never)
      expect(JSON.stringify(result)).toContain('/dev/sda1 50G 20G')
      expect(commands).toEqual(['df -h'])
      const refused = await run.execute({ machine: 'prod-web-1', command: 'reboot' }, {} as never)
      expect(JSON.stringify(refused)).toContain('not on the read-only list')
      expect(commands).toEqual(['df -h'])
    } finally {
      await registry.closeAll()
    }
  }, 60_000)
})
