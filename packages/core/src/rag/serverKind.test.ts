import { describe, expect, it } from 'vitest'
import type { HttpClient, HttpResponse } from '../platform/http.js'
import { identifyServer, probeVectorStore } from './serverKind.js'
import { createVectorIndexWriter } from './vectorStoreFactory.js'

/*
 * Reported from real use: a connection typed Qdrant (the form's default) with the team's OpenSearch
 * address. Test connection passed, and indexing failed with "Could not read collection ... (HTTP 400)",
 * which sent the user renaming the project. These pin both halves: the test now fails, and the
 * indexing error names the type.
 */

const OPENSEARCH_ROOT = {
  name: 'node-1',
  cluster_name: 'team-search',
  version: { distribution: 'opensearch', number: '2.17.0' },
}
const NO_HANDLER = { error: 'no handler found for uri [/collections/proj-code-base-ana-0123] and method [GET]' }

/** A fake server: `routes` maps a path to [status, body]; anything else is OpenSearch's 400. */
function server(routes: Record<string, [number, unknown]>): HttpClient {
  return {
    async request(url: string): Promise<HttpResponse> {
      const path = new URL(url).pathname
      const [status, body] = routes[path] ?? [400, NO_HANDLER]
      const text = typeof body === 'string' ? body : JSON.stringify(body)
      return { status, headers: {}, text: async () => text, json: async <T>() => body as T, body: null }
    },
  }
}

const connection = { url: 'https://search.corp.example:9200', label: 'team cluster' }
const openSearch = server({ '/': [200, OPENSEARCH_ROOT] })

describe('which server answered', () => {
  it('recognises each backend from its own answers, and guesses nothing else', () => {
    expect(identifyServer(OPENSEARCH_ROOT)).toBe('opensearch')
    expect(identifyServer(NO_HANDLER)).toBe('opensearch')
    expect(identifyServer({ error: { root_cause: [], type: 'index_not_found_exception' } })).toBe('opensearch')
    expect(identifyServer({ title: 'qdrant - vector search engine', version: '1.12.0' })).toBe('qdrant')
    expect(identifyServer({ 'nanosecond heartbeat': 1 })).toBe('chroma')
    // Chroma's own error envelope, and a proxy page: neither names a server.
    expect(identifyServer({ error: 'NotFoundError', message: 'missing' })).toBeUndefined()
    expect(identifyServer('<html>Bad gateway</html>')).toBeUndefined()
  })
})

describe('Test connection speaks the chosen type', () => {
  it('fails a Qdrant connection pointed at OpenSearch, saying what to change', async () => {
    await expect(probeVectorStore(openSearch, 'qdrant', connection)).rejects.toThrow(
      /answers like OpenSearch, but this connection's type is Qdrant.*set Type to OpenSearch/,
    )
  })

  it('fails a Chroma connection pointed at OpenSearch', async () => {
    await expect(probeVectorStore(openSearch, 'chroma', connection)).rejects.toThrow(/answers like OpenSearch/)
  })

  it('fails an OpenSearch connection pointed at Qdrant', async () => {
    const qdrant = server({ '/': [200, { title: 'qdrant - vector search engine', version: '1.12.0' }] })
    await expect(probeVectorStore(qdrant, 'opensearch', connection)).rejects.toThrow(
      /answers like Qdrant, but this connection's type is OpenSearch/,
    )
  })

  it('passes each backend at its own address', async () => {
    expect(await probeVectorStore(openSearch, 'opensearch', connection)).toBe('Connected to team-search (OpenSearch 2.17.0).')
    const qdrant = server({
      '/': [200, { title: 'qdrant - vector search engine', version: '1.12.0' }],
      '/collections': [200, { result: { collections: [{ name: 'a' }] } }],
    })
    expect(await probeVectorStore(qdrant, 'qdrant', connection)).toBe('Connected to Qdrant 1.12.0 - 1 collection.')
    const chroma = server({
      '/': [404, { error: 'NotFound' }],
      '/api/v2/heartbeat': [200, { 'nanosecond heartbeat': 1 }],
      '/api/v2/version': [200, '1.0.8'],
    })
    expect(await probeVectorStore(chroma, 'chroma', connection)).toBe('Connected to Chroma 1.0.8.')
  })

  it('names a rejected Qdrant API key rather than calling it the wrong server', async () => {
    const qdrant = server({
      '/': [200, { title: 'qdrant - vector search engine', version: '1.12.0' }],
      '/collections': [401, 'Unauthorized'],
    })
    await expect(probeVectorStore(qdrant, 'qdrant', connection)).rejects.toThrow(/refused the credentials/)
  })
})

describe('indexing into the wrong type of server', () => {
  it('says so in the error the user saw, instead of only HTTP 400', async () => {
    const writer = createVectorIndexWriter(openSearch, { kind: 'qdrant' }, connection)
    await expect(
      writer.ensureCollection('proj-code-base-ana-0123', 2),
    ).rejects.toThrow(/Could not read collection "proj-code-base-ana-0123" \(HTTP 400\)\. .*set Type to OpenSearch/)
  })
})
