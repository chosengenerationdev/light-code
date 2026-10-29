/**
 * What an AutoSys job's definition says about *when* it runs, and the time values its web services
 * return - kept free of any client so every rule here is tested on its own.
 *
 * Asked for alongside "which jobs are running on this machine": questions an operator answers from
 * `autorep` and the JIL - what starts between 2 and 4am, what runs on Saturdays, what has been running
 * for over an hour. The server answers *what* each job is; deciding *when* is reading these fields.
 */

/** `PAY_*`, `*_EOD`, `host?1` as a case-insensitive test - the wildcard AutoSys people already type. */
export function wildcardMatches(pattern: string, value: string | undefined): boolean {
  if (value === undefined) return false
  const source = pattern
    .trim()
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${source}$`, 'i').test(value.trim())
}

/**
 * A time as AEWS returns it, as epoch milliseconds - or undefined when it is not a time at all.
 *
 * Seen shapes: epoch seconds or milliseconds, ISO 8601, and AutoSys's own `MM/DD/YYYY HH:MM:SS`
 * (autorep's format), read in this machine's time zone - the one the user reads the answer in. A value
 * of 0 or a placeholder like `-----` means "never" and is undefined.
 */
export function parseAutosysTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text.length === 0 || /^-+$/.test(text)) return undefined
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    if (n <= 0) return undefined
    return n < 1e11 ? n * 1000 : n
  }
  const autorep = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (autorep !== null) {
    const [, month, day, year, hour, minute, second] = autorep
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? '0')).getTime()
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

export const WEEKDAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** What a definition says about when it starts. */
export interface JobSchedule {
  /** Fixed start times, `HH:MM`, sorted. */
  times: string[]
  /** Minutes past every hour (`start_mins`), when it starts hourly. */
  minutesPastHour: number[]
  /** Days of the week it runs; undefined means every day (or not by weekday). */
  days?: Weekday[] | undefined
  runCalendar?: string | undefined
  excludeCalendar?: string | undefined
  runWindow?: string | undefined
  timezone?: string | undefined
}

function attribute(definition: Record<string, unknown>, snake: string): string | undefined {
  const camel = snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
  for (const key of [snake, camel]) {
    const value = definition[key]
    if (value === undefined || value === null || value === '') continue
    return Array.isArray(value) ? value.map(String).join(',') : String(value)
  }
  return undefined
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .replace(/"/g, '')
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * The start schedule in a definition, or undefined when it has none - a job started only by its
 * condition, or inside a box (which starts with the box).
 */
export function jobSchedule(definition: Record<string, unknown>): JobSchedule | undefined {
  const times = list(attribute(definition, 'start_times'))
    .map((time) => /^(\d{1,2}):(\d{2})$/.exec(time))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => `${(match[1] ?? '0').padStart(2, '0')}:${match[2] ?? '00'}`)
    .sort()
  const minutesPastHour = list(attribute(definition, 'start_mins'))
    .map(Number)
    .filter((minute) => Number.isInteger(minute) && minute >= 0 && minute < 60)
    .sort((a, b) => a - b)
  const runCalendar = attribute(definition, 'run_calendar')
  if (times.length === 0 && minutesPastHour.length === 0 && runCalendar === undefined) return undefined
  const dayWords = list(attribute(definition, 'days_of_week')).map((day) => day.toLowerCase().slice(0, 2))
  const days = dayWords.length === 0 || dayWords.includes('al') ? undefined : WEEKDAYS.filter((day) => dayWords.includes(day))
  return {
    times,
    minutesPastHour,
    ...(days !== undefined ? { days } : {}),
    ...(runCalendar !== undefined ? { runCalendar } : {}),
    ...(attribute(definition, 'exclude_calendar') !== undefined ? { excludeCalendar: attribute(definition, 'exclude_calendar') } : {}),
    ...(attribute(definition, 'run_window') !== undefined ? { runWindow: attribute(definition, 'run_window') } : {}),
    ...(attribute(definition, 'timezone') !== undefined ? { timezone: attribute(definition, 'timezone') } : {}),
  }
}

function minutesOf(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  return (hour ?? 0) * 60 + (minute ?? 0)
}

/**
 * The start times of a schedule that fall in `[from, to]` (`HH:MM`, inclusive; a window past midnight
 * such as 22:00-02:00 wraps), on `day` when given. Calendar-only schedules are not expanded here - the
 * caller names the calendar so it can be read - and so return no times.
 */
export function startsInWindow(schedule: JobSchedule, from: string, to: string, day?: Weekday): string[] {
  if (day !== undefined && schedule.days !== undefined && !schedule.days.includes(day)) return []
  const start = minutesOf(from)
  const end = minutesOf(to)
  const inWindow = (minute: number): boolean => (start <= end ? minute >= start && minute <= end : minute >= start || minute <= end)
  const hourly: string[] = []
  for (let hour = 0; hour < 24; hour++) {
    for (const minute of schedule.minutesPastHour) hourly.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
  }
  return [...new Set([...schedule.times, ...hourly])].filter((time) => inWindow(minutesOf(time))).sort()
}

/** "mo,tu,we" -> "Mon-Wed", for a line a person reads. */
export function describeDays(days: readonly Weekday[] | undefined): string {
  if (days === undefined) return 'every day'
  const names: Record<Weekday, string> = { su: 'Sun', mo: 'Mon', tu: 'Tue', we: 'Wed', th: 'Thu', fr: 'Fri', sa: 'Sat' }
  return days.map((day) => names[day]).join(', ')
}

/** A day the user named - a weekday word, today, tomorrow, or a date - as the weekday it falls on. */
export function weekdayOf(text: string, now = new Date()): Weekday | undefined {
  const word = text.trim().toLowerCase()
  if (word === 'today') return WEEKDAYS[now.getDay()]
  if (word === 'tomorrow') return WEEKDAYS[(now.getDay() + 1) % 7]
  const short = word.slice(0, 2) as Weekday
  if (WEEKDAYS.includes(short) && /^[a-z]+$/.test(word)) return short
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(word)
  if (date !== null) return WEEKDAYS[new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getDay()]
  return undefined
}

/** Every date-looking value in a calendar record, as YYYY-MM-DD, sorted and unique. */
export function calendarDates(records: readonly Record<string, unknown>[]): string[] {
  const found = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim()
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
      const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text)
      if (iso !== null) found.add(`${iso[1] ?? ''}-${iso[2] ?? ''}-${iso[3] ?? ''}`)
      else if (us !== null) found.add(`${us[3] ?? ''}-${(us[1] ?? '').padStart(2, '0')}-${(us[2] ?? '').padStart(2, '0')}`)
    } else if (Array.isArray(value)) value.forEach(visit)
    else if (value !== null && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(visit)
  }
  records.forEach(visit)
  return [...found].sort()
}
