import type { VectorStoreKind } from '../../config/schema.js'
import type { HttpClient, HttpRequestOptions } from '../../platform/http.js'
import { describeTlsError } from '../../providers/auth/apigeeMtls.js'
import {
  VectorStoreError,
  type VectorMatch,
  type VectorSearchOptions,
  type VectorSearcher,
  type VectorStoreConnection,
} from '../vectorStore.js'

/**
 * A thin OpenSearch REST client.
 *
 * `@opensearch-project/opensearch` carries its own HTTP stack, which invariant 2 forbids —
 * all egress goes through core's `HttpClient` so it stays auditable in one place. The API
 * is plain REST, so this is a small amount of code rather than a workaround.
 *
 * ## This class cannot write. That is structural, not a convention.
 *
 * The model must never create, modify or delete anything in a cluster the organisation
 * runs. Relying on "the tool happens not to call bulk" would put one careless future edit
 * between a chat message and a deleted index, so:
 *
 * 1. `OpenSearchClient` has **no write methods at all**. The object a tool receives cannot
 *    express a write; there is nothing to call.
 * 2. `request` **refuses any HTTP method other than GET, and POST to `_search`**, so a bug
 *    or a crafted index name cannot smuggle one through the one method that does exist.
 * 3. Writing lives in `OpenSearchIndexWriter`, a separate class in a separate file, used
 *    only by the indexer — which a user starts from Settings and no tool can invoke.
 */

/** Kept as a name because it reads well at OpenSearch call sites; the shape is shared. */
export type OpenSearchConnection = VectorStoreConnection

export interface IndexInfo {
  name: string
  /** Document count, when the cluster reports it. Useful for spotting an empty index. */
  docsCount?: number
  /** Human-readable size, e.g. "1.2gb". */
  storeSize?: string
}

export interface SearchHit {
  index: string
  id: string
  score: number
  source: Record<string, unknown>
}

export interface SearchResult {
  hits: SearchHit[]
  /** Total matches, which may exceed the number returned. */
  total: number
  tookMs: number
}

/**
 * Extends `VectorStoreError` so a caller that does not care which backend failed — the
 * indexer, `search_codebase`, the bridge — catches one type rather than a growing list.
 */
export class OpenSearchError extends VectorStoreError {
  constructor(message: string, status?: number) {
    super(message, status)
    this.name = 'OpenSearchError'
  }
}

/** Index names reach here from model output; anything odd never becomes a path segment. */
export function isSafeIndexName(name: string): boolean {
  // OpenSearch forbids uppercase and these characters anyway; rejecting them here also
  // stops `../` and query-string injection into the request path.
  return /^[a-z0-9][a-z0-9._\-*+]{0,254}$/.test(name) && !name.includes('..')
}

export class OpenSearchClient implements VectorSearcher {
  readonly kind: VectorStoreKind = 'opensearch'

  constructor(
    private readonly http: HttpClient,
    private readonly connection: OpenSearchConnection,
  ) {}

  get label(): string {
    return this.connection.label ?? this.connection.url
  }

  private get base(): string {
    return this.connection.url.replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const { username, password } = this.connection
    if (username !== undefined && username.length > 0) {
      // Basic auth. `SecretStore` supplied these; they are never read from config (§15).
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
    }
    return headers
  }

  /**
   * The single choke point, and it enforces read-only.
   *
   * A GET cannot mutate anything in OpenSearch. The only POST permitted is to `_search`,
   * because search bodies are too large for a query string. Everything else — PUT, DELETE,
   * `_bulk`, `_delete_by_query`, index creation — is refused here rather than merely
   * unused, so no future edit or crafted argument can turn a read client into a writer.
   */
  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const method = options.method ?? 'GET'
    const isSearchPost = method === 'POST' && /\/_search(\?|$)/.test(path)
    if (method !== 'GET' && !isSearchPost) {
      throw new OpenSearchError(
        `Refusing ${method} ${path}: this client is read-only. Indexing goes through the ` +
          'indexer, which the user starts from Settings.',
      )
    }

    const url = `${this.base}${path}`
    const request: HttpRequestOptions = {
      method,
      headers: this.headers(),
    }
    if (options.body !== undefined) request.body = JSON.stringify(options.body)
    if (options.signal !== undefined) request.signal = options.signal
    if (this.connection.tls !== undefined) request.tls = this.connection.tls

    let response
    try {
      response = await this.http.request(url, request)
    } catch (error) {
      // Corporate clusters sit behind the same intercepting proxy the gateway does, so the
      // TLS explanation matters here as much as it does for a provider (§10).
      throw new OpenSearchError(`Could not reach ${url}: ${describeTlsError(error)}`)
    }

    if (response.status < 200 || response.status >= 300) {
      const text = await response.text().catch(() => '')
      throw new OpenSearchError(describeStatus(response.status, url, text), response.status)
    }
    return (await response.json()) as T
  }

  /** Cheapest possible reachability and auth check, for Test Connection. */
  async ping(signal?: AbortSignal): Promise<{ clusterName?: string; version?: string }> {
    const info = await this.request<{ cluster_name?: unknown; version?: { number?: unknown } }>('/', {
      ...(signal !== undefined ? { signal } : {}),
    })
    const result: { clusterName?: string; version?: string } = {}
    if (typeof info.cluster_name === 'string') result.clusterName = info.cluster_name
    if (typeof info.version?.number === 'string') result.version = info.version.number
    return result
  }

  /**
   * Lists indexes for the settings dropdown.
   *
   * Hidden and system indexes are filtered out: a cluster typically has dozens of
   * `.opensearch-*` internals that are noise in a picker. `_cat` is often denied to a
   * low-privilege user, which is why the UI always keeps free-text entry (§9).
   */
  async listIndexes(signal?: AbortSignal): Promise<IndexInfo[]> {
    const rows = await this.request<Record<string, unknown>[]>(
      '/_cat/indices?format=json&h=index,docs.count,store.size&s=index',
      { ...(signal !== undefined ? { signal } : {}) },
    )
    if (!Array.isArray(rows)) return []

    return rows
      .map((row) => {
        const name = typeof row.index === 'string' ? row.index : undefined
        if (name === undefined) return undefined
        const info: IndexInfo = { name }
        const docs = row['docs.count']
        if (typeof docs === 'string' && docs.length > 0) info.docsCount = Number.parseInt(docs, 10)
        if (typeof row['store.size'] === 'string') info.storeSize = row['store.size']
        return info
      })
      .filter((info): info is IndexInfo => info !== undefined && !info.name.startsWith('.'))
  }

  /**
   * The index's field mapping, so a query can be built against fields that exist rather
   * than guessed at. Returns a flat `path -> type` map, since nested `properties` are
   * awkward to reason about at the call site.
   */
  async getMapping(index: string, signal?: AbortSignal): Promise<Record<string, string>> {
    if (!isSafeIndexName(index)) throw new OpenSearchError(`"${index}" is not a valid index name.`)

    const body = await this.request<Record<string, { mappings?: { properties?: Record<string, unknown> } }>>(
      `/${encodeURIComponent(index)}/_mapping`,
      { ...(signal !== undefined ? { signal } : {}) },
    )

    const fields: Record<string, string> = {}
    for (const entry of Object.values(body)) {
      collectFields(entry.mappings?.properties, '', fields)
    }
    return fields
  }

  /** Runs a query the caller has already built. */
  async search(
    index: string,
    query: Record<string, unknown>,
    options: { size?: number; signal?: AbortSignal } = {},
  ): Promise<SearchResult> {
    if (!isSafeIndexName(index)) throw new OpenSearchError(`"${index}" is not a valid index name.`)

    const body = await this.request<{
      took?: unknown
      hits?: { total?: unknown; hits?: unknown[] }
    }>(`/${encodeURIComponent(index)}/_search`, {
      method: 'POST',
      body: { size: options.size ?? 10, ...query },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })

    const rawHits = Array.isArray(body.hits?.hits) ? body.hits.hits : []
    const total = body.hits?.total
    return {
      tookMs: typeof body.took === 'number' ? body.took : 0,
      // `total` is an object in modern OpenSearch and a bare number in older ones.
      total:
        typeof total === 'number'
          ? total
          : typeof (total as { value?: unknown })?.value === 'number'
            ? ((total as { value: number }).value)
            : rawHits.length,
      hits: rawHits.map((raw) => {
        const hit = raw as { _index?: unknown; _id?: unknown; _score?: unknown; _source?: unknown }
        return {
          index: typeof hit._index === 'string' ? hit._index : index,
          id: typeof hit._id === 'string' ? hit._id : '',
          score: typeof hit._score === 'number' ? hit._score : 0,
          source: (hit._source ?? {}) as Record<string, unknown>,
        }
      }),
    }
  }

  /**
   * The `VectorSearcher` half: nearest neighbours over a collection Light Code indexed.
   *
   * The kNN body lives here rather than in `search_codebase` because it is the one genuinely
   * OpenSearch-shaped thing about that tool — Qdrant and Chroma each want a different request
   * entirely. With it here, adding a backend touches no tool.
   */
  async searchByVector(
    collection: string,
    vector: readonly number[],
    options: VectorSearchOptions,
  ): Promise<VectorMatch[]> {
    const prefix = options.pathPrefix?.trim()
    const body: Record<string, unknown> = {
      /*
       * Returning the stored vector would send a 1024-float array per hit — many times the
       * size of the code it describes, and of no use to the model.
       */
      _source: { excludes: ['vector'] },
      query: {
        knn: {
          vector: {
            vector: [...vector],
            /*
             * Neighbours considered per shard. It must be at least the number of hits wanted,
             * or a filter can leave fewer than requested.
             */
            k: Math.max(options.size, 10),
            ...(prefix !== undefined && prefix.length > 0 ? { filter: { prefix: { path: prefix } } } : {}),
          },
        },
      },
    }

    const result = await this.search(collection, body, {
      size: options.size,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })

    return result.hits.map((hit) => {
      const source = hit.source as {
        path?: unknown
        startLine?: unknown
        endLine?: unknown
        text?: unknown
      }
      const match: VectorMatch = {
        id: hit.id,
        score: hit.score,
        text: typeof source.text === 'string' ? source.text : '',
        path: typeof source.path === 'string' ? source.path : hit.id,
      }
      if (typeof source.startLine === 'number') match.startLine = source.startLine
      if (typeof source.endLine === 'number') match.endLine = source.endLine
      return match
    })
  }
}

/** Flattens nested `properties` into dotted paths, which is how queries address them. */
function collectFields(properties: Record<string, unknown> | undefined, prefix: string, out: Record<string, string>): void {
  if (properties === undefined) return
  for (const [name, raw] of Object.entries(properties)) {
    const field = raw as { type?: unknown; properties?: Record<string, unknown> }
    const path = prefix.length > 0 ? `${prefix}.${name}` : name
    if (typeof field.type === 'string') out[path] = field.type
    if (field.properties !== undefined) collectFields(field.properties, path, out)
  }
}

/**
 * Status codes turned into something a user can act on. §17: an error names what failed and
 * what to do next — "HTTP 403" alone sends someone to a search engine.
 */
function describeStatus(status: number, url: string, body: string): string {
  const detail = body.trim().length > 0 ? ` ${body.slice(0, 300)}` : ''
  if (status === 401) return `Authentication failed for ${url}. Check the username and password.${detail}`
  if (status === 403) {
    return `Access denied by ${url}. The account may lack permission for this index or for _cat/indices.${detail}`
  }
  if (status === 404) return `Not found at ${url}. The index may not exist.${detail}`
  return `${url} returned HTTP ${status}.${detail}`
}
