import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * "New chat with a handoff", end to end: a running host, a stand-in model that answers the chat and
 * writes the handoff note, and the new chat opening with it. Driven over the wire, because the claim is
 * what the panel is sent and in what order - progress first, then a new chat that carries the note.
 */

let running: RunningServer | undefined
let model: Server | undefined
const folders: string[] = []

afterEach(async () => {
  await running?.close()
  running = undefined
  await new Promise<void>((resolve) => (model === undefined ? resolve() : model.close(() => resolve())))
  model = undefined
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
})

/** An OpenAI-compatible model on loopback: a handoff request gets a note, anything else a short reply. */
async function standInModel(): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = []
  model = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end()
        return
      }
      requests.push(body)
      const handoff = body.includes('handing this work over')
      const text = handoff ? '## Goal\\nShip the rounding fix.\\n## Next steps\\nRun the tests.' : 'Sure, looking at it.'
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.replace(/\\n/g, '\n') } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => model!.listen(0, '127.0.0.1', () => resolve()))
  return { baseUrl: `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1`, requests }
}

type Message = { type: string } & Record<string, unknown>

describe('a new chat with a handoff', () => {
  it('writes the note with the model, then opens a new chat that starts with it', async () => {
    const { baseUrl, requests } = await standInModel()
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-handoff-data-'))
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-handoff-ws-'))
    folders.push(dataDir, workspace)
    const configFile = path.join(dataDir, 'config.json')
    await fs.writeFile(
      configFile,
      JSON.stringify({
        profiles: [{ id: 'local', label: 'Local', wireFormat: 'openai', baseUrl, model: 'stand-in', auth: { type: 'none' } }],
        activeProfileId: 'local',
      }),
    )
    running = await startServer({ workspaceRoot: workspace, dataDir, configFile, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
    const url = running.url
    await fetch(`${url}/api/poll`, { headers: { Origin: url } })
    const inbox: Message[] = []
    const post = async (message: object): Promise<void> => {
      const response = await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(message) })
      expect(response.status).toBe(202)
    }
    const until = async (match: (message: Message) => boolean): Promise<Message> => {
      const deadline = Date.now() + 15_000
      for (;;) {
        const found = inbox.find(match)
        if (found !== undefined) return found
        if (Date.now() > deadline) throw new Error(`timed out; saw ${inbox.map((m) => m.type).join(', ')}`)
        const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
        inbox.push(...((await response.json()) as { messages: Message[] }).messages)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    await post({ type: 'sendMessage', text: 'Please fix the rounding in invoice totals.' })
    await until((message) => message.type === 'done')

    await post({ type: 'startHandoff' })
    const done = await until((message) => message.type === 'handoffProgress' && (message.phase === 'done' || message.phase === 'failed'))
    expect(done, JSON.stringify(done)).toMatchObject({ phase: 'done' })
    const phases = inbox.filter((message) => message.type === 'handoffProgress').map((message) => message.phase)
    expect(phases).toEqual(expect.arrayContaining(['gathering', 'writing', 'starting', 'done']))

    // The model was asked for the note with the conversation in front of it.
    const handoffRequest = requests.find((body) => body.includes('handing this work over'))!
    expect(handoffRequest).toContain('Please fix the rounding in invoice totals.')

    // The new chat opens with the handoff: the note, and the user's own words.
    const restored = [...inbox].reverse().find((message) => message.type === 'taskRestored')!
    const entries = JSON.stringify(restored.entries)
    expect(entries).toContain('# Handoff')
    expect(entries).toContain('Ship the rounding fix.')
    expect(entries).toContain('> Please fix the rounding in invoice totals.')
    expect(entries).not.toContain('Sure, looking at it.')

    // And it carries on by itself: the panel is told so, and the model is asked to continue from the handoff
    // with nothing typed (asked for: "after new session started, i had to send a message").
    expect(done).toMatchObject({ continuing: true })
    const handedOver = inbox.indexOf(done)
    await until((message) => message.type === 'done' && inbox.indexOf(message) > handedOver)
    const firstTurn = requests.filter((body) => !body.includes('handing this work over')).at(-1)!
    const sent = (JSON.parse(firstTurn) as { messages: { role: string; content: string }[] }).messages
    expect(sent.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(sent.find((m) => m.role === 'user')?.content).toContain('# Handoff')
  }, 60_000)
})

/*
 * Asked for: "a checkbox, when enabled it should auto handoff to new session when context limit is hit". With it on
 * and a chat at its window, the turn stops and the handoff is written and carried on with, nothing pressed.
 */
describe('handing off by itself at the context limit', () => {
  it('starts a new chat from a handoff when the chat is full, and carries on in it', async () => {
    const { baseUrl, requests } = await standInModel()
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-autohandoff-data-'))
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-autohandoff-ws-'))
    folders.push(dataDir, workspace)
    const configFile = path.join(dataDir, 'config.json')
    await fs.writeFile(
      configFile,
      JSON.stringify({
        // A small, known window, so a long second message fills it.
        profiles: [{ id: 'local', label: 'Local', wireFormat: 'openai', baseUrl, model: 'stand-in', auth: { type: 'none' }, modelCapabilities: { contextWindow: 6_000 } }],
        activeProfileId: 'local',
        autoHandoff: true,
      }),
    )
    running = await startServer({ workspaceRoot: workspace, dataDir, configFile, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
    const url = running.url
    await fetch(`${url}/api/poll`, { headers: { Origin: url } })
    const inbox: Message[] = []
    const post = async (message: object): Promise<void> => {
      const response = await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(message) })
      expect(response.status).toBe(202)
    }
    const until = async (match: (message: Message) => boolean): Promise<Message> => {
      const deadline = Date.now() + 20_000
      for (;;) {
        const found = inbox.find(match)
        if (found !== undefined) return found
        if (Date.now() > deadline) throw new Error(`timed out; saw ${inbox.map((m) => (m.type === 'error' ? `error: ${String(m['message'])}` : m.type)).join(', ')}`)
        const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
        inbox.push(...((await response.json()) as { messages: Message[] }).messages)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    await post({ type: 'sendMessage', text: 'Please fix the rounding in invoice totals.' })
    await until((message) => message.type === 'done')
    const before = requests.length
    // Long enough to fill the window: the turn stops before asking the model, and the handoff follows by itself.
    await post({ type: 'sendMessage', text: `Here is the full log:\n${'2026-11-20 02:00:01 ERROR rounding mismatch on invoice 1042\n'.repeat(500)}` })
    const done = await until((message) => message.type === 'handoffProgress' && (message.phase === 'done' || message.phase === 'failed'))
    expect(done, JSON.stringify(done)).toMatchObject({ phase: 'done', continuing: true })
    // The full chat was never sent as a reply request: the next request was the handoff note itself.
    expect(requests[before]).toContain('handing this work over')
    const restored = [...inbox].reverse().find((message) => message.type === 'taskRestored')!
    expect(JSON.stringify(restored.entries)).toContain('# Handoff')

    // The bar over the message box was told what the chat was getting ready, and ended with nothing left.
    const startup = inbox.filter((message) => message.type === 'startupProgress') as unknown as { waiting: { label: string }[] }[]
    expect(startup.some((message) => message.waiting.some((item) => item.label === 'Skills'))).toBe(true)
    expect(startup.at(-1)?.waiting).toEqual([])
  }, 60_000)
})
