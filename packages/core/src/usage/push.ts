import { usageDay, type UsageEvent, type UsageLog } from './events.js'
import type { UsageShardStore } from './store.js'

/**
 * Sends every day whose local files changed since they were last pushed to this store.
 *
 * **Correct with any number of sessions pushing at once, with no lock**, because a shard is a pure
 * function of the day's local files and every pusher checks its own work:
 *
 * 1. It reads the day's files, remembering their signature (names and sizes), and writes the shard.
 * 2. It reads the signature again. If the day changed meanwhile - an event landed, or another session
 *    is pushing - it goes round again with the new contents.
 * 3. Only a push that saw the same day before and after its write records the day as pushed.
 *
 * So the *last* write to a shard is always followed by a check that it was complete: a session that
 * wrote an older version of a day (because it read the files before another session's event landed)
 * sees the change in step 2 and writes the newer one. Any event appended after a successful check is
 * by a session that schedules its own push. Writing a shard twice changes nothing, so going round
 * again is always safe.
 */
export async function pushUsage(options: {
  log: UsageLog
  store: UsageShardStore
  /** Names the store; a different store has had nothing pushed. */
  target: string
  instance: string
  /** Bounds the rounds a day can go while other sessions keep writing to it. */
  maxRounds?: number
  /**
   * Days to write whatever the record says - a session's first push passes the last two, so a write
   * left half-checked by a session that stopped (a closed window between writing and checking) is
   * repaired the next time anything starts.
   */
  recheck?: readonly string[]
}): Promise<{ pushedDays: number; events: number }> {
  const pushedDays = new Set<string>()
  /*
   * Days this pusher wrote while they were changing. Written again whatever the record says: another
   * session may have recorded the day as pushed *before* this write landed over theirs with less in it,
   * so the record alone would leave the store holding the older version.
   */
  const again = new Set<string>(options.recheck ?? [])
  let events = 0
  const rolled = await options.log.rolledMonths(options.target)
  for (let round = 0; round < (options.maxRounds ?? 5); round++) {
    const days = await options.log.days()
    const pushed = await options.log.pushed(options.target)
    const dirty = [...days.entries()].filter(([day, entry]) => again.has(day) || pushed[day] !== entry.signature).map(([day]) => day).sort()
    if (dirty.length === 0) break
    for (const day of dirty) {
      const before = await options.log.daySignature(day)
      const ofDay = await options.log.readDay(day)
      // One shard per person and day: a queue that holds two identities (an owner renamed mid-day)
      // writes each under its own name rather than filing one person's events under the other.
      const byUser = new Map<string, UsageEvent[]>()
      for (const event of ofDay) byUser.set(event.u, [...(byUser.get(event.u) ?? []), event])
      const month = day.slice(0, 7)
      for (const [user, userEvents] of byUser) {
        if (rolled.has(month)) {
          // A late day of a month already rolled up: it replaces that day inside the month shard, which is
          // what readers use - a day shard there would be skipped (`selectShards`).
          const shard = { user, month, instance: options.instance }
          const kept = ((await options.store.readShard(shard)) ?? []).filter((event) => usageDay(event.t) !== day)
          await options.store.putMonth(shard, [...kept, ...userEvents].sort((a, b) => a.t - b.t))
        } else {
          await options.store.put({ user, day, instance: options.instance }, userEvents)
        }
      }
      const after = await options.log.daySignature(day)
      if (after === before) {
        await options.log.markPushed(options.target, day, after)
        again.delete(day)
        pushedDays.add(day)
        events += ofDay.length
      } else {
        // The day changed under us: the next round writes it again, with everything.
        again.add(day)
      }
    }
  }
  /*
   * Still changing after every round: recorded as not pushed, so the next push by any session writes it
   * again rather than trusting a record another session made before this pusher's last write landed.
   */
  for (const day of again) await options.log.markPushed(options.target, day, '')
  return { pushedDays: pushedDays.size, events }
}
