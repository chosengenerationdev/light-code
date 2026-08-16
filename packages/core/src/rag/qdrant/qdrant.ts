import { createHash } from 'node:crypto'

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
 * Qdrant, over its REST API.
 *
 * No `@qdrant/js-client-rest`: it carries its own HTTP stack, and invariant 2 requires every
 * byte to leave through core's one `HttpClient` — which is what makes mutual TLS, a corporate
 * CA and the proxy settings work here at all. The API is a handful of JSON endpoints.
 *
 * ## Three things Qdrant does differently, each of which shapes the code below
 *
 * 1. **Point ids must be unsigned integers or UUIDs.** Ours are strings like
 *    `packages/core/src/a.ts:3`. They are hashed to a deterministic UUID and the real id is
 *    kept in the payload, so re-indexing the same chunk still overwrites rather than
 *    duplicating.
 * 2. **A collection has nowhere to record who made it.** OpenSearch has `_meta`; Qdrant does
 *    not, so ownership is a marker *point* with a fixed id — see `MARKER_ID`.
 * 3. **Prefix filtering is not free.** `path` would need a full-text index to filter on
 *    server-side, so a prefix search over-fetches and filters here. The interface allows
 *    exactly this, and it is why it says an adapter may ask its engine for more.
 */

/** Authentication is a header rather than Basic, so the password doubles as the API key. */
function apiKeyHeader(connection: VectorStoreConnection): Record<string, string> {
  const { username, password } = connection
  // Only when there is no username: with both set the user means Basic, which the transport
  // already sends, and adding an api-key would be a second credential they did not ask for.
  if ((username === undefined || username.length === 0) && password !== undefined && password.length > 0) {
    return { 'api-key': password }
  }
  return {}
}

/**
 * A deterministic UUID for an arbitrary string id.
 *
 * Shaped as a v5 UUID (a SHA-1 digest with the version and variant bits set), so it is a
 * legal UUID rather than something that merely looks like one — Qdrant validates.
 */
export function pointIdFor(id: string): string {
  const hash = createHash('sha1').update(`light-code:${id}`).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The ownership marker's point id — a fixed UUID, so it can be looked up without a search.
 *
 * A collection Light Code created contains this point; one it did not, does not. That is the
 * same property OpenSearch gets from `_meta.createdBy`, and it exists for the same reason: a
 * mistyped collection name must not start overwriting somebody's production vectors.
 *
 * It carries no `path`, which is how reads drop it — see `toMatch`.
 */
const MARKER_ID = '5f6d2a41-0000-5000-8000-6c69676874c0'
const MARKER_MARK = 'light-code'

interface QdrantPoint {
  id: string
  payload?: Record<string, unknown>
  score?: number
  vector?: number[]
}

function toMatch(point: QdrantPoint): VectorMatch | undefined {
  const payload = point.payload ?? {}
  const path = typeof payload.path === 'string' ? payload.path : undefined
  // No path means the marker point, or something this did not write. Either way it is not a
  // result, and returning it would put an internal record in front of the model.
  if (path === undefined) return undefined

  const match: VectorMatch = {
    id: typeof payload.chunkId === 'string' ? payload.chunkId : point.id,
    score: typeof point.score === 'number' ? point.score : 0,
    text: typeof payload.text === 'string' ? payload.text : '',
    path,
  }
  if (typeof payload.startLine === 'number') match.startLine = payload.startLine
  if (typeof payload.endLine === 'number') match.endLine = payload.endLine
  return match
}

abstract class QdrantBase {
  protected readonly rest: RestTransport

  constructor(http: HttpClient, connection: VectorStoreConnection) {
    this.rest = new RestTransport(http, connection, () => apiKeyHeader(connection))
  }

  protected assertName(collection: string): void {
    if (!isSafeCollectionName(collection)) {
      throw new VectorStoreError(`"${collection}" is not a valid Qdrant collection name.`)
    }
  }

  protected collectionPath(collection: string): string {
    return `/collections/${encodeURIComponent(collection)}`
  }
}

export class QdrantSearcher extends QdrantBase implements VectorSearcher {
  readonly kind: VectorStoreKind = 'qdrant'

  get label(): string {
    return this.rest.label
  }

  async searchByVector(
    collection: string,
    vector: readonly number[],
    options: VectorSearchOptions,
  ): Promise<VectorMatch[]> {
    this.assertName(collection)
    const prefix = options.pathPrefix?.trim()
    const filtering = prefix !== undefined && prefix.length > 0

    const body = {
      vector: [...vector],
      /*
       * Over-fetch when filtering, because the prefix is applied here rather than by the
       * engine — asking for exactly `size` would return fewer than that as soon as anything
       * is filtered out. Capped so a deep subtree cannot pull an unbounded page.
       */
      limit: filtering ? Math.min(options.size * 10, 500) : options.size,
      with_payload: true,
      with_vector: false,
    }

    const result = await this.rest.expectOk<{ result?: QdrantPoint[] }>(
      `${this.collectionPath(collection)}/points/search`,
      'POST',
      body,
      options.signal,
    )

    const matches: VectorMatch[] = []
    for (const point of result.result ?? []) {
      const match = toMatch(point)
      if (match === undefined) continue
      if (filtering && !match.path.startsWith(prefix)) continue
      matches.push(match)
      if (matches.length >= options.size) break
    }
    return matches
  }
}

export class QdrantIndexWriter extends QdrantBase implements VectorIndexWriter {
  readonly kind: VectorStoreKind = 'qdrant'

  /** The width the collection was created with, or undefined when it does not exist. */
  private async vectorSize(collection: string, signal?: AbortSignal): Promise<number | undefined> {
    const result = await this.rest.send<{
      result?: { config?: { params?: { vectors?: { size?: number } | Record<string, { size?: number }> } } }
    }>(this.collectionPath(collection), 'GET', undefined, signal)

    if (result.status === 404) return undefined
    if (result.status < 200 || result.status >= 300) {
      throw new VectorStoreError(`Could not read collection "${collection}" (HTTP ${String(result.status)}).`, result.status)
    }

    const vectors = result.body.result?.config?.params?.vectors
    if (vectors === undefined) return undefined
    // A collection can be configured with a single unnamed vector or a map of named ones.
    // Only the unnamed form is written here, but reading the named form keeps the mismatch
    // error accurate rather than reporting "unknown".
    if (typeof (vectors as { size?: number }).size === 'number') return (vectors as { size: number }).size
    const first = Object.values(vectors as Record<string, { size?: number }>)[0]
    return typeof first?.size === 'number' ? first.size : undefined
  }

  /**
   * Refuses to write to a collection Light Code did not create.
   *
   * Checked before every write rather than only at creation, exactly as the OpenSearch writer
   * does: the name comes from config, and a typo naming somebody's production collection
   * would otherwise start overwriting points in it.
   */
  private async assertOwned(collection: string, signal?: AbortSignal): Promise<void> {
    const result = await this.rest.send<{ result?: QdrantPoint[] }>(
      `${this.collectionPath(collection)}/points`,
      'POST',
      { ids: [MARKER_ID], with_payload: true },
      signal,
    )
    const marker = result.body?.result?.[0]?.payload?.[MARKER_MARK]
    if (result.status < 200 || result.status >= 300 || marker !== true) {
      throw new VectorStoreError(
        `Refusing to write to Qdrant collection "${collection}": it was not created by Light Code. ` +
          'Choose a different name — indexing only ever writes to a collection it made itself.',
      )
    }
  }

  async ensureCollection(collection: string, dimensions: number, signal?: AbortSignal): Promise<void> {
    this.assertName(collection)

    const existing = await this.vectorSize(collection, signal)
    if (existing !== undefined) {
      await this.assertOwned(collection, signal)
      if (existing !== dimensions) {
        throw new VectorStoreError(
          `Collection "${collection}" stores ${String(existing)}-dimensional vectors, but the configured ` +
            `embedding model produces ${String(dimensions)}. A collection's width is fixed when it is created. ` +
            'Use a different collection name so a new one is made for this model.',
        )
      }
      return
    }

    await this.rest.expectOk(
      this.collectionPath(collection),
      'PUT',
      // Cosine because the embedders in use produce normalised vectors, and it is what the
      // OpenSearch mapping uses too — a store swap should not silently change the ranking.
      { vectors: { size: dimensions, distance: 'Cosine' } },
      signal,
    )

    // The ownership marker, written immediately so a crash between creation and first upsert
    // cannot leave a collection this refuses to touch afterwards.
    await this.rest.expectOk(
      `${this.collectionPath(collection)}/points?wait=true`,
      'PUT',
      {
        points: [
          {
            id: MARKER_ID,
            // A zero vector: it must be the right width to be accepted, and it should never
            // rank against a real query.
            vector: new Array<number>(dimensions).fill(0),
            payload: { [MARKER_MARK]: true },
          },
        ],
      },
      signal,
    )
  }

  async upsert(collection: string, documents: readonly VectorDocument[], signal?: AbortSignal): Promise<void> {
    this.assertName(collection)
    if (documents.length === 0) return
    await this.assertOwned(collection, signal)

    await this.rest.expectOk(
      `${this.collectionPath(collection)}/points?wait=true`,
      'PUT',
      {
        points: documents.map((document) => ({
          id: pointIdFor(document.id),
          vector: document.vector,
          payload: {
            // The real id travels in the payload: the point id is a hash and cannot be read
            // back, and callers match on the id they supplied.
            chunkId: document.id,
            path: document.path,
            text: document.text,
            startLine: document.startLine,
            endLine: document.endLine,
          },
        })),
      },
      signal,
    )
  }

  async deleteByPaths(collection: string, paths: readonly string[], signal?: AbortSignal): Promise<void> {
    this.assertName(collection)
    if (paths.length === 0) return
    await this.assertOwned(collection, signal)

    await this.rest.expectOk(
      `${this.collectionPath(collection)}/points/delete?wait=true`,
      'POST',
      { filter: { must: [{ key: 'path', match: { any: [...paths] } }] } },
      signal,
    )
  }

  async scan(
    collection: string,
    options: { cursor?: unknown; pageSize?: number; signal?: AbortSignal } = {},
  ): Promise<{ documents: VectorDocument[]; next?: unknown }> {
    this.assertName(collection)
    const result = await this.rest.send<{ result?: { points?: QdrantPoint[]; next_page_offset?: unknown } }>(
      `${this.collectionPath(collection)}/points/scroll`,
      'POST',
      {
        limit: options.pageSize ?? 256,
        with_payload: true,
        with_vector: true,
        ...(options.cursor === undefined || options.cursor === null ? {} : { offset: options.cursor }),
      },
      options.signal,
    )
    if (result.status === 404) return { documents: [] }
    if (result.status < 200 || result.status >= 300) {
      throw new VectorStoreError(`Could not read "${collection}" (HTTP ${String(result.status)}).`, result.status)
    }

    const documents: VectorDocument[] = []
    for (const point of result.body.result?.points ?? []) {
      const payload = point.payload ?? {}
      const path = typeof payload.path === 'string' ? payload.path : undefined
      // No path is the ownership marker, which is bookkeeping rather than content.
      if (path === undefined || !Array.isArray(point.vector)) continue
      documents.push({
        id: typeof payload.chunkId === 'string' ? payload.chunkId : point.id,
        text: typeof payload.text === 'string' ? payload.text : '',
        path,
        startLine: typeof payload.startLine === 'number' ? payload.startLine : 1,
        endLine: typeof payload.endLine === 'number' ? payload.endLine : 1,
        vector: point.vector,
      })
    }

    const next = result.body.result?.next_page_offset
    return next === undefined || next === null ? { documents } : { documents, next }
  }

  async listPaths(collection: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<string[]> {
    this.assertName(collection)
    const limit = options.limit ?? 10_000
    const paths = new Set<string>()
    let offset: unknown

    /*
     * Scrolled rather than faceted. Qdrant's facet API needs a keyword index on the field,
     * which this does not create — and the corpora being reconciled are hundreds of entries,
     * so paging through them costs nothing worth optimising.
     */
    for (let page = 0; page < 100; page++) {
      const result = await this.rest.send<{ result?: { points?: QdrantPoint[]; next_page_offset?: unknown } }>(
        `${this.collectionPath(collection)}/points/scroll`,
        'POST',
        {
          limit: Math.min(1_000, limit),
          with_payload: ['path'],
          with_vector: false,
          ...(offset === undefined || offset === null ? {} : { offset }),
        },
        options.signal,
      )

      // A collection that does not exist yet is the ordinary first-run case, not an error.
      if (result.status === 404) return []
      if (result.status < 200 || result.status >= 300) {
        throw new VectorStoreError(`Could not list "${collection}" (HTTP ${String(result.status)}).`, result.status)
      }

      for (const point of result.body.result?.points ?? []) {
        const path = point.payload?.path
        if (typeof path === 'string') paths.add(path)
      }

      offset = result.body.result?.next_page_offset
      if (offset === undefined || offset === null) break
      if (paths.size >= limit) break
    }

    return [...paths]
  }
}
