import type { Schedule, ScheduleTrigger } from './types.js'

/**
 * When a schedule fires next.
 *
 * Pure and taking `now` as an argument, so every awkward case — a daily time that has already
 * passed, a weekly run on the same weekday, the gap after a long sleep — is a unit test rather
 * than something discovered a day later in production.
 *
 * ## Local time, deliberately
 *
 * "Daily at 08:00" means eight o'clock where the person is. Computing in UTC would drift by an
 * hour twice a year and produce a job that runs at seven all summer, which reads as a bug in
 * the scheduler rather than a timezone decision. `Date` does local arithmetic natively, so
 * this simply does not convert.
 */

const MINUTE = 60_000

/**
 * When a schedule should next fire, counting from `from`.
 *
 * **Takes an explicit `from` rather than reading the clock**, and that distinction is the whole
 * bug this file once had. The original signature took `now` and always returned a moment
 * strictly in the future — correct as an answer to "when next?", and useless as a due check,
 * because `nextFireTime(schedule, now) <= now` is then false by construction. Every schedule
 * silently never fired; only Run Now worked, because it skips the check.
 *
 * The fix is that a schedule *stores* its `nextRunAt`, computed once from the moment it was
 * saved or last ran, and the timer compares the clock against that stored value. `isDue` below
 * is the only thing that decides, and unlike the old expression it can be tested.
 */
export function nextFireTime(schedule: Pick<Schedule, 'trigger'>, from: number): number {
  const trigger = schedule.trigger
  if (trigger.kind === 'interval') return from + trigger.everyMinutes * MINUTE
  return nextClockTime(trigger, from)
}

/**
 * Whether the timer should run this schedule now.
 *
 * A schedule with no `nextRunAt` is not due — it has never been scheduled, and the bridge
 * fills that in rather than guessing here. Treating "unknown" as "due" would fire every
 * schedule the first time the extension loaded after an upgrade.
 */
export function isDue(schedule: Schedule, now: number): boolean {
  if (!schedule.enabled) return false
  if (schedule.nextRunAt === undefined) return false
  return now >= schedule.nextRunAt
}

function nextClockTime(trigger: Extract<ScheduleTrigger, { kind: 'daily' | 'weekly' }>, now: number): number {
  const candidate = new Date(now)
  candidate.setHours(trigger.hour, trigger.minute, 0, 0)

  const allowedDays = trigger.kind === 'weekly' ? new Set(trigger.days) : undefined

  /*
   * Walks forward a day at a time rather than computing an offset. Eight iterations at most,
   * and it is correct across month ends, leap years and daylight-saving transitions for free
   * because `Date` handles those — arithmetic on milliseconds does not.
   */
  for (let attempt = 0; attempt <= 8; attempt++) {
    const isFuture = candidate.getTime() > now
    const dayAllowed = allowedDays === undefined || allowedDays.has(candidate.getDay())
    if (isFuture && dayAllowed) return candidate.getTime()
    candidate.setDate(candidate.getDate() + 1)
    // Re-applied after the date change: crossing a daylight-saving boundary otherwise shifts
    // the time by an hour.
    candidate.setHours(trigger.hour, trigger.minute, 0, 0)
  }

  // Unreachable while `days` is non-empty, which the schema enforces.
  return now + 24 * 60 * MINUTE
}

/** A sentence for the UI. Worth stating plainly — a schedule nobody understands is not trusted. */
export function describeTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === 'interval') {
    if (trigger.everyMinutes % (60 * 24) === 0) {
      const days = trigger.everyMinutes / (60 * 24)
      return `Every ${days === 1 ? 'day' : `${String(days)} days`}`
    }
    if (trigger.everyMinutes % 60 === 0) {
      const hours = trigger.everyMinutes / 60
      return `Every ${hours === 1 ? 'hour' : `${String(hours)} hours`}`
    }
    return `Every ${String(trigger.everyMinutes)} minutes`
  }

  const clock = `${String(trigger.hour).padStart(2, '0')}:${String(trigger.minute).padStart(2, '0')}`
  if (trigger.kind === 'daily') return `Every day at ${clock}`

  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const chosen = [...trigger.days].sort((a, b) => a - b).map((day) => names[day] ?? '?')
  const weekdays = [1, 2, 3, 4, 5]
  const isWeekdays = chosen.length === 5 && weekdays.every((day) => trigger.days.includes(day))
  return `${isWeekdays ? 'Weekdays' : chosen.join(', ')} at ${clock}`
}

export function describeNextRun(schedule: Schedule, now: number): string {
  if (!schedule.enabled) return 'Paused'
  // The stored time, not a freshly computed one: the list must show when this schedule will
  // actually run, which is the same value the timer is waiting on.
  const next = schedule.nextRunAt ?? nextFireTime(schedule, now)
  const minutes = Math.round((next - now) / MINUTE)
  if (minutes < 1) return 'Due now'
  if (minutes < 60) return `In ${String(minutes)} min`
  if (minutes < 60 * 24) return `In ${String(Math.round(minutes / 60))} h`
  return new Date(next).toLocaleString()
}
