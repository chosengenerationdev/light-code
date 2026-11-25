import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * Reported: "type suggestions doesn't seem to work". With a Qwen3 model it thought until the time limit and nothing was
 * shown. A stand-in Qwen on loopback that thinks for a long time unless asked not to: the suggestion must arrive.
 */

let running: RunningServer | undefined
let model: Server | undefined
const folders: string[] = []

afterEach(async () => {
  await running?.close()
  running = undefined
  await new Promise<void>((resolve) => (model === undefined ? resolve() : (model.closeAllConnections(), model.close(() => resolve()))))
  model = undefined
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
})

type Body = { model: string; max_tokens?: number; chat_template_kwargs?: { enable_thinking?: boolean } }
type Message = { type: string } & Record<string, unknown>

/** `refusesKwargs`: answers 400 to chat_template_kwargs, as some gateways do, and then answers without thinking. */
async function qwen(options: { refusesKwargs?: boolean } = {}): Promise<{ baseUrl: string; bodies: Body[] }> {
  const bodies: Body[] = []
  model = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    request.on('end', () => {
      if (request.url?.endsWith('/chat/completions') !== true) {
        response.writeHead(404).end()
        return
      }
      const body = JSON.parse(raw) as Body
      bodies.push(body)
      if (options.refusesKwargs === true && body.chat_template_kwargs !== undefined) {
        response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'unknown field chat_template_kwargs' } }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (content: string): void => void response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      const thinks = options.refusesKwargs !== true && body.chat_template_kwargs?.enable_thinking !== false
      if (thinks) {
        // Thinks for longer than the suggestion's time limit.
        send('<think>')
        const timer = setInterval(() => send('hmm '), 200)
        response.on('close', () => clearInterval(timer))
        return
      }
      send(' tests for the date parser')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => model?.listen(0, '127.0.0.1', () => resolve()))
  return { baseUrl: `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1`, bodies }
}

async function host(baseUrl: string, profile: Record<string, unknown> = {}): Promise<{ post: (m: object) => Promise<void>; until: (match: (m: Message) => boolean) => Promise<Message> }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-typeahead-data-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-typeahead-ws-'))
  folders.push(dataDir, workspace)
  const configFile = path.join(dataDir, 'config.json')
  await fs.writeFile(
    configFile,
    JSON.stringify({
      profiles: [{ id: 'main', label: 'Qwen', wireFormat: 'openai', baseUrl, model: 'qwen3-32b', auth: { type: 'none' }, ...profile }],
      activeProfileId: 'main',
      composerCompletion: true,
    }),
  )
  running = await startServer({ workspaceRoot: workspace, dataDir, configFile, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
  const url = running.url
  const inbox: Message[] = []
  inbox.push(...((await (await fetch(`${url}/api/poll`, { headers: { Origin: url } })).json()) as { messages: Message[] }).messages)
  const post = async (message: object): Promise<void> => {
    const response = await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(message) })
    expect(response.status).toBe(202)
  }
  const until = async (match: (message: Message) => boolean): Promise<Message> => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const found = inbox.find(match)
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error(`timed out; saw ${inbox.map((m) => m.type).join(', ')}`)
      const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
      inbox.push(...((await response.json()) as { messages: Message[] }).messages)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  return { post, until }
}

describe('suggestions while typing with a thinking model', () => {
  it('asks with thinking off, so the suggestion arrives', async () => {
    const { baseUrl, bodies } = await qwen()
    const { post, until } = await host(baseUrl)
    // As the panel does: it asks only once the settings say suggestions are on.
    await post({ type: 'requestSettings' })
    await until((m) => m.type === 'settings' && m['composerCompletion'] === true)
    await post({ type: 'requestCompletion', id: 'one', text: 'Please write unit' })
    const completion = await until((m) => m.type === 'completion' && m['id'] === 'one')
    expect(String(completion['text']).trim()).toBe('tests for the date parser')
    const asked = bodies.at(-1)
    expect(asked?.chat_template_kwargs?.enable_thinking).toBe(false)
  })

  it('asks again as the profile is when the gateway refuses the thinking switch', async () => {
    const { baseUrl, bodies } = await qwen({ refusesKwargs: true })
    const { post, until } = await host(baseUrl)
    await post({ type: 'requestSettings' })
    await until((m) => m.type === 'settings' && m['composerCompletion'] === true)
    await post({ type: 'requestCompletion', id: 'two', text: 'Please write unit' })
    const completion = await until((m) => m.type === 'completion' && m['id'] === 'two')
    expect(String(completion['text']).trim()).toBe('tests for the date parser')
    expect(bodies.some((body) => body.chat_template_kwargs === undefined)).toBe(true)
  })

  // Reported again with a Gemini model (native wire format): Gemini 2.5 and later think by default too.
  it('asks a Gemini model with thinkingBudget 0', async () => {
    const asked: { generationConfig?: { thinkingConfig?: { thinkingBudget?: number } } }[] = []
    model = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
      request.on('end', () => {
        if (request.url?.includes(':streamGenerateContent') !== true) {
          response.writeHead(404).end()
          return
        }
        const body = JSON.parse(raw) as (typeof asked)[number]
        asked.push(body)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (body.generationConfig?.thinkingConfig?.thinkingBudget !== 0) return // thinks for ever
        response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: ' tests for the date parser' }] } }] })}

`)
      })
    })
    await new Promise<void>((resolve) => model?.listen(0, '127.0.0.1', () => resolve()))
    const baseUrl = `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1beta`
    const { post, until } = await host(baseUrl, { wireFormat: 'gemini', model: 'gemini-4-pro', label: 'Gemini' })
    await post({ type: 'requestSettings' })
    await until((m) => m.type === 'settings' && m['composerCompletion'] === true)
    await post({ type: 'requestCompletion', id: 'g', text: 'Please write unit' })
    const completion = await until((m) => m.type === 'completion' && m['id'] === 'g')
    expect(String(completion['text']).trim()).toBe('tests for the date parser')
    expect(asked[0]?.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0)
  })

  // Reported: no suggestion with a large Gemini model - it never started answering within the time limit. Said in the panel,
  // and a small, fast model can be chosen for suggestions alone.
  it('says when the model is too slow, and uses the model chosen for suggestions', async () => {
    model = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
      request.on('end', () => {
        if (request.url?.endsWith('/chat/completions') !== true) {
          response.writeHead(404).end()
          return
        }
        const body = JSON.parse(raw) as { model: string }
        if (body.model === 'big-slow') return // never starts answering
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' tests for the date parser' } }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((resolve) => model?.listen(0, '127.0.0.1', () => resolve()))
    const baseUrl = `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1`
    const { post, until } = await host(baseUrl, { model: 'big-slow', label: 'Big' })
    await post({ type: 'requestSettings' })
    await until((m) => m.type === 'settings' && m['composerCompletion'] === true)
    await post({ type: 'requestCompletion', id: 'slow', text: 'Please write unit' })
    expect(String((await until((m) => m.type === 'completion' && m['id'] === 'slow'))['text'])).toBe('')
    await post({ type: 'requestCompletionSettings' })
    const settings = await until((m) => m.type === 'completionSettings' && typeof m['lastProblem'] === 'string')
    expect(String(settings['lastProblem'])).toContain('big-slow did not start answering within 12 seconds')
  }, 30_000)
})
