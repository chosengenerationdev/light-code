import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * The codebase's memory, end to end on a running host: what is remembered reaches the agent's instructions on the next
 * message, and switching the memory off takes it out again.
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

type Message = { type: string } & Record<string, unknown>

async function main(): Promise<{ baseUrl: string; systems: string[] }> {
  const systems: string[] = []
  model = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    request.on('end', () => {
      if (request.url?.endsWith('/chat/completions') !== true) {
        response.writeHead(404).end()
        return
      }
      const body = JSON.parse(raw) as { messages: { role: string; content: unknown }[] }
      const system = body.messages.find((m) => m.role === 'system')
      systems.push(typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? ''))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => model?.listen(0, '127.0.0.1', () => resolve()))
  return { baseUrl: `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1`, systems }
}

async function host(baseUrl: string): Promise<{ post: (m: object) => Promise<void>; until: (match: (m: Message) => boolean) => Promise<Message>; inbox: Message[] }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-memory-data-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-memory-ws-'))
  folders.push(dataDir, workspace)
  const configFile = path.join(dataDir, 'config.json')
  await fs.writeFile(configFile, JSON.stringify({ profiles: [{ id: 'main', label: 'Main', wireFormat: 'openai', baseUrl, model: 'main', auth: { type: 'none' } }], activeProfileId: 'main', modeId: 'ask' }))
  running = await startServer({ workspaceRoot: workspace, dataDir, configFile, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
  const url = running.url
  const inbox: Message[] = []
  inbox.push(...((await (await fetch(`${url}/api/poll`, { headers: { Origin: url } })).json()) as { messages: Message[] }).messages)
  const post = async (message: object): Promise<void> => {
    const response = await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(message) })
    expect(response.status).toBe(202)
  }
  const until = async (match: (message: Message) => boolean): Promise<Message> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const found = inbox.find(match)
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error(`timed out; saw ${inbox.map((m) => m.type).join(', ')}`)
      const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
      inbox.push(...((await response.json()) as { messages: Message[] }).messages)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  return { post, until, inbox }
}

describe("the codebase's memory", () => {
  it('reaches the agent on the next message, and leaves when switched off', async () => {
    const { baseUrl, systems } = await main()
    const { post, until, inbox } = await host(baseUrl)
    await post({ type: 'addCodebaseMemory', text: 'Always run the tests with -x before saying they pass.' })
    await until((m) => m.type === 'codebaseMemory' && (m['entries'] as unknown[]).length === 1)

    await post({ type: 'sendMessage', text: 'Check the parser.' })
    await until((m) => m.type === 'done')
    expect(systems.at(-1)).toContain('## Remembered guidance')
    expect(systems.at(-1)).toContain('Always run the tests with -x before saying they pass.')

    const before = inbox.length
    await post({ type: 'setCodebaseMemoryEnabled', value: false })
    await until((m) => m.type === 'codebaseMemory' && m['enabled'] === false)
    await post({ type: 'sendMessage', text: 'And the lexer.' })
    await until((m) => m.type === 'done' && inbox.indexOf(m) >= before)
    expect(systems.at(-1)).not.toContain('Remembered guidance')
  })
})
