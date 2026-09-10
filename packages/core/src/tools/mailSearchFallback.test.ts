import { describe, expect, it } from 'vitest'

import { createSearchMailTool } from './mail.js'
import type { MailRecord } from '../office/mailIndex.js'

/**
 * A query must never be silently ignored.
 *
 * With no embedding model configured, `query` was dropped and the tool returned the newest
 * messages in the index — a well-formed answer, in time order, with nothing to do with what was
 * asked. The assistant would then report those as matches, which is the worst available outcome:
 * a confident wrong answer that looks exactly like a right one.
 */
const RECORDS: MailRecord[] = [
  {
    id: '1',
    subject: 'Weekly reading list',
    sender: 'list@example.invalid',
    receivedAt: Date.now() - 3600_000,
    folder: 'Inbox',
    preview: 'This week we look at The Pragmatic Programmer.',
  },
  {
    id: '2',
    subject: 'Lunch on Thursday',
    sender: 'someone@example.invalid',
    receivedAt: Date.now() - 7200_000,
    folder: 'Inbox',
    preview: 'Shall we say one o clock',
  },
]

function tool(records: MailRecord[] = RECORDS) {
  return createSearchMailTool({ loadRecords: async () => records })
}

async function run(params: Record<string, unknown>): Promise<string> {
  const result = await tool().execute(params as never, {} as never)
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
}

describe('searching mail with no embedding model', () => {
  it('matches on words rather than returning everything', async () => {
    const output = await run({ query: 'pragmatic programmer' })
    expect(output).toContain('Weekly reading list')
    expect(output).not.toContain('Lunch on Thursday')
  })

  it('says a hit was matched on words, not meaning', async () => {
    const output = await run({ query: 'pragmatic' })
    expect(output).toContain('matched on words, not meaning')
  })

  it('reports a genuine absence as an absence', async () => {
    const output = await run({ query: 'quarterly forecast spreadsheet' })
    expect(output.toLowerCase()).toContain('nothing indexed mentions')
    // And explains the limit, so "not found" is not mistaken for "not in your mail".
    expect(output).toContain('opening of each message')
  })

  it('still returns the whole window when no query is given', async () => {
    const output = await run({})
    expect(output).toContain('Weekly reading list')
    expect(output).toContain('Lunch on Thursday')
  })
})
