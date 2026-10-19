import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { McpServersConfig } from '../mcp/types.js'
import { mcpServersSchema } from '../mcp/types.js'
import {
  addonServerEntry,
  addonServerName,
  addonState,
  defaultAddonFolders,
  discoverAddons,
  missingAddons,
  runnableServers,
} from './discover.js'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-addons-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function pkg(dir: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest))
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await fs.writeFile(path.join(dir, name), text)
  }
  return dir
}

const RUNTIME = { execPath: 'C:/node/node.exe', electron: false }

describe('finding add-ons', () => {
  it('finds labelled packages in a node_modules folder, scoped ones too, and nothing else', async () => {
    const modules = path.join(root, 'node_modules')
    await pkg(path.join(modules, 'light-code-addon-weather'), { name: 'light-code-addon-weather', version: '1.2.0', lightCode: { addon: { main: 'dist/server.js', displayName: 'Weather' } } }, { 'dist/server.js': '' })
    await pkg(path.join(modules, '@team', 'reports'), { name: '@team/reports', version: '0.1.0', main: 'index.js', lightCode: { addon: {} } }, { 'index.js': '' })
    await pkg(path.join(modules, 'left-pad'), { name: 'left-pad', version: '1.0.0', main: 'index.js' }, { 'index.js': '' })

    const { addons, problems } = await discoverAddons([modules])
    expect(problems).toEqual([])
    expect(addons.map((a) => [a.package, a.server, a.displayName])).toEqual([
      ['@team/reports', 'addon-reports', '@team/reports'],
      ['light-code-addon-weather', 'addon-weather', 'Weather'],
    ])
    expect(addons[1]?.main).toBe(path.join(modules, 'light-code-addon-weather', 'dist', 'server.js'))
  })

  it('takes a folder that is itself an add-on - one being written', async () => {
    const dir = await pkg(path.join(root, 'my-addon'), { name: 'my-addon', version: '0.0.1', lightCode: { addon: { main: 'server.js' } } }, { 'server.js': '' })
    const { addons } = await discoverAddons([dir])
    expect(addons.map((a) => a.package)).toEqual(['my-addon'])
  })

  it('says why a labelled package cannot be used, rather than hiding it', async () => {
    const modules = path.join(root, 'nm')
    await pkg(path.join(modules, 'escapes'), { name: 'escapes', version: '1.0.0', lightCode: { addon: { main: '../elsewhere.js' } } })
    await pkg(path.join(modules, 'unbuilt'), { name: 'unbuilt', version: '1.0.0', lightCode: { addon: { main: 'dist/server.js' } } })
    await pkg(path.join(modules, 'nomain'), { name: 'nomain', version: '1.0.0', lightCode: { addon: {} } })
    const { addons, problems } = await discoverAddons([modules])
    expect(addons).toEqual([])
    expect(problems.map((p) => [p.package, p.problem])).toEqual([
      ['escapes', '"../elsewhere.js" is outside the package folder.'],
      ['nomain', 'No server script: set "lightCode.addon.main" to the MCP server file.'],
      ['unbuilt', 'dist/server.js does not exist - was the package built?'],
    ])
  })

  it('lets the first folder win a name, as on a PATH, and skips folders that are not there', async () => {
    const first = await pkg(path.join(root, 'a', 'x'), { name: 'x', version: '2.0.0', lightCode: { addon: { main: 's.js' } } }, { 's.js': '' })
    await pkg(path.join(root, 'b', 'x'), { name: 'x', version: '1.0.0', lightCode: { addon: { main: 's.js' } } }, { 's.js': '' })
    const { addons } = await discoverAddons([path.join(root, 'missing'), path.join(root, 'a'), path.join(root, 'b')])
    expect(addons.map((a) => [a.dir, a.version])).toEqual([[first, '2.0.0']])
  })

  it('looks in npm global folder by default', () => {
    expect(defaultAddonFolders({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\node\\node.exe', 'win32')).toContain(
      path.resolve('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules'),
    )
    expect(defaultAddonFolders({}, '/usr/local/bin/node', 'linux')).toContain(path.resolve('/usr/local/lib/node_modules'))
  })

  it('also looks where npm was told to put global packages, and beside node.exe', () => {
    const npmrc = ['registry=https://mirror.example/', 'prefix=%APPDATA%/custom-npm', ''].join('\n')
    const folders = defaultAddonFolders({ APPDATA: 'C:/Users/a/AppData/Roaming' }, 'C:/nvm/v24/node.exe', 'win32', npmrc)
    expect(folders).toContain(path.resolve('C:/Users/a/AppData/Roaming/custom-npm/node_modules'))
    expect(folders).toContain(path.resolve('C:/nvm/v24/node_modules'))
    // Inside VS Code the runtime is the editor: its folder holds no npm packages.
    expect(defaultAddonFolders({}, 'C:/VSCode/Code.exe', 'win32')).toEqual([])
  })

  it('names the server after the package, short', () => {
    expect(addonServerName('@team/light-code-addon-Big Reports')).toBe('addon-big-reports')
    expect(addonServerName('fire-code-addon-jira')).toBe('addon-jira')
  })
})

describe('running add-ons', () => {
  async function weather(version = '1.0.0'): Promise<Awaited<ReturnType<typeof discoverAddons>>['addons']> {
    const dir = path.join(root, 'nm', 'w')
    await pkg(dir, { name: 'w', version, lightCode: { addon: { main: 'server.js', args: ['--quiet'] } } }, { 'server.js': '' })
    return (await discoverAddons([path.join(root, 'nm')])).addons
  }

  it('writes an ordinary server entry that the MCP schema keeps, settings of an earlier one included', async () => {
    const [addon] = await weather()
    const entry = addonServerEntry(addon!, { command: 'node', disabledTools: ['slow'], timeout: 120 })
    const parsed = mcpServersSchema.parse({ [addon!.server]: entry })
    expect(parsed[addon!.server]).toMatchObject({ addon: { package: 'w', version: '1.0.0' }, disabledTools: ['slow'], timeout: 120 })
  })

  it('runs the installed copy with this host runtime - inside VS Code, its Electron told to be Node', async () => {
    const addons = await weather()
    const servers: McpServersConfig = { 'addon-w': addonServerEntry(addons[0]!) }
    // Written on another machine: the stored path is irrelevant.
    ;(servers['addon-w'] as { args: string[] }).args = ['D:/elsewhere/server.js']
    const plain = runnableServers(servers, addons, RUNTIME)['addon-w'] as { command: string; args: string[]; disabled?: boolean; env?: Record<string, string> }
    expect(plain.command).toBe(RUNTIME.execPath)
    expect(plain.args).toEqual([addons[0]!.main, '--quiet'])
    expect(plain.disabled).toBeUndefined()
    expect(plain.env).toBeUndefined()
    const electron = runnableServers(servers, addons, { execPath: 'Code.exe', electron: true })['addon-w'] as { env?: Record<string, string> }
    expect(electron.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('keeps an updated add-on off until that version is enabled', async () => {
    const before = await weather('1.0.0')
    const servers: McpServersConfig = { 'addon-w': addonServerEntry(before[0]!) }
    const after = await weather('1.1.0')
    expect(addonState(after[0]!, servers)).toBe('updated')
    expect((runnableServers(servers, after, RUNTIME)['addon-w'] as { disabled?: boolean }).disabled).toBe(true)
    expect(addonState(after[0]!, { 'addon-w': addonServerEntry(after[0]!) })).toBe('enabled')
  })

  it('keeps an add-on off when it is no longer installed, and says which', async () => {
    const addons = await weather()
    const servers: McpServersConfig = { 'addon-w': addonServerEntry(addons[0]!) }
    expect((runnableServers(servers, [], RUNTIME)['addon-w'] as { disabled?: boolean }).disabled).toBe(true)
    expect(missingAddons([], servers)).toEqual([{ server: 'addon-w', tag: { package: 'w', version: '1.0.0' } }])
  })

  it('never lets a repository switch on an installed add-on by naming it', async () => {
    const addons = await weather()
    const servers: McpServersConfig = { 'addon-w': addonServerEntry(addons[0]!) }
    expect((runnableServers(servers, addons, RUNTIME, ['addon-w'])['addon-w'] as { disabled?: boolean }).disabled).toBe(true)
  })

  it('leaves every other server exactly as configured', () => {
    const servers: McpServersConfig = { files: { command: 'npx', args: ['-y', 'x'] }, web: { url: 'https://mcp.example/' } }
    expect(runnableServers(servers, [], RUNTIME)).toEqual(servers)
  })
})

describe('the example add-on in the repository', () => {
  it('is found as an add-on, so the example people copy is a working one', async () => {
    const example = path.resolve(__dirname, '..', '..', '..', '..', 'examples', 'light-code-addon-hello')
    const { addons, problems } = await discoverAddons([example])
    expect(problems).toEqual([])
    expect(addons.map((a) => [a.package, a.server, a.displayName])).toEqual([['light-code-addon-hello', 'addon-hello', 'Hello (example)']])
  })
})
