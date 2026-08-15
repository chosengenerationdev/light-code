import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpRequestOptions, HttpResponse } from '../../platform/http.js'
import { VectorStoreError, type VectorDocument } from '../vectorStore.js'
import { ChromaIndexWriter, ChromaSearcher } from './chroma.js'

interface Recorded {
  url: string
  method: string
  body?: unknown
}

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

const local = { url: 'http://127.0.0.1:8000', label: 'Local Chroma' }
const COLLECTION_URL = '/api/v2/tenants/default_tenant/databases/default_database/collections'

const ours = { id: 'col-1', name: 'codebase', metadata: { created_by: 'light-code', dimensions: 384 } }
const theirs = { id: 'col-2', name: 'theirs', metadata: { owner: 'someone-else' } }

function lookup(record: unknown) {
  return (url: string, method: string): [number, unknown] | undefined =>
    method === 'GET' && url.includes(`${COLLECTION_URL}/`) ? [200, record] : undefined
}

function doc(id: string, path: string): VectorDocument {
  return { id, text: 'body', path, startLine: 1, endLine: 2, vector: [0.1, 0.2] }
}

describe('ChromaSearcher', () => {
  it('queries by id and flattens the columnar response', async () => {
    const { http, calls } = recordingHttp((url, method) => {
      const found = lookup(ours)(url, method)
      if (found !== undefined) return found
      if (url.endsWith('/query')) {
        return [
          200,
          {
            ids: [['a.ts:0']],
            distances: [[0.25]],
            documents: [['hello']],
            metadatas: [[{ path: 'src/a.ts', startLine: 3, endLine: 9 }]],
          },
        ]
      }
      return undefined
    })

    const matches = await new ChromaSearcher(http, local).searchByVector('codebase', [0.1, 0.2], { size: 5 })

    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ id: 'a.ts:0', text: 'hello', path: 'src/a.ts', startLine: 3, endLine: 9 })
    // Operations go through the collection's UUID, not its name.
    expect(calls.some((call) => call.url.includes('/collections/col-1/query'))).toBe(true)
  })

  /**
   * Chroma returns a *distance*; the seam wants a score where higher is better. Getting this
   * backwards would rank the least relevant hit first while looking perfectly plausible.
   */
  it('inverts distance into a score, so nearer ranks higher', async () => {
    const { http } = recordingHttp((url, method) => {
      const found = lookup(ours)(url, method)
      if (found !== undefined) return found
      if (url.endsWith('/query')) {
        return [
          200,
          {
            ids: [['near', 'far']],
            distances: [[0.1, 2.0]],
            documents: [['a', 'b']],
            metadatas: [[{ path: 'a.ts' }, { path: 'b.ts' }]],
          },
        ]
      }
      return undefined
    })

    const matches = await new ChromaSearcher(http, local).searchByVector('codebase', [0.1], { size: 5 })
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 1)
  })

  it('filters by path prefix, asking for more than it returns', async () => {
    const { http, calls } = recordingHttp((url, method) => {
      const found = lookup(ours)(url, method)
      if (found !== undefined) return found
      if (url.endsWith('/query')) {
        return [
          200,
          {
            ids: [['1', '2', '3']],
            distances: [[0.1, 0.2, 0.3]],
            documents: [['a', 'b', 'c']],
            metadatas: [[{ path: 'src/a.ts' }, { path: 'docs/b.md' }, { path: 'src/c.ts' }]],
          },
        ]
      }
      return undefined
    })

    const matches = await new ChromaSearcher(http, local).searchByVector('codebase', [0.1], {
      size: 2,
      pathPrefix: 'src/',
    })

    expect(matches.map((match) => match.path)).toEqual(['src/a.ts', 'src/c.ts'])
    const query = calls.find((call) => call.url.endsWith('/query'))
    expect((query?.body as { n_results: number }).n_results).toBeGreaterThan(2)
  })

  /**
   * The v1 endpoints were removed in Chroma 1.0. Left unhandled, a pre-1.0 server's 404 reads
   * as "no such collection" and sends the user looking for the wrong problem.
   */
  it('names the version problem when the server does not speak v2', async () => {
    const { http } = recordingHttp(() => [410, { error: 'gone' }])
    await expect(
      new ChromaSearcher(http, local).searchByVector('codebase', [0.1], { size: 1 }),
    ).rejects.toThrow(/Chroma 1\.0 or newer/)
  })

  it('refuses a collection name that could escape the URL', async () => {
    const { http } = recordingHttp(() => [200, {}])
    await expect(
      new ChromaSearcher(http, local).searchByVector('../admin', [0.1], { size: 1 }),
    ).rejects.toBeInstanceOf(VectorStoreError)
  })
})

describe('ChromaIndexWriter', () => {
  it('creates a collection marked as ours, with no server-side embedding', async () => {
    const { http, calls } = recordingHttp((url, method) => (method === 'GET' ? [404, {}] : undefined))

    await new ChromaIndexWriter(http, local).ensureCollection('codebase', 384)

    const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/collections'))
    expect(create?.body).toMatchObject({
      name: 'codebase',
      metadata: { created_by: 'light-code', dimensions: 384 },
    })
    // Vectors are supplied; a server-side embedder would be a second model and a silent
    // mismatch with everything already stored.
    expect((create?.body as { configuration: { embedding_function: unknown } }).configuration.embedding_function).toBeNull()
  })

  /** The same rule OpenSearch and Qdrant enforce: never write where we did not create. */
  it('refuses to write to a collection it did not create', async () => {
    const { http } = recordingHttp(lookup(theirs))
    await expect(new ChromaIndexWriter(http, local).upsert('theirs', [doc('a', 'x.ts')])).rejects.toThrow(
      /not created by Light Code/,
    )
  })

  it('reports a width mismatch by naming the cause', async () => {
    const { http } = recordingHttp(lookup({ ...ours, metadata: { created_by: 'light-code', dimensions: 768 } }))
    await expect(new ChromaIndexWriter(http, local).ensureCollection('codebase', 384)).rejects.toThrow(
      /768-dimensional.*384/s,
    )
  })

  it('upserts ids, embeddings, documents and metadata as parallel arrays', async () => {
    const { http, calls } = recordingHttp(lookup(ours))

    await new ChromaIndexWriter(http, local).upsert('codebase', [doc('src/a.ts:0', 'src/a.ts')])

    const write = calls.find((call) => call.url.endsWith('/upsert'))
    expect(write?.body).toEqual({
      ids: ['src/a.ts:0'],
      embeddings: [[0.1, 0.2]],
      documents: ['body'],
      metadatas: [{ path: 'src/a.ts', startLine: 1, endLine: 2 }],
    })
  })

  it('deletes many paths in one request', async () => {
    const { http, calls } = recordingHttp(lookup(ours))

    await new ChromaIndexWriter(http, local).deleteByPaths('codebase', ['a.ts', 'b.ts'])

    const deletes = calls.filter((call) => call.url.endsWith('/delete'))
    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.body).toEqual({ where: { path: { $in: ['a.ts', 'b.ts'] } } })
  })

  it('does nothing at all for an empty batch', async () => {
    const { http, calls } = recordingHttp(lookup(ours))
    const writer = new ChromaIndexWriter(http, local)
    await writer.upsert('codebase', [])
    await writer.deleteByPaths('codebase', [])
    expect(calls).toEqual([])
  })

  it('lists distinct paths', async () => {
    const { http } = recordingHttp((url, method) => {
      const found = lookup(ours)(url, method)
      if (found !== undefined) return found
      if (url.endsWith('/get')) {
        return [200, { metadatas: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'a.ts' }] }]
      }
      return undefined
    })

    expect((await new ChromaIndexWriter(http, local).listPaths('codebase')).sort()).toEqual(['a.ts', 'b.ts'])
  })

  /** The ordinary first run, not a failure. */
  it('treats a missing collection as having no paths', async () => {
    const { http } = recordingHttp(() => [404, {}])
    expect(await new ChromaIndexWriter(http, local).listPaths('codebase')).toEqual([])
  })
})
