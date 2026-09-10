import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MailStore } from './mailStore.js'
import { syncMail, type HarvestedMessage } from './mailSync.js'

/**
 * History is collected only as far back as retention keeps it.
 *
 * The defect this pins, spotted by the user asking whether indexing goes past the six-month
 * retention: it did. The backfill walked to the beginning of the mailbox with no floor, embedding
 * years of mail that the next prune would delete — and then embedding it *again*, because pruning
 * moves the oldest mark forward and the backfill resumes from wherever that now is. A permanent
 * loop paying for the same messages, with nothing anywhere reporting it.
 */
let dir: string
let store: MailStore

const NOW = Date.parse('2026-09-10T12:00:00Z')
const DAY = 24 * 3600_000

/** Two years of daily mail, so the horizon has to be what stops it. */
const MAILBOX: HarvestedMessage[] = Array.from({ length: 730 }, (_, index) => ({
  id: `m${String(index)}`,
  subject: `day ${String(index)}`,
  sender: 'x@example.invalid',
  receivedAt: NOW - index * DAY,
  folder: 'Inbox',
  preview: '',
}))

function harvester(seen: { requests: { sinceMs: number | undefined; beforeMs: number | undefined }[] }) {
  return async (
    requests: readonly { path: string; sinceMs?: number; beforeMs?: number }[],
    limits: { limit: number },
  ) => {
    const messages: HarvestedMessage[] = []
    for (const request of requests) {
      seen.requests.push({ sinceMs: request.sinceMs, beforeMs: request.beforeMs })
      messages.push(
        ...MAILBOX.filter((entry) => entry.folder === request.path)
          .filter((entry) => request.sinceMs === undefined || entry.receivedAt >= request.sinceMs)
          .filter((entry) => request.beforeMs === undefined || entry.receivedAt < request.beforeMs)
          .sort((a, b) => b.receivedAt - a.receivedAt),
      )
    }
    return { messages: messages.slice(0, limits.limit), truncated: messages.length > limits.limit }
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-horizon-'))
  store = new MailStore(dir)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('indexing history with a retention limit', () => {
  it('never asks for mail older than the retention horizon', async () => {
    const seen = { requests: [] as { sinceMs: number | undefined; beforeMs: number | undefined }[] }
    const harvest = harvester(seen)
    for (let pass = 0; pass < 10; pass++) {
      await syncMail({ store, harvest, folders: ['Inbox'], batchLimit: 50, retentionMonths: 6, now: NOW })
    }

    // Roughly six months back. Nothing fetched may predate it.
    const horizon = NOW - 190 * DAY
    const oldest = Math.min(...(await store.load()).map((record) => record.receivedAt))
    expect(oldest).toBeGreaterThan(horizon)
  })

  it('stops asking once the folder has reached the horizon', async () => {
    const seen = { requests: [] as { sinceMs: number | undefined; beforeMs: number | undefined }[] }
    const harvest = harvester(seen)
    for (let pass = 0; pass < 20; pass++) {
      await syncMail({ store, harvest, folders: ['Inbox'], batchLimit: 100, retentionMonths: 6, now: NOW })
    }

    const before = seen.requests.length
    await syncMail({ store, harvest, folders: ['Inbox'], batchLimit: 100, retentionMonths: 6, now: NOW })
    // One request — the forward pass, keeping up. No backward pass at all: without this the same
    // folder was re-examined on every sync, for ever.
    expect(seen.requests.length - before).toBe(1)
  })

  it('still walks the whole mailbox when no retention is configured', async () => {
    const harvest = harvester({ requests: [] })
    for (let pass = 0; pass < 20; pass++) {
      await syncMail({ store, harvest, folders: ['Inbox'], batchLimit: 100, now: NOW })
    }
    const oldest = Math.min(...(await store.load()).map((record) => record.receivedAt))
    expect(oldest).toBeLessThan(NOW - 365 * DAY)
  })
})
