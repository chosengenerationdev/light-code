import { describe, expect, it } from 'vitest'

import {
  findNearAnniversaries,
  findRecurrence,
  minutesIntoDay,
  monthsBefore,
  normaliseSubject,
  parseStatusTag,
  pruneOlderThan,
  since,
  type MailRecord,
} from './mailIndex.js'

/**
 * The arithmetic behind "any alerts in the last N hours" and "does this happen every day".
 *
 * These are the questions the user described, and they are *temporal* rather than semantic.
 * Embeddings answer "similar to this"; asked "between 02:00 and 03:00 on the last four
 * Tuesdays" they return something plausible, ranked, and wrong, with nothing to say so. So the
 * facts are kept exactly and answered by counting.
 */

let counter = 0
function mail(subject: string, at: string, extra: Partial<MailRecord> = {}): MailRecord {
  counter += 1
  const status = parseStatusTag(subject)
  return {
    id: `id-${String(counter)}`,
    subject,
    sender: 'monitoring@example.invalid',
    receivedAt: new Date(at).getTime(),
    folder: 'Inbox/Alerts',
    preview: '',
    ...(status !== undefined ? { status } : {}),
    ...extra,
  }
}

describe('reading the status out of a subject', () => {
  it('recognises the two tags the convention uses', () => {
    expect(parseStatusTag('[ALERT] disk full')).toBe('alert')
    expect(parseStatusTag('[OK] nightly load finished')).toBe('ok')
  })

  it('is case and space insensitive, because senders are not consistent', () => {
    expect(parseStatusTag('[ alert ] x')).toBe('alert')
    expect(parseStatusTag('[Ok] x')).toBe('ok')
  })

  /** A reply about an alert is exactly what someone searching for alerts wants to find. */
  it('finds a tag that is not at the front', () => {
    expect(parseStatusTag('Re: [ALERT] disk full')).toBe('alert')
  })

  /**
   * Deliberately narrow. Guessing that `[WARN]` means alert would silently reclassify a mailbox
   * nobody described, and no status is a better answer than a wrong one.
   */
  it('does not guess at tags it was not told about', () => {
    expect(parseStatusTag('[WARN] disk at 80%')).toBeUndefined()
    expect(parseStatusTag('[CRITICAL] everything is on fire')).toBeUndefined()
    expect(parseStatusTag('nightly load finished')).toBeUndefined()
  })
})

describe('reducing a subject to its shape', () => {
  it('strips the parts that change on every send', () => {
    expect(normaliseSubject('[ALERT] Job 4471 failed at 03:14 on 2026-09-08')).toBe('job failed at on')
  })

  it('treats a reply as the same shape', () => {
    expect(normaliseSubject('Re: [ALERT] disk full')).toBe(normaliseSubject('[ALERT] disk full'))
  })

  /** Nothing removes words, so two genuinely different alerts stay different. */
  it('keeps two different hosts apart', () => {
    expect(normaliseSubject('Disk 90% on host A')).not.toBe(normaliseSubject('Disk 90% on host B'))
  })
})

describe('does this happen every day, around the same time', () => {
  it('groups the same alert and reports when it tends to arrive', () => {
    const records = [
      mail('[ALERT] Job 1 failed at 03:01', '2026-09-05T03:01:00'),
      mail('[ALERT] Job 2 failed at 03:04', '2026-09-06T03:04:00'),
      mail('[ALERT] Job 3 failed at 02:58', '2026-09-07T02:58:00'),
    ]
    const [pattern] = findRecurrence(records)

    expect(pattern?.occurrences).toBe(3)
    expect(pattern?.days).toBe(3)
    expect(pattern?.typicalTime).toBe('03:01')
    expect(pattern?.spreadMinutes).toBeLessThanOrEqual(3)
  })

  /**
   * The spread is what carries the meaning. A median alone would claim a pattern for something
   * arriving at 03:00 one day and 15:00 the next, and telling those apart is the whole point.
   */
  it('reports a wide spread when there is no pattern', () => {
    const records = [
      mail('[ALERT] Job 1 failed', '2026-09-05T03:00:00'),
      mail('[ALERT] Job 2 failed', '2026-09-06T15:00:00'),
      mail('[ALERT] Job 3 failed', '2026-09-07T09:00:00'),
    ]
    const [pattern] = findRecurrence(records)

    expect(pattern?.spreadMinutes).toBeGreaterThan(120)
  })

  /**
   * Around the clock. Without this, 23:58 and 00:02 look 1436 minutes apart rather than four,
   * and a job that runs at midnight is reported as having no pattern at all.
   */
  it('handles a job that runs at midnight', () => {
    // The same subject each time: normalisation strips numbers, never words, so `A` and `B`
    // would be two different alerts — which is the behaviour wanted, and was a fault in the
    // first version of this fixture rather than in the code.
    const records = [
      mail('[ALERT] Nightly load failed', '2026-09-05T23:58:00'),
      mail('[ALERT] Nightly load failed', '2026-09-07T00:02:00'),
      mail('[ALERT] Nightly load failed', '2026-09-08T00:01:00'),
    ]
    const [pattern] = findRecurrence(records)

    expect(pattern?.spreadMinutes).toBeLessThanOrEqual(5)
  })

  it('ignores a subject that happened only once', () => {
    const records = [mail('[ALERT] one-off', '2026-09-05T03:00:00')]
    expect(findRecurrence(records)).toEqual([])
  })

  /** A stripped skeleton is unreadable, so a real subject is carried through. */
  it('reports a readable example rather than the shape', () => {
    const records = [
      mail('[ALERT] Job 1 failed at 03:01', '2026-09-05T03:01:00'),
      mail('[ALERT] Job 2 failed at 03:04', '2026-09-06T03:04:00'),
    ]
    expect(findRecurrence(records)[0]?.example).toContain('Job')
  })
})

describe('was a similar one sent last week, same day, same time', () => {
  const reference = mail('[ALERT] Payment sync failed', '2026-09-08T03:05:00')

  it('finds the one from the same weekday a week earlier', () => {
    const older = mail('[ALERT] Payment sync failed', '2026-09-01T03:12:00')
    const found = findNearAnniversaries([older, reference], reference, { sameWeekdayOnly: true })

    expect(found.map((entry) => entry.id)).toEqual([older.id])
  })

  it('rejects one at the same time on a different weekday', () => {
    const other = mail('[ALERT] Payment sync failed', '2026-09-02T03:10:00')
    const found = findNearAnniversaries([other, reference], reference, { sameWeekdayOnly: true })

    expect(found).toEqual([])
  })

  it('rejects one on the right day at the wrong time', () => {
    const other = mail('[ALERT] Payment sync failed', '2026-09-01T17:00:00')
    const found = findNearAnniversaries([other, reference], reference, { sameWeekdayOnly: true })

    expect(found).toEqual([])
  })

  it('does not report the reference message as its own precedent', () => {
    expect(findNearAnniversaries([reference], reference)).toEqual([])
  })

  it('never looks forward in time', () => {
    const later = mail('[ALERT] Payment sync failed', '2026-09-15T03:05:00')
    expect(findNearAnniversaries([later, reference], reference)).toEqual([])
  })
})

describe('the last N hours', () => {
  it('returns what arrived inside the window, newest first', () => {
    const now = new Date('2026-09-08T12:00:00').getTime()
    const records = [
      mail('[ALERT] old', '2026-09-08T02:00:00'),
      mail('[ALERT] recent', '2026-09-08T11:00:00'),
      mail('[OK] middling', '2026-09-08T08:00:00'),
    ]
    const found = since(records, 6, now)

    expect(found.map((entry) => entry.subject)).toEqual(['[ALERT] recent', '[OK] middling'])
  })
})

describe('keeping the index from growing without bound', () => {
  it('separates what is kept from what goes, rather than deleting in place', () => {
    const now = new Date('2026-09-08T12:00:00').getTime()
    const records = [
      mail('[OK] ancient', '2025-01-01T00:00:00'),
      mail('[OK] recent', '2026-08-01T00:00:00'),
    ]
    const { kept, removed } = pruneOlderThan(records, 6, now)

    expect(kept.map((entry) => entry.subject)).toEqual(['[OK] recent'])
    expect(removed.map((entry) => entry.subject)).toEqual(['[OK] ancient'])
  })

  /** Calendar months, not 30-day approximations: "six months" is what people mean by it. */
  it('counts months rather than fixed-length periods', () => {
    const now = new Date('2026-03-31T12:00:00').getTime()
    const justInside = mail('[OK] inside', '2025-10-01T00:00:00')
    const { kept } = pruneOlderThan([justInside], 6, now)

    expect(kept).toHaveLength(1)
  })

  /**
   * The month-boundary trap, found by this test rather than reasoned about.
   *
   * `setMonth(getMonth() - 6)` on 31 March gives **1 October**, not 30 September: 31 September
   * does not exist and JavaScript rolls forward instead of clamping. For retention that errs in
   * the worse direction, deleting a day more than was asked for.
   */
  it('clamps to the last real day of the target month', () => {
    const now = new Date('2026-03-31T12:00:00').getTime()
    expect(new Date(monthsBefore(now, 6)).getMonth()).toBe(8) // September, not October
    expect(new Date(monthsBefore(now, 6)).getDate()).toBe(30)
  })
})

describe('minutes into the day', () => {
  it('measures from local midnight', () => {
    expect(minutesIntoDay(new Date('2026-09-08T03:15:00').getTime())).toBe(195)
  })
})
