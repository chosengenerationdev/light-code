import { describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { createSearchCodebaseTool } from '../tools/searchCodebase.js'
import type { ToolExecutionContext } from '../tools/types.js'
import type { Embedder } from './embedder.js'
import { OpenSearchClient } from './opensearch/client.js'
import { OpenSearchIndexWriter } from './opensearch/writer.js'
import type { VectorMatch, VectorSearcher } from './vectorStore.js'
import { createVectorIndexWriter, createVectorSearcher } from './vectorStoreFactory.js'

interface Recorded {
  url: string
  method: string
  body?: unknown
}

function recordingHttp(respond: (url: string) => unknown): { http: HttpClient; calls: Recorded[] } {
  const calls: Recorded[] = []
  const http: HttpClient = {
    async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
      calls.push({
        url,
        method: options.method ?? 'GET',
        ...(options.body !== undefined ? { body: JSON.parse(options.body) as unknown } : {}),
      })
      const payload = respond(url)
      return {
        status: 200,
        headers: {},
        text: async () => JSON.stringify(payload),
        json: async <T>() => payload as T,
        body: null,
      }
    },
  }
  return { http, calls }
}

const connection = { url: 'https://search.corp.example:9200', label: 'corp cluster' }

const hitsResponse = {
  took: 4,
  hits: {
    total: { value: 2 },
    hits: [
      {
        _index: 'lc-index',
        _id: 'a',
        _score: 0.9,
        _source: { path: 'src/retry.ts', startLine: 10, endLine: 20, text: 'function shouldAttemptAgain() {}' },
      },
      { _index: 'lc-index', _id: 'b', _score: 0.4, _source: { path: 'src/http.ts', startLine: 1, endLine: 5, text: 'get()' } },
    ],
  },
}

describe('the vector-store seam', () => {
  /**
   * The property the two-interface split exists for, asserted against the factory rather than
   * the class: whatever backend is configured, the object a *tool* is handed must have no way
   * to write. `opensearch.test.ts` proves it for the concrete class; this proves the wiring
   * that produces it cannot hand back a writer by mistake.
   */
  it('never returns a writable object from createVectorSearcher', () => {
    const searcher = createVectorSearcher(recordingHttp(() => ({})).http, { kind: 'opensearch' }, connection) as unknown as Record<
      string,
      unknown
    >
    for (const method of ['ensureCollection', 'upsert', 'deleteByPaths', 'bulkIndex', 'ensureIndex']) {
      expect(searcher[method]).toBeUndefined()
    }
  })

  it('builds the OpenSearch pair for kind "opensearch"', () => {
    const { http } = recordingHttp(() => ({}))
    expect(createVectorSearcher(http, { kind: 'opensearch' }, connection)).toBeInstanceOf(OpenSearchClient)
    expect(createVectorIndexWriter(http, { kind: 'opensearch' }, connection)).toBeInstanceOf(OpenSearchIndexWriter)
  })

  it('reports the configured label, falling back to the URL', () => {
    const { http } = recordingHttp(() => ({}))
    expect(createVectorSearcher(http, { kind: 'opensearch' }, connection).label).toBe('corp cluster')
    expect(createVectorSearcher(http, { kind: 'opensearch' }, { url: 'https://x:9200' }).label).toBe('https://x:9200')
  })
})

describe('OpenSearchClient.searchByVector', () => {
  it('issues a knn query that excludes the stored vector from the response', async () => {
    const { http, calls } = recordingHttp(() => hitsResponse)
    await new OpenSearchClient(http, connection).searchByVector('lc-index', [0.1, 0.2], { size: 5 })

    const body = calls[0]?.body as {
      size?: number
      _source?: { excludes?: string[] }
      query?: { knn?: { vector?: { vector?: number[]; k?: number; filter?: unknown } } }
    }
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toContain('/lc-index/_search')
    expect(body._source?.excludes).toEqual(['vector'])
    expect(body.query?.knn?.vector?.vector).toEqual([0.1, 0.2])
    expect(body.size).toBe(5)
    // Returning a 1024-float array per hit would dwarf the code it describes.
    expect(body.query?.knn?.vector?.filter).toBeUndefined()
  })

  /**
   * k is neighbours considered per shard. Below the number of hits wanted, a filter can leave
   * fewer results than requested — so it is floored, and a large size raises it.
   */
  it('keeps k at or above the number of hits wanted', async () => {
    const { http, calls } = recordingHttp(() => hitsResponse)
    const client = new OpenSearchClient(http, connection)

    await client.searchByVector('lc-index', [0.1], { size: 2 })
    await client.searchByVector('lc-index', [0.1], { size: 25 })

    const k = (index: number): unknown =>
      (calls[index]?.body as { query?: { knn?: { vector?: { k?: number } } } }).query?.knn?.vector?.k
    expect(k(0)).toBe(10)
    expect(k(1)).toBe(25)
  })

  it('translates a path prefix into a filter, and ignores a blank one', async () => {
    const { http, calls } = recordingHttp(() => hitsResponse)
    const client = new OpenSearchClient(http, connection)

    await client.searchByVector('lc-index', [0.1], { size: 3, pathPrefix: '  packages/core/src  ' })
    await client.searchByVector('lc-index', [0.1], { size: 3, pathPrefix: '   ' })

    const filter = (index: number): unknown =>
      (calls[index]?.body as { query?: { knn?: { vector?: { filter?: unknown } } } }).query?.knn?.vector?.filter
    expect(filter(0)).toEqual({ prefix: { path: 'packages/core/src' } })
    expect(filter(1)).toBeUndefined()
  })

  it('flattens hits into backend-neutral matches', async () => {
    const { http } = recordingHttp(() => hitsResponse)
    const matches = await new OpenSearchClient(http, connection).searchByVector('lc-index', [0.1], { size: 5 })

    expect(matches).toEqual<VectorMatch[]>([
      { id: 'a', score: 0.9, text: 'function shouldAttemptAgain() {}', path: 'src/retry.ts', startLine: 10, endLine: 20 },
      { id: 'b', score: 0.4, text: 'get()', path: 'src/http.ts', startLine: 1, endLine: 5 },
    ])
  })

  /** A document written before a mapping change, or by a different backend, must not throw. */
  it('survives a hit missing path, text or line numbers', async () => {
    const { http } = recordingHttp(() => ({
      hits: { total: { value: 1 }, hits: [{ _index: 'lc-index', _id: 'orphan', _score: 0.5, _source: {} }] },
    }))
    const matches = await new OpenSearchClient(http, connection).searchByVector('lc-index', [0.1], { size: 5 })

    expect(matches[0]).toEqual({ id: 'orphan', score: 0.5, text: '', path: 'orphan' })
  })
})

describe('search_codebase over the seam', () => {
  const embedder = { embed: async () => [0.1, 0.2, 0.3] } as unknown as Embedder
  // This tool touches no filesystem, terminal or deny list — the vector store is its only
  // input. An empty context is honest about that rather than propping up an unused stub.
  const noContext = {} as unknown as ToolExecutionContext

  function fakeSearcher(matches: VectorMatch[]): { searcher: VectorSearcher; seen: unknown[] } {
    const seen: unknown[] = []
    return {
      seen,
      searcher: {
        kind: 'opensearch',
        label: 'corp cluster',
        searchByVector: async (collection, vector, options) => {
          seen.push({ collection, vector: [...vector], options })
          return matches
        },
      },
    }
  }

  /**
   * The tool must work against any backend, so it is handed a `VectorSearcher` it did not
   * build and cannot inspect. If this ever needs a concrete client again, the seam has leaked.
   */
  it('delegates to whatever searcher it was given, with no OpenSearch query in sight', async () => {
    const { searcher, seen } = fakeSearcher([
      { id: 'a', score: 0.87, text: 'const backoff = 2 ** attempt', path: 'src/retry.ts', startLine: 10, endLine: 12 },
    ])
    const tool = createSearchCodebaseTool({ searcher, embedder, index: 'lc-index', connectionLabel: 'corp cluster' })

    const result = await tool.execute({ query: 'where retry backoff is calculated', size: 4, pathPrefix: 'src' }, noContext)

    expect(seen).toEqual([
      { collection: 'lc-index', vector: [0.1, 0.2, 0.3], options: { size: 4, pathPrefix: 'src' } },
    ])
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('src/retry.ts:10-12')
    expect(result.content).toContain('const backoff = 2 ** attempt')
  })

  /**
   * Said on every non-empty result on purpose: the failure mode is the model treating a weak
   * semantic hit as authoritative and never opening the file (§12).
   */
  it('always warns that the results are approximate', async () => {
    const { searcher } = fakeSearcher([{ id: 'a', score: 0.9, text: 'x', path: 'a.ts' }])
    const tool = createSearchCodebaseTool({ searcher, embedder, index: 'lc-index', connectionLabel: 'corp cluster' })

    expect((await tool.execute({ query: 'anything' }, noContext)).content).toContain('approximate')
  })

  it('renders a hit with unknown line numbers rather than dropping it', async () => {
    const { searcher } = fakeSearcher([{ id: 'a', score: 0.9, text: 'body', path: 'a.ts' }])
    const tool = createSearchCodebaseTool({ searcher, embedder, index: 'lc-index', connectionLabel: 'corp cluster' })

    expect((await tool.execute({ query: 'anything' }, noContext)).content).toContain('a.ts:?-?')
  })

  /** An empty index must point at Settings, not look like "this code does not exist". */
  it('names the index and the connection when nothing matches', async () => {
    const { searcher } = fakeSearcher([])
    const tool = createSearchCodebaseTool({ searcher, embedder, index: 'lc-index', connectionLabel: 'corp cluster' })

    const result = await tool.execute({ query: 'anything' }, noContext)
    expect(result.content).toContain('lc-index')
    expect(result.content).toContain('corp cluster')
    expect(result.content).toContain('search_files')
  })

  it('reports a backend failure as a tool error rather than throwing', async () => {
    const tool = createSearchCodebaseTool({
      searcher: {
        kind: 'opensearch',
        label: 'corp cluster',
        searchByVector: async () => {
          throw new Error('cluster unreachable')
        },
      },
      embedder,
      index: 'lc-index',
      connectionLabel: 'corp cluster',
    })

    expect(await tool.execute({ query: 'anything' }, noContext)).toMatchObject({ isError: true, content: 'cluster unreachable' })
  })
})

/**
 * Reconciling a collection against a freshly-built corpus.
 *
 * This is on the writer rather than the searcher on purpose: it is the writer that removes
 * what has gone, and the searcher is the object handed to tools, which have no business
 * enumerating an index.
 */
describe('OpenSearchIndexWriter.listPaths', () => {
  const stored = {
    hits: {
      hits: [
        { _source: { path: 'tool:s3__get_object' } },
        { _source: { path: 'skill:deployment' } },
        // Two chunks of one file share a path; callers want the distinct set.
        { _source: { path: 'skill:deployment' } },
      ],
    },
  }

  it('returns the distinct paths, asking only for that field', async () => {
    const { http, calls } = recordingHttp(() => stored)
    const paths = await new OpenSearchIndexWriter(http, connection).listPaths('lc-docs')

    expect(paths.sort()).toEqual(['skill:deployment', 'tool:s3__get_object'])
    const body = calls[0]?.body as { _source?: { includes?: string[] }; size?: number }
    // Documents carry their full text and a vector; pulling those back to enumerate names
    // would move megabytes to answer a question about a few hundred strings.
    expect(body._source?.includes).toEqual(['path'])
    expect(body.size).toBe(1_000)
  })

  it('honours a caller-supplied cap', async () => {
    const { http, calls } = recordingHttp(() => stored)
    await new OpenSearchIndexWriter(http, connection).listPaths('lc-docs', { limit: 25 })
    expect((calls[0]?.body as { size?: number }).size).toBe(25)
  })

  /** First run: the collection does not exist yet, and every path is new by definition. */
  it('treats a missing collection as empty rather than an error', async () => {
    const http: HttpClient = {
      async request(): Promise<HttpResponse> {
        return {
          status: 404,
          headers: {},
          text: async () => 'index_not_found_exception',
          json: async <T>() => ({}) as T,
          body: null,
        }
      },
    }
    await expect(new OpenSearchIndexWriter(http, connection).listPaths('absent')).resolves.toEqual([])
  })

  it('rejects an unsafe collection name before it becomes a path segment', async () => {
    const { http } = recordingHttp(() => stored)
    await expect(new OpenSearchIndexWriter(http, connection).listPaths('../evil')).rejects.toThrow(/not a valid index name/i)
  })
})
