import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * Reported: "why i dont see web chat section under agents in fire code?". The CLI passed the user's personal folder to
 * the server, and neither the server nor the session forwarded it - so on the Node host and in Fire Code there was no
 * personal folder at all: no web chat panel, and no "only me" skills and tools either. Checked on a running host.
 */

let running: RunningServer | undefined
const folders: string[] = []
afterEach(async () => {
  await running?.close()
  running = undefined
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
})

it("reaches the session: the web chat panel is offered when the host has the user's personal folder", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-personal-'))
  folders.push(dataDir)
  const configFile = path.join(dataDir, 'config.json')
  await fs.writeFile(configFile, '{}')
  running = await startServer({
    workspaceRoot: dataDir,
    dataDir,
    configFile,
    clientAssets: {},
    ripgrepPath: () => undefined,
    noToken: true,
    logSink: () => undefined,
    personalDir: path.join(dataDir, 'personal'),
  })
  const url = running.url
  type Message = { type: string } & Record<string, unknown>
  const inbox: Message[] = []
  const poll = async (): Promise<void> => {
    inbox.push(...((await (await fetch(`${url}/api/poll`, { headers: { Origin: url } })).json()) as { messages: Message[] }).messages)
  }
  await poll()
  await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ type: 'requestWebChat' }) })
  for (let i = 0; i < 100 && !inbox.some((m) => m.type === 'webChat'); i += 1) {
    await poll()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  expect(inbox.find((m) => m.type === 'webChat')?.['available']).toBe(true)
}, 30_000)
