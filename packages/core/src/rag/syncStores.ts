import type { IndexManifest } from './indexer.js'
import { VectorStoreError, type VectorIndexWriter } from './vectorStore.js'

/**
 * Copying an index from one vector store to another.
 *
 * ## Why this exists rather than "just reindex"
 *
 * Reindexing is always correct and is the right answer most of the time. But it re-embeds
 * every chunk, which costs money where embedding is billed and costs *time* everywhere — a
 * large repository is minutes to hours. The vectors already exist; moving between backends
 * should not mean paying to compute them twice.
 *
 * ## The one thing that makes this safe, and the one that makes it dangerous
 *
 * A vector is only meaningful alongside vectors from the same embedding model. Copy vectors
 * made by model A into a collection later queried with model B and every search returns
 * confident nonsense — no error, no warning, just quietly wrong neighbours. That is the worst
 * failure shape in the whole product, so the copy **refuses** unless the source manifest's
 * model, width and chunking match what is configured now.
 *
 * The manifest already records all three, because the indexer needs them to decide when a
 * re-chunk is required. So the guard costs nothing to have and is the reason a sync can be
 * offered at all.
 *
 * ## What it does not do
 *
 * It does not delete anything from the source, and it does not touch the destination beyond
 * the collection it writes. Both writers already refuse a collection Light Code did not
 * create, so the ownership rule holds without anything extra here.
 */

export interface SyncProgress {
  copied: number
  /** Undefined until the source has been walked; there is no count to ask for up front. */
  total?: number
}

export interface SyncOptions {
  from: VectorIndexWriter
  to: VectorIndexWriter
  /** The same collection name on both sides — it is derived from the workspace, not the store. */
  collection: string
  /** The source's manifest, whose embedder fingerprint is what makes the copy safe. */
  manifest: IndexManifest | undefined
  /** What is configured *now*. A copy into a differently-embedded world is refused. */
  current: { model: string; dimensions: number; chunkSignature?: string }
  onProgress?: (progress: SyncProgress) => void
  signal?: AbortSignal
  /** Documents per round trip. Small enough that a slow link still shows progress. */
  pageSize?: number
}

export interface SyncResult {
  copied: number
  collection: string
}

/**
 * Refuses a copy that would mix embeddings, naming which part disagrees.
 *
 * Returned rather than thrown so the caller can show it as a sentence: this is a decision the
 * user has to act on — reindex instead — not an error in the machinery.
 */
export function describeSyncMismatch(
  manifest: IndexManifest | undefined,
  current: { model: string; dimensions: number; chunkSignature?: string },
): string | undefined {
  if (manifest === undefined) {
    return (
      'There is no record of how that store was indexed, so its vectors cannot be shown to ' +
      'match the embedding model configured now. Index the new store directly instead.'
    )
  }
  if (manifest.model !== current.model) {
    return (
      `That store was indexed with "${manifest.model}" and the configured model is now ` +
      `"${current.model}". Vectors from different models cannot be compared — copying them ` +
      'would make every search quietly wrong. Index the new store directly instead.'
    )
  }
  if (manifest.dimensions !== current.dimensions) {
    return (
      `That store holds ${String(manifest.dimensions)}-dimensional vectors and the configured ` +
      `model produces ${String(current.dimensions)}. Index the new store directly instead.`
    )
  }
  if (current.chunkSignature !== undefined && manifest.chunkSignature !== current.chunkSignature) {
    return (
      'That store was indexed with different chunking, so its entries would not line up with ' +
      'newly indexed ones. Index the new store directly instead.'
    )
  }
  return undefined
}

/**
 * Copies every document from one store's collection into another's.
 *
 * Streamed page by page rather than gathered first: a large index is hundreds of megabytes of
 * float arrays, and holding it all in memory to write it once would be the one operation that
 * could take the extension host down.
 */
export async function syncVectorStores(options: SyncOptions): Promise<SyncResult> {
  const mismatch = describeSyncMismatch(options.manifest, options.current)
  if (mismatch !== undefined) throw new VectorStoreError(mismatch)

  await options.to.ensureCollection(options.collection, options.current.dimensions, options.signal)

  let cursor: unknown
  let copied = 0

  for (;;) {
    options.signal?.throwIfAborted()

    const page = await options.from.scan(options.collection, {
      ...(cursor === undefined ? {} : { cursor }),
      pageSize: options.pageSize ?? 256,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })

    if (page.documents.length > 0) {
      await options.to.upsert(options.collection, page.documents, options.signal)
      copied += page.documents.length
      options.onProgress?.({ copied })
    }

    if (page.next === undefined || page.next === null) break
    cursor = page.next
  }

  return { copied, collection: options.collection }
}
