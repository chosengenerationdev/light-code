import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { backfillOnce } from './backfill.js'
import { UsageLog, usageDay, type UsageEvent } from './events.js'
import { pushUsage } from './push.js'
import { FolderShardStore, type UsageShard, type UsageShardStore } from './store.js'

/**
 * Several sessions on one storage folder - VS Code windows share one - must never lose, duplicate or
 * half-write an event. These tests run the sessions against each other for real (same folder, same
 * moment) rather than reasoning about it, including the interleaving that defeats a time-based mark:
 * a pusher that read the files a moment before another session's event landed, writing last.
 */

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-usage-race-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const now = Date.now()
const ev = (n: string, offset = 0): UsageEvent => ({ t: now - offset, u: 'ann', k: 'tool', n })
const keyOf = (event: UsageEvent): string => `${String(event.t)}:${event.n}`

describe('several sessions on one storage folder', () => {
  it('interleaved appends and simultaneous pushes leave every event in the store exactly once', async () => {
    const storage = path.join(dir, 'storage')
    const store = new FolderShardStore(path.join(dir, 'team'))
    const sessions = [new UsageLog(storage, 'one'), new UsageLog(storage, 'two'), new UsageLog(storage, 'three')]
    const written: UsageEvent[] = []
    await Promise.all(
      sessions.map(async (log, index) => {
        for (let i = 0; i < 60; i++) {
          const event = ev(`s${String(index)}-${String(i)}`, i * 3)
          written.push(event)
          await log.append(event)
          // Push while the others are still writing.
          if (i % 15 === 0) await pushUsage({ log, store, target: 'T', instance: 'inst' })
        }
      }),
    )
    // Everybody pushes once more at the same moment.
    await Promise.all(sessions.map((log) => pushUsage({ log, store, target: 'T', instance: 'inst' })))
    const read = await store.read('2000-01-01', '2100-01-01')
    expect(read.map(keyOf).sort()).toEqual(written.map(keyOf).sort())
  })

  it('a pusher that read too early and wrote last goes round again and leaves the day complete', async () => {
    const storage = path.join(dir, 'storage')
    const real = new FolderShardStore(path.join(dir, 'team'))
    const early = new UsageLog(storage, 'early')
    const other = new UsageLog(storage, 'other')
    await early.append(ev('first'))
    let held: (() => void) | undefined
    let firstPut = true
    // The early session's first write is held until the other session has appended and pushed.
    const slow: UsageShardStore = {
      label: 'slow',
      put: async (shard: UsageShard, events) => {
        if (firstPut) {
          firstPut = false
          await new Promise<void>((resolve) => (held = resolve))
        }
        await real.put(shard, events)
      },
      read: (a, b) => real.read(a, b),
      putProfile: (u, p) => real.putProfile(u, p),
      readProfiles: () => real.readProfiles(),
      listOwn: (i) => real.listOwn(i),
      readShard: (x) => real.readShard(x),
      putMonth: (a, b) => real.putMonth(a, b),
      removeShard: (x) => real.removeShard(x),
    }
    const earlyPush = pushUsage({ log: early, store: slow, target: 'T', instance: 'inst' })
    while (held === undefined) await new Promise((resolve) => setTimeout(resolve, 5))
    await other.append(ev('second'))
    await pushUsage({ log: other, store: real, target: 'T', instance: 'inst' })
    expect((await real.read('2000-01-01', '2100-01-01')).map((event) => event.n).sort()).toEqual(['first', 'second'])
    // Now the stale write lands - with only "first" - and must be followed by a complete one.
    held()
    await earlyPush
    expect((await real.read('2000-01-01', '2100-01-01')).map((event) => event.n).sort()).toEqual(['first', 'second'])
  })

  it('clean-up removes only old days that were pushed as they are, and never a file being written', async () => {
    const storage = path.join(dir, 'storage')
    const log = new UsageLog(storage, 'one')
    const store = new FolderShardStore(path.join(dir, 'team'))
    await log.append(ev('old-pushed', 30 * 86_400_000))
    await log.append(ev('today'))
    await pushUsage({ log, store, target: 'T', instance: 'i' })
    // An old day that changed after its push is kept until it is pushed again.
    const later = new UsageLog(storage, 'two')
    await later.append(ev('old-late', 31 * 86_400_000))
    expect(await log.prune('T', 14)).toBe(1)
    const left = (await fs.readdir(log.queueDir)).sort()
    expect(left.some((name) => name.startsWith(usageDay(now)))).toBe(true)
    expect(left.some((name) => name.startsWith(usageDay(now - 31 * 86_400_000)))).toBe(true)
    expect(left.some((name) => name.startsWith(usageDay(now - 30 * 86_400_000)))).toBe(false)
    // A different store has had nothing pushed, so nothing old is deleted on its account.
    expect(await log.prune('other-store', 14)).toBe(0)
  })

  it('two sessions importing past conversations at once leave one copy, with one cut-off', async () => {
    const storage = path.join(dir, 'storage')
    const usageDir = path.join(storage, 'usage')
    const cutOffs: number[] = []
    const run = async (before: number) => {
      cutOffs.push(before)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { events: [ev('from-history', 86_400_000), ev('also-history', 2 * 86_400_000)], tasks: 2, unreadable: 0, via: 'node' as const }
    }
    let clock = now
    const sessions = [new UsageLog(storage, 'one'), new UsageLog(storage, 'two'), new UsageLog(storage, 'three')]
    await Promise.all(sessions.map((log) => backfillOnce({ usageDir, log, run, now: () => clock++ })))
    expect(new Set(cutOffs).size).toBe(1)
    const all = await sessions[0]!.all()
    expect(all.map((event) => event.n).sort()).toEqual(['also-history', 'from-history'])
    // Done is recorded: a later session does not import again.
    expect((await backfillOnce({ usageDir, log: sessions[0]!, run })).ran).toBe(false)
  })

  it('moves an older single queue file into per-day files once, even when two sessions do it together', async () => {
    const storage = path.join(dir, 'storage')
    await fs.mkdir(storage, { recursive: true })
    await fs.writeFile(path.join(storage, 'usage-events.jsonl'), [ev('a'), ev('b', 86_400_000)].map((event) => JSON.stringify(event)).join('\n') + '\n')
    const one = new UsageLog(storage, 'one')
    const two = new UsageLog(storage, 'two')
    await Promise.all([one.migrateLegacy(), two.migrateLegacy()])
    expect((await one.all()).map((event) => event.n).sort()).toEqual(['a', 'b'])
    await expect(fs.stat(path.join(storage, 'usage-events.jsonl'))).rejects.toThrow()
  })
})

describe('repairs', () => {
  it('a day still changing after every round is left marked as not pushed, for the next pusher', async () => {
    const storage = path.join(dir, 'storage')
    const log = new UsageLog(storage, 'one')
    const busy = new UsageLog(storage, 'busy')
    await log.append(ev('a'))
    const real = new FolderShardStore(path.join(dir, 'team'))
    let n = 0
    // Every write races with another append, for ever.
    const racing: UsageShardStore = { ...real, label: 'racing', put: async (shard, events) => { await real.put(shard, events); await busy.append(ev(`b${String(n++)}`)) }, read: (a, b) => real.read(a, b), putProfile: (u, p) => real.putProfile(u, p), readProfiles: () => real.readProfiles(), listOwn: (i) => real.listOwn(i), readShard: (x) => real.readShard(x), putMonth: (a, b) => real.putMonth(a, b), removeShard: (x) => real.removeShard(x) }
    await pushUsage({ log, store: racing, target: 'T', instance: 'i', maxRounds: 3 })
    expect((await log.pushed('T'))[usageDay(now)]).toBe('')
    await pushUsage({ log, store: real, target: 'T', instance: 'i' })
    expect((await real.read('2000-01-01', '2100-01-01')).length).toBe(1 + n)
  })

  it('a recheck re-writes a day the record calls pushed - repairing a write nobody checked', async () => {
    const storage = path.join(dir, 'storage')
    const log = new UsageLog(storage, 'one')
    const store = new FolderShardStore(path.join(dir, 'team'))
    await log.append(ev('a'))
    await log.append(ev('b'))
    await pushUsage({ log, store, target: 'T', instance: 'i' })
    // A stale write lands and its session stops before checking.
    await store.put({ user: 'ann', day: usageDay(now), instance: 'i' }, [ev('a')])
    await pushUsage({ log, store, target: 'T', instance: 'i' })
    expect(await store.read('2000-01-01', '2100-01-01')).toHaveLength(1)
    await pushUsage({ log, store, target: 'T', instance: 'i', recheck: [usageDay(now)] })
    expect(await store.read('2000-01-01', '2100-01-01')).toHaveLength(2)
  })
})
