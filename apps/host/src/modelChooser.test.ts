import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * The model chooser on a new provider.
 *
 * Reported for Google Gemini: the list never loaded. The model box is empty on a new profile, and the
 * request for the list was refused for that - with the refusal posted to the chat, behind Settings, so
 * the dropdown said "Loading…" for ever. Then Google's catalogue is paged, and newer models were past
 * the first page. Driven against a running server and a stand-in for Google's `/models`.
 */

let running: RunningServer | undefined
let google: http.Server | undefined
let dataDir = ''
let workspace = ''

afterEach(async () => {
  await running?.close()
  running = undefined
  await new Promise((resolve) => (google === undefined ? resolve(undefined) : google.close(resolve)))
  google = undefined
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined)
})

type Message = { type: string } & Record<string, unknown>

async function session(): Promise<{ post: (message: object) => Promise<void>; next: (type: string) => Promise<Message>; seen: Message[] }> {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-models-data-'))
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-models-ws-'))
  running = await startServer({ workspaceRoot: workspace, dataDir, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
  const url = running.url
  await fetch(`${url}/api/poll`, { headers: { Origin: url } })
  const inbox: Message[] = []
  const seen: Message[] = []
  return {
    seen,
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
        const arrived = ((await response.json()) as { messages: Message[] }).messages
        inbox.push(...arrived)
        seen.push(...arrived)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    },
  }
}

/** Two pages, as Google sends them, with an embedding model that has no place in a chat chooser. */
async function fakeGoogle(): Promise<{ baseUrl: string; keys: string[] }> {
  const keys: string[] = []
  google = http.createServer((request, response) => {
    keys.push(String(request.headers['x-goog-api-key']))
    const token = new URL(request.url ?? '/', 'http://x').searchParams.get('pageToken')
    const body =
      token === null
        ? { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'two' }
        : { models: [{ name: 'models/gemini-4-pro', supportedGenerationMethods: ['generateContent'] }] }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => google!.listen(0, '127.0.0.1', resolve))
  const address = google.address() as { port: number }
  return { baseUrl: `http://127.0.0.1:${address.port}/v1beta`, keys }
}

describe('the model chooser', () => {
  it('lists every chat model on a new Gemini profile before a model is chosen', async () => {
    const { baseUrl, keys } = await fakeGoogle()
    const { post, next, seen } = await session()
    await post({ type: 'requestModels', profile: { label: '', wireFormat: 'gemini', baseUrl, model: '', authType: 'apiKey', apiKey: 'test-key' } })
    const models = await next('models')
    expect(models.models).toEqual(['gemini-2.5-flash', 'gemini-4-pro'])
    expect(models.warning).toBeUndefined()
    expect(keys).toEqual(['test-key', 'test-key'])
    expect(seen.some((message) => message.type === 'error')).toBe(false)
  }, 30_000)

  it('answers a form it cannot use on the chooser itself, never in the chat', async () => {
    const { post, next, seen } = await session()
    await post({ type: 'requestModels', profile: { label: '', wireFormat: 'gemini', baseUrl: 'not a url', model: '', authType: 'apiKey', apiKey: 'k' } })
    const models = await next('models')
    expect(models.models).toEqual([])
    expect(String(models.warning)).toMatch(/baseUrl/)
    expect(seen.some((message) => message.type === 'error')).toBe(false)
  }, 30_000)
})
