import { describe, expect, it } from 'vitest'

import { createSearchMailTool } from './mail.js'
import type { MailRecord } from '../office/mailIndex.js'

/**
 * A folder path may be written with either separator.
 *
 * Outlook spells its paths with backslashes, and everybody types a forward slash. The filter
 * compared the two literally, so `Inbox/Alerts` matched nothing at all — silently, and looking
 * exactly like an empty folder. The worker's own path splitter already accepted both; this filter
 * was the one place that did not.
 */
const RECORDS: MailRecord[] = [
  {
    id: '1',
    subject: 'Nightly job failed',
    sender: 'monitor@example.invalid',
    receivedAt: Date.now() - 3600_000,
    folder: 'mailbox\\Inbox\\Alerts',
    preview: '',
  },
  {
    id: '2',
    subject: 'Lunch',
    sender: 'someone@example.invalid',
    receivedAt: Date.now() - 7200_000,
    folder: 'mailbox\\Inbox',
    preview: '',
  },
]

async function run(params: Record<string, unknown>): Promise<string> {
  const tool = createSearchMailTool({ loadRecords: async () => RECORDS })
  const result = await tool.execute(params as never, {} as never)
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
}

describe('filtering mail by folder', () => {
  it('accepts a forward slash where Outlook stores a backslash', async () => {
    const output = await run({ folder: 'mailbox/Inbox/Alerts' })
    expect(output).toContain('Nightly job failed')
    expect(output).not.toContain('Lunch')
  })

  it('still accepts the backslash form', async () => {
    const output = await run({ folder: 'mailbox\\Inbox\\Alerts' })
    expect(output).toContain('Nightly job failed')
  })

  it('matches a parent folder either way', async () => {
    expect(await run({ folder: 'mailbox/Inbox' })).toContain('Lunch')
    expect(await run({ folder: 'mailbox\\Inbox' })).toContain('Lunch')
  })

  it('is case-insensitive, as Outlook is', async () => {
    expect(await run({ folder: 'MAILBOX/inbox/ALERTS' })).toContain('Nightly job failed')
  })
})
