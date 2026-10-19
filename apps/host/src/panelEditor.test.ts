import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * Editing the standing instructions, a skill or a tool where there is no editor - Fire Code, the browser.
 *
 * Asked for: "i am not able to edit things like standing instruction with in fire code". There, Open used
 * to paste the file's text into the chat. Driven against a running server, because every claim is about
 * what goes over the wire and what lands on disk.
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
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-editor-data-'))
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-editor-ws-'))
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

describe('the panel editor', () => {
  it('opens the standing instructions for editing and saves the edit to the file', async () => {
    const { post, next } = await session()
    await post({ type: 'openStandingSkill' })
    const opened = await next('editorFile')
    expect(opened.name).toBe('standing-instructions.md')
    expect(String(opened.content)).toContain('always: true')

    const edited = `${String(opened.content)}\n- Always answer in British English.\n`
    await post({ type: 'saveEditorFile', path: opened.path, content: edited, mtimeMs: opened.mtimeMs })
    const saved = await next('editorSaved')
    expect(saved).toMatchObject({ ok: true })
    expect(await fs.readFile(String(opened.path), 'utf8')).toBe(edited)
  }, 30_000)

  it('refuses to overwrite a file that changed on disk after it was opened', async () => {
    const { post, next } = await session()
    await post({ type: 'openStandingSkill' })
    const opened = await next('editorFile')
    // Somebody else - another chat, the agent, a sync - writes it in between.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await fs.writeFile(String(opened.path), 'their version\n')
    await post({ type: 'saveEditorFile', path: opened.path, content: 'my version\n', mtimeMs: opened.mtimeMs })
    expect(await next('editorSaved')).toMatchObject({ ok: false, conflict: true })
    expect(await fs.readFile(String(opened.path), 'utf8')).toBe('their version\n')
  }, 30_000)

  it('will not open or write anything outside the skill and tool folders', async () => {
    const { post, next } = await session()
    const outside = path.join(workspace, 'notes.md')
    await fs.writeFile(outside, 'mine\n')
    await post({ type: 'saveEditorFile', path: outside, content: 'replaced\n', mtimeMs: 0 })
    expect(await next('editorSaved')).toMatchObject({ ok: false })
    expect(await fs.readFile(outside, 'utf8')).toBe('mine\n')
  }, 30_000)
})
