import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { createVectorIndexWriter, createVectorSearcher } from './vectorStoreFactory.js'
import type { VectorStoreConnection } from './vectorStore.js'

/**
 * TLS material is configured once and reaches every backend.
 *
 * §19: there used to be four places to put a CA, which is not flexibility but three chances to
 * miss one. Everything now resolves through `platform/connectionTls.ts`, and the host hands the
 * result to whichever adapter is active. This asserts the last link in that chain — that an
 * adapter actually *sends* what it was given — because that is the part a new backend gets
 * wrong by simply not reading the field, and nothing else would notice until a corporate
 * cluster refused the handshake.
 */
function capturingHttp(): { http: HttpClient; seen: (HttpRequestOptions | undefined)[] } {
  const seen: (HttpRequestOptions | undefined)[] = []
  const http: HttpClient = {
    async request(_url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
      seen.push(options)
      const payload = { result: { points: [] }, ids: [[]], id: 'c1', metadata: { created_by: 'light-code' } }
      return {
        status: 200,
        headers: {},
        text: async () => JSON.stringify(payload),
        json: async <T>() => payload as T,
        body: null,
      }
    },
  }
  return { http, seen }
}

const tls = { ca: [Buffer.from('---CORP ROOT---')], rejectUnauthorized: true }
const connection: VectorStoreConnection = { url: 'https://vectors.corp.example', tls }

describe('every vector backend sends the resolved TLS material', () => {
  for (const kind of ['opensearch', 'qdrant', 'chroma'] as const) {
    it(`${kind} searches with it`, async () => {
      const { http, seen } = capturingHttp()
      await createVectorSearcher(http, { kind }, connection)
        .searchByVector('collection', [0.1, 0.2], { size: 1 })
        .catch(() => undefined)

      expect(seen.length).toBeGreaterThan(0)
      // Every request, not merely the first: a client that authenticated over TLS and then
      // queried without it would be worse than one that never used it at all.
      for (const options of seen) expect(options?.tls).toEqual(tls)
    })

    it(`${kind} lists paths with it`, async () => {
      const { http, seen } = capturingHttp()
      await createVectorIndexWriter(http, { kind }, connection)
        .listPaths('collection')
        .catch(() => undefined)

      expect(seen.length).toBeGreaterThan(0)
      for (const options of seen) expect(options?.tls).toEqual(tls)
    })
  }

  it('sends none when none is configured, rather than an empty object', async () => {
    const { http, seen } = capturingHttp()
    await createVectorSearcher(http, { kind: 'qdrant' }, { url: 'http://127.0.0.1:6333' })
      .searchByVector('c', [0.1], { size: 1 })
      .catch(() => undefined)

    // The local case: a container on loopback needs no TLS, and passing an empty options object
    // would have undici build an agent for nothing.
    expect(seen[0]?.tls).toBeUndefined()
  })
})
