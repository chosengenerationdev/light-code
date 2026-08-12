import { describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../../platform/http.js'
import { isSafeIndexName, OpenSearchClient, OpenSearchError } from './client.js'
import { buildSearchQuery, checkIndexBreadth, selectQueryFields, summariseHit } from './query.js'

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

const connection = { url: 'https://search.corp.example:9200' }

describe('read-only enforcement', () => {
  /**
   * The guarantee the user asked for: the model can never create or modify anything in a
   * cluster the organisation runs. Asserted directly, because "the tool happens not to
   * call bulk" is a convention and one careless edit away from being false.
   */
  it('exposes no write methods at all', () => {
    const client = new OpenSearchClient(recordingHttp(() => ({})).http, connection) as unknown as Record<string, unknown>

    for (const method of ['bulk', 'index', 'ensureIndex', 'delete', 'deleteByQuery', 'update', 'createIndex']) {
      expect(client[method]).toBeUndefined()
    }
  })

  it('only ever issues GET, or POST to _search', async () => {
    const { http, calls } = recordingHttp((url) =>
      url.includes('_mapping')
        ? { idx: { mappings: { properties: { body: { type: 'text' } } } } }
        : url.includes('_cat')
          ? []
          : url.includes('_search')
            ? { took: 1, hits: { total: { value: 0 }, hits: [] } }
            : { cluster_name: 'c', version: { number: '2.13.0' } },
    )
    const client = new OpenSearchClient(http, connection)

    await client.ping()
    await client.listIndexes()
    await client.getMapping('idx')
    await client.search('idx', buildSearchQuery('anything').body)

    expect(calls).not.toHaveLength(0)
    for (const call of calls) {
      if (call.method === 'GET') continue
      expect(call.method).toBe('POST')
      expect(call.url).toMatch(/_search/)
    }
  })

  /** Defence in depth: even if a future edit passes a mutating method, it is refused. */
  it('refuses a mutating request routed through the internal helper', async () => {
    const { http } = recordingHttp(() => ({}))
    const client = new OpenSearchClient(http, connection)
    const internal = client as unknown as {
      request: (path: string, options: { method?: string }) => Promise<unknown>
    }

    await expect(internal.request('/idx/_doc/1', { method: 'PUT' })).rejects.toBeInstanceOf(OpenSearchError)
    await expect(internal.request('/idx/_bulk', { method: 'POST' })).rejects.toThrow(/read-only/)
    await expect(internal.request('/idx', { method: 'DELETE' })).rejects.toThrow(/read-only/)
  })
})

describe('index names', () => {
  /** Index names arrive from model output and become a path segment. */
  it('rejects traversal and anything that is not a legal index name', () => {
    expect(isSafeIndexName('app-logs-2026.08')).toBe(true)
    expect(isSafeIndexName('logs*')).toBe(true)

    expect(isSafeIndexName('../secrets')).toBe(false)
    expect(isSafeIndexName('a/../b')).toBe(false)
    expect(isSafeIndexName('UPPER')).toBe(false)
    expect(isSafeIndexName('with space')).toBe(false)
    expect(isSafeIndexName('')).toBe(false)
  })

  it('refuses a bad index name before making any request', async () => {
    const { http, calls } = recordingHttp(() => ({}))
    const client = new OpenSearchClient(http, connection)

    await expect(client.search('../evil', {})).rejects.toBeInstanceOf(OpenSearchError)
    expect(calls).toHaveLength(0)
  })
})

describe('listIndexes', () => {
  it('parses _cat output and hides system indexes', async () => {
    const { http } = recordingHttp(() => [
      { index: 'app-logs', 'docs.count': '1200', 'store.size': '4.5mb' },
      { index: '.opensearch-observability', 'docs.count': '3' },
      { index: 'jira-tickets', 'docs.count': '88' },
    ])

    const indexes = await new OpenSearchClient(http, connection).listIndexes()

    expect(indexes.map((i) => i.name)).toEqual(['app-logs', 'jira-tickets'])
    expect(indexes[0]?.docsCount).toBe(1200)
    expect(indexes[0]?.storeSize).toBe('4.5mb')
  })
})

describe('getMapping', () => {
  it('flattens nested properties into dotted paths', async () => {
    const { http } = recordingHttp(() => ({
      'app-logs': {
        mappings: {
          properties: {
            message: { type: 'text' },
            '@timestamp': { type: 'date' },
            host: { properties: { name: { type: 'keyword' } } },
          },
        },
      },
    }))

    const mapping = await new OpenSearchClient(http, connection).getMapping('app-logs')

    expect(mapping).toMatchObject({ message: 'text', '@timestamp': 'date', 'host.name': 'keyword' })
  })
})

describe('search results', () => {
  it('reads the modern object-shaped total', async () => {
    const { http } = recordingHttp(() => ({
      took: 12,
      hits: { total: { value: 57 }, hits: [{ _index: 'i', _id: '1', _score: 2.5, _source: { message: 'boom' } }] },
    }))

    const result = await new OpenSearchClient(http, connection).search('i', {})

    expect(result.total).toBe(57)
    expect(result.tookMs).toBe(12)
    expect(result.hits[0]).toMatchObject({ id: '1', score: 2.5, source: { message: 'boom' } })
  })

  /** Older clusters report a bare number; both shapes are in the wild. */
  it('reads the legacy numeric total', async () => {
    const { http } = recordingHttp(() => ({ took: 1, hits: { total: 3, hits: [] } }))
    expect((await new OpenSearchClient(http, connection).search('i', {})).total).toBe(3)
  })
})

describe('errors', () => {
  it('explains 403 in terms of what to do, not just the code', async () => {
    const http: HttpClient = {
      async request(): Promise<HttpResponse> {
        return { status: 403, headers: {}, text: async () => 'no permissions', json: async <T>() => ({}) as T, body: null }
      },
    }

    await expect(new OpenSearchClient(http, connection).listIndexes()).rejects.toThrow(/permission/i)
  })

  it('translates a TLS failure rather than surfacing an OpenSSL code', async () => {
    const http: HttpClient = {
      async request(): Promise<HttpResponse> {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('unable to verify'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
        })
      },
    }

    await expect(new OpenSearchClient(http, connection).ping()).rejects.toThrow(/corporate root CA/)
  })
})

describe('query building', () => {
  const mapping = {
    message: 'text',
    'message.keyword': 'keyword',
    level: 'keyword',
    '@timestamp': 'date',
    bytes: 'long',
    'agent.name': 'keyword',
  }

  it('searches text fields and leaves numeric ones alone', () => {
    const { text, keyword } = selectQueryFields(mapping)

    expect(text).toContain('message')
    expect(keyword).toContain('level')
    // A free-text term can never match a numeric field, and including it only adds noise.
    expect([...text, ...keyword]).not.toContain('bytes')
  })

  it('drops a .keyword sub-field when its analysed parent is already searched', () => {
    expect(selectQueryFields(mapping).keyword).not.toContain('message.keyword')
  })

  it('drops infrastructure noise fields', () => {
    expect(selectQueryFields(mapping).keyword).not.toContain('agent.name')
  })

  /**
   * The bug this avoids: `query_string` treats the input as Lucene syntax, so a perfectly
   * ordinary question containing a colon or a quote throws a parse error instead of
   * searching. `multi_match` treats it as terms.
   */
  it('uses multi_match so punctuation in a question is not Lucene syntax', () => {
    const query = JSON.stringify(buildSearchQuery('why did service:auth fail?', { mapping }).body)

    expect(query).toContain('multi_match')
    expect(query).not.toContain('query_string')
  })

  it('includes keyword fields for a short token, but not for a sentence', () => {
    const token = JSON.stringify(buildSearchQuery('ERROR', { mapping }).body)
    const sentence = JSON.stringify(buildSearchQuery('why is the service failing today', { mapping }).body)

    expect(token).toContain('level')
    expect(sentence).not.toContain('"level"')
  })

  it('applies filters as a non-scoring filter clause', () => {
    const { body } = buildSearchQuery('boom', { mapping, filters: { level: 'ERROR' } })
    const filter = (body as { query: { bool: { filter?: unknown[] } } }).query.bool.filter
    expect(filter).toContainEqual({ term: { level: 'ERROR' } })
  })

  it('ranges over the first date field it finds', () => {
    const query = JSON.stringify(buildSearchQuery('x', { mapping, after: '2026-08-01T00:00:00Z' }).body)
    expect(query).toContain('@timestamp')
    expect(query).toContain('2026-08-01')
  })

  it('falls back to a lenient wildcard when no mapping could be read', () => {
    const query = JSON.stringify(buildSearchQuery('anything').body)
    expect(query).toContain('"lenient":true')
  })

  it('matches everything for an empty query rather than producing an invalid one', () => {
    expect(JSON.stringify(buildSearchQuery('   ').body)).toContain('match_all')
  })
})

describe('summariseHit', () => {
  it('drops empty fields and clips long ones', () => {
    const summary = summariseHit({ message: 'x'.repeat(900), empty: '', missing: null, level: 'ERROR' }, 100)

    expect(summary).toContain('level: ERROR')
    expect(summary).not.toContain('empty')
    expect(summary).not.toContain('missing')
    expect(summary).toContain('…')
    expect(summary.length).toBeLessThan(300)
  })
})

describe('production guard rails', () => {
  const mapping = { message: 'text', '@timestamp': 'date' }

  /**
   * The expensive read on a log cluster is an unbounded one. The model will not think to
   * bound it, so a lookback is imposed when nothing else constrains the query.
   */
  it('bounds an unbounded query to a default lookback', () => {
    const { body, guards } = buildSearchQuery('errors', { mapping })

    expect(guards.lookbackHours).toBe(24)
    expect(JSON.stringify(body)).toContain('now-24h')
  })

  it('leaves an explicitly bounded query alone', () => {
    const { guards } = buildSearchQuery('errors', { mapping, after: '2026-01-01T00:00:00Z' })
    expect(guards.lookbackHours).toBeUndefined()
  })

  it('does not invent a lookback for an index with no date field', () => {
    expect(buildSearchQuery('x', { mapping: { message: 'text' } }).guards.lookbackHours).toBeUndefined()
  })

  it('sends a per-shard timeout and an early-termination cap', () => {
    const { body } = buildSearchQuery('x', { mapping })
    expect(body.timeout).toBe('10s')
    expect(body.terminate_after).toBe(10_000)
  })

  /** Counting every match forces a full traversal; nobody needs the exact figure. */
  it('bounds the hit count instead of computing an exact total', () => {
    expect(buildSearchQuery('x', { mapping }).body.track_total_hits).toBe(1000)
  })

  it('honours raised limits from the connection', () => {
    const { body, guards } = buildSearchQuery('x', {
      mapping,
      limits: { timeoutSeconds: 60, terminateAfter: 0, defaultLookbackHours: 0 },
    })

    expect(body.timeout).toBe('60s')
    // 0 disables rather than meaning "immediately".
    expect(body.terminate_after).toBeUndefined()
    expect(guards.lookbackHours).toBeUndefined()
  })
})

describe('index breadth', () => {
  const known = ['app-logs-01', 'app-logs-02', 'app-logs-03', 'jira', 'confluence']

  /** Fanning out across every shard of every index is the read most likely to hurt. */
  it('refuses to search everything', () => {
    expect(checkIndexBreadth('*', known).ok).toBe(false)
    expect(checkIndexBreadth('_all', known).ok).toBe(false)
  })

  it('allows a pattern that stays within the limit', () => {
    const result = checkIndexBreadth('app-logs-*', known, 5)
    expect(result.ok).toBe(true)
  })

  it('refuses a pattern matching more indexes than allowed, and says how many', () => {
    const result = checkIndexBreadth('app-logs-*', known, 2)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('3 indexes')
      expect(result.reason).toContain('limit of 2')
    }
  })

  it('leaves an exact index name alone', () => {
    expect(checkIndexBreadth('jira', known, 1).ok).toBe(true)
  })

  /** Blocking on a guess would be worse than allowing it; the other guards still apply. */
  it('allows a pattern through when the index list could not be read', () => {
    expect(checkIndexBreadth('app-*', [], 1).ok).toBe(true)
  })

  it('can be disabled by setting the limit to zero', () => {
    expect(checkIndexBreadth('app-logs-*', known, 0).ok).toBe(true)
  })
})
