import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpRequestOptions, HttpResponse } from '../../platform/http.js'
import { VectorStoreError, type VectorDocument } from '../vectorStore.js'
import { pointIdFor, QdrantIndexWriter, QdrantSearcher } from './qdrant.js'

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

/** `respond` returns `[status, payload]` for a URL; anything unmatched is a 200 with `{}`. */
function recordingHttp(respond: (url: string, method: string) => [number, unknown] | undefined): {
  http: HttpClient
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const http: HttpClient = {
    async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
      const method = options.method ?? 'GET'
      calls.push({
        url,
        method,
        headers: options.headers ?? {},
        ...(options.body !== undefined ? { body: JSON.parse(options.body) as unknown } : {}),
      })
      const [status, payload] = respond(url, method) ?? [200, {}]
      return {
        status,
        headers: {},
        text: async () => JSON.stringify(payload),
        json: async <T>() => payload as T,
        body: null,
      }
    },
  }
  return { http, calls }
}

const local = { url: 'http://127.0.0.1:6333', label: 'Local Qdrant' }

const owned: [number, unknown] = [200, { result: [{ id: 'marker', payload: { 'light-code': true } }] }]
const notOwned: [number, unknown] = [200, { result: [] }]

function doc(id: string, path: string): VectorDocument {
  return { id, text: 'body', path, startLine: 1, endLine: 2, vector: [0.1, 0.2] }
}

describe('point ids', () => {
  /**
   * Qdrant rejects arbitrary string ids — they must be unsigned integers or UUIDs — while the
   * indexer produces `path:chunk`. The mapping has to be stable or every reindex would insert
   * duplicates instead of overwriting.
   */
  it('are stable UUIDs derived from the chunk id', () => {
    const id = pointIdFor('packages/core/src/a.ts:3')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(pointIdFor('packages/core/src/a.ts:3')).toBe(id)
    expect(pointIdFor('packages/core/src/a.ts:4')).not.toBe(id)
  })
})

describe('QdrantSearcher', () => {
  it('searches and flattens the payload', async () => {
    const { http, calls } = recordingHttp((url) =>
      url.endsWith('/points/search')
        ? [
            200,
            {
              result: [
                {
                  id: 'uuid-1',
                  score: 0.82,
                  payload: { chunkId: 'a.ts:0', path: 'src/a.ts', text: 'hello', startLine: 3, endLine: 9 },
                },
              ],
            },
          ]
        : undefined,
    )

    const matches = await new QdrantSearcher(http, local).searchByVector('codebase', [0.1, 0.2], { size: 5 })

    expect(matches).toEqual([
      { id: 'a.ts:0', score: 0.82, text: 'hello', path: 'src/a.ts', startLine: 3, endLine: 9 },
    ])
    expect(calls[0]?.url).toBe('http://127.0.0.1:6333/collections/codebase/points/search')
    expect(calls[0]?.body).toMatchObject({ with_vector: false, limit: 5 })
  })

  /** A 1024-float array per hit is many times the size of the code it describes. */
  it('never asks for the stored vectors back', async () => {
    const { http, calls } = recordingHttp(() => [200, { result: [] }])
    await new QdrantSearcher(http, local).searchByVector('codebase', [0.1], { size: 3 })
    expect((calls[0]?.body as { with_vector?: boolean }).with_vector).toBe(false)
  })

  it('drops the ownership marker from results', async () => {
    const { http } = recordingHttp(() => [
      200,
      { result: [{ id: 'marker', score: 1, payload: { 'light-code': true } }] },
    ])
    // The marker has no `path`, which is how it is recognised. Returning it would put an
    // internal bookkeeping record in front of the model.
    expect(await new QdrantSearcher(http, local).searchByVector('c', [0.1], { size: 5 })).toEqual([])
  })

  /**
   * Qdrant cannot filter by prefix without an index on the field, so the adapter over-fetches
   * and filters — which the seam explicitly permits.
   */
  it('filters by path prefix, asking for more than it returns', async () => {
    const { http, calls } = recordingHttp(() => [
      200,
      {
        result: [
          { id: '1', score: 0.9, payload: { path: 'src/a.ts', text: 'a' } },
          { id: '2', score: 0.8, payload: { path: 'docs/b.md', text: 'b' } },
          { id: '3', score: 0.7, payload: { path: 'src/c.ts', text: 'c' } },
        ],
      },
    ])

    const matches = await new QdrantSearcher(http, local).searchByVector('c', [0.1], {
      size: 2,
      pathPrefix: 'src/',
    })

    expect(matches.map((match) => match.path)).toEqual(['src/a.ts', 'src/c.ts'])
    expect((calls[0]?.body as { limit: number }).limit).toBeGreaterThan(2)
  })

  it('refuses a collection name that could escape the URL', async () => {
    const { http } = recordingHttp(() => [200, {}])
    await expect(
      new QdrantSearcher(http, local).searchByVector('../admin', [0.1], { size: 1 }),
    ).rejects.toBeInstanceOf(VectorStoreError)
  })

  /** Local Qdrant usually has no auth at all; a bare password is its API key, not Basic. */
  it('sends the password as an api-key header when there is no username', async () => {
    const { http, calls } = recordingHttp(() => [200, { result: [] }])
    await new QdrantSearcher(http, { ...local, password: 'secret' }).searchByVector('c', [0.1], { size: 1 })
    expect(calls[0]?.headers['api-key']).toBe('secret')
    expect(calls[0]?.headers.Authorization).toBeUndefined()
  })

  it('sends nothing extra when there are no credentials', async () => {
    const { http, calls } = recordingHttp(() => [200, { result: [] }])
    await new QdrantSearcher(http, local).searchByVector('c', [0.1], { size: 1 })
    expect(calls[0]?.headers['api-key']).toBeUndefined()
    expect(calls[0]?.headers.Authorization).toBeUndefined()
  })
})

describe('QdrantIndexWriter', () => {
  it('creates a collection with the right width and writes the ownership marker', async () => {
    const { http, calls } = recordingHttp((url, method) =>
      url.endsWith('/collections/codebase') && method === 'GET' ? [404, {}] : undefined,
    )

    await new QdrantIndexWriter(http, local).ensureCollection('codebase', 384)

    const create = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/collections/codebase'))
    expect(create?.body).toEqual({ vectors: { size: 384, distance: 'Cosine' } })

    const marker = calls.find((call) => call.url.includes('/points?wait=true'))
    const points = (marker?.body as { points: { payload: Record<string, unknown>; vector: number[] }[] }).points
    expect(points[0]?.payload).toEqual({ 'light-code': true })
    // The marker vector must be the configured width or Qdrant rejects it.
    expect(points[0]?.vector).toHaveLength(384)
  })

  /**
   * The property that matters most. A mistyped collection name must not start overwriting
   * somebody's production vectors — the same rule the OpenSearch writer enforces via `_meta`.
   */
  it('refuses to write to a collection it did not create', async () => {
    const { http } = recordingHttp((url, method) => {
      if (url.endsWith('/collections/theirs') && method === 'GET') {
        return [200, { result: { config: { params: { vectors: { size: 384 } } } } }]
      }
      if (url.endsWith('/points') && method === 'POST') return notOwned
      return undefined
    })

    await expect(new QdrantIndexWriter(http, local).upsert('theirs', [doc('a', 'x.ts')])).rejects.toThrow(
      /not created by Light Code/,
    )
  })

  it('reports a width mismatch by naming the cause', async () => {
    const { http } = recordingHttp((url, method) => {
      if (url.endsWith('/collections/codebase') && method === 'GET') {
        return [200, { result: { config: { params: { vectors: { size: 768 } } } } }]
      }
      if (url.endsWith('/points') && method === 'POST') return owned
      return undefined
    })

    await expect(new QdrantIndexWriter(http, local).ensureCollection('codebase', 384)).rejects.toThrow(
      /768-dimensional.*384/s,
    )
  })

  it('upserts with the chunk id preserved in the payload', async () => {
    const { http, calls } = recordingHttp((url, method) =>
      url.endsWith('/points') && method === 'POST' ? owned : undefined,
    )

    await new QdrantIndexWriter(http, local).upsert('codebase', [doc('src/a.ts:0', 'src/a.ts')])

    const write = calls.find((call) => call.method === 'PUT')
    const points = (write?.body as { points: { id: string; payload: { chunkId: string } }[] }).points
    expect(points[0]?.id).toBe(pointIdFor('src/a.ts:0'))
    // The point id is a hash and cannot be read back, so callers match on this instead.
    expect(points[0]?.payload.chunkId).toBe('src/a.ts:0')
  })

  it('deletes by path with one request rather than one per path', async () => {
    const { http, calls } = recordingHttp((url, method) =>
      url.endsWith('/points') && method === 'POST' ? owned : undefined,
    )

    await new QdrantIndexWriter(http, local).deleteByPaths('codebase', ['a.ts', 'b.ts'])

    const deletes = calls.filter((call) => call.url.includes('/points/delete'))
    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.body).toEqual({ filter: { must: [{ key: 'path', match: { any: ['a.ts', 'b.ts'] } }] } })
  })

  it('does nothing at all for an empty batch', async () => {
    const { http, calls } = recordingHttp(() => [200, {}])
    const writer = new QdrantIndexWriter(http, local)
    await writer.upsert('codebase', [])
    await writer.deleteByPaths('codebase', [])
    // Not even the ownership check: there is nothing to protect against.
    expect(calls).toEqual([])
  })

  it('lists distinct paths, following the scroll', async () => {
    let page = 0
    const { http } = recordingHttp((url) => {
      if (!url.includes('/points/scroll')) return undefined
      page++
      return page === 1
        ? [200, { result: { points: [{ id: '1', payload: { path: 'a.ts' } }], next_page_offset: 'more' } }]
        : [
            200,
            {
              result: {
                points: [
                  { id: '2', payload: { path: 'b.ts' } },
                  { id: '3', payload: { path: 'a.ts' } },
                ],
                next_page_offset: null,
              },
            },
          ]
    })

    expect((await new QdrantIndexWriter(http, local).listPaths('codebase')).sort()).toEqual(['a.ts', 'b.ts'])
  })

  /** The ordinary first run, not a failure. */
  it('treats a missing collection as having no paths', async () => {
    const { http } = recordingHttp(() => [404, {}])
    expect(await new QdrantIndexWriter(http, local).listPaths('codebase')).toEqual([])
  })
})
