import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * A strategy stays with its chat - asked for: "after current chat session is over and when it is handed over to new
 * session, strategy should be selected for new session too ... different strategy for different chats, it should be
 * persisted, new chats can be defaulted to no strategy".
 *
 * Driven against a running host restarted on the same data folder, as a window reload, a Fire Code chat waking from
 * sleep and a restart after a crash all are. Before this, a restart brought the conversation back and dropped the
 * strategy (and the plan): only reopening a chat from History restored them.
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
type Body = { messages: { role: string; content?: unknown }[] }

/** A model that answers every message with a line of text, and remembers each system prompt it was sent. */
async function standInModel(): Promise<{ baseUrl: string; prompts: string[] }> {
  const prompts: string[] = []
  model = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end()
        return
      }
      const body = JSON.parse(raw) as Body
      const system = body.messages.find((m) => m.role === 'system')?.content
      prompts.push(typeof system === 'string' ? system : JSON.stringify(system ?? ''))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Noted.' } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => model!.listen(0, '127.0.0.1', () => resolve()))
  return { baseUrl: `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1`, prompts }
}

const STRATEGY = {
  id: 'review-first',
  name: 'Review first',
  updatedAt: 1,
  nodes: [
    { id: 'r', role: 'reviewer', x: 40, y: 40 },
    { id: 'p', role: 'programmer', x: 300, y: 40 },
  ],
  edges: [{ id: 'e', from: 'r', to: 'p' }],
}

interface Host {
  post: (message: object) => Promise<void>
  until: (match: (message: Message) => boolean) => Promise<Message>
  activeStrategy: () => Promise<unknown>
}

async function start(dataDir: string, workspace: string, configFile: string): Promise<Host> {
  running = await startServer({ workspaceRoot: workspace, dataDir, configFile, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
  const url = running.url
  const inbox: Message[] = []
  // The first poll attaches the page; what it already carries (the chat being restored) is kept.
  inbox.push(...((await (await fetch(`${url}/api/poll`, { headers: { Origin: url } })).json()) as { messages: Message[] }).messages)
  const post = async (message: object): Promise<void> => {
    const response = await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(message) })
    expect(response.status).toBe(202)
  }
  const until = async (match: (message: Message) => boolean): Promise<Message> => {
    const deadline = Date.now() + 15_000
    for (;;) {
      const index = inbox.findIndex(match)
      if (index >= 0) return inbox.splice(index, 1)[0]!
      if (Date.now() > deadline) throw new Error(`timed out; saw ${inbox.map((m) => m.type).join(', ')}`)
      const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
      inbox.push(...((await response.json()) as { messages: Message[] }).messages)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  // The restore runs as the session starts; wait for it before asking.
  await until((m) => m.type === 'taskRestored')
  return {
    post,
    until,
    async activeStrategy() {
      inbox.splice(0, inbox.length, ...inbox.filter((m) => m.type !== 'strategies'))
      await post({ type: 'requestStrategies' })
      return (await until((m) => m.type === 'strategies'))['active']
    },
  }
}

describe('a strategy chosen for a chat', () => {
  it('stays with the chat through restarts, before and after its first message, and a new chat started from it keeps it', async () => {
    const { baseUrl, prompts } = await standInModel()
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-perchat-data-'))
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-perchat-ws-'))
    folders.push(dataDir, workspace)
    const configFile = path.join(dataDir, 'config.json')
    await fs.writeFile(
      configFile,
      JSON.stringify({
        profiles: [{ id: 'main', label: 'Main', wireFormat: 'openai', baseUrl, model: 'main', auth: { type: 'none' } }],
        activeProfileId: 'main',
        modeId: 'auto',
        agents: { roles: { reviewer: { kind: 'profile', profileId: 'main' }, programmer: { kind: 'profile', profileId: 'main' } } },
      }),
    )
    const restart = async (): Promise<Host> => {
      await running?.close()
      return start(dataDir, workspace, configFile)
    }

    // Chosen for a brand-new chat, before anything is sent.
    let host = await start(dataDir, workspace, configFile)
    expect(await host.activeStrategy()).toBeUndefined()
    await host.post({ type: 'saveStrategy', strategy: STRATEGY, use: true })
    await host.until((m) => m.type === 'strategyResult')

    // A reload of the empty chat keeps it.
    host = await restart()
    expect(await host.activeStrategy()).toMatchObject({ id: 'review-first' })

    // The first message is sent under it, and a reload after that keeps it too.
    await host.post({ type: 'sendMessage', text: 'Rename the invoice module.' })
    await host.until((m) => m.type === 'done')
    expect(prompts.at(-1)).toContain('## Strategy: Review first')
    host = await restart()
    expect(await host.activeStrategy()).toMatchObject({ id: 'review-first' })

    // The next topic in the same chat is told to follow it as well.
    await host.post({ type: 'sendMessage', text: 'Now add a CSV export.' })
    await host.until((m) => m.type === 'done')
    expect(prompts.at(-1)).toContain('## Strategy: Review first')
    expect(prompts.at(-1)).toContain('including a new topic after an earlier one is finished')

    // A new chat keeps the strategy of the chat it was started from ("clicking + didnt carry the selected strategy"),
    // and keeps it through a reload before its first message.
    await host.post({ type: 'newTask' })
    await host.until((m) => m.type === 'taskRestored' && m['taskId'] === undefined)
    expect(await host.activeStrategy()).toMatchObject({ id: 'review-first' })
    host = await restart()
    expect(await host.activeStrategy()).toMatchObject({ id: 'review-first' })

    // Stopped in that chat, the next new chat starts with none, and stays with none after a reload.
    await host.post({ type: 'useStrategy' })
    expect(await host.activeStrategy()).toBeUndefined()
    await host.post({ type: 'newTask' })
    await host.until((m) => m.type === 'taskRestored' && m['taskId'] === undefined)
    expect(await host.activeStrategy()).toBeUndefined()
    host = await restart()
    expect(await host.activeStrategy()).toBeUndefined()

    // A whole strategy handed over by Fire Code's + (with this chat's own contracts) is taken as it is.
    await host.post({ type: 'useStrategy', strategy: { ...STRATEGY, edges: [{ ...STRATEGY.edges[0]!, contract: 'the renamed files' }] } })
    expect(await host.activeStrategy()).toMatchObject({ id: 'review-first', edges: [{ contract: 'the renamed files' }] })
    await host.post({ type: 'useStrategy' })
    expect(await host.activeStrategy()).toBeUndefined()

    // The first chat still has its own, opened from History.
    await host.post({ type: 'requestTasks' })
    const tasks = (await host.until((m) => m.type === 'tasks' && Array.isArray(m['tasks']) && (m['tasks'] as unknown[]).length > 0)) as unknown as { tasks: { id: string }[] }
    await host.post({ type: 'openTask', id: tasks.tasks[0]!.id })
    await host.until((m) => m.type === 'taskRestored' && m['taskId'] === tasks.tasks[0]!.id)
    expect(await host.activeStrategy()).toMatchObject({ id: 'review-first' })
  }, 60_000)
})
