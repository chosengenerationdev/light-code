import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deliveryFor, possibleSecretRefs, secretEnvName } from './delivery.js'
import { discoverAddons, runnableServers, addonServerEntry } from './discover.js'
import { addonSecretRef, cleanAddonValues, recordUpdateFrom, type AddonField } from './page.js'

/**
 * An add-on's own tab: what it may declare, how what the user enters is checked, and how it reaches
 * the add-on - values in a file, secrets only as references resolved when it starts.
 */

const fields: AddonField[] = [
  { key: 'label', label: 'Label', type: 'string', required: true, pattern: '^[a-z0-9-]+$', patternMessage: 'lower case, digits and dashes' },
  { key: 'port', label: 'Port', type: 'number', default: 22 },
  { key: 'auth', label: 'Sign in with', type: 'choice', default: 'agent', options: [{ value: 'agent', label: 'Agent' }, { value: 'key', label: 'Key' }] },
  { key: 'keyFile', label: 'Key file', type: 'path', required: true, showWhen: { field: 'auth', equals: 'key' } },
  { key: 'password', label: 'Password', type: 'secret' },
]

describe('what the user enters', () => {
  it('is typed, defaulted, and checked - and secrets never land in the values', () => {
    expect(cleanAddonValues(fields, { label: 'web-1', port: '2222', password: 'x' })).toEqual({ ok: true, values: { label: 'web-1', port: 2222, auth: 'agent' } })
    expect(cleanAddonValues(fields, { label: 'Web 1' })).toEqual({ ok: false, message: 'lower case, digits and dashes' })
    expect(cleanAddonValues(fields, {})).toEqual({ ok: false, message: 'Label is required.' })
    expect(cleanAddonValues(fields, { label: 'a', port: 'x' })).toEqual({ ok: false, message: 'Port must be a number.' })
    expect(cleanAddonValues(fields, { label: 'a', auth: 'telnet' })).toEqual({ ok: false, message: 'Sign in with: choose one of the options.' })
  })

  it('requires a field only while it is shown, and drops it when it is not', () => {
    expect(cleanAddonValues(fields, { label: 'a', auth: 'key' })).toEqual({ ok: false, message: 'Key file is required.' })
    expect(cleanAddonValues(fields, { label: 'a', auth: 'agent', keyFile: 'C:/k' })).toEqual({ ok: true, values: { label: 'a', port: 22, auth: 'agent' } })
  })
})

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-addon-page-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function addon(label: Record<string, unknown>, files: Record<string, string> = {}): Promise<string> {
  const folder = path.join(dir, 'pkg')
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, 'server.js'), '')
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(folder, name), text)
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'light-code-addon-x', version: '1.0.0', lightCode: { addon: { main: 'server.js', ...label } } }))
  return folder
}

describe("a button's answer", () => {
  it('may ask for its record to change, and nothing else is read as such a request', () => {
    expect(recordUpdateFrom({ lightCode: { recordUpdate: { auth: 'key', keyFile: 'C:/k' } } })).toEqual({ auth: 'key', keyFile: 'C:/k' })
    expect(recordUpdateFrom({ recordUpdate: { auth: 'key' } })).toBeUndefined()
    expect(recordUpdateFrom({ lightCode: { recordUpdate: ['x'] } })).toBeUndefined()
    expect(recordUpdateFrom(undefined)).toBeUndefined()
    // Applied as if typed: a secret it names is dropped, a value outside the options refused.
    expect(cleanAddonValues(fields, { label: 'a', auth: 'key', keyFile: 'C:/k', password: 'leak' })).toEqual({ ok: true, values: { label: 'a', port: 22, auth: 'key', keyFile: 'C:/k' } })
  })
})

describe('what an add-on declares', () => {
  it('a page and an SVG icon, read from the package', async () => {
    const folder = await addon(
      { icon: 'x.svg', settings: 'page.json' },
      { 'x.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'page.json': JSON.stringify({ title: 'X', records: { noun: 'host', title: 'Hosts', keyField: 'label', fields } }) },
    )
    const [found] = (await discoverAddons([folder])).addons
    expect(found?.page?.title).toBe('X')
    expect(found?.icon).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(found?.pageProblem).toBeUndefined()
  })

  it('keeps its tools when its page or icon cannot be used, and says why', async () => {
    const folder = await addon({ icon: '../outside.svg', settings: { title: 'X', records: { noun: 'h', title: 'H', keyField: 'missing', fields } } })
    const [found] = (await discoverAddons([folder])).addons
    expect(found?.server).toBe('addon-x')
    expect(found?.page).toBeUndefined()
    expect(found?.icon).toBeUndefined()
    expect(found?.pageProblem).toContain('outside the package folder')
    expect(found?.pageProblem).toContain('keyField "missing"')
  })

  it('refuses an icon that is not an SVG', async () => {
    const folder = await addon({ icon: 'x.svg' }, { 'x.svg': '<html><script>alert(1)</script></html>' })
    const [found] = (await discoverAddons([folder])).addons
    expect(found?.icon).toBeUndefined()
    expect(found?.pageProblem).toContain('is not an SVG')
  })
})

describe('what the add-on is given', () => {
  it('values in a file, each stored secret only as a reference, and nothing for a secret not stored', async () => {
    const folder = await addon({ settings: { title: 'X', records: { noun: 'h', title: 'H', keyField: 'label', fields } } })
    const [found] = (await discoverAddons([folder])).addons
    const settings = { records: [{ id: 'r1', values: { label: 'a' } }, { id: 'r2', values: { label: 'b' } }] }
    const refs = possibleSecretRefs(found!, settings)
    expect(refs).toEqual([addonSecretRef('light-code-addon-x', 'r1', 'password'), addonSecretRef('light-code-addon-x', 'r2', 'password')])
    const delivery = deliveryFor(dir, found!, settings, new Set([refs[0]!]))
    const name = secretEnvName(refs[0]!)
    expect(delivery.env[name]).toBe(`\${secret:${refs[0]!}}`)
    expect(Object.keys(delivery.env).filter((key) => key.startsWith('LC_SECRET_'))).toEqual([name])
    expect(delivery.contents.secrets).toEqual({ r1: { password: name } })
    expect(delivery.env['LIGHT_CODE_ADDON_SETTINGS']).toBe(path.join(dir, 'addons', 'addon-x', 'settings.json'))
    // Reaches the server's environment only for an add-on enabled from the user's own settings.
    const servers = { 'addon-x': addonServerEntry(found!) }
    const runtime = { execPath: 'node', electron: false }
    expect((runnableServers(servers, [found!], runtime, [], () => delivery.env)['addon-x'] as { env?: Record<string, string> }).env?.[name]).toBeDefined()
    expect((runnableServers(servers, [found!], runtime, ['addon-x'], () => delivery.env)['addon-x'] as { disabled?: boolean }).disabled).toBe(true)
  })
})
