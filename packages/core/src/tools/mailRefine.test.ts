import { describe, expect, it } from 'vitest'

import { createSearchMailTool } from './mail.js'
import type { MailRecord } from '../office/mailIndex.js'

/**
 * Narrowing a result set, repeatedly, without the ground shifting underneath.
 *
 * Requested directly: find some mail, then search *inside* what was found, as many times as it
 * takes. The reason `within` exists rather than "just add more filters and search again" is that
 * a second broad search is a different operation — semantic ranking reorders the population, so
 * the "narrowed" answer can contain messages the first pass never showed. Pinning the ids makes a
 * refinement a genuine subset of what was seen, and makes refining a refinement terminate.
 */
const NOW = Date.parse('2026-09-10T12:00:00Z')
const HOUR = 3600_000

const RECORDS: MailRecord[] = [
  {
    id: 'a',
    subject: '[ALERT] Nightly job failed',
    sender: 'monitor@example.invalid',
    receivedAt: NOW - 2 * HOUR,
    folder: 'mailbox\\Inbox\\Alerts',
    status: 'alert',
    preview: 'Disk pressure on the batch host.',
  },
  {
    id: 'b',
    subject: '[ALERT] Nightly job failed',
    sender: 'other@example.invalid',
    receivedAt: NOW - 26 * HOUR,
    folder: 'mailbox\\Inbox\\Alerts',
    status: 'alert',
    preview: 'Disk pressure again.',
  },
  {
    id: 'c',
    subject: '[OK] Nightly job finished',
    sender: 'monitor@example.invalid',
    receivedAt: NOW - 3 * HOUR,
    folder: 'mailbox\\Inbox\\Alerts',
    status: 'ok',
    preview: 'All clear.',
  },
  {
    id: 'd',
    subject: 'Lunch on Thursday',
    sender: 'someone@example.invalid',
    receivedAt: NOW - 4 * HOUR,
    folder: 'mailbox\\Inbox',
    preview: 'One o clock?',
  },
]

async function run(params: Record<string, unknown>): Promise<string> {
  const tool = createSearchMailTool({ loadRecords: async () => RECORDS })
  const result = await tool.execute(params as never, {} as never)
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
}

/** The ids an `idsOnly` answer listed. */
function idsFrom(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => RECORDS.some((record) => record.id === line))
}

describe('narrowing a mail search', () => {
  it('searches only within the ids it is given', async () => {
    const output = await run({ within: ['a', 'c'], idsOnly: true })
    expect(idsFrom(output).sort()).toEqual(['a', 'c'])
  })

  it('applies the other criteria inside that population', async () => {
    // Two alerts exist, but only one is inside the given set.
    const output = await run({ within: ['a', 'd'], status: 'alert', idsOnly: true })
    expect(idsFrom(output)).toEqual(['a'])
  })

  it('can be applied again to its own output, and terminates', async () => {
    const first = idsFrom(await run({ status: 'alert', idsOnly: true }))
    expect(first.sort()).toEqual(['a', 'b'])

    const second = idsFrom(await run({ within: first, sender: 'monitor', idsOnly: true }))
    expect(second).toEqual(['a'])

    const third = idsFrom(await run({ within: second, subject: 'Nightly', idsOnly: true }))
    expect(third).toEqual(['a'])
  })

  it('filters on subject, sender and free text exactly', async () => {
    expect(idsFrom(await run({ subject: 'lunch', idsOnly: true }))).toEqual(['d'])
    expect(idsFrom(await run({ sender: 'monitor', idsOnly: true })).sort()).toEqual(['a', 'c'])
    expect(idsFrom(await run({ contains: 'disk pressure', idsOnly: true })).sort()).toEqual(['a', 'b'])
  })

  it('excludes rather than includes when asked to', async () => {
    const kept = idsFrom(await run({ sender: 'monitor', exclude: 'all clear', idsOnly: true }))
    expect(kept).toEqual(['a'])
  })

  it('bounds by absolute date', async () => {
    const recent = idsFrom(await run({ after: '2026-09-10T00:00:00Z', idsOnly: true }))
    // `b` is 26 hours old, so it falls outside the day.
    expect(recent).not.toContain('b')
    expect(recent).toContain('a')
  })

  it('refuses a date it cannot read rather than ignoring it', async () => {
    /*
     * Silently dropping an unreadable bound would widen the search to everything and report the
     * result as though the bound had been applied — the same quiet wrongness as a dropped query.
     */
    const output = await run({ after: 'last Tuesday' })
    expect(output).toContain('Could not read')
  })

  it('says what it narrowed by, so an empty result is diagnosable', async () => {
    const output = await run({ within: ['a'], sender: 'nobody' })
    expect(output).toContain('from "nobody"')
    expect(output).toContain('within 1 given message(s)')
  })
})
