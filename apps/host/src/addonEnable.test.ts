import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * Pressing Enable on an installed add-on, against a running host - the Fire Code path.
 *
 * Reported from real use: Enable ended in "starting MCP failed" in VS Code, nothing at all in Fire Code,
 * and no add-on tab anywhere. The reason went to the chat behind the Settings page, and a start that threw
 * skipped sending the add-on list, which is what makes the tab appear. Whatever happens when it starts,
 * the list now comes back with the add-on enabled - so its tab is there - and the reason on the Add-ons tab.
 */

const linux = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../addons/linux')

let running: RunningServer | undefined
const cleanup: string[] = []

afterEach(async () => {
  await running?.close()
  running = undefined
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

type Message = { type: string } & Record<string, unknown>
type AddonRow = { package: string; state: string; pageTitle?: string; status?: string; error?: string; logs?: string[] }

async function session(): Promise<{ post: (message: object) => Promise<void>; addonsAfter: (test: (rows: AddonRow[]) => boolean) => Promise<AddonRow[]> }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-addon-data-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-addon-ws-'))
  cleanup.push(dataDir, workspace)
  running = await startServer({ workspaceRoot: workspace, dataDir, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
  const url = running.url
  await fetch(`${url}/api/poll`, { headers: { Origin: url } })
  const post = async (message: object): Promise<void> => {
    const response = await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(message) })
    expect(response.status).toBe(202)
  }
  return {
    post,
    async addonsAfter(test) {
      const deadline = Date.now() + 15_000
      let last: AddonRow[] = []
      while (Date.now() < deadline) {
        const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
        for (const message of ((await response.json()) as { messages: Message[] }).messages) {
          if (message.type === 'mcp') await post({ type: 'requestAddons' })
          if (message.type !== 'addons') continue
          last = message.addons as AddonRow[]
          if (test(last)) return last
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`the add-on list never matched; last seen: ${JSON.stringify(last).slice(0, 600)}`)
    },
  }
}

describe('enabling an add-on', () => {
  it('reports one that fails to start as enabled, with its tab and the reason', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-addon-broken-'))
    cleanup.push(folder)
    await fs.writeFile(
      path.join(folder, 'package.json'),
      JSON.stringify({ name: 'broken-addon', version: '1.0.0', lightCode: { addon: { main: 'server.cjs', settings: { title: 'Broken', fields: [{ key: 'x', label: 'X', type: 'string' }] } } } }),
    )
    await fs.writeFile(path.join(folder, 'server.cjs'), "console.error('cannot reach the thing it needs'); process.exit(3)\n")

    const { post, addonsAfter } = await session()
    await post({ type: 'saveAddonFolders', folders: [folder] })
    await addonsAfter((rows) => rows.some((row) => row.package === 'broken-addon'))
    await post({ type: 'enableAddon', package: 'broken-addon' })
    const rows = await addonsAfter((list) => list.some((row) => row.package === 'broken-addon' && row.status === 'failed'))
    const row = rows.find((candidate) => candidate.package === 'broken-addon')!
    // Enabled with a page title is exactly what puts its tab in Settings.
    expect(row).toMatchObject({ state: 'enabled', pageTitle: 'Broken', status: 'failed' })
    expect((row.logs ?? []).join('\n')).toContain('cannot reach the thing it needs')
  }, 60_000)

  it.skipIf(!existsSync(path.join(linux, 'dist', 'server.cjs')))('starts the Linux add-on and keeps its tab', async () => {
    const { post, addonsAfter } = await session()
    await post({ type: 'saveAddonFolders', folders: [linux] })
    await addonsAfter((rows) => rows.some((row) => row.package === '@chosengeneration/light-code-addon-linux'))
    await post({ type: 'enableAddon', package: '@chosengeneration/light-code-addon-linux' })
    const rows = await addonsAfter((list) => list.some((row) => row.package.endsWith('addon-linux') && row.status === 'ready'))
    expect(rows.find((row) => row.package.endsWith('addon-linux'))).toMatchObject({ state: 'enabled', pageTitle: 'Linux', status: 'ready' })
  }, 60_000)
})
