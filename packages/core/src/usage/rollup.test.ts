import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { VectorDocument, VectorIndexWriter } from '../rag/vectorStore.js'
import type { S3Client } from '../s3/client.js'
import { UsageLog, type UsageEvent } from './events.js'
import { pushUsage } from './push.js'
import { rollUpMonths } from './rollup.js'
import { FolderShardStore, S3ShardStore, VectorShardStore, type UsageShardStore } from './store.js'

/**
 * The monthly roll-up deletes from a shared store, so every promise it makes is pinned here, on all three
 * kinds of store: nothing lost, nothing counted twice, only this install's files, never before the month
 * is written and read back, and a late day still counted.
 */

const DAY = 86_400_000
// 10 October: September is over and past the grace; October is not.
const now = Date.UTC(2026, 9, 10, 12)
const sept = (day: number, n: string, u = 'ann'): UsageEvent => ({ t: Date.UTC(2026, 8, day, 10), u, k: 'skill', n })

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-rollup-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function fakeS3(): S3Client {
  const objects = new Map<string, Buffer>()
  return {
    put: async (key: string, bytes: Uint8Array) => void objects.set(key, Buffer.from(bytes)),
    list: async (prefix: string) => [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, size: 1, lastModified: '' })),
    get: async (key: string) => {
      const found = objects.get(key)
      if (found === undefined) throw new Error(`S3 answered 404 NoSuchKey for ${key}`)
      return found
    },
    remove: async (key: string) => void objects.delete(key),
  } as unknown as S3Client
}

function fakeVector(): VectorIndexWriter {
  const docs = new Map<string, VectorDocument>()
  return {
    kind: 'qdrant',
    ensureCollection: async () => undefined,
    upsert: async (_c: string, list: readonly VectorDocument[]) => list.forEach((doc) => docs.set(doc.id, doc)),
    deleteByPaths: async (_c: string, paths: readonly string[]) => {
      for (const [id, doc] of docs) if (paths.includes(doc.path)) docs.delete(id)
    },
    listPaths: async () => [],
    scan: async () => ({ documents: [...docs.values()] }),
  } as VectorIndexWriter
}

const kinds: [string, () => UsageShardStore][] = [
  ['shared folder', () => new FolderShardStore(path.join(dir, 'team'))],
  ['S3 bucket', () => new S3ShardStore(fakeS3(), 'bucket', 'team')],
  ['vector store', () => new VectorShardStore(fakeVector(), 'usage', 'Store')],
]

async function seed(store: UsageShardStore, instance: string, log: UsageLog): Promise<void> {
  for (const event of [sept(1, 'a'), sept(1, 'b'), sept(2, 'c'), sept(30, 'd'), sept(3, 'x', 'bob')]) await log.append(event)
  await pushUsage({ log, store, target: 'T', instance })
}

for (const [label, make] of kinds) {
  describe(`roll-up in a ${label}`, () => {
    it('turns the month into one shard per person, deletes the days, and the numbers do not change', async () => {
      const store = make()
      const log = new UsageLog(path.join(dir, 'a'), 's')
      await seed(store, 'inst', log)
      const before = await store.read('2026-09-01', '2026-09-30')
      const result = await rollUpMonths({ log, store, target: 'T', instance: 'inst', now })
      expect(result).toMatchObject({ months: 2, removed: 4, problems: [] })
      const own = await store.listOwn('inst')
      expect(own.every((shard) => shard.month === '2026-09')).toBe(true)
      expect(own).toHaveLength(2)
      expect((await store.read('2026-09-01', '2026-09-30')).map((event) => event.n).sort()).toEqual(before.map((event) => event.n).sort())
    })

    it('never touches another install\'s shards', async () => {
      const store = make()
      await seed(store, 'mine', new UsageLog(path.join(dir, 'a'), 's'))
      await seed(store, 'theirs', new UsageLog(path.join(dir, 'b'), 's'))
      await rollUpMonths({ log: new UsageLog(path.join(dir, 'a'), 's'), store, target: 'T', instance: 'mine', now })
      expect((await store.listOwn('theirs')).every((shard) => shard.day !== undefined)).toBe(true)
      expect(await store.read('2026-09-01', '2026-09-30')).toHaveLength(10)
    })

    it('a late day after the roll-up goes into the month, replacing that day rather than adding to it', async () => {
      const store = make()
      const log = new UsageLog(path.join(dir, 'a'), 's')
      await seed(store, 'inst', log)
      await rollUpMonths({ log, store, target: 'T', instance: 'inst', now })
      // The laptop comes back with one more event for 2 September.
      await log.append(sept(2, 'late'))
      await pushUsage({ log, store, target: 'T', instance: 'inst' })
      const names = (await store.read('2026-09-01', '2026-09-30')).map((event) => event.n).sort()
      expect(names).toEqual(['a', 'b', 'c', 'd', 'late', 'x'])
      expect((await store.listOwn('inst')).some((shard) => shard.day !== undefined)).toBe(false)
    })
  })
}

describe('roll-up safety', () => {
  it('waits for the grace after a month ends, and for this install\'s unsent days', async () => {
    const store = new FolderShardStore(path.join(dir, 'team'))
    const log = new UsageLog(path.join(dir, 'a'), 's')
    await seed(store, 'inst', log)
    expect((await rollUpMonths({ log, store, target: 'T', instance: 'inst', now: Date.UTC(2026, 9, 2) })).months).toBe(0)
    await log.append(sept(15, 'unsent'))
    expect((await rollUpMonths({ log, store, target: 'T', instance: 'inst', now })).months).toBe(0)
    await pushUsage({ log, store, target: 'T', instance: 'inst' })
    expect((await rollUpMonths({ log, store, target: 'T', instance: 'inst', now })).months).toBe(2)
  })

  it('keeps the days when the month does not read back complete', async () => {
    const real = new FolderShardStore(path.join(dir, 'team'))
    const log = new UsageLog(path.join(dir, 'a'), 's')
    await seed(real, 'inst', log)
    const lossy: UsageShardStore = {
      label: 'lossy',
      put: (s, e) => real.put(s, e),
      read: (a, b) => real.read(a, b),
      putProfile: (u, p) => real.putProfile(u, p),
      readProfiles: () => real.readProfiles(),
      listOwn: (i) => real.listOwn(i),
      readShard: async (shard) => ((await real.readShard(shard)) ?? []).slice(shard.month !== undefined ? 1 : 0),
      putMonth: (s, e) => real.putMonth(s, e),
      removeShard: (s) => real.removeShard(s),
    }
    const result = await rollUpMonths({ log, store: lossy, target: 'T', instance: 'inst', now })
    expect(result.months).toBe(0)
    expect(result.problems.length).toBeGreaterThan(0)
    expect((await real.listOwn('inst')).filter((shard) => shard.day !== undefined)).toHaveLength(4)
    // Days left beside a month that exists are skipped by readers, so nothing is counted twice.
    // The month was written but not trusted: its days stay, readers use the month and skip the days - every
    // event once, none twice.
    expect(await real.read('2026-09-01', '2026-09-30')).toHaveLength(5)
  })

  it('two sessions of one install rolling up at once leave the same, complete month', async () => {
    const store = new FolderShardStore(path.join(dir, 'team'))
    const storage = path.join(dir, 'a')
    await seed(store, 'inst', new UsageLog(storage, 's1'))
    await Promise.all([
      rollUpMonths({ log: new UsageLog(storage, 's1'), store, target: 'T', instance: 'inst', now }),
      rollUpMonths({ log: new UsageLog(storage, 's2'), store, target: 'T', instance: 'inst', now }),
    ])
    expect((await store.read('2026-09-01', '2026-09-30')).map((event) => event.n).sort()).toEqual(['a', 'b', 'c', 'd', 'x'])
    expect((await store.listOwn('inst')).every((shard) => shard.month !== undefined)).toBe(true)
  })

  it('a later range does not read the rolled month; an overlapping one does', async () => {
    const store = new FolderShardStore(path.join(dir, 'team'))
    const log = new UsageLog(path.join(dir, 'a'), 's')
    await seed(store, 'inst', log)
    await rollUpMonths({ log, store, target: 'T', instance: 'inst', now })
    expect(await store.read('2026-10-01', '2026-10-09')).toHaveLength(0)
    expect(await store.read('2026-09-29', '2026-10-09')).toHaveLength(5)
  })
})

describe('the clock', () => {
  it('rolls up nothing in the current month', async () => {
    const store = new FolderShardStore(path.join(dir, 'team'))
    const log = new UsageLog(path.join(dir, 'a'), 's')
    await log.append({ t: now - DAY, u: 'ann', k: 'skill', n: 'today-ish' })
    await pushUsage({ log, store, target: 'T', instance: 'inst' })
    expect((await rollUpMonths({ log, store, target: 'T', instance: 'inst', now })).months).toBe(0)
  })
})
