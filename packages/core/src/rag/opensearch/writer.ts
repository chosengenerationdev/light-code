import type { VectorStoreKind } from '../../config/schema.js'
import type { HttpClient, HttpRequestOptions } from '../../platform/http.js'
import { describeTlsError } from '../../providers/auth/apigeeMtls.js'
import type { VectorDocument, VectorIndexWriter } from '../vectorStore.js'
import { isSafeIndexName, OpenSearchError, type OpenSearchConnection } from './client.js'

/**
 * The write half of OpenSearch access — index creation and bulk upsert.
 *
 * **Deliberately a separate class in a separate file from `OpenSearchClient`.** The client
 * a tool receives must have no way to express a write, so writing cannot live on it behind
 * a flag or a permission check that a future edit could get wrong. Nothing in the tool path
 * imports this file: it is constructed only by the indexer, which a user starts from
 * Settings.
 *
 * It also refuses to touch an index it did not create. A cluster runs indexes the
 * organisation depends on, and "the indexer had a bug" must never be able to mean "your
 * production logs were overwritten".
 */

/** Every index this writes carries it, and it refuses to write to one that lacks it. */
export const OWNED_INDEX_MARKER = 'light-code'

/**
 * What the indexer produces. Identical across backends, so it is `VectorDocument` — kept as
 * an alias because the name reads better at OpenSearch call sites and predates the seam.
 */
export type IndexedDocument = VectorDocument

export class OpenSearchIndexWriter implements VectorIndexWriter {
  readonly kind: VectorStoreKind = 'opensearch'

  constructor(
    private readonly http: HttpClient,
    private readonly connection: OpenSearchConnection,
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const { username, password } = this.connection
    if (username !== undefined && username.length > 0) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
    }
    return headers
  }

  private async request<T>(path: string, method: string, body?: string | object, signal?: AbortSignal): Promise<T> {
    const url = `${this.connection.url.replace(/\/+$/, '')}${path}`
    const request: HttpRequestOptions = { method, headers: this.headers() }
    if (body !== undefined) {
      // Bulk bodies are NDJSON and must be sent verbatim; everything else is JSON.
      if (typeof body === 'string') {
        request.headers = { ...request.headers, 'Content-Type': 'application/x-ndjson' }
        request.body = body
      } else {
        request.body = JSON.stringify(body)
      }
    }
    if (signal !== undefined) request.signal = signal
    if (this.connection.tls !== undefined) request.tls = this.connection.tls

    let response
    try {
      response = await this.http.request(url, request)
    } catch (error) {
      throw new OpenSearchError(`Could not reach ${url}: ${describeTlsError(error)}`)
    }
    if (response.status < 200 || response.status >= 300) {
      const text = await response.text().catch(() => '')
      throw new OpenSearchError(`${method} ${url} returned HTTP ${response.status}. ${text.slice(0, 300)}`, response.status)
    }
    return (await response.json()) as T
  }

  /**
   * Refuses to write to an index Light Code did not create.
   *
   * Checked before every write, not only at creation: the index name comes from config and
   * a typo could otherwise name a production index, whose documents this would then start
   * overwriting by id. The marker is set in `_meta` at creation and cannot be there by
   * accident.
   */
  private async assertOwned(index: string, signal?: AbortSignal): Promise<void> {
    const mapping = await this.request<Record<string, { mappings?: { _meta?: { createdBy?: unknown } } }>>(
      `/${encodeURIComponent(index)}/_mapping`,
      'GET',
      undefined,
      signal,
    )
    const createdBy = Object.values(mapping)[0]?.mappings?._meta?.createdBy
    if (createdBy !== OWNED_INDEX_MARKER) {
      throw new OpenSearchError(
        `Refusing to write to "${index}": it was not created by Light Code. ` +
          'Choose a different index name — indexing only ever writes to an index it made itself.',
      )
    }
  }

  /** True when the index exists. A 404 is the answer, not an error. */
  async exists(index: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request(`/${encodeURIComponent(index)}/_mapping`, 'GET', undefined, signal)
      return true
    } catch (error) {
      if (error instanceof OpenSearchError && error.status === 404) return false
      throw error
    }
  }

  /**
   * Creates the index if it is absent, with a `knn_vector` field of the given width.
   *
   * The width is fixed at creation and cannot be altered afterwards, which is why the
   * embedder validates every vector against the configured dimensions rather than
   * discovering the mismatch here as an opaque mapping rejection.
   */
  async ensureCollection(index: string, dimensions: number, signal?: AbortSignal): Promise<void> {
    if (!isSafeIndexName(index)) throw new OpenSearchError(`"${index}" is not a valid index name.`)
    if (index.includes('*')) throw new OpenSearchError('An index to write to cannot be a wildcard pattern.')

    if (await this.exists(index, signal)) {
      await this.assertOwned(index, signal)
      /*
       * An existing index keeps the width it was created with — a mapping cannot be altered.
       * Left unchecked, switching to a model of a different width means every single write
       * fails with a mapping error that never mentions the real cause, which is that this
       * index belongs to the previous model.
       */
      const existing = await this.vectorDimension(index, signal)
      if (existing !== undefined && existing !== dimensions) {
        throw new OpenSearchError(
          `Index "${index}" stores ${existing}-dimensional vectors, but the configured embedding ` +
            `model produces ${dimensions}. A vector field's width is fixed when the index is created. ` +
            'Either set the width back in Settings → Search, or use a different index name so a new ' +
            'one is created for this model.',
        )
      }
      return
    }

    await this.request(
      `/${encodeURIComponent(index)}`,
      'PUT',
      {
        settings: { index: { knn: true } },
        mappings: {
          // The ownership marker. Everything else here is ours to define.
          _meta: { createdBy: OWNED_INDEX_MARKER },
          properties: {
            text: { type: 'text' },
            path: { type: 'keyword' },
            startLine: { type: 'integer' },
            endLine: { type: 'integer' },
            vector: { type: 'knn_vector', dimension: dimensions },
          },
        },
      },
      signal,
    )
  }

  /** The width an existing index was created with, or undefined if it cannot be read. */
  private async vectorDimension(index: string, signal?: AbortSignal): Promise<number | undefined> {
    try {
      const body = await this.request<Record<string, unknown>>(
        `/${encodeURIComponent(index)}/_mapping`,
        'GET',
        undefined,
        signal,
      )
      const mappings = (body[index] as { mappings?: unknown } | undefined)?.mappings as
        | { properties?: { vector?: { dimension?: unknown } } }
        | undefined
      const dimension = mappings?.properties?.vector?.dimension
      return typeof dimension === 'number' ? dimension : undefined
    } catch {
      // Unreadable mapping is not worth failing over — the write will report its own error.
      return undefined
    }
  }

  /**
   * Upserts documents by id, so re-indexing a changed file replaces its chunks rather than
   * duplicating them.
   *
   * `_bulk` reports per-item failures with a 200 overall, so the response is inspected
   * rather than trusted — a silent partial write would leave a corpus that looks complete
   * and quietly is not.
   */
  async upsert(index: string, documents: readonly IndexedDocument[], signal?: AbortSignal): Promise<void> {
    if (documents.length === 0) return
    await this.assertOwned(index, signal)

    const lines: string[] = []
    for (const document of documents) {
      lines.push(JSON.stringify({ index: { _index: index, _id: document.id } }))
      lines.push(
        JSON.stringify({
          text: document.text,
          path: document.path,
          startLine: document.startLine,
          endLine: document.endLine,
          vector: document.vector,
        }),
      )
    }

    const result = await this.request<{ errors?: boolean; items?: unknown[] }>(
      '/_bulk',
      'POST',
      `${lines.join('\n')}\n`,
      signal,
    )

    if (result.errors === true) {
      const firstError = (result.items ?? [])
        .map((item) => (item as { index?: { error?: { reason?: unknown } } }).index?.error?.reason)
        .find((reason) => typeof reason === 'string')
      throw new OpenSearchError(`Some documents were rejected. First reason: ${String(firstError ?? 'unknown')}`)
    }
  }

  /**
   * Removes the chunks of files that no longer exist, so a deleted file stops appearing in
   * results. Scoped to our own index by `assertOwned`.
   */
  async deleteByPaths(index: string, paths: readonly string[], signal?: AbortSignal): Promise<void> {
    if (paths.length === 0) return
    await this.assertOwned(index, signal)

    await this.request(
      `/${encodeURIComponent(index)}/_delete_by_query`,
      'POST',
      { query: { terms: { path: [...paths] } } },
      signal,
    )
  }
}
