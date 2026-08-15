import type { VectorStoreKind } from '../../config/schema.js'
import type { HttpClient } from '../../platform/http.js'
import { isSafeCollectionName, RestTransport } from '../restTransport.js'
import {
  VectorStoreError,
  type VectorDocument,
  type VectorIndexWriter,
  type VectorMatch,
  type VectorSearchOptions,
  type VectorSearcher,
  type VectorStoreConnection,
} from '../vectorStore.js'

/**
 * Chroma, over its v2 REST API.
 *
 * No `chromadb` client, for invariant 2's reason: it brings its own HTTP stack, and every
 * byte has to leave through core's `HttpClient` or mutual TLS and corporate CAs stop working.
 *
 * ## What makes Chroma awkward, and how each is handled
 *
 * 1. **Operations are keyed by collection *id*, not name.** Every call needs a UUID obtained
 *    by looking the name up first, so the id is resolved once and cached per instance.
 * 2. **v1 was removed in Chroma 1.0.** Only v2 is spoken here — the tenant/database path
 *    form. A pre-1.0 server answers 404 or 410, and the error says so rather than leaving
 *    "not found" to be read as "no collection".
 * 3. **Distance, not similarity.** Chroma returns distances where the seam wants a score
 *    where higher is better, so it is inverted. Only the ordering is comparable across
 *    backends, which `VectorMatch.score` already says.
 */

/** Chroma's own defaults. Overridable, because a shared deployment usually is not on them. */
const DEFAULT_TENANT = 'default_tenant'
const DEFAULT_DATABASE = 'default_database'

/** Recorded in the collection's metadata, so a collection this did not create is refused. */
const OWNER_KEY = 'created_by'
const OWNER_VALUE = 'light-code'

interface ChromaCollection {
  id?: string
  name?: string
  metadata?: Record<string, unknown> | null
}

abstract class ChromaBase {
  protected readonly rest: RestTransport
  private readonly ids = new Map<string, string>()

  constructor(
    http: HttpClient,
    connection: VectorStoreConnection,
    private readonly tenant: string = DEFAULT_TENANT,
    private readonly database: string = DEFAULT_DATABASE,
  ) {
    this.rest = new RestTransport(http, connection)
  }

  protected get base(): string {
    return `/api/v2/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(this.database)}`
  }

  protected assertName(collection: string): void {
    if (!isSafeCollectionName(collection)) {
      throw new VectorStoreError(`"${collection}" is not a valid Chroma collection name.`)
    }
  }

  /** The collection record, or undefined when it does not exist. */
  protected async lookup(collection: string, signal?: AbortSignal): Promise<ChromaCollection | undefined> {
    const result = await this.rest.send<ChromaCollection | { error?: string }>(
      `${this.base}/collections/${encodeURIComponent(collection)}`,
      'GET',
      undefined,
      signal,
    )
    if (result.status === 404) return undefined
    if (result.status === 410 || result.status === 501) {
      throw new VectorStoreError(
        `${this.rest.label} does not speak the Chroma v2 API. Light Code needs Chroma 1.0 or newer — ` +
          'the v1 endpoints were removed upstream and are not implemented here.',
        result.status,
      )
    }
    if (result.status < 200 || result.status >= 300) {
      throw new VectorStoreError(
        `Could not read collection "${collection}" from ${this.rest.label} (HTTP ${String(result.status)}).`,
        result.status,
      )
    }
    const body = result.body as ChromaCollection
    return typeof body.id === 'string' ? body : undefined
  }

  /**
   * The collection's id, cached.
   *
   * Cached per adapter instance rather than globally: an instance lives for one indexing run
   * or one search, so a collection deleted and recreated between runs is looked up again.
   */
  protected async idFor(collection: string, signal?: AbortSignal): Promise<string> {
    this.assertName(collection)
    const cached = this.ids.get(collection)
    if (cached !== undefined) return cached

    const found = await this.lookup(collection, signal)
    if (found?.id === undefined) {
      throw new VectorStoreError(
        `Chroma collection "${collection}" does not exist on ${this.rest.label}.`,
        404,
      )
    }
    this.ids.set(collection, found.id)
    return found.id
  }

  protected forget(collection: string): void {
    this.ids.delete(collection)
  }
}

export class ChromaSearcher extends ChromaBase implements VectorSearcher {
  readonly kind: VectorStoreKind = 'chroma'

  get label(): string {
    return this.rest.label
  }

  async searchByVector(
    collection: string,
    vector: readonly number[],
    options: VectorSearchOptions,
  ): Promise<VectorMatch[]> {
    const id = await this.idFor(collection, options.signal)
    const prefix = options.pathPrefix?.trim()
    const filtering = prefix !== undefined && prefix.length > 0

    const result = await this.rest.expectOk<{
      ids?: string[][]
      distances?: number[][]
      documents?: (string | null)[][]
      metadatas?: (Record<string, unknown> | null)[][]
    }>(
      `${this.base}/collections/${id}/query`,
      'POST',
      {
        query_embeddings: [[...vector]],
        /*
         * Over-fetch when filtering. Chroma's `where` could express a prefix only as an
         * equality or an `$in`, neither of which is a prefix — so it is applied here, and the
         * seam explicitly allows an adapter to ask its engine for more than it returns.
         */
        n_results: filtering ? Math.min(options.size * 10, 500) : options.size,
        include: ['documents', 'metadatas', 'distances'],
      },
      options.signal,
    )

    // Chroma answers one row per query embedding; one was sent, so the first row is the one.
    const ids = result.ids?.[0] ?? []
    const distances = result.distances?.[0] ?? []
    const documents = result.documents?.[0] ?? []
    const metadatas = result.metadatas?.[0] ?? []

    const matches: VectorMatch[] = []
    for (let index = 0; index < ids.length; index++) {
      const metadata = metadatas[index] ?? {}
      const path = typeof metadata.path === 'string' ? metadata.path : undefined
      if (path === undefined) continue
      if (filtering && !path.startsWith(prefix)) continue

      const distance = distances[index]
      const match: VectorMatch = {
        id: ids[index] ?? '',
        /*
         * Inverted, because Chroma returns a distance and the seam wants "higher is better".
         * `1 / (1 + d)` is monotonic and stays finite at zero, which is what matters — only
         * the ordering is comparable between backends anyway.
         */
        score: typeof distance === 'number' ? 1 / (1 + Math.max(0, distance)) : 0,
        text: documents[index] ?? (typeof metadata.text === 'string' ? metadata.text : ''),
        path,
      }
      if (typeof metadata.startLine === 'number') match.startLine = metadata.startLine
      if (typeof metadata.endLine === 'number') match.endLine = metadata.endLine
      matches.push(match)
      if (matches.length >= options.size) break
    }
    return matches
  }
}

export class ChromaIndexWriter extends ChromaBase implements VectorIndexWriter {
  readonly kind: VectorStoreKind = 'chroma'

  /**
   * Refuses to write to a collection Light Code did not create.
   *
   * Chroma has collection metadata, so unlike Qdrant this needs no marker record — the same
   * property OpenSearch gets from `_meta.createdBy`, and for the same reason: a mistyped name
   * must not start overwriting somebody else's vectors.
   */
  private assertOwned(collection: string, found: ChromaCollection): void {
    if (found.metadata?.[OWNER_KEY] !== OWNER_VALUE) {
      throw new VectorStoreError(
        `Refusing to write to Chroma collection "${collection}": it was not created by Light Code. ` +
          'Choose a different name — indexing only ever writes to a collection it made itself.',
      )
    }
  }

  async ensureCollection(collection: string, dimensions: number, signal?: AbortSignal): Promise<void> {
    this.assertName(collection)

    const existing = await this.lookup(collection, signal)
    if (existing !== undefined) {
      this.assertOwned(collection, existing)
      const width = existing.metadata?.dimensions
      /*
       * Chroma infers width from the first vector written and rejects later ones that differ,
       * with an error that does not mention the model. Recording it at creation turns that
       * into a sentence naming the real cause.
       */
      if (typeof width === 'number' && width !== dimensions) {
        throw new VectorStoreError(
          `Collection "${collection}" stores ${String(width)}-dimensional vectors, but the configured ` +
            `embedding model produces ${String(dimensions)}. Chroma fixes the width at the first write. ` +
            'Use a different collection name so a new one is made for this model.',
        )
      }
      return
    }

    await this.rest.expectOk(
      `${this.base}/collections`,
      'POST',
      {
        name: collection,
        metadata: { [OWNER_KEY]: OWNER_VALUE, dimensions },
        get_or_create: true,
        // Vectors are supplied directly; Chroma must not try to embed anything itself, which
        // would mean a second embedding model and a silent mismatch with the stored ones.
        configuration: { embedding_function: null },
      },
      signal,
    )
    this.forget(collection)
  }

  private async ownedId(collection: string, signal?: AbortSignal): Promise<string> {
    const found = await this.lookup(collection, signal)
    if (found?.id === undefined) {
      throw new VectorStoreError(`Chroma collection "${collection}" does not exist on ${this.rest.label}.`, 404)
    }
    this.assertOwned(collection, found)
    return found.id
  }

  async upsert(collection: string, documents: readonly VectorDocument[], signal?: AbortSignal): Promise<void> {
    this.assertName(collection)
    if (documents.length === 0) return
    const id = await this.ownedId(collection, signal)

    await this.rest.expectOk(
      `${this.base}/collections/${id}/upsert`,
      'POST',
      {
        ids: documents.map((document) => document.id),
        embeddings: documents.map((document) => document.vector),
        documents: documents.map((document) => document.text),
        metadatas: documents.map((document) => ({
          path: document.path,
          startLine: document.startLine,
          endLine: document.endLine,
        })),
      },
      signal,
    )
  }

  async deleteByPaths(collection: string, paths: readonly string[], signal?: AbortSignal): Promise<void> {
    this.assertName(collection)
    if (paths.length === 0) return
    const id = await this.ownedId(collection, signal)

    await this.rest.expectOk(
      `${this.base}/collections/${id}/delete`,
      'POST',
      // `$in` rather than one request per path: a reindex after a large delete would otherwise
      // be hundreds of round trips.
      { where: { path: { $in: [...paths] } } },
      signal,
    )
  }

  async listPaths(collection: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<string[]> {
    this.assertName(collection)
    const limit = options.limit ?? 10_000

    const found = await this.lookup(collection, options.signal)
    // Not an error: an unindexed collection is the ordinary first run.
    if (found?.id === undefined) return []

    const result = await this.rest.expectOk<{ metadatas?: (Record<string, unknown> | null)[] }>(
      `${this.base}/collections/${found.id}/get`,
      'POST',
      { include: ['metadatas'], limit },
      options.signal,
    )

    const paths = new Set<string>()
    for (const metadata of result.metadatas ?? []) {
      const path = metadata?.path
      if (typeof path === 'string') paths.add(path)
    }
    return [...paths]
  }
}
