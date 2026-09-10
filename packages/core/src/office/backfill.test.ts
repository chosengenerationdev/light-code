import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MailStore } from './mailStore.js'
import { syncMail, type HarvestedMessage } from './mailSync.js'

/**
 * A folder holding far more mail than one batch.
 *
 * The bug this pins, found by the user asking whether indexing resumes after a restart: the
 * forward-only version indexed the newest batch and then never moved again. Measured against
 * 2000 messages with a 500 batch it reported `500 -> 500 -> 500 -> 500`, the older 1500 were
 * unreachable, and restarting changed nothing because the mark was derived the same way each time.
 */
let dir: string
let store: MailStore

const BASE = Date.parse('2026-09-10T00:00:00Z')
const MAILBOX: HarvestedMessage[] = Array.from({ length: 2000 }, (_, index) => ({
  id: `m${String(index)}`,
  subject: `message ${String(index)}`,
  sender: 'x@example.invalid',
  receivedAt: BASE - index * 3600_000,
  folder: 'Inbox',
  preview: '',
}))

/** Behaves like the worker: restricted both ways, newest first, capped. */
function harvester(mailbox: HarvestedMessage[] = MAILBOX) {
  return async (
    requests: readonly { path: string; sinceMs?: number; beforeMs?: number }[],
    limits: { limit: number },
  ) => {
    const messages: HarvestedMessage[] = []
    for (const request of requests) {
      const matching = mailbox
        .filter((entry) => entry.folder === request.path)
        .filter((entry) => request.sinceMs === undefined || entry.receivedAt >= request.sinceMs)
        .filter((entry) => request.beforeMs === undefined || entry.receivedAt < request.beforeMs)
        .sort((a, b) => b.receivedAt - a.receivedAt)
      messages.push(...matching.slice(0, limits.limit))
    }
    return { messages: messages.slice(0, limits.limit), truncated: messages.length >= limits.limit }
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-backfill-'))
  store = new MailStore(dir)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('catching up on a large folder', () => {
  it('keeps making progress on every pass instead of stalling', async () => {
    const harvest = harvester()
    const totals: number[] = []
    for (let pass = 0; pass < 4; pass++) {
      totals.push((await syncMail({ store, harvest, folders: ['Inbox'], batchLimit: 500 })).total)
    }

    // The exact numbers are not the point; each pass making progress is.
    expect(totals[1]).toBeGreaterThan(totals[0] as number)
    expect(totals[3]).toBeGreaterThan(totals[1] as number)
  })

  it('eventually reads the whole folder', async () => {
    const harvest = harvester()
    for (let pass = 0; pass < 12; pass++) {
      await syncMail({ store, harvest, folders: ['Inbox'], batchLimit: 500 })
    }
    expect((await store.load()).length).toBe(MAILBOX.length)
  })

  /**
   * The newest first, always. The questions this index answers are about recent mail, so it
   * becomes useful on the first pass; history fills in behind it.
   */
  it('indexes the newest messages first', async () => {
    await syncMail({ store, harvest: harvester(), folders: ['Inbox'], batchLimit: 100 })
    const records = await store.load()
    const newest = Math.max(...records.map((entry) => entry.receivedAt))

    expect(newest).toBe(BASE)
    expect(records.length).toBe(100)
  })

  /**
   * Resuming is the whole point of the question that found this. Both marks are derived from the
   * records, so a new MailStore over the same directory - which is what a restart is - carries on.
   */
  it('resumes where it stopped when everything is reconstructed', async () => {
    const harvest = harvester()
    await syncMail({ store, harvest, folders: ['Inbox'], batchLimit: 300 })
    const afterFirst = (await store.load()).length

    // A fresh store over the same directory: exactly what reopening the editor gives you.
    const reopened = new MailStore(dir)
    await syncMail({ store: reopened, harvest, folders: ['Inbox'], batchLimit: 300 })

    expect((await reopened.load()).length).toBeGreaterThan(afterFirst)
  })

  /** New mail must not wait behind the backfill: it is what the index is actually for. */
  it('picks up a newly arrived message while still catching up', async () => {
    const harvest = harvester()
    await syncMail({ store, harvest, folders: ['Inbox'], batchLimit: 200 })

    const arrived: HarvestedMessage = {
      id: 'brand-new',
      subject: '[ALERT] just now',
      sender: 'x@example.invalid',
      receivedAt: BASE + 3600_000,
      folder: 'Inbox',
      preview: '',
    }
    await syncMail({ store, harvest: harvester([arrived, ...MAILBOX]), folders: ['Inbox'], batchLimit: 200 })

    expect((await store.load()).some((entry) => entry.id === 'brand-new')).toBe(true)
  })

  /**
   * A finished folder stops being asked. It cannot be derived - "nothing older than my oldest"
   * and "I have not looked" produce identical records - so it is recorded.
   */
  it('records a folder as finished and stops asking for history', async () => {
    const small: HarvestedMessage[] = MAILBOX.slice(0, 5)
    const harvest = harvester(small)
    await syncMail({ store, harvest, folders: ['Inbox'], batchLimit: 500 })
    const result = await syncMail({ store, harvest, folders: ['Inbox'], batchLimit: 500 })

    expect(result.complete).toContain('Inbox')
    expect(await store.loadBackfillState()).toEqual({ Inbox: true })
  })
})
