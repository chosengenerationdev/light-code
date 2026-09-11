import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DatasetStore } from './store.js'
import { clearDataset, syncDataset } from './sync.js'
import type { DatasetRecord } from './types.js'
import type { Embedder } from '../rag/embedder.js'
import type { VectorIndexWriter } from '../rag/vectorStore.js'

/**
 * Collecting a corpus the user owns, repeatedly, without it growing or drifting.
 *
 * The two failures worth designing against are both silent. A collector that returns everything
 * each run — which is the ordinary case, since most sources have no "changed since" — must not
 * duplicate the corpus, and must not cost a full re-embedding every time. Either would look fine
 * for a day and be ruinous by the end of a week.
 */
let dir: string
let store: DatasetStore

const NOW = Date.parse('2026-09-11T12:00:00Z')
const DAY = 24 * 3600_000

function record(id: string, text: string, agoDays = 0): DatasetRecord {
  return { id, text, timestamp: NOW - agoDays * DAY }
}

/** Counts what was embedded, so "did it re-embed?" is observable rather than inferred. */
function embedder() {
  const seen: string[] = []
  return {
    seen,
    embedder: {
      model: 'test',
      dimensions: 3,
      embed: async (text: string) => {
        seen.push(text)
        return [1, 0, 0]
      },
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    } as unknown as Embedder,
  }
}

function writer() {
  const upserted: string[] = []
  const deleted: string[] = []
  return {
    upserted,
    deleted,
    writer: {
      ensureCollection: async () => undefined,
      upsert: async (_collection: string, documents: readonly { id: string }[]) => {
        upserted.push(...documents.map((document) => document.id))
      },
      deleteByPaths: async (_collection: string, paths: readonly string[]) => {
        deleted.push(...paths)
      },
      listPaths: async () => [],
    } as unknown as VectorIndexWriter,
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-dataset-'))
  store = new DatasetStore(dir, 'tickets')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('syncing a dataset', () => {
  it('stores what the collector returned', async () => {
    const result = await syncDataset({
      datasetId: 'tickets',
      store,
      collect: async () => [record('T-1', 'disk full'), record('T-2', 'login broken')],
      now: NOW,
    })
    expect(result.collected).toBe(2)
    expect(result.total).toBe(2)
  })

  it('does not duplicate when the collector returns everything again', async () => {
    // The ordinary case: most sources cannot say what changed, so a collector returns the lot.
    const all = async () => [record('T-1', 'disk full'), record('T-2', 'login broken')]
    await syncDataset({ datasetId: 'tickets', store, collect: all, now: NOW })
    const second = await syncDataset({ datasetId: 'tickets', store, collect: all, now: NOW })

    expect(second.updated).toBe(0)
    expect(second.total).toBe(2)
    expect((await store.load()).map((entry) => entry.id).sort()).toEqual(['T-1', 'T-2'])
  })

  it('does not re-embed a record that has not changed', async () => {
    /*
     * The property that makes "return everything each time" affordable. Without it, an hourly
     * collector over ten thousand records pays for ten thousand embeddings an hour, for ever.
     */
    const { seen, embedder: model } = embedder()
    const { writer: store2 } = writer()
    const semantic = { embedder: model, writer: store2, collection: 'c' }
    const all = async () => [record('T-1', 'disk full'), record('T-2', 'login broken')]

    await syncDataset({ datasetId: 'tickets', store, collect: all, semantic, now: NOW })
    expect(seen).toHaveLength(2)

    await syncDataset({ datasetId: 'tickets', store, collect: all, semantic, now: NOW })
    expect(seen).toHaveLength(2)
  })

  it('re-embeds a record whose text changed, and updates rather than adds', async () => {
    const { seen, embedder: model } = embedder()
    const { writer: store2 } = writer()
    const semantic = { embedder: model, writer: store2, collection: 'c' }

    await syncDataset({ datasetId: 'tickets', store, collect: async () => [record('T-1', 'disk full')], semantic, now: NOW })
    await syncDataset({
      datasetId: 'tickets',
      store,
      collect: async () => [record('T-1', 'disk full — resolved')],
      semantic,
      now: NOW,
    })

    expect(seen).toHaveLength(2)
    const held = await store.load()
    expect(held).toHaveLength(1)
    expect(held[0]?.text).toBe('disk full — resolved')
  })

  it('applies retention, vectors before facts', async () => {
    const { writer: store2, deleted } = writer()
    const { embedder: model } = embedder()
    await syncDataset({
      datasetId: 'tickets',
      store,
      collect: async () => [record('old', 'ancient', 100), record('new', 'today', 1)],
      semantic: { embedder: model, writer: store2, collection: 'c' },
      retentionDays: 30,
      now: NOW,
    })

    expect((await store.load()).map((entry) => entry.id)).toEqual(['new'])
    expect(deleted).toContain('data:tickets:old')
  })

  it('keeps a record with no timestamp, because it has no age to judge', async () => {
    await syncDataset({
      datasetId: 'tickets',
      store,
      collect: async () => [{ id: 'x', text: 'undated' }],
      retentionDays: 1,
      now: NOW,
    })
    // Removing it would delete exactly the records whose source could not say when they were from.
    expect((await store.load()).map((entry) => entry.id)).toEqual(['x'])
  })

  it('hands the collector the time of the last successful sync', async () => {
    const asked: (number | undefined)[] = []
    const collect = async (since: number | undefined) => {
      asked.push(since)
      return [record('T-1', 'one')]
    }
    await syncDataset({ datasetId: 'tickets', store, collect, now: NOW })
    await syncDataset({ datasetId: 'tickets', store, collect, now: NOW + 1000 })

    expect(asked[0]).toBeUndefined()
    expect(asked[1]).toBe(NOW)
  })

  it('does not advance the watermark when the collector fails', async () => {
    /*
     * Otherwise whatever the source produced while it was broken is skipped for ever, with
     * nothing anywhere recording the gap.
     */
    await syncDataset({ datasetId: 'tickets', store, collect: async () => [record('T-1', 'one')], now: NOW })
    await expect(
      syncDataset({
        datasetId: 'tickets',
        store,
        collect: async () => {
          throw new Error('source unreachable')
        },
        now: NOW + 5000,
      }),
    ).rejects.toThrow(/unreachable/)

    expect(await store.lastSyncedAt()).toBe(NOW)
  })

  it('refuses output that is not records, naming the shape', async () => {
    await expect(
      syncDataset({ datasetId: 'tickets', store, collect: async () => ({ rows: [1, 2] }), now: NOW }),
    ).rejects.toThrow(/id.*text|expected shape/i)
  })

  it('accepts both a bare array and {records: [...]}', async () => {
    await syncDataset({ datasetId: 'tickets', store, collect: async () => ({ records: [record('a', 'x')] }), now: NOW })
    expect((await store.load())[0]?.id).toBe('a')
  })

  it('keeps the file from growing with the number of syncs', async () => {
    // Append-as-upsert means a record refreshed hourly adds a line hourly without compaction.
    const all = async () => [record('T-1', String(Math.random()))]
    for (let pass = 0; pass < 5; pass++) {
      await syncDataset({ datasetId: 'tickets', store, collect: all, now: NOW })
    }
    const lines = (await fs.readFile(path.join(dir, 'datasets', 'tickets.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0)
    expect(lines).toHaveLength(1)
  })
})

describe('clearing a dataset', () => {
  it('removes the vectors and the records and the watermark', async () => {
    const { writer: store2, deleted } = writer()
    const { embedder: model } = embedder()
    await syncDataset({
      datasetId: 'tickets',
      store,
      collect: async () => [record('T-1', 'one'), record('T-2', 'two')],
      semantic: { embedder: model, writer: store2, collection: 'c' },
      now: NOW,
    })

    const result = await clearDataset({
      datasetId: 'tickets',
      store,
      semantic: { writer: store2, collection: 'c' },
    })

    expect(result.removed).toBe(2)
    expect(deleted).toEqual(expect.arrayContaining(['data:tickets:T-1', 'data:tickets:T-2']))
    expect(await store.load()).toEqual([])
    // The watermark goes too, so a rebuild asks the collector for everything.
    expect(await store.lastSyncedAt()).toBeUndefined()
  })
})
