import type { VectorStoreKind } from '../config/schema.js'
import type { TlsOptions } from '../platform/http.js'

/**
 * The backend-neutral seam for Light Code's own vector corpus.
 *
 * ## Why this is two interfaces and not one
 *
 * The read/write split between `OpenSearchClient` and `OpenSearchIndexWriter` is a security
 * property, not a filing decision: the object a tool receives must have **no way to express
 * a write**, so that no future edit can turn a chat message into a deleted index. Collapsing
 * both halves into one `VectorStore` interface would hand `search_codebase` an `upsert`
 * method and throw that away.
 *
 * So the seam preserves the split it found. `VectorSearcher` is what a tool gets;
 * `VectorIndexWriter` is what the indexer gets, and nothing in the tool path constructs one.
 *
 * ## What is deliberately NOT behind this seam
 *
 * `search_docs` — querying the organisation's *existing* indexes with raw OpenSearch DSL,
 * plus `_cat/indices` and mapping introspection — has no counterpart in Qdrant or Chroma,
 * which store points in collections rather than documents in mapped indexes. Forcing it
 * through a neutral interface would mean inventing a query language and translating it,
 * which §11 already names as a silent-failure source. It stays on `OpenSearchClient` and is
 * offered only when the active store is an OpenSearch cluster.
 *
 * The neutral term for a named bucket of vectors is **collection**. OpenSearch calls it an
 * index, Qdrant and Chroma call it a collection; the adapter maps.
 */

/**
 * Where a store lives and how to reach it, with secrets already resolved by the host.
 *
 * One shape for every backend: they all take a URL, optional basic credentials and the TLS
 * material the one resolver in `platform/connectionTls.ts` produced. Two near-identical
 * connection interfaces would be exactly the drift §15's single-schema rule exists to
 * prevent, so `OpenSearchConnection` is an alias of this rather than a copy of it.
 */
export interface VectorStoreConnection {
  url: string
  username?: string
  password?: string
  tls?: TlsOptions
  /** The configured store's label, used in user-facing messages. Falls back to the URL. */
  label?: string
}

/** A chunk as stored. Identical across backends — the indexer produces exactly this. */
export interface VectorDocument {
  id: string
  text: string
  path: string
  startLine: number
  endLine: number
  vector: number[]
}

/** A hit, already flattened. Backends disagree about where payload lives; adapters resolve it. */
export interface VectorMatch {
  id: string
  /** Higher is better, in whatever scale the backend uses. Only the ordering is comparable. */
  score: number
  text: string
  path: string
  startLine?: number
  endLine?: number
}

export interface VectorSearchOptions {
  /** Hits wanted. An adapter may ask its engine for more, but returns at most this many. */
  size: number
  /** Restrict to a subtree, e.g. `packages/core/src`. */
  pathPrefix?: string
  signal?: AbortSignal
}

/**
 * The read half — the only vector-store capability a tool is ever handed.
 *
 * There is no write method here, and that absence is the point.
 */
export interface VectorSearcher {
  readonly kind: VectorStoreKind
  /** The configured connection's label, for "nothing indexed yet" messages. */
  readonly label: string
  searchByVector(collection: string, vector: readonly number[], options: VectorSearchOptions): Promise<VectorMatch[]>
}

/**
 * The write half. Constructed only by the indexer, which a user starts from Settings.
 *
 * An implementation must refuse to write to a collection it did not create — a cluster runs
 * indexes the organisation depends on, and "the indexer had a bug" must never be able to
 * mean "your production logs were overwritten".
 */
export interface VectorIndexWriter {
  readonly kind: VectorStoreKind
  /**
   * Creates the collection if absent, with a vector field of the given width.
   *
   * Must reject an existing collection whose width differs: every backend fixes vector width
   * at creation, so a changed embedding model otherwise fails on each write with an error
   * that never mentions the real cause.
   */
  ensureCollection(collection: string, dimensions: number, signal?: AbortSignal): Promise<void>
  /** Upserts by id, so re-indexing a changed file replaces its chunks rather than duplicating. */
  upsert(collection: string, documents: readonly VectorDocument[], signal?: AbortSignal): Promise<void>
  /** Removes the chunks of files that no longer exist. */
  deleteByPaths(collection: string, paths: readonly string[], signal?: AbortSignal): Promise<void>
  /**
   * The distinct `path` values currently stored, so a caller can work out what has gone.
   *
   * **On the writer rather than the searcher, deliberately.** Reconciling a collection against
   * a fresh corpus is the writer's job, and the searcher is the object handed to tools — it
   * stays as small as possible. A tool has no business enumerating an index.
   *
   * Needed because the documentation corpus has no manifest: the workspace indexer tracks
   * what it wrote last time and can diff locally, but the tool and skill corpus is rebuilt
   * wholesale each run, so the only way to know a tool has disappeared is to ask. Returning
   * an empty array for a collection that does not exist yet is correct — that is the ordinary
   * first-run case, not an error.
   *
   * `limit` is a safety cap rather than pagination. The corpora this reconciles are hundreds
   * of entries, not millions; a backend that truncates should not pretend otherwise, so an
   * implementation must cap rather than silently return a partial answer as if complete.
   */
  listPaths(collection: string, options?: { limit?: number; signal?: AbortSignal }): Promise<string[]>
  /**
   * Every stored document, vectors included, a page at a time.
   *
   * **On the writer, like `listPaths`, and for the same reason.** Reading a whole collection
   * back — with its vectors — is a bulk-export capability, and the object handed to tools must
   * not have one. A tool that could page through the index could exfiltrate the entire
   * embedded codebase through the chat, which is precisely the shape of thing the read/write
   * split exists to make impossible.
   *
   * Exists so one store can be copied into another without paying to re-embed. `cursor` is
   * opaque and backend-defined; the caller passes back whatever it was given until `next` is
   * undefined. Returning an empty page for a collection that does not exist is correct — that
   * is the ordinary "nothing to copy" case, not an error.
   */
  scan(
    collection: string,
    options?: { cursor?: unknown; pageSize?: number; signal?: AbortSignal },
  ): Promise<{ documents: VectorDocument[]; next?: unknown }>
}

/**
 * The base class for every backend's errors.
 *
 * Callers that do not care which backend failed — the indexer, the tools, the bridge — catch
 * this. `OpenSearchError` extends it, so adding a backend does not mean revisiting every
 * `catch`.
 */
export class VectorStoreError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'VectorStoreError'
  }
}
