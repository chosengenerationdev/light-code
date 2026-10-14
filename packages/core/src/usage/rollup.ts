import { usageDay, type UsageEvent, type UsageLog } from './events.js'
import type { ListedShard, UsageShardStore } from './store.js'

/**
 * The monthly roll-up: once a month is over, this install's day shards for it become one month shard
 * per person, and the day shards are deleted - so a year is a dozen files per person and install instead
 * of a few hundred, and a store that lists or scans stays fast (asked for after seeing the numbers; the
 * user approved deleting, which the shared stores otherwise never do on their own).
 *
 * **Only this install's own shards**, named by its instance id - never a colleague's. And never a loss,
 * by construction:
 *
 * - A month is rolled only when it ended `graceDays` ago **and** this install's local queue has nothing
 *   unsent for it, so no day of it is still on its way.
 * - The month shard is written, **read back and counted** before a single day shard is deleted. A month
 *   that does not read back complete is left as it was, and tried again next time.
 * - Readers skip a person's and install's day shards for a month once its month shard exists
 *   (`selectShards`), so the moment between writing the month and deleting the days counts nothing twice,
 *   and a roll-up that stopped half-way leaves nothing counted twice either.
 * - Day shards are the truth for their own days: a month shard's events for a day that still has a day
 *   shard are replaced by that day shard's, so repeating a roll-up - or two sessions doing it at once -
 *   writes the same month.
 *
 * A day pushed *after* its month was rolled (a laptop offline for weeks) goes into the month shard
 * (`pushUsage`, `rolledMonths`) rather than a day shard nobody would read.
 */
export async function rollUpMonths(options: {
  log: UsageLog
  store: UsageShardStore
  target: string
  instance: string
  now?: number
  graceDays?: number
}): Promise<{ months: number; removed: number; problems: string[] }> {
  const now = options.now ?? Date.now()
  const grace = (options.graceDays ?? 3) * 86_400_000
  const currentMonth = usageDay(now).slice(0, 7)
  const monthEnd = (month: string): number => {
    const [year, number] = month.split('-').map(Number) as [number, number]
    return Date.UTC(year, number, 1)
  }
  const eligible = (month: string): boolean => month < currentMonth && now >= monthEnd(month) + grace

  // Months with anything unsent locally are not ready: one of their days is still on its way.
  const pushed = await options.log.pushed(options.target)
  const blocked = new Set<string>()
  for (const [day, entry] of await options.log.days()) if (pushed[day] !== entry.signature) blocked.add(day.slice(0, 7))

  const groups = new Map<string, { user: string; month: string; days: ListedShard[]; monthShard?: ListedShard }>()
  for (const shard of await options.store.listOwn(options.instance)) {
    const month = shard.month ?? shard.day?.slice(0, 7)
    if (month === undefined) continue
    const key = `${shard.user}|${month}`
    const group = groups.get(key) ?? { user: shard.user, month, days: [] }
    if (shard.month !== undefined) group.monthShard = shard
    else group.days.push(shard)
    groups.set(key, group)
  }

  let months = 0
  let removed = 0
  const problems: string[] = []
  for (const group of groups.values()) {
    if (group.monthShard !== undefined) await options.log.markRolled(options.target, group.month)
    if (group.days.length === 0 || !eligible(group.month) || blocked.has(group.month)) continue
    const monthShard = { user: group.user, month: group.month, instance: options.instance }
    /*
     * The days first, then the month - the order is what makes two sessions rolling up at once safe.
     * A day shard is only ever deleted *after* a month containing it was written, so a day found gone here
     * is in the month read afterwards; reading the month first could see it empty, find the days already
     * deleted by the other session, and write an empty month over a good one (found by a test).
     */
    const covered = new Set<string>()
    const fromDays: UsageEvent[] = []
    for (const shard of group.days) {
      const events = await options.store.readShard(shard)
      if (events === undefined) continue
      covered.add(shard.day!)
      fromDays.push(...events)
    }
    const existing = (await options.store.readShard(monthShard)) ?? []
    const merged = [...existing.filter((event) => !covered.has(usageDay(event.t))), ...fromDays].sort((a, b) => a.t - b.t)
    await options.store.putMonth(monthShard, merged)
    const back = await options.store.readShard(monthShard)
    if (back === undefined || back.length !== merged.length) {
      problems.push(`${group.user} ${group.month}: the month read back with ${String(back?.length ?? 0)} of ${String(merged.length)} events, so its days were kept.`)
      continue
    }
    await options.log.markRolled(options.target, group.month)
    for (const shard of group.days) {
      await options.store.removeShard(shard)
      removed++
    }
    months++
  }
  return { months, removed, problems }
}
