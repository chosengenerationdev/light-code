import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MailStore } from './mailStore.js'
import { refreshMail, syncMail, type HarvestedMessage } from './mailSync.js'

/**
 * Repairing a window that came out wrong.
 *
 * Reported as "a lot of the latest emails are not in the index". Neither existing action could
 * fix it: a sync skips what it already holds — which is what makes it cheap, and exactly why it
 * can never close a gap — and clearing everything throws away years of history to repair a
 * fortnight. So the thing being pinned here is the one rule this path deliberately breaks.
 */
let dir: string
let store: MailStore

const NOW = Date.now()

function message(id: string, agoHours: number, subject: string): HarvestedMessage {
  return {
    id,
    subject,
    sender: 'x@example.invalid',
    receivedAt: NOW - agoHours * 3600_000,
    folder: 'Inbox',
    preview: '',
  }
}

function harvester(mailbox: HarvestedMessage[]) {
  return async (
    requests: readonly { path: string; sinceMs?: number; beforeMs?: number }[],
    limits: { limit: number },
  ) => {
    const messages: HarvestedMessage[] = []
    for (const request of requests) {
      messages.push(
        ...mailbox
          .filter((entry) => entry.folder === request.path)
          .filter((entry) => request.sinceMs === undefined || entry.receivedAt >= request.sinceMs)
          .filter((entry) => request.beforeMs === undefined || entry.receivedAt < request.beforeMs)
          .sort((a, b) => b.receivedAt - a.receivedAt),
      )
    }
    return { messages: messages.slice(0, limits.limit), truncated: messages.length > limits.limit }
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-refresh-'))
  store = new MailStore(dir)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('refreshing a recent window', () => {
  it('re-reads messages that are already indexed, where a sync would skip them', async () => {
    const first = [message('a', 2, 'original subject')]
    await syncMail({ store, harvest: harvester(first), folders: ['Inbox'] })
    expect((await store.load())[0]?.subject).toBe('original subject')

    // The same id, corrected. A sync sees a known id and does nothing at all with it.
    const corrected = [message('a', 2, 'corrected subject')]
    await syncMail({ store, harvest: harvester(corrected), folders: ['Inbox'] })
    expect((await store.load())[0]?.subject).toBe('original subject')

    const result = await refreshMail({ store, harvest: harvester(corrected), folders: ['Inbox'], days: 7 })
    expect(result.added).toBe(1)
    expect((await store.load())[0]?.subject).toBe('corrected subject')
  })

  it('fills a gap inside the window without duplicating what is there', async () => {
    await syncMail({ store, harvest: harvester([message('a', 2, 'a')]), folders: ['Inbox'] })

    const full = [message('a', 2, 'a'), message('b', 3, 'b'), message('c', 4, 'c')]
    await refreshMail({ store, harvest: harvester(full), folders: ['Inbox'], days: 7 })

    const records = await store.load()
    expect(records.map((record) => record.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('leaves mail outside the window alone', async () => {
    const old = message('old', 24 * 40, 'from last month')
    await syncMail({ store, harvest: harvester([old]), folders: ['Inbox'] })

    // The harvester honours `sinceMs`, so a 7-day refresh cannot see it — and must not drop it.
    await refreshMail({ store, harvest: harvester([old, message('new', 1, 'today')]), folders: ['Inbox'], days: 7 })

    const ids = (await store.load()).map((record) => record.id).sort()
    expect(ids).toEqual(['new', 'old'])
  })
})
