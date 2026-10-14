import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { VectorDocument, VectorIndexWriter } from '../rag/vectorStore.js'
import type { S3Client } from '../s3/client.js'
import { computeDashboard, normalisedName, type InventoryItem } from './dashboard.js'
import { UsageLog, parseUsageLines, usageDay, type UsageEvent } from './events.js'
import { pushUsage } from './push.js'
import { FolderShardStore, S3ShardStore, VectorShardStore, parseShardName, shardSegment } from './store.js'

/**
 * The usage dashboard is believed - somebody deletes a skill because it says "unused" - so every
 * number it shows is pinned here from fixtures, and so is the plumbing that gets a team's events
 * into one place without one person's windows overwriting each other.
 */

const DAY = 86_400_000
const now = Date.UTC(2026, 9, 10, 12)
const ev = (u: string, k: 'skill' | 'tool', n: string, daysAgo: number, extra: Partial<UsageEvent> = {}): UsageEvent => ({
  t: now - daysAgo * DAY,
  u,
  k,
  n,
  ...extra,
})

const item = (kind: 'skill' | 'tool', name: string, extra: Partial<InventoryItem> = {}): InventoryItem => ({
  kind,
  name,
  filePath: `/skills/${name}.md`,
  deletable: true,
  location: 'this project',
  description: 'does a thing',
  ...extra,
})

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-usage-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('events', () => {
  it('skips a torn last line and anything not an event', () => {
    const text = `${JSON.stringify(ev('ann', 'skill', 'deploy', 0))}\n{"t":1}\n{"t":2,"u":"x","k":"skill","n":"y"}\n{"t":3,"u":`
    expect(parseUsageLines(text).map((event) => event.n)).toEqual(['deploy', 'y'])
  })

  it('names shard files so only real shards are read, and keeps a user name inside its folder', () => {
    expect(parseShardName('2026-10-10__abc123.jsonl')).toEqual({ day: '2026-10-10', instance: 'abc123' })
    expect(parseShardName('notes.txt')).toBeUndefined()
    expect(shardSegment('..\\evil/../x')).not.toMatch(/[\\/]/)
    expect(shardSegment('..')).not.toBe('..')
  })
})

describe('pushing to a shared folder', () => {
  it('writes one shard per person, day and install, idempotently, and two installs never overwrite each other', async () => {
    const store = new FolderShardStore(path.join(dir, 'team'))
    const first = new UsageLog(path.join(dir, 'a'))
    const second = new UsageLog(path.join(dir, 'b'))
    await first.append(ev('ann', 'skill', 'deploy', 1))
    await first.append(ev('ann', 'tool', 'read_file', 0))
    await second.append(ev('ann', 'skill', 'deploy', 0))

    expect(await pushUsage({ log: first, store, target: 'T', instance: 'aaa' })).toEqual({ pushedDays: 2, events: 2 })
    await pushUsage({ log: second, store, target: 'T', instance: 'bbb' })
    // Pushing again sends nothing new and changes nothing.
    expect((await pushUsage({ log: first, store, target: 'T', instance: 'aaa' })).events).toBe(0)

    const read = await store.read(usageDay(now - 5 * DAY), usageDay(now))
    expect(read).toHaveLength(3)
    expect(await fs.readdir(path.join(dir, 'team', 'ann'))).toHaveLength(3)
    // A range that excludes yesterday reads only today's shards.
    expect(await store.read(usageDay(now), usageDay(now))).toHaveLength(2)
  })

  it('starts again from the beginning when pointed at a different store', async () => {
    const log = new UsageLog(path.join(dir, 'a'))
    await log.append(ev('ann', 'skill', 'deploy', 0))
    await pushUsage({ log, store: new FolderShardStore(path.join(dir, 'one')), target: 'one', instance: 'i' })
    const other = new FolderShardStore(path.join(dir, 'two'))
    await pushUsage({ log, store: other, target: 'two', instance: 'i' })
    expect(await other.read('2000-01-01', '2100-01-01')).toHaveLength(1)
  })

  it('a missing folder reads as no events, not an error', async () => {
    expect(await new FolderShardStore(path.join(dir, 'nowhere')).read('2000-01-01', '2100-01-01')).toEqual([])
  })
})

describe('S3 and vector stores', () => {
  it('S3: keys under usage/, and only shards in range are fetched', async () => {
    const objects = new Map<string, Buffer>()
    const fake = {
      put: async (key: string, bytes: Uint8Array) => void objects.set(key, Buffer.from(bytes)),
      list: async (prefix: string) => [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, size: 1, lastModified: '' })),
      get: async (key: string) => objects.get(key)!,
    } as unknown as S3Client
    const store = new S3ShardStore(fake, 'bucket', 'team')
    await store.put({ user: 'ann', day: '2026-10-09', instance: 'x' }, [ev('ann', 'skill', 'a', 1)])
    await store.put({ user: 'bob', day: '2026-10-10', instance: 'y' }, [ev('bob', 'skill', 'b', 0)])
    expect([...objects.keys()]).toEqual(['team/usage/ann/2026-10-09__x.jsonl', 'team/usage/bob/2026-10-10__y.jsonl'])
    expect((await store.read('2026-10-10', '2026-10-10')).map((event) => event.n)).toEqual(['b'])
  })

  it('vector store: one document per shard with a token vector, read back by scanning', async () => {
    const saved = new Map<string, VectorDocument>()
    let ensured = 0
    const writer = {
      kind: 'qdrant',
      ensureCollection: async () => void ensured++,
      upsert: async (_c: string, docs: readonly VectorDocument[]) => docs.forEach((doc) => saved.set(doc.id, doc)),
      deleteByPaths: async () => undefined,
      listPaths: async () => [],
      scan: async () => ({ documents: [...saved.values()] }),
    } as VectorIndexWriter
    const store = new VectorShardStore(writer, 'usage', 'Local Qdrant')
    await store.put({ user: 'ann', day: '2026-10-10', instance: 'x' }, [ev('ann', 'skill', 'a', 0)])
    await store.put({ user: 'ann', day: '2026-10-10', instance: 'x' }, [ev('ann', 'skill', 'a', 0), ev('ann', 'skill', 'b', 0)])
    expect(ensured).toBe(1)
    expect(saved.size).toBe(1)
    expect([...saved.values()][0]!.vector).toHaveLength(2)
    expect(await store.read('2026-10-10', '2026-10-10')).toHaveLength(2)
  })
})

describe('the dashboard', () => {
  const events = [
    ev('ann', 'skill', 'deploy', 1, { a: 'bob' }),
    ev('ann', 'skill', 'deploy', 2, { a: 'bob' }),
    ev('cat', 'skill', 'deploy', 3, { a: 'bob' }),
    ev('cat', 'skill', 'review', 4),
    ev('ann', 'tool', 'py__fetch', 1, { ok: false, d: 200 }),
    ev('ann', 'tool', 'py__fetch', 1, { ok: false, d: 400 }),
    ev('ann', 'tool', 'py__fetch', 1, { d: 300 }),
    ev('cat', 'skill', 'colleague-only', 2),
    // The previous week.
    ev('ann', 'skill', 'deploy', 9, { a: 'bob' }),
  ]
  const inventory = [
    item('skill', 'deploy', { author: 'bob' }),
    item('skill', 'review', { author: 'ann' }),
    item('skill', 'old-notes', { author: 'ann', updated: '2024-01-01T00:00:00Z' }),
    item('skill', 'Old_Notes', { filePath: '/shared/Old_Notes.md', deletable: false, location: 'shared folder' }),
    item('tool', 'fetch', { filePath: '/tools/fetch.py', author: 'ann' }),
  ]
  const base = { events, inventory, me: 'ann', from: now - 7 * DAY, to: now }

  it('counts the team, compares with the previous period, and ranks', () => {
    const d = computeDashboard({ ...base, scope: 'team' })
    expect(d.totals.skillUses).toEqual({ value: 5, previous: 1 })
    expect(d.totals.people.value).toBe(2)
    expect(d.topSkills[0]).toMatchObject({ name: 'deploy', uses: 3, previous: 1, users: 2, author: 'bob', installed: true })
    expect(d.topTools[0]).toMatchObject({ label: 'fetch', uses: 3, failures: 2, averageMs: 300 })
  })

  it('"me" counts only the viewer, but contribution still counts everybody who used the work', () => {
    const d = computeDashboard({ ...base, scope: 'me' })
    expect(d.totals.skillUses.value).toBe(2)
    expect(d.people).toHaveLength(1)
    // ann wrote review (used by cat) and fetch (used by ann).
    expect(d.myImpact).toMatchObject({ skills: 2, tools: 1, usedByOthers: 1 })
    expect(d.contributors[0]?.author).toBe('ann')
    expect(d.contributors.find((person) => person.author === 'bob')).toMatchObject({ uses: 3, reached: 2 })
  })

  it('"unused" means unused by anybody, whatever the scope, and marks the stale', () => {
    const d = computeDashboard({ ...base, scope: 'me' })
    // review was used by cat, not by ann - so it is not unused.
    expect(d.unused.map((entry) => entry.name).sort()).toEqual(['Old_Notes', 'old-notes'])
    expect(d.unused.find((entry) => entry.name === 'old-notes')?.stale).toBe(true)
  })

  it('finds failing tools, near-duplicate names, and skills colleagues use that are not here', () => {
    const ids = computeDashboard({ ...base, scope: 'team' }).problems.map((problem) => problem.id)
    expect(ids).toContain('tool-failing')
    expect(ids).toContain('skill-similar-names')
    expect(ids).toContain('skill-not-here')
    expect(normalisedName('Deploy_App')).toBe(normalisedName('deploy-app'))
  })

  it('a bucket copy identical to the original is not a problem; the same name with different content is', () => {
    const same = [item('skill', 'deploy', { contentHash: 'h1' }), item('skill', 'deploy', { contentHash: 'h1', filePath: '/b/deploy.md', location: 'bucket' })]
    expect(computeDashboard({ ...base, inventory: same, scope: 'team' }).problems.map((problem) => problem.id)).not.toContain('skill-name-conflict')
    const differ = [item('skill', 'deploy', { contentHash: 'h1' }), item('skill', 'deploy', { contentHash: 'h2', filePath: '/b/deploy.md', location: 'bucket' })]
    expect(computeDashboard({ ...base, inventory: differ, scope: 'team' }).problems.map((problem) => problem.id)).toContain('skill-name-conflict')
    const renamed = [item('skill', 'deploy', { contentHash: 'h1' }), item('skill', 'ship-it', { contentHash: 'h1' })]
    expect(computeDashboard({ ...base, inventory: renamed, scope: 'team' }).problems.map((problem) => problem.id)).toContain('skill-duplicate-content')
  })

  it('buckets by hour for a day, by day for a week, by week for a year', () => {
    expect(computeDashboard({ ...base, from: now - DAY, scope: 'team' }).timeline.unit).toBe('hour')
    expect(computeDashboard({ ...base, scope: 'team' }).timeline.unit).toBe('day')
    const year = computeDashboard({ ...base, from: now - 365 * DAY, scope: 'team' })
    expect(year.timeline.unit).toBe('week')
    expect(year.timeline.buckets.reduce((sum, bucket) => sum + bucket.skills + bucket.tools, 0)).toBe(events.length)
  })
})
