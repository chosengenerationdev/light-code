import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MailStore, resumePoints, withoutKnown } from './mailStore.js'
import { pruneMail, syncMail, type HarvestedMessage } from './mailSync.js'
import type { MailRecord } from './mailIndex.js'
import type { VectorDocument, VectorIndexWriter } from '../rag/vectorStore.js'

/**
 * Collecting new mail without losing any and without fetching it twice.
 *
 * The requirement that shapes all of it: *"once i configure, it should be automatically indexing
 * with the new emails that are received"*. An incremental sync that drops a message is worse
 * than one that never runs, because nothing indicates it — the index simply has a hole where an
 * alert used to be.
 */

let storageDir: string
let store: MailStore

beforeEach(async () => {
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-mail-'))
  store = new MailStore(storageDir)
})

afterEach(async () => {
  await fs.rm(storageDir, { recursive: true, force: true })
})

function message(id: string, at: string, folder = 'Inbox/Alerts', subject = `[ALERT] job ${id} failed`): HarvestedMessage {
  return {
    id,
    subject,
    sender: 'monitoring@example.invalid',
    receivedAt: new Date(at).getTime(),
    folder,
    preview: 'the job did not finish',
  }
}

function harvester(batches: { messages: HarvestedMessage[]; truncated?: boolean }[]) {
  const seen: { path: string; sinceMs?: number }[][] = []
  let call = 0
  return {
    seen,
    harvest: async (requests: readonly { path: string; sinceMs?: number }[]) => {
      seen.push([...requests])
      const batch = batches[call] ?? { messages: [] }
      call += 1
      return { messages: batch.messages, truncated: batch.truncated ?? false }
    },
  }
}

describe('collecting new mail', () => {
  it('records what arrived and reads the status out of the subject', async () => {
    const { harvest } = harvester([{ messages: [message('a', '2026-09-08T03:00:00')] }])
    const result = await syncMail({ store, harvest, folders: ['Inbox/Alerts'] })

    expect(result.added).toBe(1)
    const records = await store.load()
    expect(records[0]?.status).toBe('alert')
    expect(records[0]?.subject).toContain('job a failed')
  })

  it('does not record the same message twice', async () => {
    const { harvest } = harvester([
      { messages: [message('a', '2026-09-08T03:00:00')] },
      { messages: [message('a', '2026-09-08T03:00:00'), message('b', '2026-09-08T04:00:00')] },
    ])
    await syncMail({ store, harvest, folders: ['Inbox/Alerts'] })
    const second = await syncMail({ store, harvest, folders: ['Inbox/Alerts'] })

    expect(second.added).toBe(1)
    expect((await store.load()).map((r) => r.id)).toEqual(['a', 'b'])
  })

  /**
   * Per folder, not one global mark. A folder added to the configuration later would otherwise
   * resume from the newest message in a *different* folder and skip everything older in it —
   * which looks exactly like the feature not working.
   */
  it('resumes each folder from its own newest message', async () => {
    const { harvest, seen } = harvester([
      {
        messages: [
          message('a', '2026-09-08T03:00:00', 'Inbox/Alerts'),
          message('b', '2026-09-01T03:00:00', 'Inbox/Reports'),
        ],
      },
      { messages: [] },
    ])
    await syncMail({ store, harvest, folders: ['Inbox/Alerts', 'Inbox/Reports'] })
    await syncMail({ store, harvest, folders: ['Inbox/Alerts', 'Inbox/Reports'] })

    const second = seen[1] ?? []
    const alerts = second.find((entry) => entry.path === 'Inbox/Alerts')
    const reports = second.find((entry) => entry.path === 'Inbox/Reports')
    expect(alerts?.sinceMs).toBeGreaterThan(reports?.sinceMs ?? 0)
  })

  /**
   * Outlook's restriction is inclusive at second granularity, so resuming from exactly the last
   * timestamp loses anything that arrived in the same second. One second of overlap is free —
   * `withoutKnown` discards the repeats — and losing a message is not recoverable.
   */
  it('resumes a second early rather than exactly', () => {
    const records: MailRecord[] = [
      { id: 'a', subject: 's', sender: 'x', receivedAt: 1_000_000, folder: 'Inbox', preview: '' },
    ]
    expect(resumePoints(records).get('Inbox')).toBe(999_000)
  })

  it('says when there is more to collect', async () => {
    const { harvest } = harvester([{ messages: [message('a', '2026-09-08T03:00:00')], truncated: true }])
    const result = await syncMail({ store, harvest, folders: ['Inbox/Alerts'] })

    expect(result.more).toBe(true)
  })
})

describe('what reaches the vector store', () => {
  function recordingWriter(): { writer: VectorIndexWriter; upserted: VectorDocument[]; deleted: string[] } {
    const upserted: VectorDocument[] = []
    const deleted: string[] = []
    const writer = {
      kind: 'qdrant' as const,
      ensureCollection: async () => undefined,
      upsert: async (_c: string, documents: readonly VectorDocument[]) => {
        upserted.push(...documents)
      },
      deleteByPaths: async (_c: string, paths: readonly string[]) => {
        deleted.push(...paths)
      },
      listPaths: async () => [],
    } as unknown as VectorIndexWriter
    return { writer, upserted, deleted }
  }

  const embedder = { embed: async () => [0.1], dimensions: 1 } as never

  it('embeds each new message once, keyed so a hit joins back to its facts', async () => {
    const { harvest } = harvester([{ messages: [message('a', '2026-09-08T03:00:00')] }])
    const { writer, upserted } = recordingWriter()

    await syncMail({
      store,
      harvest,
      folders: ['Inbox/Alerts'],
      semantic: { embedder, writer, collection: 'mail' },
    })

    expect(upserted).toHaveLength(1)
    expect(upserted[0]?.path).toBe('mail:a')
  })

  /**
   * Embedded before recorded. Recording first would mark a message done even when the embedding
   * failed, leaving it permanently absent from semantic search with nothing to indicate it —
   * the facts complete and the meaning quietly missing.
   */
  it('records nothing when embedding fails, so the message is collected again', async () => {
    const { harvest } = harvester([{ messages: [message('a', '2026-09-08T03:00:00')] }])
    const failing = {
      kind: 'qdrant' as const,
      ensureCollection: async () => undefined,
      upsert: async () => {
        throw new Error('embedding endpoint unreachable')
      },
      deleteByPaths: async () => undefined,
      listPaths: async () => [],
    } as unknown as VectorIndexWriter

    await expect(
      syncMail({ store, harvest, folders: ['Inbox/Alerts'], semantic: { embedder, writer: failing, collection: 'mail' } }),
    ).rejects.toThrow(/unreachable/)

    expect(await store.load()).toEqual([])
  })

  /** Facts alone still answer every temporal question, which is most of them. */
  it('works with no vector store at all', async () => {
    const { harvest } = harvester([{ messages: [message('a', '2026-09-08T03:00:00')] }])
    const result = await syncMail({ store, harvest, folders: ['Inbox/Alerts'] })

    expect(result.added).toBe(1)
    expect(result.embedded).toBe(0)
  })
})

describe('pruning old mail', () => {
  it('removes the vectors before the facts, so nothing is orphaned', async () => {
    const order: string[] = []
    const writer = {
      kind: 'qdrant' as const,
      ensureCollection: async () => undefined,
      upsert: async () => undefined,
      deleteByPaths: async () => {
        order.push('vectors')
      },
      listPaths: async () => [],
    } as unknown as VectorIndexWriter

    await store.append([
      { id: 'old', subject: 's', sender: 'x', receivedAt: new Date('2024-01-01').getTime(), folder: 'Inbox', preview: '' },
    ])

    const result = await pruneMail({
      store,
      months: 6,
      semantic: { writer, collection: 'mail' },
      now: new Date('2026-09-08').getTime(),
    })
    order.push('facts')

    expect(order).toEqual(['vectors', 'facts'])
    expect(result.removed).toBe(1)
    expect(await store.load()).toEqual([])
  })

  it('reports zero rather than looking like a failure when nothing is old enough', async () => {
    await store.append([
      { id: 'new', subject: 's', sender: 'x', receivedAt: new Date('2026-09-01').getTime(), folder: 'Inbox', preview: '' },
    ])
    const result = await pruneMail({ store, months: 6, now: new Date('2026-09-08').getTime() })

    expect(result).toEqual({ removed: 0, kept: 1 })
  })
})

describe('the store on disk', () => {
  /** One torn line costs one message, not the history. The same shape as expert-events.jsonl. */
  it('skips a malformed line rather than refusing to load', async () => {
    await store.append([
      { id: 'a', subject: 's', sender: 'x', receivedAt: 1, folder: 'Inbox', preview: '' },
    ])
    await fs.appendFile(path.join(storageDir, 'mail-index.jsonl'), '{"broken\n', 'utf8')
    await store.append([
      { id: 'b', subject: 's', sender: 'x', receivedAt: 2, folder: 'Inbox', preview: '' },
    ])

    expect((await store.load()).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('discards ids it already holds', () => {
    const known: MailRecord[] = [{ id: 'a', subject: 's', sender: 'x', receivedAt: 1, folder: 'Inbox', preview: '' }]
    const candidates: MailRecord[] = [
      { id: 'a', subject: 's', sender: 'x', receivedAt: 1, folder: 'Inbox', preview: '' },
      { id: 'b', subject: 's', sender: 'x', receivedAt: 2, folder: 'Inbox', preview: '' },
    ]
    expect(withoutKnown(candidates, known).map((r) => r.id)).toEqual(['b'])
  })
})
