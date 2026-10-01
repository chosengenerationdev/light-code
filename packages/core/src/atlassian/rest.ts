import type { HttpClient, HttpRequestOptions, HttpResponse, TlsOptions } from '../platform/http.js'
import { readBody } from '../platform/readBody.js'

/**
 * The one REST core under the Confluence, Jira and Bitbucket clients.
 *
 * ## Why one core
 *
 * All three are Atlassian Data Center / Server products taking a personal access token as
 * `Authorization: Bearer`, over the one `HttpClient` (invariant 2), with the same TLS story. Three
 * copies of "send, check the status, turn the error body into a sentence" would drift — the first
 * change to one would miss the other two, which is the shape of bug this project has paid for most.
 *
 * ## Errors are for humans (§17)
 *
 * Each product answers failures in its own JSON shape — Confluence `{message}`, Jira
 * `{errorMessages, errors}`, Bitbucket `{errors: [{message}]}` — and the message inside is usually
 * the whole explanation. It is passed through, with what was being attempted and, for the statuses
 * people actually hit, what to do next.
 *
 * Cloud (email + API token) is not attempted by any of the three, rather than half-supported.
 */

export type AtlassianProduct = 'confluence' | 'jira' | 'bitbucket' | 'jenkins' | 'autosys'

export const PRODUCT_LABELS: Record<AtlassianProduct, string> = {
  confluence: 'Confluence',
  jira: 'Jira',
  bitbucket: 'Bitbucket',
  jenkins: 'Jenkins',
  autosys: 'AutoSys',
}

export interface AtlassianConnection {
  /** Including any context path, e.g. `https://wiki.example.com/confluence`. */
  baseUrl: string
  /** The personal access token. Held only for the life of a request, never logged. */
  token: string
  /**
   * Set for Jenkins, whose API tokens are sent as HTTP Basic with the user's id. Absent sends the
   * token as a Bearer token — the Atlassian products, and a Jenkins whose single sign-on plugin
   * accepts an access token that way.
   */
  username?: string | undefined
  tls?: TlsOptions | undefined
  /**
   * Replaces `token`/`username` as how a request is authorised — AutoSys behind an API gateway,
   * where a token is fetched from one URL and sent to another. The provider auth strategies fit
   * this shape, so the gateway client is the very one the chat gateway uses.
   */
  auth?: ConnectionAuth | undefined
}

/** What `AtlassianRest` needs from a token-issuing strategy. `ApigeeMtlsAuthStrategy` is one. */
export interface ConnectionAuth {
  resolveHeaders(): Promise<Record<string, string>>
  /** Drop the cached token and get a new one; true means retrying is worth it. */
  onUnauthorized(): Promise<boolean>
}

export class AtlassianError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AtlassianError'
  }
}

export class AtlassianRest {
  readonly base: string

  constructor(
    private readonly http: HttpClient,
    readonly product: AtlassianProduct,
    private readonly connection: AtlassianConnection,
  ) {
    this.base = connection.baseUrl.replace(/\/+$/, '')
  }

  /** Where a relative link on this site actually is. */
  url(relative: string | undefined): string {
    return relative === undefined ? this.base : `${this.base}${relative}`
  }

  async json<T>(doing: string, pathAndQuery: string, options: HttpRequestOptions, signal?: AbortSignal): Promise<T> {
    const response = await this.send(
      doing,
      pathAndQuery,
      { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } },
      signal,
    )
    // A 204 (a transition, some updates) has nothing to parse, and that is success.
    if (response.status === 204) return {} as T
    const text = await response.text()
    return (text.length === 0 ? {} : JSON.parse(text)) as T
  }

  async text(doing: string, pathAndQuery: string, signal?: AbortSignal): Promise<string> {
    const response = await this.send(doing, pathAndQuery, { method: 'GET', headers: { Accept: '*/*' } }, signal)
    return (await readBody(response)).toString('utf8')
  }

  /**
   * Bytes from a path on this site. The path must be relative: a link that came from the server
   * and pointed anywhere else would carry the token with it.
   */
  async bytes(doing: string, pathAndQuery: string, signal?: AbortSignal): Promise<Buffer> {
    if (!pathAndQuery.startsWith('/')) {
      throw new AtlassianError(`Refused to fetch "${pathAndQuery}": it is not a link on ${this.base}.`)
    }
    const response = await this.send(doing, pathAndQuery, { method: 'GET' }, signal)
    return readBody(response)
  }

  private async authHeaders(doing: string): Promise<Record<string, string>> {
    if (this.connection.auth !== undefined) {
      try {
        return await this.connection.auth.resolveHeaders()
      } catch (error) {
        // The token request is a step of its own; naming it is what separates "the gateway would
        // not issue a token" from "AutoSys refused the call".
        throw new AtlassianError(
          `Could not get a token from the gateway for ${PRODUCT_LABELS[this.product]} while ${doing}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return {
      Authorization:
        this.connection.username !== undefined && this.connection.username.length > 0
          ? `Basic ${Buffer.from(`${this.connection.username}:${this.connection.token}`, 'utf8').toString('base64')}`
          : `Bearer ${this.connection.token}`,
    }
  }

  private async attempt(doing: string, pathAndQuery: string, options: HttpRequestOptions, signal?: AbortSignal): Promise<HttpResponse> {
    try {
      return await this.http.request(`${this.base}${pathAndQuery}`, {
        ...options,
        headers: {
          Accept: 'application/json',
          ...(options.headers ?? {}),
          ...(await this.authHeaders(doing)),
        },
        ...(signal !== undefined ? { signal } : {}),
        ...(this.connection.tls !== undefined ? { tls: this.connection.tls } : {}),
      })
    } catch (error) {
      if (error instanceof AtlassianError) throw error
      throw new AtlassianError(
        `Could not reach ${PRODUCT_LABELS[this.product]} at ${this.base} while ${doing}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async send(doing: string, pathAndQuery: string, options: HttpRequestOptions, signal?: AbortSignal): Promise<HttpResponse> {
    let response = await this.attempt(doing, pathAndQuery, options, signal)
    /*
     * One retry with a fresh token, never a loop (§10). Only with a gateway token: a rejected
     * password would be rejected again, and a second attempt can lock an account.
     */
    if (response.status === 401 && this.connection.auth !== undefined && (await this.connection.auth.onUnauthorized())) {
      await response.text().catch(() => '')
      response = await this.attempt(doing, pathAndQuery, options, signal)
    }
    if (response.status >= 200 && response.status < 300) return response
    const detail = await response.text().catch(() => '')
    throw new AtlassianError(describeAtlassianFailure(this.product, doing, response.status, detail), response.status)
  }
}

/** Whatever message the product put in its error body, in any of the three shapes. */
function messageFrom(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      message?: unknown
      errorMessages?: unknown
      errors?: unknown
    }
    const parts: string[] = []
    if (typeof parsed.message === 'string') parts.push(parsed.message)
    if (Array.isArray(parsed.errorMessages)) parts.push(...parsed.errorMessages.filter((m): m is string => typeof m === 'string'))
    if (Array.isArray(parsed.errors)) {
      for (const entry of parsed.errors) {
        const message = (entry as { message?: unknown }).message
        if (typeof message === 'string') parts.push(message)
      }
    } else if (parsed.errors !== null && typeof parsed.errors === 'object') {
      // Jira's per-field errors: `{ summary: "You must specify a summary" }`.
      for (const [field, message] of Object.entries(parsed.errors as Record<string, unknown>)) {
        if (typeof message === 'string') parts.push(`${field}: ${message}`)
      }
    }
    return parts.join(' ')
  } catch {
    // Jenkins answers errors as an HTML page; the words are what matter.
    return body
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
  }
}

/** One sentence per status people actually hit, with what to do about it. */
export function describeAtlassianFailure(product: AtlassianProduct, doing: string, status: number, body: string): string {
  const label = PRODUCT_LABELS[product]
  const message = messageFrom(body)
  const said = message.length > 0 ? ` ${label} said: ${message}` : ''
  switch (status) {
    case 400:
      return (
        `${label} refused ${doing}.${said}` +
        (product === 'confluence' && /xhtml/i.test(message)
          ? ' The page body is not valid storage format — every tag must be closed and every macro well formed.'
          : '')
      )
    case 401:
      return (
        `${label} did not accept the personal access token while ${doing}. It may have expired or ` +
        `been revoked: create a new one and save it in Settings → DevOps → ${label}.`
      )
    case 403:
      return `The token's owner is not allowed to do this (${doing}).${said} Ask an administrator for permission.`
    case 404:
      return `${label} found nothing while ${doing}.${said} Check the key, id or path.`
    case 409:
      return (
        `Someone changed it while ${doing}, so nothing was overwritten.${said} Read it again and ` +
        'redo the change against the current version.'
      )
    default:
      return `${label} answered HTTP ${String(status)} while ${doing}.${said}`
  }
}
