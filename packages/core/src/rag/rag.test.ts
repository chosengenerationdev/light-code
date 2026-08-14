import { describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { NoAuthStrategy } from '../providers/auth/apiKey.js'
import type { ProviderProfile } from '../providers/types.js'
import { Embedder, EmbedderError } from './embedder.js'
import { OpenSearchError } from './opensearch/client.js'
import { OpenSearchIndexWriter, OWNED_INDEX_MARKER } from './opensearch/writer.js'

const profile: ProviderProfile = {
  id: 'p',
  label: 'Gateway',
  wireFormat: 'openai',
  baseUrl: 'https://gw.example.com/v1',
  model: 'gpt-4o',
  auth: { type: 'none' },
}

interface Call {
  url: string
  method: string
  body?: unknown
}

function http(respond: (url: string, method: string, body: string | undefined) => { status?: number; payload: unknown }): {
  client: HttpClient
  calls: Call[]
} {
  const calls: Call[] = []
  const client: HttpClient = {
    async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
      const method = options.method ?? 'GET'
      calls.push({ url, method, body: options.body })
      const { status = 200, payload } = respond(url, method, options.body)
      return {
        status,
        headers: {},
        text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
        json: async <T>() => payload as T,
        body: null,
      }
    },
  }
  return { client, calls }
}

const connection = { url: 'https://search.corp.example:9200' }
const ownedMapping = { idx: { mappings: { _meta: { createdBy: OWNED_INDEX_MARKER } } } }

describe('Embedder', () => {
  it('posts to the profile base URL and returns the vector', async () => {
    const { client, calls } = http(() => ({ payload: { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] } }))
    const embedder = new Embedder(client, { profile, auth: new NoAuthStrategy(), model: 'embed-1', dimensions: 3 })

    expect(await embedder.embed('hello')).toEqual([0.1, 0.2, 0.3])
    expect(calls[0]?.url).toBe('https://gw.example.com/v1/embeddings')
    expect(JSON.parse(calls[0]?.body as string)).toMatchObject({ model: 'embed-1', input: ['hello'] })
  })

  /**
   * A silently reordered batch attaches every chunk's vector to the wrong chunk, producing
   * a corpus that returns confident nonsense with no clue where the fault is. The response
   * is sorted by its own `index` rather than trusted to arrive in order.
   */
  it('reorders an out-of-order response by its index field', async () => {
    const { client } = http(() => ({
      payload: {
        data: [
          { index: 2, embedding: [3] },
          { index: 0, embedding: [1] },
          { index: 1, embedding: [2] },
        ],
      },
    }))
    const embedder = new Embedder(client, { profile, auth: new NoAuthStrategy(), model: 'e', dimensions: 1 })

    expect(await embedder.embedBatch(['a', 'b', 'c'])).toEqual([[1], [2], [3]])
  })

  it('refuses a response with the wrong number of vectors rather than mispairing', async () => {
    const { client } = http(() => ({ payload: { data: [{ index: 0, embedding: [1] }] } }))
    const embedder = new Embedder(client, { profile, auth: new NoAuthStrategy(), model: 'e', dimensions: 1 })

    await expect(embedder.embedBatch(['a', 'b'])).rejects.toThrow(/Refusing to continue/)
  })

  /** OpenSearch would reject this later with a message about the mapping, which misleads. */
  it('catches a dimension mismatch and names the real fix', async () => {
    const { client } = http(() => ({ payload: { data: [{ index: 0, embedding: [1, 2, 3, 4] }] } }))
    const embedder = new Embedder(client, { profile, auth: new NoAuthStrategy(), model: 'e', dimensions: 1024 })

    await expect(embedder.embed('x')).rejects.toThrow(/4-dimensional.*configured for 1024/s)
  })

  /**
   * The bug a real cluster found. `JSON.stringify([1, NaN, 3])` is `[1,null,3]`, so one bad
   * float reaches OpenSearch as a null and the whole document is rejected with "failed to
   * parse field [vector] of type [knn_vector] ... preview of field's value: null" — a message
   * about the mapping, when the mapping is fine. Checking `Array.isArray` and length was not
   * enough; the elements have to be numbers.
   */
  it('refuses a vector containing NaN, which would serialise to null', async () => {
    const { client } = http(() => ({ payload: { data: [{ index: 0, embedding: [0.1, Number.NaN, 0.3] }] } }))
    const embedder = new Embedder(client, { profile, auth: new NoAuthStrategy(), model: 'e', dimensions: 3 })

    await expect(embedder.embed('x')).rejects.toThrow(/NaN at position 1/)
  })

  it('refuses a vector containing null', async () => {
    const { client } = http(() => ({ payload: { data: [{ index: 0, embedding: [0.1, null, 0.3] }] } }))
    const embedder = new Embedder(client, { profile, auth: new NoAuthStrategy(), model: 'e', dimensions: 3 })

    await expect(embedder.embed('x')).rejects.toThrow(/position 1/)
  })

  it('refuses Infinity, which serialises to null just as quietly', async () => {
    const { client } = http(() => ({ payload: { data: [{ index: 0, embedding: [1, 2, Number.POSITIVE_INFINITY] }] } }))
    const embedder = new Embedder(client, { profile, auth: new NoAuthStrategy(), model: 'e', dimensions: 3 })

    await expect(embedder.embed('x')).rejects.toThrow(/position 2/)
  })

  it('batches a large input rather than sending one enormous request', async () => {
    const { client, calls } = http((_url, _method, body) => {
      const input = (JSON.parse(body ?? '{}') as { input: string[] }).input
      return { payload: { data: input.map((_, index) => ({ index, embedding: [index] })) } }
    })
    const embedder = new Embedder(client, { profile, auth: new NoAuthStrategy(), model: 'e', dimensions: 1 }, 10)

    const vectors = await embedder.embedBatch(Array.from({ length: 25 }, (_, i) => `text ${i}`))

    expect(vectors).toHaveLength(25)
    expect(calls).toHaveLength(3)
  })

  it('explains a transport failure rather than surfacing an OpenSSL code', async () => {
    const client: HttpClient = {
      async request(): Promise<HttpResponse> {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('x'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
        })
      },
    }
    const embedder = new Embedder(client, { profile, auth: new NoAuthStrategy(), model: 'e', dimensions: 1 })

    await expect(embedder.embed('x')).rejects.toBeInstanceOf(EmbedderError)
    await expect(embedder.embed('x')).rejects.toThrow(/corporate root CA/)
  })
})

describe('OpenSearchIndexWriter ownership', () => {
  /**
   * The guarantee that matters most here: a typo in an index name must never mean
   * "your production logs were overwritten". Every write checks the marker first.
   */
  it('refuses to write to an index it did not create', async () => {
    const { client } = http(() => ({ payload: { 'prod-logs': { mappings: {} } } }))
    const writer = new OpenSearchIndexWriter(client, connection)

    await expect(
      writer.upsert('prod-logs', [
        { id: '1', text: 't', path: 'a.ts', startLine: 1, endLine: 2, vector: [1] },
      ]),
    ).rejects.toThrow(/not created by Light Code/)
  })

  it('refuses to delete from an index it did not create', async () => {
    const { client } = http(() => ({ payload: { 'prod-logs': { mappings: {} } } }))
    await expect(new OpenSearchIndexWriter(client, connection).deleteByPaths('prod-logs', ['a.ts'])).rejects.toThrow(
      /not created by Light Code/,
    )
  })

  it('refuses to adopt an existing index that lacks the marker', async () => {
    const { client } = http(() => ({ payload: { 'prod-logs': { mappings: {} } } }))
    await expect(new OpenSearchIndexWriter(client, connection).ensureCollection('prod-logs', 8)).rejects.toThrow(
      /not created by Light Code/,
    )
  })

  it('writes to an index carrying the marker', async () => {
    const { client, calls } = http((url, method) =>
      url.includes('_mapping') ? { payload: ownedMapping } : method === 'POST' ? { payload: { errors: false } } : { payload: {} },
    )

    await new OpenSearchIndexWriter(client, connection).upsert('idx', [
      { id: '1', text: 't', path: 'a.ts', startLine: 1, endLine: 2, vector: [1] },
    ])

    const bulk = calls.find((call) => call.url.endsWith('/_bulk'))
    expect(bulk).toBeDefined()
    expect(String(bulk?.body)).toContain('"_id":"1"')
  })

  /**
   * A vector field's width is fixed at creation. Switching embedding model without switching
   * index means every write fails with a mapping error that never mentions the real cause.
   */
  it('refuses an existing index whose vector width does not match', async () => {
    const { client } = http((url) =>
      url.includes('_mapping')
        ? {
            payload: {
              idx: {
                mappings: { _meta: { createdBy: OWNED_INDEX_MARKER }, properties: { vector: { dimension: 768 } } },
              },
            },
          }
        : { payload: {} },
    )

    await expect(new OpenSearchIndexWriter(client, connection).ensureCollection('idx', 1536)).rejects.toThrow(
      /stores 768-dimensional vectors.*produces 1536/s,
    )
  })

  it('accepts an existing index whose width matches', async () => {
    const { client } = http((url) =>
      url.includes('_mapping')
        ? {
            payload: {
              idx: {
                mappings: { _meta: { createdBy: OWNED_INDEX_MARKER }, properties: { vector: { dimension: 1536 } } },
              },
            },
          }
        : { payload: {} },
    )

    await expect(new OpenSearchIndexWriter(client, connection).ensureCollection('idx', 1536)).resolves.toBeUndefined()
  })

  it('refuses a wildcard as a write target', async () => {
    const { client } = http(() => ({ payload: {} }))
    await expect(new OpenSearchIndexWriter(client, connection).ensureCollection('logs-*', 8)).rejects.toBeInstanceOf(
      OpenSearchError,
    )
  })
})

describe('OpenSearchIndexWriter behaviour', () => {
  it('creates a knn index with the configured width and the ownership marker', async () => {
    const { client, calls } = http((url, method) => {
      if (url.includes('_mapping')) return { status: 404, payload: {} }
      if (method === 'PUT') return { payload: { acknowledged: true } }
      return { payload: {} }
    })

    await new OpenSearchIndexWriter(client, connection).ensureCollection('idx', 1024)

    const create = calls.find((call) => call.method === 'PUT')
    const body = JSON.parse(String(create?.body)) as {
      settings: { index: { knn: boolean } }
      mappings: { _meta: { createdBy: string }; properties: { vector: { type: string; dimension: number } } }
    }

    expect(body.settings.index.knn).toBe(true)
    expect(body.mappings.properties.vector).toEqual({ type: 'knn_vector', dimension: 1024 })
    expect(body.mappings._meta.createdBy).toBe(OWNED_INDEX_MARKER)
  })

  /** `_bulk` returns 200 with per-item failures; trusting the status hides a partial write. */
  it('surfaces per-item bulk failures despite the 200', async () => {
    const { client } = http((url) =>
      url.includes('_mapping')
        ? { payload: ownedMapping }
        : { payload: { errors: true, items: [{ index: { error: { reason: 'mapper_parsing_exception' } } }] } },
    )

    await expect(
      new OpenSearchIndexWriter(client, connection).upsert('idx', [
        { id: '1', text: 't', path: 'a.ts', startLine: 1, endLine: 1, vector: [1] },
      ]),
    ).rejects.toThrow(/mapper_parsing_exception/)
  })

  it('does nothing at all for an empty batch', async () => {
    const { client, calls } = http(() => ({ payload: {} }))
    await new OpenSearchIndexWriter(client, connection).upsert('idx', [])
    expect(calls).toHaveLength(0)
  })
})
