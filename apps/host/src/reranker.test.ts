import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * The reranker, end to end, on a running host - asked for: a BGE reranker served behind an OpenAI-compatible provider,
 * used for finding tools and skills, team skills and code, and working with the decision model.
 *
 * A stand-in reranker on loopback, answering only TEI's `/rerank` with `{query, texts}` (so `/v1/rerank` and the
 * `documents` body are tried and refused first), scoring by shared words. Checked: Test reranker reads the order and
 * where it answered; the Search tab's tool-and-skill search is ranked by it with no vector index; with no reranker set
 * up nothing is asked; a reranker that fails leaves the search's own order and says so.
 */

let running: RunningServer | undefined
let reranker: Server | undefined
const folders: string[] = []

afterEach(async () => {
  await running?.close()
  running = undefined
  await new Promise<void>((resolve) => (reranker === undefined ? resolve() : reranker.close(() => resolve())))
  reranker = undefined
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
})

type Message = { type: string } & Record<string, unknown>

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? [])

/** TEI's shape only. `fail`: every request answers 500. */
async function standIn(options: { fail?: boolean } = {}): Promise<{ baseUrl: string; asked: { path: string; body: Record<string, unknown> }[] }> {
  const asked: { path: string; body: Record<string, unknown> }[] = []
  reranker = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    request.on('end', () => {
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {}
      asked.push({ path: request.url ?? '', body })
      if (options.fail === true) {
        response.writeHead(500).end('boom')
        return
      }
      if (request.url !== '/rerank' || !Array.isArray(body['texts'])) {
        response.writeHead(request.url === '/rerank' ? 422 : 404).end()
        return
      }
      const query = words(String(body['query']))
      const scores = (body['texts'] as string[]).map((text, index) => {
        const shared = [...words(text)].filter((word) => query.has(word)).length
        return { index, score: shared / (shared + 2) }
      })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(scores.sort((a, b) => b.score - a.score)))
    })
  })
  await new Promise<void>((resolve) => reranker?.listen(0, '127.0.0.1', () => resolve()))
  return { baseUrl: `http://127.0.0.1:${String((reranker.address() as AddressInfo).port)}`, asked }
}

async function host(extra: Record<string, unknown>, baseUrl: string): Promise<{ post: (m: object) => Promise<void>; until: (match: (m: Message) => boolean) => Promise<Message> }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-rerank-data-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-rerank-ws-'))
  folders.push(dataDir, workspace)
  const configFile = path.join(dataDir, 'config.json')
  await fs.writeFile(
    configFile,
    JSON.stringify({
      profiles: [
        { id: 'main', label: 'Main', wireFormat: 'openai', baseUrl, model: 'main', auth: { type: 'none' } },
        { id: 'bge', label: 'BGE reranker', wireFormat: 'openai', baseUrl, model: 'bge-reranker-v2-m3', auth: { type: 'none' } },
      ],
      activeProfileId: 'main',
      ...extra,
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
  return { post, until }
}

describe('the reranker', () => {
  it('Test reranker finds where it answers and shows the order', async () => {
    const { baseUrl, asked } = await standIn()
    const { post, until } = await host({ reranker: { profileId: 'bge' } }, baseUrl)
    await post({ type: 'requestReranker' })
    const panel = await until((m) => m.type === 'reranker')
    expect(panel['label']).toBe('BGE reranker')
    await post({ type: 'testReranker' })
    const result = (await until((m) => m.type === 'rerankerTest'))['result'] as { ok: boolean; endpoint: string; order: { text: string; expectedFirst: boolean }[] }
    expect(result.ok).toBe(true)
    expect(result.endpoint).toBe('/rerank (texts)')
    expect(result.order[0]?.expectedFirst).toBe(true)
    // Tried in order: /v1/rerank, /rerank with `documents`, then TEI's `texts`.
    expect(asked.map((entry) => entry.path).filter((p) => p !== '/models')).toEqual(['/v1/rerank', '/rerank', '/rerank'])
    expect(asked.find((entry) => entry.path === '/v1/rerank')?.body['model']).toBe('bge-reranker-v2-m3')
  })

  it('ranks tools and skills for search_docs with no vector index', async () => {
    const { baseUrl, asked } = await standIn()
    const { post, until } = await host({ reranker: { profileId: 'bge' } }, baseUrl)
    await post({ type: 'runSearchProbe', target: 'docs', query: 'show a desktop notification message to the user' })
    const probe = await until((m) => m.type === 'searchProbe')
    const text = String(probe['text'])
    expect(text).toContain('Ranked by the reranker')
    expect(text).toMatch(/### tool: notify {2}\(relevance \d\.\d{3}\)/)
    expect(text.indexOf('### tool: notify')).toBe(text.indexOf('### '))
    expect(asked.some((entry) => entry.path === '/rerank')).toBe(true)
  })

  it('asks nothing without a reranker set up', async () => {
    const { baseUrl, asked } = await standIn()
    const { post, until } = await host({}, baseUrl)
    await post({ type: 'runSearchProbe', target: 'docs', query: 'show a desktop notification message to the user' })
    const probe = await until((m) => m.type === 'searchProbe')
    expect(String(probe['text'])).toContain('Matched on names and descriptions')
    expect(asked.filter((entry) => entry.path.includes('rerank') || entry.path.includes('score'))).toEqual([])
  })

  it('keeps the search working when the reranker fails, and says so', async () => {
    const { baseUrl } = await standIn({ fail: true })
    const { post, until } = await host({ reranker: { profileId: 'bge' } }, baseUrl)
    await post({ type: 'runSearchProbe', target: 'docs', query: 'show a desktop notification message to the user' })
    const probe = await until((m) => m.type === 'searchProbe')
    const text = String(probe['text'])
    expect(text).toContain('The reranker did not answer')
    expect(text).toContain('### tool:')
  })

  // Asked for: choose the provider, then the model for the seat - not one provider profile per model.
  it("asks with the seat's own model, and lists a saved profile's models", async () => {
    const { baseUrl, asked } = await standIn()
    const { post, until } = await host({ reranker: { profileId: 'bge', model: 'bge-reranker-large' } }, baseUrl)
    await post({ type: 'testReranker' })
    await until((m) => m.type === 'rerankerTest')
    expect(asked.find((entry) => entry.path === '/v1/rerank')?.body['model']).toBe('bge-reranker-large')
    await post({ type: 'requestProfileModels', profileId: 'bge' })
    const listed = await until((m) => m.type === 'profileModels' && m['profileId'] === 'bge')
    // The stand-in has no model list: the panel is told, and a name can still be typed.
    expect(listed['models']).toEqual([])
    expect(listed['model']).toBe('bge-reranker-v2-m3')
  })
})
