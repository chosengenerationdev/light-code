import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpResponse } from '../platform/http.js'
import { createVectorIndexWriter, createVectorSearcher } from './vectorStoreFactory.js'
import { VectorStoreError } from './vectorStore.js'

const http: HttpClient = {
  async request(): Promise<HttpResponse> {
    throw new Error('the factory must not make a request just to build a client')
  },
}

const connection = { url: 'http://127.0.0.1:6333' }
const kinds = ['opensearch', 'qdrant', 'chroma'] as const

describe('the vector store factory', () => {
  it('builds a searcher for every backend, reporting its own kind', () => {
    for (const kind of kinds) {
      expect(createVectorSearcher(http, { kind }, connection).kind).toBe(kind)
    }
  })

  it('builds a writer for every backend', () => {
    for (const kind of kinds) {
      expect(createVectorIndexWriter(http, { kind }, connection).kind).toBe(kind)
    }
  })

  /**
   * The property the two-interface split exists for.
   *
   * A tool is handed a `VectorSearcher`, and it must have no way to express a write — so that
   * no future edit can turn a chat message into a deleted collection. Asserted for every
   * backend, because a new adapter is exactly where the invariant would be lost by accident.
   */
  it('gives a searcher no way to write, whatever the backend', () => {
    for (const kind of kinds) {
      const searcher = createVectorSearcher(http, { kind }, connection) as unknown as Record<string, unknown>
      for (const method of ['upsert', 'deleteByPaths', 'ensureCollection', 'listPaths', 'bulk', 'delete']) {
        expect(typeof searcher[method]).not.toBe('function')
      }
    }
  })

  /**
   * Unreachable while the schema and this switch agree — a config naming anything else fails
   * validation first. It exists because they are two files, and the day they disagree the
   * failure should name the reason rather than being an undefined.
   */
  it('names an unknown backend rather than returning undefined', () => {
    expect(() => createVectorSearcher(http, { kind: 'pinecone' as never }, connection)).toThrow(VectorStoreError)
    expect(() => createVectorIndexWriter(http, { kind: 'pinecone' as never }, connection)).toThrow(VectorStoreError)
  })

  it('does not touch the network merely to construct a client', () => {
    // The `http` above throws on any request. Building a client during config load or panel
    // open must not contact anything (invariant 3).
    for (const kind of kinds) {
      expect(() => createVectorSearcher(http, { kind }, connection)).not.toThrow()
      expect(() => createVectorIndexWriter(http, { kind }, connection)).not.toThrow()
    }
  })
})
