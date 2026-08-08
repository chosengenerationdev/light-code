import type { HttpClient, TlsOptions } from '../../platform/http.js'
import type { AuthStrategy } from '../types.js'

/**
 * Every field is configurable with a working default (CLAUDE.md §10) — gateways differ on
 * all of it, and guessing wrong produces an opaque failure at the worst moment.
 *
 * Each optional field is explicitly `| undefined` because these come straight from a zod
 * `.optional()` schema, which under `exactOptionalPropertyTypes` produces exactly that.
 */
export interface ApigeeMtlsSettings {
  /** Defaults to the inference base URL's origin + `/oauth/token`. */
  tokenUrl?: string | undefined
  grantType?: string | undefined
  clientId?: string | undefined
  /**
   * Resolved per token request rather than held as a field: §15 says fetch secrets at
   * request time and drop them after, so a long-lived strategy object never carries one.
   */
  resolveClientSecret?: (() => Promise<string | undefined>) | undefined
  scope?: string | undefined
  extraTokenParams?: Record<string, string> | undefined
  /** Defaults to `Authorization` / `Bearer `. */
  tokenHeaderName?: string | undefined
  tokenHeaderPrefix?: string | undefined
  /** Dotted paths into the token response. Default `access_token` / `expires_in`. */
  tokenPath?: string | undefined
  expiresInPath?: string | undefined
  /** Some gateways omit expiry entirely. Default 3600s. */
  fallbackExpirySeconds?: number | undefined
  /** Refresh this long before actual expiry. Default 60s. */
  refreshSkewSeconds?: number | undefined
  extraHeaders?: Record<string, string> | undefined
}

const DEFAULTS = {
  grantType: 'client_credentials',
  tokenHeaderName: 'Authorization',
  tokenHeaderPrefix: 'Bearer ',
  tokenPath: 'access_token',
  expiresInPath: 'expires_in',
  fallbackExpirySeconds: 3600,
  refreshSkewSeconds: 60,
} as const

/** A long generation must not have its token expire mid-stream. */
const STREAM_LIFETIME_MARGIN_SECONDS = 120

export function defaultTokenUrl(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).origin}/oauth/token`
  } catch {
    return ''
  }
}

function readPath(source: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((current, segment) => {
    if (typeof current !== 'object' || current === null) return undefined
    return (current as Record<string, unknown>)[segment]
  }, source)
}

export class ApigeeAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApigeeAuthError'
  }
}

interface CachedToken {
  value: string
  /** Epoch ms at which we consider it stale — already includes the skew. */
  refreshAfter: number
  /** Epoch ms of real expiry, for the stream-lifetime check. */
  expiresAt: number
}

/**
 * Client-credentials over mutual TLS. The token lives **in memory only** — never on disk,
 * never in logs (§10). Note it is deliberately not exposed by any getter: the only way it
 * leaves this class is inside a request header.
 */
export class ApigeeMtlsAuthStrategy implements AuthStrategy {
  private cached: CachedToken | undefined
  /** The in-flight refresh, shared by concurrent callers — the single-flight guarantee. */
  private inFlight: Promise<CachedToken> | undefined

  constructor(
    private readonly http: HttpClient,
    private readonly settings: ApigeeMtlsSettings,
    private readonly baseUrl: string,
    /** Client certificate material; also used for the token request itself. */
    private readonly loadTls: () => Promise<TlsOptions | undefined>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async tls(): Promise<TlsOptions | undefined> {
    return this.loadTls()
  }

  async resolveHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken()
    const name = this.settings.tokenHeaderName ?? DEFAULTS.tokenHeaderName
    const prefix = this.settings.tokenHeaderPrefix ?? DEFAULTS.tokenHeaderPrefix
    return { ...this.settings.extraHeaders, [name]: `${prefix}${token.value}` }
  }

  /**
   * A 401 despite a proactively-refreshed token means the token was rejected for a reason
   * refreshing might fix (clock skew, revocation, rotation). Force one refresh and allow
   * exactly one retry — never a loop.
   */
  async onUnauthorized(): Promise<boolean> {
    this.cached = undefined
    try {
      await this.refresh()
      return true
    } catch {
      // The retry would fail the same way; let the original 401 surface instead.
      return false
    }
  }

  /**
   * True when the current token will outlive a long generation. The provider checks this
   * before opening a stream, because a token expiring mid-stream aborts the response with
   * no clean way to resume.
   */
  async ensureTokenForStream(): Promise<void> {
    const token = await this.getToken()
    if (token.expiresAt - this.now() < STREAM_LIFETIME_MARGIN_SECONDS * 1000) {
      this.cached = undefined
      await this.getToken()
    }
  }

  private async getToken(): Promise<CachedToken> {
    const cached = this.cached
    if (cached !== undefined && this.now() < cached.refreshAfter) return cached
    return this.refresh()
  }

  private async refresh(): Promise<CachedToken> {
    // Concurrent callers await the same promise rather than each starting a handshake —
    // ten simultaneous requests must produce exactly one token fetch.
    const existing = this.inFlight
    if (existing !== undefined) return existing

    const attempt = this.fetchToken()
      .then((token) => {
        this.cached = token
        return token
      })
      .finally(() => {
        this.inFlight = undefined
      })

    this.inFlight = attempt
    return attempt
  }

  private async fetchToken(): Promise<CachedToken> {
    const tokenUrl = this.settings.tokenUrl ?? defaultTokenUrl(this.baseUrl)
    if (tokenUrl.length === 0) {
      throw new ApigeeAuthError('No token URL is configured, and one could not be derived from the base URL.')
    }

    const clientSecret = await this.settings.resolveClientSecret?.()
    const params = new URLSearchParams({
      grant_type: this.settings.grantType ?? DEFAULTS.grantType,
      ...(this.settings.clientId !== undefined ? { client_id: this.settings.clientId } : {}),
      ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
      ...(this.settings.scope !== undefined ? { scope: this.settings.scope } : {}),
      ...this.settings.extraTokenParams,
    })

    const tls = await this.loadTls()
    let response
    try {
      response = await this.http.request(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        ...(tls !== undefined ? { tls } : {}),
      })
    } catch (error) {
      throw new ApigeeAuthError(`Could not reach the token endpoint at ${tokenUrl}: ${describeTlsError(error)}`)
    }

    if (response.status < 200 || response.status >= 300) {
      const body = await response.text().catch(() => '')
      throw new ApigeeAuthError(
        `Token request to ${tokenUrl} failed with HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new ApigeeAuthError(`The token endpoint at ${tokenUrl} did not return JSON.`)
    }

    const tokenPath = this.settings.tokenPath ?? DEFAULTS.tokenPath
    const value = readPath(payload, tokenPath)
    if (typeof value !== 'string' || value.length === 0) {
      throw new ApigeeAuthError(
        `The token endpoint response has no token at "${tokenPath}". Set tokenPath if your gateway nests it elsewhere.`,
      )
    }

    const rawExpiry = readPath(payload, this.settings.expiresInPath ?? DEFAULTS.expiresInPath)
    const expiresInSeconds =
      typeof rawExpiry === 'number' && rawExpiry > 0
        ? rawExpiry
        : typeof rawExpiry === 'string' && Number.parseInt(rawExpiry, 10) > 0
          ? Number.parseInt(rawExpiry, 10)
          : (this.settings.fallbackExpirySeconds ?? DEFAULTS.fallbackExpirySeconds)

    const skew = this.settings.refreshSkewSeconds ?? DEFAULTS.refreshSkewSeconds
    const issuedAt = this.now()
    return {
      value,
      expiresAt: issuedAt + expiresInSeconds * 1000,
      // Refreshing early is the whole point: waiting for a 401 stalls mid-stream (§10).
      refreshAfter: issuedAt + Math.max(0, expiresInSeconds - skew) * 1000,
    }
  }
}

/**
 * Turns OpenSSL codes into something a human can act on — §10 forbids surfacing them raw.
 *
 * Undici reports every transport failure as a bare `TypeError: fetch failed` and hangs the
 * real reason off `.cause` (sometimes nested more than once). Reading only the top-level
 * message therefore turns "your corporate root CA is not trusted" — the single most likely
 * failure on an intercepted network — into "fetch failed", which tells the user nothing.
 */
export function describeTlsError(error: unknown): string {
  const chain: unknown[] = []
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    chain.push(current)
    current = (current as { cause?: unknown }).cause
  }

  const message = error instanceof Error ? error.message : String(error)
  const combined = chain
    .map((link) => `${(link as { code?: string }).code ?? ''} ${link instanceof Error ? link.message : String(link)}`)
    .join(' ')

  if (
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT|unable to get local issuer|unable to verify the first certificate/i.test(
      combined,
    )
  ) {
    return 'the server certificate could not be verified. If your network intercepts TLS, add the corporate root CA (caFile, or NODE_EXTRA_CA_CERTS).'
  }
  if (/CERT_HAS_EXPIRED/i.test(combined)) return 'the server certificate has expired.'
  if (/ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match/i.test(combined)) {
    return "the server certificate is not valid for this host name. Check the base URL matches the certificate's subject."
  }
  if (/EPROTO|SSL routines|SSL alert|handshake|TLSV1|BAD_CERTIFICATE/i.test(combined)) {
    return 'the TLS handshake failed. The gateway may require a client certificate, or may have rejected the one presented.'
  }
  if (/ECONNREFUSED/i.test(combined)) return 'the connection was refused.'
  if (/ENOTFOUND|EAI_AGAIN/i.test(combined)) return 'the host could not be resolved.'
  if (/ECONNRESET|socket hang up/i.test(combined)) {
    return 'the connection was closed by the server. A gateway that requires a client certificate often does this when none is presented.'
  }

  // Nothing recognised. Prefer the deepest cause over undici's opaque "fetch failed"
  // wrapper, which on its own is unactionable.
  const deepest = chain[chain.length - 1]
  const deepestMessage = deepest instanceof Error ? deepest.message : String(deepest)
  return message === 'fetch failed' && deepestMessage !== message ? deepestMessage : message
}
