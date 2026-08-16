import { describe, expect, it, vi } from 'vitest'

import type { IndexManifest } from './indexer.js'
import { describeSyncMismatch, syncVectorStores } from './syncStores.js'
import { VectorStoreError, type VectorDocument, type VectorIndexWriter } from './vectorStore.js'

function doc(id: string): VectorDocument {
  return { id, text: `t${id}`, path: `src/${id}.ts`, startLine: 1, endLine: 2, vector: [0.1, 0.2] }
}

/** A writer that hands back fixed pages and records what it was told to write. */
function fakeStore(pages: VectorDocument[][] = []): VectorIndexWriter & { written: VectorDocument[]; created: number[] } {
  const written: VectorDocument[] = []
  const created: number[] = []
  let page = 0
  return {
    kind: 'qdrant',
    written,
    created,
    ensureCollection: async (_collection: string, dimensions: number) => {
      created.push(dimensions)
    },
    upsert: async (_collection: string, documents: readonly VectorDocument[]) => {
      written.push(...documents)
    },
    deleteByPaths: async () => {},
    listPaths: async () => [],
    scan: async () => {
      const documents = pages[page] ?? []
      page++
      return page < pages.length ? { documents, next: page } : { documents }
    },
  }
}

const manifest: IndexManifest = {
  model: 'bge-small',
  dimensions: 384,
  chunkSignature: 'v1',
  files: {},
}
const current = { model: 'bge-small', dimensions: 384, chunkSignature: 'v1' }

describe('describeSyncMismatch', () => {
  it('allows a copy when the embedding matches exactly', () => {
    expect(describeSyncMismatch(manifest, current)).toBeUndefined()
  })

  /**
   * The failure this whole guard exists for. Vectors from two models are not comparable, and
   * mixing them produces confident, plausible, wrong neighbours — with no error anywhere.
   */
  it('refuses a different embedding model, and says why', () => {
    const reason = describeSyncMismatch(manifest, { ...current, model: 'e5-large' })
    expect(reason).toMatch(/bge-small/)
    expect(reason).toMatch(/e5-large/)
    expect(reason).toMatch(/quietly wrong|cannot be compared/)
  })

  it('refuses a different vector width', () => {
    expect(describeSyncMismatch(manifest, { ...current, dimensions: 768 })).toMatch(/384.*768/s)
  })

  it('refuses different chunking, since entries would not line up', () => {
    expect(describeSyncMismatch(manifest, { ...current, chunkSignature: 'v2' })).toMatch(/chunking/)
  })

  /** No record means no proof. Absence is not evidence that it matches. */
  it('refuses when there is no manifest at all', () => {
    expect(describeSyncMismatch(undefined, current)).toMatch(/no record/i)
  })

  it('names reindexing as the way forward every time it refuses', () => {
    for (const bad of [
      describeSyncMismatch(undefined, current),
      describeSyncMismatch(manifest, { ...current, model: 'other' }),
      describeSyncMismatch(manifest, { ...current, dimensions: 1 }),
    ]) {
      expect(bad).toMatch(/Index the new store directly/)
    }
  })
})

describe('syncVectorStores', () => {
  it('copies every page into the destination', async () => {
    const from = fakeStore([[doc('a'), doc('b')], [doc('c')]])
    const to = fakeStore()

    const result = await syncVectorStores({ from, to, collection: 'idx', manifest, current })

    expect(result.copied).toBe(3)
    expect(to.written.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('creates the destination collection at the right width first', async () => {
    const to = fakeStore()
    await syncVectorStores({ from: fakeStore([[doc('a')]]), to, collection: 'idx', manifest, current })
    expect(to.created).toEqual([384])
  })

  it('carries the vectors across, which is the entire point', async () => {
    const to = fakeStore()
    await syncVectorStores({ from: fakeStore([[doc('a')]]), to, collection: 'idx', manifest, current })
    expect(to.written[0]?.vector).toEqual([0.1, 0.2])
  })

  it('refuses rather than mixing embeddings', async () => {
    await expect(
      syncVectorStores({
        from: fakeStore([[doc('a')]]),
        to: fakeStore(),
        collection: 'idx',
        manifest,
        current: { ...current, model: 'other' },
      }),
    ).rejects.toBeInstanceOf(VectorStoreError)
  })

  it('writes nothing at all when it refuses', async () => {
    const to = fakeStore()
    await syncVectorStores({
      from: fakeStore([[doc('a')]]),
      to,
      collection: 'idx',
      manifest: undefined,
      current,
    }).catch(() => undefined)

    // Not even the collection: a refused copy must leave the destination untouched.
    expect(to.created).toEqual([])
    expect(to.written).toEqual([])
  })

  it('reports progress as it goes, since a large index takes minutes', async () => {
    const onProgress = vi.fn()
    await syncVectorStores({
      from: fakeStore([[doc('a')], [doc('b')]]),
      to: fakeStore(),
      collection: 'idx',
      manifest,
      current,
      onProgress,
    })
    expect(onProgress.mock.calls.map((call) => (call[0] as { copied: number }).copied)).toEqual([1, 2])
  })

  it('handles an empty source without writing anything', async () => {
    const to = fakeStore()
    const result = await syncVectorStores({ from: fakeStore([[]]), to, collection: 'idx', manifest, current })
    expect(result.copied).toBe(0)
    expect(to.written).toEqual([])
  })

  it('stops when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      syncVectorStores({
        from: fakeStore([[doc('a')]]),
        to: fakeStore(),
        collection: 'idx',
        manifest,
        current,
        signal: controller.signal,
      }),
    ).rejects.toThrow()
  })
})
