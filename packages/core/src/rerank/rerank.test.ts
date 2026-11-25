import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpRequestOptions } from '../platform/http.js'
import type { ProviderProfile } from '../providers/types.js'
import type { VectorMatch, VectorSearcher } from '../rag/vectorStore.js'
import type { Embedder } from '../rag/embedder.js'
import { createSearchCodebaseTool } from '../tools/searchCodebase.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { readScores, rerank, reorder, type Reranking, type RerankerModel } from './rerank.js'

/**
 * The reranker client against each shape a server answers in, and the step every search uses with it. The searches
 * themselves are driven end to end on a running host (apps/host/src/reranker.test.ts).
 */

type Answer = { status: number; body: unknown }

function fakeHttp(answer: (url: string, body: Record<string, unknown>) => Answer | Promise<Answer>): { http: HttpClient; urls: string[] } {
  const urls: string[] = []
  const http: HttpClient = {
    async request(url: string, options?: HttpRequestOptions) {
      urls.push(url)
      const body = JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>
      // Rejects on abort, as the real client does.
      const reply = await Promise.race([
        answer(url, body),
        new Promise<never>((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      ])
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
      return { status: reply.status, ok: reply.status < 300, headers: new Headers(), text: async () => text } as unknown as Awaited<ReturnType<HttpClient['request']>>
    },
  }
  return { http, urls }
}

const model = (http: HttpClient, baseUrl = 'http://rerank.example.internal/v1', endpoint?: string): RerankerModel => ({
  profile: { id: 'bge', label: 'BGE', wireFormat: 'openai', baseUrl, model: 'bge-reranker-v2-m3', auth: { type: 'none' } } as ProviderProfile,
  http,
  auth: { resolveHeaders: async () => ({}) } as unknown as RerankerModel['auth'],
  ...(endpoint !== undefined ? { endpoint } : {}),
})

describe('reading scores', () => {
  it('reads every shape a reranker answers in', () => {
    expect(readScores(JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] }), 2)).toEqual([0.1, 0.9])
    expect(readScores(JSON.stringify([{ index: 0, score: 0.3 }, { index: 1, score: 0.7 }]), 2)).toEqual([0.3, 0.7])
    expect(readScores(JSON.stringify({ data: [{ index: 0, score: 0.5 }, { index: 1, score: 0.2 }] }), 2)).toEqual([0.5, 0.2])
    expect(readScores(JSON.stringify({ scores: [0.4, 0.6] }), 2)).toEqual([0.4, 0.6])
    // A chat completion, a missing index or a short list: not a reranker's answer.
    expect(readScores(JSON.stringify({ choices: [] }), 2)).toBeUndefined()
    expect(readScores(JSON.stringify({ results: [{ index: 0, relevance_score: 0.1 }] }), 2)).toBeUndefined()
    expect(readScores('not json', 1)).toBeUndefined()
  })
})

describe('asking a reranker', () => {
  it('finds the path from the server root even when the base URL ends in /v1, and remembers it', async () => {
    const { http, urls } = fakeHttp((url, body) =>
      url.endsWith('/v1/score') ? { status: 200, body: { data: (body['text_2'] as string[]).map((_, index) => ({ index, score: index / 10 })) } } : { status: 404, body: '' },
    )
    const first = await rerank(model(http, 'http://one.example.internal/v1'), 'q', ['a', 'b'])
    expect(first).toMatchObject({ ok: true, scores: [0, 0.1], endpoint: '/v1/score (score)' })
    expect(urls.slice(0, 4)).toEqual([
      'http://one.example.internal/v1/rerank',
      'http://one.example.internal/rerank',
      'http://one.example.internal/rerank',
      'http://one.example.internal/v1/score',
    ])
    urls.length = 0
    await rerank(model(http, 'http://one.example.internal/v1'), 'q', ['a'])
    expect(urls).toEqual(['http://one.example.internal/v1/score'])
  })

  it('uses a configured path on the base URL as typed', async () => {
    const { http, urls } = fakeHttp((_url, body) => ({ status: 200, body: { results: (body['documents'] as string[]).map((_, index) => ({ index, relevance_score: 0.5 })) } }))
    const result = await rerank(model(http, 'http://two.example.internal/v1', '/bge/rerank'), 'q', ['a'])
    expect(result.ok).toBe(true)
    expect(urls).toEqual(['http://two.example.internal/v1/bge/rerank'])
  })

  it('sends many texts in batches and puts the scores back in order', async () => {
    const { http, urls } = fakeHttp((_url, body) => {
      const documents = body['documents'] as string[]
      return { status: 200, body: { results: documents.map((text, index) => ({ index, relevance_score: Number(text) / 1000 })) } }
    })
    const texts = Array.from({ length: 150 }, (_, i) => String(i))
    const result = await rerank(model(http, 'http://three.example.internal'), 'q', texts)
    expect(result.scores).toHaveLength(150)
    expect(result.scores?.[149]).toBeCloseTo(0.149, 5)
    expect(urls).toHaveLength(3)
  })

  it('gives up on time and says so, never throwing', async () => {
    const { http } = fakeHttp(() => new Promise<Answer>(() => undefined))
    const result = await rerank(model(http, 'http://four.example.internal'), 'q', ['a'], { timeoutMs: 50 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('took longer than')
  })

  it('stops at a refusal of the credential rather than trying every path', async () => {
    const { http, urls } = fakeHttp(() => ({ status: 401, body: '' }))
    const result = await rerank(model(http, 'http://five.example.internal'), 'q', ['a'])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('HTTP 401')
    expect(urls).toHaveLength(1)
  })
})

describe('reordering what a search found', () => {
  const scoring = (scores: number[] | 'fail'): Reranking => ({
    scores: async () => (scores === 'fail' ? { ok: false, error: 'HTTP 500', ms: 1 } : { ok: true, scores, ms: 1 }),
    minScore: 0.2,
    candidates: 30,
  })

  it('puts the most relevant first and sets aside what scores too low', async () => {
    const ordered = await reorder(scoring([0.1, 0.9, 0.5]), 'q', ['a', 'b', 'c'], (x) => x, 5)
    expect(ordered.items).toEqual([{ item: 'b', score: 0.9 }, { item: 'c', score: 0.5 }])
    expect(ordered.dropped).toBe(1)
  })

  // For the Auditor's task report: what it put first, what it set aside, or that it did not answer.
  it('reports what it did, and when it did not answer', async () => {
    const seen: unknown[] = []
    await reorder({ ...scoring([0.1, 0.9, 0.5]), report: (o) => seen.push(o) }, 'find b', ['a', 'b', 'c'], (x) => x, 5)
    expect(seen[0]).toMatchObject({ query: 'find b', candidates: 3, first: [{ label: 'b', score: 0.9 }, { label: 'c', score: 0.5 }], dropped: 1, ok: true })
    await reorder({ ...scoring('fail'), report: (o) => seen.push(o) }, 'q', ['a'], (x) => x, 5)
    expect(seen[1]).toMatchObject({ ok: false, error: 'HTTP 500' })
  })

  it('keeps the search order when the reranker does not answer, and says so', async () => {
    const ordered = await reorder(scoring('fail'), 'q', ['a', 'b', 'c'], (x) => x, 2)
    expect(ordered.items.map((entry) => entry.item)).toEqual(['a', 'b'])
    expect(ordered.note).toContain('The reranker did not answer (HTTP 500)')
  })

  it('reorders codebase search results and asks the index for more candidates', async () => {
    const hits: VectorMatch[] = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((path, i) => ({ id: path, path, text: `chunk ${String(i)}`, score: 1 - i / 10 }))
    let asked = 0
    const searcher: VectorSearcher = {
      kind: 'opensearch',
      label: 'test',
      searchByVector: async (_collection, _vector, options) => {
        asked = options.size
        return hits
      },
    }
    const embedder = { embed: async () => [0.1] } as unknown as Embedder
    const tool = createSearchCodebaseTool({ searcher, embedder, index: 'code', connectionLabel: 'test', reranking: scoring([0.1, 0.3, 0.95]) })
    const result = await tool.execute({ query: 'where is c', size: 2 }, { workspaceRoot: undefined } as unknown as ToolExecutionContext)
    expect(asked).toBe(30)
    const content = result.content
    expect(content.indexOf('src/c.ts')).toBeLessThan(content.indexOf('src/b.ts'))
    expect(content).toContain('relevance 0.950')
    expect(content).not.toContain('src/a.ts')
    expect(content).toContain('set aside 1 weak match')
  })
})
