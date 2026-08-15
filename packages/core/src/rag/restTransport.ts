import type { HttpClient, HttpRequestOptions } from '../platform/http.js'
import { describeTlsError } from '../providers/auth/apigeeMtls.js'
import { VectorStoreError, type VectorStoreConnection } from './vectorStore.js'

/**
 * The JSON-over-HTTP plumbing every vector backend needs.
 *
 * All three are plain REST, and invariant 2 sends every byte through core's one `HttpClient`
 * — so the alternative to sharing this is three copies of the same auth, TLS, error-shaping
 * and URL-joining code, differing only in the ways that turn into bugs.
 *
 * OpenSearch keeps its own copy rather than being retrofitted onto this: it has NDJSON bulk
 * bodies and a 404-is-an-answer convention that would make this less clear for the two
 * backends being added, and rewriting a working, tested client to share a helper is a change
 * with all of the risk and none of the benefit.
 */

export interface RestResult<T> {
  status: number
  body: T
}

export class RestTransport {
  constructor(
    private readonly http: HttpClient,
    private readonly connection: VectorStoreConnection,
    /**
     * Extra headers, evaluated per request.
     *
     * Qdrant authenticates with `api-key` rather than Basic, so the header set is a property
     * of the backend rather than of the connection.
     */
    private readonly extraHeaders: () => Record<string, string> = () => ({}),
  ) {}

  get label(): string {
    return this.connection.label ?? this.connection.url
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.extraHeaders() }
    const { username, password } = this.connection
    if (username !== undefined && username.length > 0) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
    }
    return headers
  }

  /**
   * Sends a request and returns the status alongside the parsed body.
   *
   * **A non-2xx is returned, not thrown.** Both backends use 404 as a legitimate answer —
   * "that collection does not exist yet" is the ordinary first-run case — and a helper that
   * threw would push every caller into catching and re-inspecting an error to find out
   * whether it was really an error. `expectOk` is there for the cases that are.
   */
  async send<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<RestResult<T>> {
    const url = `${this.connection.url.replace(/\/+$/, '')}${path}`
    const request: HttpRequestOptions = { method, headers: this.headers() }
    if (body !== undefined) request.body = JSON.stringify(body)
    if (signal !== undefined) request.signal = signal
    if (this.connection.tls !== undefined) request.tls = this.connection.tls

    let response
    try {
      response = await this.http.request(url, request)
    } catch (error) {
      // `describeTlsError` walks undici's cause chain: without it the single most likely
      // corporate failure — an untrusted intercepting root — surfaces as "fetch failed".
      throw new VectorStoreError(`Could not reach ${url}: ${describeTlsError(error)}`)
    }

    if (response.status === 204) return { status: response.status, body: undefined as T }

    const text = await response.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      // A body that is not JSON is usually a proxy's HTML error page. Keeping it as text means
      // the message names what actually answered rather than a parse failure.
      parsed = text
    }
    return { status: response.status, body: parsed as T }
  }

  /** Sends, and throws unless the status is 2xx. */
  async expectOk<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const result = await this.send<T>(path, method, body, signal)
    if (result.status < 200 || result.status >= 300) {
      const detail = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? '')
      throw new VectorStoreError(
        `${method} ${path} on ${this.label} returned HTTP ${String(result.status)}. ${detail.slice(0, 300)}`,
        result.status,
      )
    }
    return result.body
  }
}

/**
 * Collection names are interpolated into URLs and come from config, so they are constrained.
 *
 * Deliberately narrower than either backend allows: both accept a wide range of characters,
 * and the ones that differ are exactly the ones that make a path traversal or an accidental
 * wildcard possible.
 */
export function isSafeCollectionName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(name) && !name.includes('..')
}
