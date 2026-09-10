import type { Embedder } from '../rag/embedder.js'
import type { VectorDocument, VectorIndexWriter } from '../rag/vectorStore.js'
import { monthsBefore, parseStatusTag, pruneOlderThan, type MailRecord } from './mailIndex.js'
import { folderMarks, withoutKnown, type MailStore } from './mailStore.js'

/**
 * One pass of collecting new mail, embedding it, and recording it.
 *
 * ## Incremental by construction
 *
 * Each folder resumes from the newest message already recorded for *that folder*, not from a
 * single global mark — a folder added to the configuration later would otherwise be skipped back
 * to the day it was added, which looks exactly like it not working.
 *
 * The overlap is deliberate and one second wide: Outlook's restriction is inclusive at second
 * granularity, so resuming from exactly the last timestamp loses anything that arrived in the
 * same second. Re-fetching a handful of known messages is free, and `withoutKnown` discards
 * them; losing one silently is not recoverable.
 *
 * ## What reaches the embedding endpoint
 *
 * The subject and the preview, not the whole body. That keeps the largest egress in this feature
 * proportionate to what searching actually needs, and it is stated plainly in the UI — enabling
 * this sends the contents of the named folders to whichever endpoint is configured.
 */

export interface MailSyncOptions {
  store: MailStore
  /** Asks Outlook for messages newer than the given point, per folder. */
  harvest: (
    requests: readonly { path: string; sinceMs?: number; beforeMs?: number }[],
    limits: { limit: number; previewChars: number },
  ) => Promise<{ messages: HarvestedMessage[]; truncated: boolean }>
  folders: readonly string[]
  /** Absent means facts only: the index still answers every temporal question. */
  semantic?: {
    embedder: Embedder
    writer: VectorIndexWriter
    collection: string
  }
  previewChars?: number
  /**
   * How far back history is worth collecting, in months. The retention setting.
   *
   * **The backfill must stop here, and it did not.** It walked back to the beginning of the
   * mailbox regardless, which is wasted embedding cost for mail that retention exists to delete —
   * and worse, it looped: pruning moved the oldest mark forward, the next backfill re-fetched and
   * re-embedded exactly what had just been deleted, and pruning removed it again. Every cycle,
   * for ever, paying to embed the same messages.
   *
   * Undefined means no floor, which is what a caller with no retention configured wants.
   */
  retentionMonths?: number
  /** Injectable clock, so the retention horizon can be tested without waiting six months. */
  now?: number
  /** Messages per pass. Bounded so a first run over a large mailbox does not stall the timer. */
  batchLimit?: number
  signal?: AbortSignal
  /**
   * Called as messages are embedded.
   *
   * Embedding is the slow part by a wide margin - one request per message - so progress that
   * only reported "harvesting" and then "done" would show nothing for most of the run.
   */
  onProgress?: (done: number, total: number, phase: string) => void
}

export interface HarvestedMessage {
  id: string
  subject: string
  sender: string
  receivedAt: number
  folder: string
  preview: string
}

/**
 * Re-reads a recent window, whether or not it is already indexed.
 *
 * Separate from the ordinary sync because it deliberately breaks that one's central rule: a sync
 * skips what it already holds, which is what makes it cheap, and is also why it can never repair
 * a gap. Anything already present in the window is replaced rather than skipped, so a message
 * indexed from a partial harvest is corrected rather than kept forever in its first state.
 */
export async function refreshMail(
  options: Omit<MailSyncOptions, 'batchLimit'> & { days: number; batchLimit?: number },
): Promise<MailSyncResult> {
  const known = await options.store.load()
  const limit = options.batchLimit ?? 2000
  const previewChars = options.previewChars ?? 400
  const sinceMs = Date.now() - options.days * 24 * 60 * 60 * 1000

  const harvested = await options.harvest(
    options.folders.map((path) => ({ path, sinceMs })),
    { limit, previewChars },
  )
  const fetched = harvested.messages.map(toRecord)
  if (fetched.length === 0) {
    return { added: 0, more: false, total: known.length, embedded: 0, backfilled: 0, complete: [] }
  }

  /*
   * The old copies go, then the new ones are appended.
   *
   * `replace` rewrites the whole file, which is the expensive path - but this runs when somebody
   * has pressed a button because the index is wrong, and correctness there is worth more than the
   * append-only shortcut. Vectors are upserted by the same id, so they need no deletion.
   */
  const refreshedIds = new Set(fetched.map((record) => record.id))
  await options.store.replace([...known.filter((record) => !refreshedIds.has(record.id)), ...fetched])

  let embedded = 0
  if (options.semantic !== undefined) {
    embedded = await embedRecords(fetched, options)
  }

  return {
    added: fetched.length,
    more: harvested.truncated,
    total: known.filter((record) => !refreshedIds.has(record.id)).length + fetched.length,
    embedded,
    backfilled: 0,
    complete: [],
  }
}

export interface MailSyncResult {
  added: number
  /** True when there is more to fetch, so the caller knows to run again. */
  more: boolean
  total: number
  embedded: number
  /** How many messages came from walking backwards through history. */
  backfilled: number
  /** Folders with nothing older left to read. */
  complete: string[]
}

function toRecord(message: HarvestedMessage): MailRecord {
  const status = parseStatusTag(message.subject)
  return {
    id: message.id,
    subject: message.subject,
    sender: message.sender,
    receivedAt: message.receivedAt,
    folder: message.folder,
    preview: message.preview,
    ...(status !== undefined ? { status } : {}),
  }
}

/** What is embedded: enough to find the message by meaning, and no more. */
export function mailEmbedText(record: MailRecord): string {
  return [record.subject, record.sender, record.preview].filter((part) => part.length > 0).join('\n')
}

/**
 * One pass: keep up first, then catch up.
 *
 * ## Why forward before backward
 *
 * The questions this index exists to answer are about *recent* mail - "any alerts in the last six
 * hours". So the newest messages are fetched first and every pass keeps them current, and history
 * fills in behind across as many passes as it takes. The opposite order would leave someone with
 * a fully indexed 2019 and nothing about this morning.
 *
 * ## Why there is a backward pass at all
 *
 * Because without one there was no progress. Measured against a 2000-message folder with a
 * 500-message batch, the forward-only version reported `500 -> 500 -> 500 -> 500`: it indexed the
 * newest batch, then asked only for mail newer than that, found none, and stopped. The remaining
 * 1500 were unreachable, closing and reopening changed nothing, and nothing said so.
 *
 * Both marks come from the records themselves, so a restart resumes exactly where it stopped
 * without any state to keep in step.
 */
export async function syncMail(options: MailSyncOptions): Promise<MailSyncResult> {
  const known = await options.store.load()
  const marks = folderMarks(known)
  const backfillDone = await options.store.loadBackfillState()
  const limit = options.batchLimit ?? 500
  const previewChars = options.previewChars ?? 400

  // --- forward: anything newer than what we hold ---------------------------------------------
  const forwardRequests = options.folders.map((path) => {
    const mark = marks.get(path)
    // One second back: Outlook restricts inclusively at second granularity.
    return mark === undefined ? { path } : { path, sinceMs: mark.newest - 1000 }
  })

  const forward = await options.harvest(forwardRequests, { limit, previewChars })
  let candidates = forward.messages.map(toRecord)
  let backfilled = 0
  const completed: string[] = []
  let more = forward.truncated

  // --- backward: history, back as far as retention wants it ------------------------------------
  const remaining = limit - candidates.length
  /*
   * The floor, and the folders already standing on it.
   *
   * A folder whose oldest message is already past the horizon has nothing left worth collecting:
   * anything older would be fetched, embedded, and then deleted by the next prune. Treated as
   * finished rather than skipped, so it is recorded and never asked again.
   */
  const floor =
    options.retentionMonths === undefined
      ? undefined
      : monthsBefore(options.now ?? Date.now(), options.retentionMonths)

  const outstanding = options.folders.filter((path) => marks.has(path) && backfillDone[path] !== true)
  const atFloor =
    floor === undefined
      ? []
      : outstanding.filter((path) => (marks.get(path) as { oldest: number }).oldest <= floor)
  const behind = outstanding.filter((path) => !atFloor.includes(path))
  completed.push(...atFloor)

  if (remaining > 0 && behind.length > 0 && options.signal?.aborted !== true) {
    const backRequests = behind.map((path) => ({
      path,
      // Strictly older, so the oldest held message is not fetched again every pass.
      beforeMs: (marks.get(path) as { oldest: number }).oldest,
      // And no older than retention wants. The harvest ANDs the two into one window.
      ...(floor === undefined ? {} : { sinceMs: floor }),
    }))
    const backward = await options.harvest(backRequests, { limit: remaining, previewChars })
    backfilled = backward.messages.length
    candidates = [...candidates, ...backward.messages.map(toRecord)]

    /*
     * A folder that returned nothing older is finished, and is recorded as such.
     *
     * It cannot be derived later: "nothing older than my oldest" and "I have not looked" produce
     * identical records, so without this every finished folder would be re-asked for absent
     * history on every sync, forever.
     */
    const returnedFor = new Set(backward.messages.map((message) => message.folder))
    for (const path of behind) {
      if (!returnedFor.has(path)) completed.push(path)
    }
    if (backward.truncated || backfilled > 0) more = true
  }

  if (completed.length > 0) {
    /*
     * Written outside the backward block, because a folder can reach the floor without a backward
     * pass ever running — the batch may have been spent on new mail. Leaving it unrecorded there
     * meant the same folder was re-examined on every single sync.
     */
    await options.store.saveBackfillState({
      ...backfillDone,
      ...Object.fromEntries(completed.map((path) => [path, true])),
    })
  }

  const fresh = withoutKnown(candidates, known)
  if (fresh.length === 0) {
    return {
      added: 0,
      more: more && behind.length > completed.length,
      total: known.length,
      embedded: 0,
      backfilled: 0,
      complete: completed,
    }
  }

  /*
   * Embedded *before* being recorded, so a failure leaves the message unrecorded and it is
   * collected again next pass. Recording first would mark it done and leave it permanently
   * absent from semantic search, with nothing to indicate it — the facts would be complete and
   * the meaning quietly missing.
   */
  let embedded = 0
  if (options.semantic !== undefined) embedded = await embedRecords(fresh, options)

  await options.store.append(fresh)
  return {
    added: fresh.length,
    more,
    total: known.length + fresh.length,
    embedded,
    backfilled,
    complete: completed,
  }
}

/**
 * Drops indexed mail older than the retention window.
 *
 * Both halves, and in this order: the vector documents go first, then the facts. The reverse
 * would leave orphaned vectors that a semantic search can still return, with no record to join
 * them to — a hit that renders as nothing at all.
 *
 * Reported as a count because "it worked" and "there was nothing to remove" look identical
 * otherwise, and pruning is exactly the operation where people want to see that it did something.
 */
export async function pruneMail(options: {
  store: MailStore
  months: number
  semantic?: { writer: VectorIndexWriter; collection: string }
  now?: number
  signal?: AbortSignal
}): Promise<{ removed: number; kept: number }> {
  const records = await options.store.load()
  const { kept, removed } = pruneOlderThan(records, options.months, options.now ?? Date.now())
  if (removed.length === 0) return { removed: 0, kept: kept.length }

  if (options.semantic !== undefined) {
    await options.semantic.writer.deleteByPaths(
      options.semantic.collection,
      removed.map((record) => `mail:${record.id}`),
      options.signal,
    )
  }
  await options.store.replace(kept)
  return { removed: removed.length, kept: kept.length }
}

/**
 * Embeds these records and writes them, reporting as it goes.
 *
 * Extracted so the ordinary sync and a forced refresh cannot drift apart on how a message becomes
 * searchable — the id in `path`, the empty-text skip, the abort check between messages. Two copies
 * of this is the shape that has cost this project the most, and the second copy was about to be
 * written.
 */
async function embedRecords(
  records: readonly MailRecord[],
  options: Pick<MailSyncOptions, 'semantic' | 'signal' | 'onProgress'>,
): Promise<number> {
  if (options.semantic === undefined) return 0
  const { embedder, writer, collection } = options.semantic
  await writer.ensureCollection(collection, embedder.dimensions, options.signal)

  const documents: VectorDocument[] = []
  for (const record of records) {
    // Checked between messages rather than only at the boundaries: a mailbox with a thousand
    // new messages would otherwise ignore Stop for the length of the whole batch.
    if (options.signal?.aborted === true) throw new Error('Stopped.')
    options.onProgress?.(documents.length, records.length, 'Embedding messages')
    const text = mailEmbedText(record)
    if (text.trim().length === 0) continue
    documents.push({
      id: `mail:${record.id}`,
      text,
      // The id travels in `path`, which is how a hit is joined back to its facts.
      path: `mail:${record.id}`,
      startLine: 1,
      endLine: 1,
      vector: await embedder.embed(text),
    })
  }
  if (documents.length === 0) return 0
  await writer.upsert(collection, documents, options.signal)
  return documents.length
}
