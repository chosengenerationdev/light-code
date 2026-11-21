import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * A chat cut off mid-turn carries on by itself when the host is started with `--resume-interrupted` (Fire Code
 * passes it after the agent's process stopped unexpectedly), and waits as before when it is not. Asked for:
 * "when agent is crashed in fire code, when restarted it should continue the work automatically".
 *
 * The crash is made on disk: a finished chat's saved task is edited to look like one killed while a tool ran -
 * `turnRunning` set and an assistant tool call with no result - because killing a process inside a test would
 * also kill the test.
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
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Carrying on.' } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => model!.listen(0, '127.0.0.1', () => resolve()))
  return { baseUrl: `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1`, requests }
}

type Message = { type: string } & Record<string, unknown>

async function findTaskFile(folder: string): Promise<string> {
  for (const entry of await fs.readdir(folder, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'index.json') continue
    const file = path.join(entry.parentPath, entry.name)
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if (text.includes('"messages"') && text.includes('Summarise the logs')) return file
  }
  throw new Error('no saved task found')
}

async function setUp(): Promise<{ dataDir: string; workspace: string; configFile: string; requests: string[] }> {
  const { baseUrl, requests } = await standInModel()
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-resume-data-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-resume-ws-'))
  folders.push(dataDir, workspace)
  const configFile = path.join(dataDir, 'config.json')
  await fs.writeFile(configFile, JSON.stringify({ profiles: [{ id: 'local', label: 'Local', wireFormat: 'openai', baseUrl, model: 'stand-in', auth: { type: 'none' } }], activeProfileId: 'local' }))
  return { dataDir, workspace, configFile, requests }
}

function client(url: string): { inbox: Message[]; post: (message: object) => Promise<void>; until: (match: (m: Message) => boolean, ms?: number) => Promise<Message | undefined> } {
  const inbox: Message[] = []
  return {
    inbox,
    post: async (message) => {
      const response = await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(message) })
      expect(response.status).toBe(202)
    },
    until: async (match, ms = 15_000) => {
      const deadline = Date.now() + ms
      for (;;) {
        const found = inbox.find(match)
        if (found !== undefined) return found
        if (Date.now() > deadline) return undefined
        const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
        inbox.push(...((await response.json()) as { messages: Message[] }).messages)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    },
  }
}

/** Runs one finished turn, closes the host, and makes its saved task look cut off while a tool ran. */
async function crashedChat(setup: { dataDir: string; workspace: string; configFile: string }): Promise<void> {
  running = await startServer({ workspaceRoot: setup.workspace, dataDir: setup.dataDir, configFile: setup.configFile, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
  const first = client(running.url)
  await first.until(() => false, 200)
  await first.post({ type: 'sendMessage', text: 'Summarise the logs in this folder.' })
  expect(await first.until((m) => m.type === 'done')).toBeDefined()
  await running.close()
  running = undefined

  const file = await findTaskFile(setup.dataDir)
  const task = JSON.parse(await fs.readFile(file, 'utf8')) as { messages: unknown[]; turnRunning?: boolean }
  expect(task.turnRunning).toBeUndefined()
  task.messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'list_files', arguments: '{"path":"."}' }] })
  task.turnRunning = true
  await fs.writeFile(file, JSON.stringify(task))
}

describe('a chat cut off mid-turn', () => {
  it('carries on by itself when the host is told the last run crashed', async () => {
    const setup = await setUp()
    await crashedChat(setup)
    const before = setup.requests.length

    running = await startServer({ workspaceRoot: setup.workspace, dataDir: setup.dataDir, configFile: setup.configFile, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined, resumeInterrupted: true })
    const second = client(running.url)
    expect(await second.until((m) => m.type === 'hostTurnStarted')).toBeDefined()
    expect(await second.until((m) => m.type === 'done')).toBeDefined()

    const resumed = setup.requests.slice(before)
    expect(resumed).toHaveLength(1)
    const sent = (JSON.parse(resumed[0]!) as { messages: { role: string; content: string; tool_call_id?: string }[] }).messages
    // The conversation so far, the cut-off call answered (a provider refuses an unanswered one), then the resume.
    expect(sent.some((m) => m.role === 'user' && m.content === 'Summarise the logs in this folder.')).toBe(true)
    expect(sent.some((m) => m.role === 'tool' && m.tool_call_id === 'call-1')).toBe(true)
    expect(sent.at(-1)?.content).toContain('stopped unexpectedly in the middle of this task')

    // The finished turn's save clears the mark, so another restart resumes nothing.
    const task = JSON.parse(await fs.readFile(await findTaskFile(setup.dataDir), 'utf8')) as { turnRunning?: boolean; crashResumes?: number }
    expect(task.turnRunning).toBeUndefined()
    expect(task.crashResumes).toBeUndefined()
  }, 60_000)

  it('waits for a message, as before, when the host is not told to resume', async () => {
    const setup = await setUp()
    await crashedChat(setup)
    const before = setup.requests.length

    running = await startServer({ workspaceRoot: setup.workspace, dataDir: setup.dataDir, configFile: setup.configFile, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
    const second = client(running.url)
    expect(await second.until((m) => m.type === 'taskRestored')).toBeDefined()
    expect(await second.until((m) => m.type === 'hostTurnStarted', 2_000)).toBeUndefined()
    expect(setup.requests.length).toBe(before)
  }, 60_000)

  it('stops resuming after three crashes in a row, and says so', async () => {
    const setup = await setUp()
    await crashedChat(setup)
    const file = await findTaskFile(setup.dataDir)
    const task = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    await fs.writeFile(file, JSON.stringify({ ...task, crashResumes: 3 }))
    const before = setup.requests.length

    running = await startServer({ workspaceRoot: setup.workspace, dataDir: setup.dataDir, configFile: setup.configFile, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined, resumeInterrupted: true })
    const second = client(running.url)
    const error = await second.until((m) => m.type === 'error')
    expect(String(error?.message)).toContain('3 times in a row')
    expect(setup.requests.length).toBe(before)
  }, 60_000)
})
