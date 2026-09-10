import type { Embedder } from '../rag/embedder.js'
import type { VectorDocument, VectorIndexWriter } from '../rag/vectorStore.js'
import { parseStatusTag, pruneOlderThan, type MailRecord } from './mailIndex.js'
import { resumePoints, withoutKnown, type MailStore } from './mailStore.js'

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
    requests: readonly { path: string; sinceMs?: number }[],
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
  /** Messages per pass. Bounded so a first run over a large mailbox does not stall the timer. */
  batchLimit?: number
  signal?: AbortSignal
}

export interface HarvestedMessage {
  id: string
  subject: string
  sender: string
  receivedAt: number
  folder: string
  preview: string
}

export interface MailSyncResult {
  added: number
  /** True when the batch limit was reached, so the caller knows to run again. */
  more: boolean
  total: number
  embedded: number
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

export async function syncMail(options: MailSyncOptions): Promise<MailSyncResult> {
  const known = await options.store.load()
  const marks = resumePoints(known)

  const requests = options.folders.map((path) => {
    const sinceMs = marks.get(path)
    return sinceMs === undefined ? { path } : { path, sinceMs }
  })

  const limit = options.batchLimit ?? 500
  const harvested = await options.harvest(requests, {
    limit,
    previewChars: options.previewChars ?? 400,
  })

  const fresh = withoutKnown(harvested.messages.map(toRecord), known)
  if (fresh.length === 0) {
    return { added: 0, more: harvested.truncated, total: known.length, embedded: 0 }
  }

  /*
   * Embedded *before* being recorded, so a failure leaves the message unrecorded and it is
   * collected again next pass. Recording first would mark it done and leave it permanently
   * absent from semantic search, with nothing to indicate it — the facts would be complete and
   * the meaning quietly missing.
   */
  let embedded = 0
  if (options.semantic !== undefined) {
    const { embedder, writer, collection } = options.semantic
    await writer.ensureCollection(collection, embedder.dimensions, options.signal)

    const documents: VectorDocument[] = []
    for (const record of fresh) {
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
    if (documents.length > 0) {
      await writer.upsert(collection, documents, options.signal)
      embedded = documents.length
    }
  }

  await options.store.append(fresh)
  return {
    added: fresh.length,
    more: harvested.truncated,
    total: known.length + fresh.length,
    embedded,
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
