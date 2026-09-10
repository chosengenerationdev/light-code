/**
 * The record kept for every indexed message, and what can be asked of it.
 *
 * ## Why facts live here rather than in the vector store
 *
 * The questions this exists to answer are mostly *temporal*, not semantic: "any alerts in the
 * last six hours", "does this one fire at the same time every day", "did the same thing arrive
 * last Tuesday". Embeddings answer "similar to this" and are actively bad at "between 02:00 and
 * 03:00 on the last four Tuesdays" — a nearest-neighbour search will return something
 * plausible, ranked, and wrong, with nothing to indicate it.
 *
 * So the split is deliberate: **the vector store holds meaning, this holds facts.** Received
 * time, folder, sender and the `[OK]`/`[ALERT]` tag are exact, are filtered on exactly, and
 * never go through an approximate nearest-neighbour lookup. A semantic query ranks candidates;
 * a temporal one is answered arithmetically and is either right or absent.
 *
 * The second reason is that it avoids inventing a filter language across three backends.
 * OpenSearch, Qdrant and Chroma all express range filters and all express them differently, and
 * §11 already names schema translation as a silent-failure source. Nothing here needs
 * translating.
 *
 * The file is a sidecar and is entirely rebuildable from Outlook, so losing it costs a reindex
 * rather than data.
 */

/** What the subject line declares about the message, for a mailbox that uses the convention. */
export type MailStatus = 'ok' | 'alert'

export interface MailRecord {
  /** Outlook's own `EntryID`. Stable for the life of the message, and how it is reopened. */
  id: string
  subject: string
  sender: string
  /** Epoch milliseconds. The single most important field here. */
  receivedAt: number
  /** Folder path as Outlook spells it, e.g. `mailbox@example.com\Inbox\Alerts`. */
  folder: string
  /** From the subject convention, when there is one. */
  status?: MailStatus
  /** First part of the body, for showing a hit without reopening Outlook. */
  preview: string
}

/**
 * Reads `[OK]` / `[ALERT]` out of a subject line.
 *
 * Written for the convention the user described — a tag in brackets at the front — but matched
 * anywhere in the subject, because "Re: [ALERT] disk full" is the same alert and a reply about
 * one is exactly what someone searching for alerts wants to find.
 *
 * Deliberately narrow. It recognises the two words asked for and nothing else: guessing that
 * `[WARN]` or `[CRITICAL]` means alert would silently reclassify a mailbox nobody described, and
 * an unrecognised tag is better left as *no status* than as a wrong one. Untagged mail is
 * searchable by every other means.
 */
export function parseStatusTag(subject: string): MailStatus | undefined {
  if (/\[\s*alert\s*\]/i.test(subject)) return 'alert'
  if (/\[\s*ok\s*\]/i.test(subject)) return 'ok'
  return undefined
}

/**
 * A subject stripped of the parts that change every time it is sent.
 *
 * Two nightly failures are "the same alert" even though one says 03:14 and the other 03:16, and
 * grouping them is the whole of "does this happen every day". So numbers, dates, times, ids and
 * reply prefixes come out, and what is left is the shape of the message.
 *
 * The risk is over-normalising two genuinely different alerts into one, which is why nothing
 * here removes *words*. `Disk 90% on host A` and `Disk 90% on host B` stay distinct.
 */
export function normaliseSubject(subject: string): string {
  return subject
    .replace(/^\s*(re|fw|fwd)\s*:\s*/gi, '')
    .replace(/\[\s*(alert|ok)\s*\]/gi, '')
    // Timestamps first, before their digits are eaten by the generic number rule.
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '')
    .replace(/\b[0-9a-f]{8,}\b/gi, '')
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Minutes past local midnight, which is the axis "same time every day" is measured on. */
export function minutesIntoDay(at: number): number {
  const when = new Date(at)
  return when.getHours() * 60 + when.getMinutes()
}

export interface RecurrencePattern {
  /** The normalised subject shared by the group. */
  shape: string
  /** One real subject, so the answer is readable rather than a stripped skeleton. */
  example: string
  occurrences: number
  /** Median minutes past midnight, reported as `HH:MM`. */
  typicalTime: string
  /** How far occurrences stray from that time, in minutes. Small means "same time every day". */
  spreadMinutes: number
  /** Distinct calendar days it appeared on. */
  days: number
  /** Epoch ms of the most recent one. */
  lastSeen: number
  status?: MailStatus
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length === 0) return 0
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0)
}

function formatMinutes(total: number): string {
  const rounded = Math.round(total)
  const hours = Math.floor(rounded / 60) % 24
  const minutes = rounded % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/**
 * Groups messages by what they are, and reports when they tend to arrive.
 *
 * This is the "does this alert happen every day around the same time" question, answered by
 * counting rather than by asking a model to eyeball a list. The **spread** is the part that
 * carries the meaning: a median alone would claim a pattern for something that arrives at 03:00
 * one day and 15:00 the next, and the whole point is to tell those apart.
 *
 * Median rather than mean, because one alert at midnight in a run of nine at 03:00 should not
 * drag the answer to 02:40 — which is a time nothing ever happened.
 */
export function findRecurrence(
  records: readonly MailRecord[],
  options: { minimumOccurrences?: number } = {},
): RecurrencePattern[] {
  const minimum = options.minimumOccurrences ?? 2
  const groups = new Map<string, MailRecord[]>()

  for (const record of records) {
    const shape = normaliseSubject(record.subject)
    if (shape.length === 0) continue
    const existing = groups.get(shape)
    if (existing === undefined) groups.set(shape, [record])
    else existing.push(record)
  }

  const patterns: RecurrencePattern[] = []
  for (const [shape, group] of groups) {
    if (group.length < minimum) continue
    const times = group.map((record) => minutesIntoDay(record.receivedAt))
    const typical = median(times)
    /*
     * Distance is measured around the clock. Without this, 23:58 and 00:02 look 1436 minutes
     * apart rather than four, and a job that runs at midnight would be reported as having no
     * pattern at all.
     */
    const spread = median(times.map((value) => Math.min(Math.abs(value - typical), 1440 - Math.abs(value - typical))))
    const days = new Set(group.map((record) => new Date(record.receivedAt).toDateString())).size
    const newest = group.reduce((best, record) => (record.receivedAt > best.receivedAt ? record : best), group[0] as MailRecord)

    patterns.push({
      shape,
      example: newest.subject,
      occurrences: group.length,
      typicalTime: formatMinutes(typical),
      spreadMinutes: Math.round(spread),
      days,
      lastSeen: newest.receivedAt,
      ...(newest.status !== undefined ? { status: newest.status } : {}),
    })
  }

  return patterns.sort((a, b) => b.occurrences - a.occurrences)
}

/**
 * The occurrences of one shape that landed near a given moment on earlier days.
 *
 * This is "was a similar alert sent last week, same day, around the same time" — asked directly
 * rather than left to a model comparing timestamps by eye, which it does badly.
 *
 * `sameWeekdayOnly` exists because "last week same day" and "yesterday at this time" are
 * different questions and a batch job frequently only runs on weekdays.
 */
export function findNearAnniversaries(
  records: readonly MailRecord[],
  reference: MailRecord,
  options: { withinMinutes?: number; sameWeekdayOnly?: boolean; lookbackDays?: number } = {},
): MailRecord[] {
  const tolerance = options.withinMinutes ?? 45
  const shape = normaliseSubject(reference.subject)
  const referenceMinute = minutesIntoDay(reference.receivedAt)
  const referenceWeekday = new Date(reference.receivedAt).getDay()
  const earliest =
    options.lookbackDays === undefined ? 0 : reference.receivedAt - options.lookbackDays * 24 * 60 * 60 * 1000

  return records
    .filter((record) => record.id !== reference.id)
    .filter((record) => record.receivedAt >= earliest && record.receivedAt <= reference.receivedAt)
    .filter((record) => normaliseSubject(record.subject) === shape)
    .filter((record) => options.sameWeekdayOnly !== true || new Date(record.receivedAt).getDay() === referenceWeekday)
    .filter((record) => {
      const distance = Math.abs(minutesIntoDay(record.receivedAt) - referenceMinute)
      return Math.min(distance, 1440 - distance) <= tolerance
    })
    .sort((a, b) => b.receivedAt - a.receivedAt)
}

/** Everything received in the last `hours`, newest first. */
export function since(records: readonly MailRecord[], hours: number, now = Date.now()): MailRecord[] {
  const earliest = now - hours * 60 * 60 * 1000
  return records.filter((record) => record.receivedAt >= earliest).sort((a, b) => b.receivedAt - a.receivedAt)
}

/**
 * The same clock time, `months` calendar months earlier, clamped to a real date.
 *
 * `setMonth(getMonth() - 6)` is the obvious way and it is wrong at a month boundary: 31 March
 * minus six months gives **1 October**, because 31 September does not exist and JavaScript
 * silently rolls forward rather than clamping. Measured, not assumed — and for retention it
 * errs in the worse direction, deleting a day more than asked.
 *
 * The day is therefore clamped to the last of the target month, which is what "six months ago"
 * means to a person.
 */
export function monthsBefore(now: number, months: number): number {
  const from = new Date(now)
  const target = new Date(now)
  target.setDate(1)
  target.setMonth(target.getMonth() - months)

  const lastDayOfTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(from.getDate(), lastDayOfTarget))
  return target.getTime()
}

/**
 * Drops anything older than the cutoff.
 *
 * Returned rather than mutated so the caller decides when it reaches disk — pruning is
 * destructive and the count is worth showing before it does.
 */
export function pruneOlderThan(
  records: readonly MailRecord[],
  months: number,
  now = Date.now(),
): { kept: MailRecord[]; removed: MailRecord[] } {
  const boundary = monthsBefore(now, months)

  const kept: MailRecord[] = []
  const removed: MailRecord[] = []
  for (const record of records) {
    if (record.receivedAt >= boundary) kept.push(record)
    else removed.push(record)
  }
  return { kept, removed }
}
