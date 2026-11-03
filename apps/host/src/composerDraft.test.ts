import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * Reported from Fire Code: the agent crashed, and on restart what had been typed was gone. The page's own storage
 * belongs to its address, and a restarted host listens on a new port - so the host keeps the draft too. Driven
 * against a running server, then a second server on the same data folder, as a restart is.
 */

let running: RunningServer | undefined
let dataDir = ''
let workspace = ''

afterEach(async () => {
  await running?.close()
  running = undefined
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined)
})

type Message = { type: string } & Record<string, unknown>

async function session(): Promise<{ post: (message: object) => Promise<void>; next: (type: string) => Promise<Message> }> {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-draft-data-'))
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-draft-ws-'))
  running = await startServer({ workspaceRoot: workspace, dataDir, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
  const url = running.url
  await fetch(`${url}/api/poll`, { headers: { Origin: url } })
  const inbox: Message[] = []
  return {
    async post(message) {
      const response = await fetch(`${url}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url },
        body: JSON.stringify(message),
      })
      expect(response.status).toBe(202)
    },
    async next(type) {
      const deadline = Date.now() + 8000
      for (;;) {
        const found = inbox.findIndex((message) => message.type === type)
        if (found >= 0) return inbox.splice(found, 1)[0]!
        if (Date.now() > deadline) throw new Error(`no ${type} message arrived`)
        const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
        inbox.push(...((await response.json()) as { messages: Message[] }).messages)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    },
  }
}

describe('the draft being typed', () => {
  it('is kept by the host and handed back after a restart', async () => {
    const first = await session()
    await first.post({ type: 'saveComposerDraft', text: 'why did JOB_X fail at 02:00' })
    await first.post({ type: 'requestComposerDraft' })
    expect(await first.next('composerDraft')).toMatchObject({ text: 'why did JOB_X fail at 02:00' })

    // The restart: the same data folder and workspace, a new server and port.
    await running?.close()
    const keepData = dataDir
    const keepWorkspace = workspace
    running = await startServer({ workspaceRoot: keepWorkspace, dataDir: keepData, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
    const url = running.url
    await fetch(`${url}/api/poll`, { headers: { Origin: url } })
    await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ type: 'requestComposerDraft' }) })
    let restored: Message | undefined
    for (let n = 0; n < 100 && restored === undefined; n += 1) {
      const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
      restored = ((await response.json()) as { messages: Message[] }).messages.find((m) => m.type === 'composerDraft')
      if (restored === undefined) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(restored).toMatchObject({ text: 'why did JOB_X fail at 02:00' })

    // Sent: an empty draft removes it.
    await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ type: 'saveComposerDraft', text: '' }) })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ type: 'requestComposerDraft' }) })
    let cleared: Message | undefined
    for (let n = 0; n < 100 && cleared === undefined; n += 1) {
      const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
      cleared = ((await response.json()) as { messages: Message[] }).messages.find((m) => m.type === 'composerDraft')
      if (cleared === undefined) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(cleared).toMatchObject({ text: '' })
  }, 30_000)
})
