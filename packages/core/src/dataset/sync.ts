import type { Embedder } from '../rag/embedder.js'
import type { VectorDocument, VectorIndexWriter } from '../rag/vectorStore.js'
import { DatasetStore, partitionByAge } from './store.js'
import { parseDatasetPayload, type DatasetRecord } from './types.js'

/** How a record is turned into the text that gets embedded. */
export function datasetEmbedText(record: DatasetRecord): string {
  return [record.title, record.text].filter((part) => part !== undefined && part.length > 0).join('\n')
}

/** The id a record's vector is stored under. Prefixed so one collection can hold several corpora. */
export function datasetVectorId(datasetId: string, recordId: string): string {
  return `data:${datasetId}:${recordId}`
}

export interface DatasetSyncOptions {
  datasetId: string
  store: DatasetStore
  /** Runs the collector and returns whatever it produced, unparsed. */
  collect: (since: number | undefined) => Promise<unknown>
  semantic?: {
    embedder: Embedder
    writer: VectorIndexWriter
    collection: string
  }
  retentionDays?: number | undefined
  signal?: AbortSignal | undefined
  onProgress?: ((done: number, total: number, phase: string) => void) | undefined
  now?: number | undefined
}

export interface DatasetSyncResult {
  collected: number
  /** How many were new or changed. A record identical to the one held is not re-embedded. */
  updated: number
  embedded: number
  removed: number
  total: number
}

/**
 * Runs a collector and folds what it returned into the dataset.
 *
 * ## Why unchanged records are not re-embedded
 *
 * A collector that returns everything each time is the ordinary case — most sources have no
 * "changed since" and asking users to build one would be the wrong trade. But embedding is the
 * expensive part, and re-embedding an unchanged record buys nothing at all. So each record is
 * compared against what is held and only genuinely different ones are sent. That turns "return
 * everything every hour" from ruinous into nearly free, which is what makes the simple collector
 * the right one to write.
 *
 * ## Why embedding happens before recording
 *
 * §12f's rule, for the same reason: recording first would mark a record done even when its
 * embedding failed, leaving it permanently absent from search with the facts complete and the
 * meaning quietly missing.
 */
export async function syncDataset(options: DatasetSyncOptions): Promise<DatasetSyncResult> {
  const now = options.now ?? Date.now()
  const held = await options.store.load()
  const heldById = new Map(held.map((record) => [record.id, record]))

  options.onProgress?.(0, 0, 'Running the collector')
  const since = await options.store.lastSyncedAt()
  const payload = await options.collect(since)

  const parsed = parseDatasetPayload(payload)
  if ('error' in parsed) throw new Error(parsed.error)
  const collected = parsed.records

  /*
   * Changed means "differs from what is held", compared on the serialised record.
   *
   * Not on `text` alone: a title or a url that changed is a change worth storing, even though it
   * would not alter the embedding. The embedding is skipped separately, below, when only
   * non-embedded fields moved.
   */
  const changed = collected.filter((record) => {
    const existing = heldById.get(record.id)
    return existing === undefined || JSON.stringify(existing) !== JSON.stringify(record)
  })

  let embedded = 0
  if (options.semantic !== undefined && changed.length > 0) {
    const { embedder, writer, collection } = options.semantic
    await writer.ensureCollection(collection, embedder.dimensions, options.signal)

    const documents: VectorDocument[] = []
    for (const record of changed) {
      // Checked per record rather than at the boundaries: a first sync of ten thousand records
      // would otherwise ignore Stop for the whole run.
      if (options.signal?.aborted === true) throw new Error('Stopped.')
      options.onProgress?.(documents.length, changed.length, 'Embedding new and changed records')

      const existing = heldById.get(record.id)
      // Only the embedded text matters here. A url that changed needs storing, not re-embedding.
      if (existing !== undefined && datasetEmbedText(existing) === datasetEmbedText(record)) continue

      const text = datasetEmbedText(record)
      if (text.trim().length === 0) continue
      documents.push({
        id: datasetVectorId(options.datasetId, record.id),
        text,
        // The id travels in `path`, which is how a hit is joined back to its record.
        path: datasetVectorId(options.datasetId, record.id),
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

  if (changed.length > 0) await options.store.append(changed)

  // ---------------------------------------------------------------- retention
  let removed = 0
  if (options.retentionDays !== undefined) {
    const cutoff = now - options.retentionDays * 24 * 60 * 60 * 1000
    const after = await options.store.load()
    const { kept, removed: old } = partitionByAge(after, cutoff)
    if (old.length > 0) {
      options.onProgress?.(0, old.length, 'Removing records past retention')
      // Vectors first, then the facts — §12f's ordering. The facts are what name the vectors, so
      // clearing them first would strand every one of them with nothing left that knows their ids.
      if (options.semantic !== undefined) {
        await options.semantic.writer.deleteByPaths(
          options.semantic.collection,
          old.map((record) => datasetVectorId(options.datasetId, record.id)),
          options.signal,
        )
      }
      await options.store.replace(kept)
      removed = old.length
    }
  }

  /*
   * Compacted only when it would actually shrink the file.
   *
   * Append-as-upsert means a record refreshed hourly adds a line hourly, so without this the file
   * grows with the number of syncs rather than the size of the corpus.
   */
  await options.store.compact()

  await options.store.recordSync(now)
  const total = (await options.store.load()).length
  return { collected: collected.length, updated: changed.length, embedded, removed, total }
}

/**
 * Throws the dataset away, vectors first.
 *
 * Takes the sync watermark with it, so a rebuild asks the collector for everything rather than
 * for "what changed since the run before the one that was deleted".
 */
export async function clearDataset(options: {
  datasetId: string
  store: DatasetStore
  semantic?: { writer: VectorIndexWriter; collection: string } | undefined
  signal?: AbortSignal | undefined
  onProgress?: ((done: number, total: number, phase: string) => void) | undefined
}): Promise<{ removed: number }> {
  const held = await options.store.load()
  if (options.semantic !== undefined && held.length > 0) {
    const size = 500
    const paths = held.map((record) => datasetVectorId(options.datasetId, record.id))
    for (let start = 0; start < paths.length; start += size) {
      if (options.signal?.aborted === true) throw new Error('Stopped.')
      options.onProgress?.(Math.min(start + size, paths.length), paths.length, 'Removing vectors')
      await options.semantic.writer.deleteByPaths(
        options.semantic.collection,
        paths.slice(start, start + size),
        options.signal,
      )
    }
  }
  await options.store.clear()
  return { removed: held.length }
}
