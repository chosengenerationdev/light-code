import { describe, expect, it } from 'vitest'

import { countBy, crossTab, dailyChange, extractNumber, numberOverTime } from './mailStats.js'
import type { MailRecord } from './mailIndex.js'

/**
 * Counting mail, exactly, for the questions a chart answers.
 *
 * The failure these guard against is the one §12f names: arithmetic answered by impression.
 * Search returns a page, so counting what was shown reports a sample as though it were the total —
 * confidently, and with a number attached.
 */
const DAY = 86400_000
const BASE = Date.parse('2026-09-08T09:00:00')

function record(id: string, folder: string, dayOffset: number, subject: string): MailRecord {
  return {
    id,
    folder,
    subject,
    sender: `${folder.split('\\').pop() ?? 'x'}@example.invalid`,
    receivedAt: BASE + dayOffset * DAY,
    preview: '',
    ...(subject.startsWith('[ALERT]') ? { status: 'alert' as const } : {}),
  }
}

const RECORDS: MailRecord[] = [
  record('1', 'mailbox\\Inbox\\Alerts', 0, '[ALERT] queue depth 120'),
  record('2', 'mailbox\\Inbox\\Alerts', 0, '[ALERT] queue depth 145'),
  record('3', 'mailbox\\Inbox\\Alerts', 2, '[ALERT] queue depth 190'),
  record('4', 'mailbox\\Inbox', 2, 'Lunch'),
]

describe('counting indexed mail', () => {
  it('counts into buckets and names what it counted', () => {
    const buckets = countBy(RECORDS, 'folder')
    expect(buckets[0]?.label).toBe('mailbox\\Inbox\\Alerts')
    expect(buckets[0]?.count).toBe(3)
    // The drill-down: a bar reading 3 must be able to say which three.
    expect(buckets[0]?.detail).toHaveLength(3)
  })

  it('includes a day with nothing as a zero rather than leaving it out', () => {
    /*
     * A missing category and a category worth nothing are different claims, and only one is true.
     * Omitted, a line chart joins the days either side into a straight line that hides the gap.
     */
    const days = countBy(RECORDS, 'day', { fillDays: true })
    expect(days.map((bucket) => bucket.count)).toEqual([2, 0, 2])
  })

  it('aligns a cross-tab so every series has one value per category', () => {
    const table = crossTab(RECORDS, 'day', 'folder')
    for (const series of table.series) {
      // A series short by one silently shifts every value after it, and the chart still draws.
      expect(series.values).toHaveLength(table.categories.length)
      expect(series.detail).toHaveLength(table.categories.length)
    }
  })

  it('orders time forwards and everything else largest first', () => {
    expect(countBy(RECORDS, 'day').map((b) => b.label)).toEqual([...countBy(RECORDS, 'day').map((b) => b.label)].sort())
    expect(countBy(RECORDS, 'folder')[0]?.count).toBe(3)
  })
})

describe('reading a number out of an alert', () => {
  it('finds a labelled number', () => {
    expect(extractNumber(RECORDS[0] as MailRecord, 'queue depth')).toBe(120)
  })

  it('will not take a number that belongs to something else', () => {
    /*
     * The load-bearing decision. "The first number in the subject" would read the 3 out of
     * `[ALERT] Job 3 failed` and chart it as a trend — a plausible line drawn from nothing.
     */
    const other = record('9', 'x', 0, '[ALERT] Job 3 failed')
    expect(extractNumber(other, 'queue depth')).toBeUndefined()
  })

  it('handles thousands separators and decimals', () => {
    const big = record('9', 'x', 0, 'rows 1,240.5 written')
    expect(extractNumber(big, 'rows')).toBe(1240.5)
  })

  it('tracks the number over days and says what it left out', () => {
    const { points, matched, skipped } = numberOverTime(RECORDS, 'queue depth', 'max')
    expect(matched).toBe(3)
    // The lunch message carries no such label and is omitted, never counted as zero.
    expect(skipped).toBe(1)
    expect(points.map((point) => point.value)).toEqual([145, 190])
  })

  it('reports day-on-day movement with no invented first day', () => {
    const { points } = numberOverTime(RECORDS, 'queue depth', 'max')
    const change = dailyChange(points)
    // A first day shown as a rise of zero is a claim about a day nobody measured.
    expect(change[0]?.change).toBeUndefined()
    expect(change[1]?.change).toBe(45)
  })
})
