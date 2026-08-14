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
 * Interval schedules count from the last run, not from a fixed epoch.
 *
 * The alternative — firing on wall-clock multiples — means a run that finishes late is
 * immediately due again, so a slow job that takes longer than its interval never rests. Basing
 * it on completion guarantees the gap the user asked for actually exists between runs.
 */
export function nextFireTime(schedule: Schedule, now: number): number {
  const trigger = schedule.trigger

  if (trigger.kind === 'interval') {
    const from = schedule.lastRunAt ?? now
    const next = from + trigger.everyMinutes * MINUTE
    /*
     * A schedule that was due while VS Code was closed fires once, shortly after startup,
     * rather than immediately or repeatedly. Immediately would mean every schedule firing at
     * once on a morning launch; repeatedly would mean catching up on a weekend's worth of
     * missed runs, which is never what anyone wants from a reminder.
     */
    return next <= now ? now + MINUTE : next
  }

  return nextClockTime(trigger, now)
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
  const next = nextFireTime(schedule, now)
  const minutes = Math.round((next - now) / MINUTE)
  if (minutes < 1) return 'Due now'
  if (minutes < 60) return `In ${String(minutes)} min`
  if (minutes < 60 * 24) return `In ${String(Math.round(minutes / 60))} h`
  return new Date(next).toLocaleString()
}
