import { redact } from '../logging/redact.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from './http.js'
import { readBody } from './readBody.js'

/**
 * Every request a connection test makes, and what came back - for the Details under Test connection.
 *
 * Asked for after a test that went wrong: a tool used by hand (Postman) showed HTTP 403 for a service
 * account, while Light Code showed a sentence about something else. A sentence is our reading of the
 * failure; when the reading is wrong, the person needs what we read it from - the address, the status,
 * the headers that came back and the start of the body - in the order the requests were made (the
 * gateway's token request first, then the call it authorised).
 *
 * **Every credential is masked before it is kept**, because this text is shown on screen and is meant
 * to be copied into a message to whoever runs the service: authorization headers show their scheme and
 * length (a Basic header also its user name, which is what "the service account" questions are about),
 * cookies and anything named like a key, secret, password or token are masked in headers, addresses and
 * bodies, and the values passed as `knownSecrets` are blanked wherever they appear.
 *
 * Only a test is wrapped: it reads each response body whole to keep an excerpt, which an ordinary call
 * (a large log, a page's attachments) should never pay for.
 */

export interface TraceEntry {
  method: string
  url: string
  requestHeaders: Record<string, string>
  requestBody?: string
  status?: number
  responseHeaders?: Record<string, string>
  responseBody?: string
  error?: string
  millis: number
}

const SECRET_NAME = /secret|password|passwd|token|api[-_]?key|assertion|credential|session|signature|cookie/i
const MASK = '•••'
const BODY_EXCERPT = 1500

function maskAuthorization(value: string): string {
  const [scheme, ...rest] = value.trim().split(/\s+/)
  const credential = rest.join(' ')
  if (scheme === undefined || credential.length === 0) return `${MASK} (${String(value.length)} characters)`
  if (/^basic$/i.test(scheme)) {
    // The user name is not the secret, and "which account was this sent as" is the question a 403 raises.
    try {
      const decoded = Buffer.from(credential, 'base64').toString('utf8')
      const at = decoded.indexOf(':')
      if (at > 0) return `${scheme} ${decoded.slice(0, at)}:${MASK} (base64 of user:password)`
    } catch {
      // Not base64: fall through to the plain mask.
    }
  }
  return `${scheme} ${MASK} (${String(credential.length)} characters)`
}

export function maskHeaders(headers: Record<string, string>, knownSecrets: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (/authorization/i.test(name)) out[name] = maskAuthorization(value)
    else if (/^(set-)?cookie$/i.test(name)) out[name] = value.replace(/=([^;,\s]*)/g, `=${MASK}`)
    else if (SECRET_NAME.test(name)) out[name] = `${MASK} (${String(value.length)} characters)`
    else out[name] = redact(value, knownSecrets)
  }
  return out
}

export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username !== '' || parsed.password !== '') {
      parsed.password = parsed.password === '' ? '' : MASK
    }
    for (const key of [...parsed.searchParams.keys()]) if (SECRET_NAME.test(key)) parsed.searchParams.set(key, MASK)
    return decodeURI(parsed.toString())
  } catch {
    return url
  }
}

/** A body with every field named like a secret masked - form-encoded, JSON, or plain text. */
export function maskBody(body: string, knownSecrets: readonly string[] = []): string {
  const trimmed = body.trim()
  let masked = body
  if (/^[\w.-]+=[^&]*(&[\w.-]+=[^&]*)*$/.test(trimmed)) {
    masked = trimmed
      .split('&')
      .map((pair) => {
        const at = pair.indexOf('=')
        return at > 0 && SECRET_NAME.test(decodeURIComponent(pair.slice(0, at))) ? `${pair.slice(0, at)}=${MASK}` : pair
      })
      .join('&')
  } else if (/^[{[]/.test(trimmed)) {
    try {
      const walk = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(walk)
        if (value !== null && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, SECRET_NAME.test(key) && typeof inner !== 'object' ? MASK : walk(inner)]),
          )
        }
        return value
      }
      masked = JSON.stringify(walk(JSON.parse(trimmed)), null, 1)
    } catch {
      // Not JSON after all: the generic patterns below still apply.
    }
  }
  return redact(masked, knownSecrets)
}

function excerpt(text: string): string {
  return text.length > BODY_EXCERPT ? `${text.slice(0, BODY_EXCERPT)}\n… (${String(text.length - BODY_EXCERPT)} more characters)` : text
}

/** The message of an error and of every cause under it - a failed connect hides its reason on `.cause`. */
function errorChain(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    const message = current instanceof Error ? `${current.name === 'Error' ? '' : `${current.name}: `}${current.message}` : String(current)
    const code = (current as { code?: unknown }).code
    parts.push(typeof code === 'string' ? `${message} [${code}]` : message)
    current = (current as { cause?: unknown }).cause
  }
  return parts.join(' <- ')
}

/** `inner`, recording every request into `entries`. Bodies are read whole and handed on as text. */
export function tracingHttpClient(inner: HttpClient, entries: TraceEntry[], knownSecrets: readonly string[] = []): HttpClient {
  return {
    async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
      const started = Date.now()
      const entry: TraceEntry = {
        method: (options.method ?? 'GET').toUpperCase(),
        url: maskUrl(url),
        requestHeaders: maskHeaders(options.headers ?? {}, knownSecrets),
        ...(options.body !== undefined ? { requestBody: excerpt(maskBody(options.body, knownSecrets)) } : {}),
        ...(options.bodyBytes !== undefined ? { requestBody: `(${String(options.bodyBytes.length)} bytes)` } : {}),
        millis: 0,
      }
      entries.push(entry)
      let response: HttpResponse
      try {
        response = await inner.request(url, options)
      } catch (error) {
        entry.error = redact(errorChain(error), knownSecrets)
        entry.millis = Date.now() - started
        throw error
      }
      const bytes = await readBody(response)
      const text = bytes.toString('utf8')
      entry.status = response.status
      entry.responseHeaders = maskHeaders(response.headers, knownSecrets)
      entry.responseBody = excerpt(maskBody(text, knownSecrets))
      entry.millis = Date.now() - started
      return {
        status: response.status,
        headers: response.headers,
        body: null,
        text: async () => text,
        json: async <T>() => JSON.parse(text) as T,
      }
    },
    ...(inner.openWebSocket !== undefined ? { openWebSocket: inner.openWebSocket.bind(inner) } : {}),
  }
}

/** The trace as text to read on screen and to paste to whoever runs the service. */
/**
 * What one recorded step usually means, in words - asked for: "in test connection failures of confluence or
 * jira or bitbucket or jenkins, can you show details info for the user to understand why it is failing?".
 * The raw request and response stay below it; this is the reading, offered as the likely cause, not a verdict.
 */
export function explainStep(entry: TraceEntry): string | undefined {
  const error = (entry.error ?? '').toLowerCase()
  const status = entry.status
  const body = (entry.responseBody ?? '').trimStart().toLowerCase()
  const header = (name: string): string | undefined => Object.entries(entry.responseHeaders ?? {}).find(([k]) => k.toLowerCase() === name)?.[1]
  if (entry.error !== undefined) {
    if (/enotfound|getaddrinfo|eai_again/.test(error)) return 'The server name does not resolve here: check the site address, or that this machine is on the network or VPN that can see it.'
    if (/econnrefused/.test(error)) return 'Nothing is listening at that address and port: check the port in the site address, or whether the service is up.'
    if (/etimedout|timeout|timed out|aborted/.test(error)) return 'No answer: a firewall or proxy may be dropping the connection. Check the address, and whether this network needs a proxy (Settings → Network).'
    if (/certificate|self.signed|unable to verify|cert_|ssl|tls/.test(error)) return 'TLS: the server\'s certificate is not trusted here. Add your company\'s CA in Settings → Network (or the connection\'s own CA file).'
    if (/econnreset|socket hang up/.test(error)) return 'The connection was cut: often a proxy or TLS inspection, or plain http sent to an https port (or the other way round).'
    return undefined
  }
  if (status === undefined) return undefined
  if (status >= 300 && status < 400) {
    const to = header('location')
    return `Redirected${to !== undefined ? ` to ${to}` : ''}: the address may need https, a context path (/jira, /confluence, /AEWS), or it leads to a login page - use the server's own address.`
  }
  if (status >= 200 && status < 300 && (body.startsWith('<!doctype html') || body.startsWith('<html'))) {
    return 'A web page came back where data was expected: usually a single sign-on login page, which means the token is not accepted at this address. Use the server\'s REST address, not a portal link.'
  }
  if (status === 400) return 'The server did not understand the request: often a wrong context path or API version in the site address, or a field it does not accept.'
  if (status === 401) return 'Not signed in: the token or password was refused, or not sent the way this server expects (Bearer token vs user name and password; an expired token).'
  if (status === 403) return 'Signed in, but this account may not do this: check its permissions on the server, the token\'s scopes, or an IP allow-list on a gateway.'
  if (status === 404) return 'Nothing at this address: the site address (its context path, such as /jira, /confluence or /AEWS) or the API path differs on this server. Compare with the address that works in a browser or Postman.'
  if (status === 405) return 'This address does not accept this kind of request: it probably points at a different service than the one named.'
  if (status === 407) return 'The proxy wants a sign-in: set the proxy\'s user name and password in Settings → Network.'
  if (status === 429) return 'Too many requests: the server or gateway is limiting calls. Wait a little and try again.'
  if (status >= 500) return 'The server (or a gateway in front of it) failed: the body may say why. A 502/503/504 usually means the gateway could not reach the service behind it.'
  return undefined
}

export function renderTrace(entries: readonly TraceEntry[]): string {
  if (entries.length === 0) return 'No request was sent - the test stopped before reaching the network (see the message above).'
  const failed = entries.findIndex((e) => e.error !== undefined || (e.status !== undefined && (e.status >= 300 || explainStep(e) !== undefined)))
  const first = failed === -1 ? undefined : entries[failed]
  const reading = first === undefined ? undefined : explainStep(first)
  const summary = first !== undefined && reading !== undefined ? [`Likely cause (step #${String(failed + 1)}): ${reading}`] : []
  return [...summary, ...entries
    .map((entry, index) => {
      const lines = [`#${String(index + 1)} ${entry.method} ${entry.url}`]
      const meaning = explainStep(entry)
      if (meaning !== undefined) lines.push(`What this usually means: ${meaning}`)
      const headers = Object.entries(entry.requestHeaders)
      if (headers.length > 0) lines.push('Request headers:', ...headers.map(([name, value]) => `  ${name}: ${value}`))
      if (entry.requestBody !== undefined && entry.requestBody.length > 0) lines.push('Request body:', indent(entry.requestBody))
      if (entry.error !== undefined) {
        lines.push(`No response after ${String(entry.millis)} ms: ${entry.error}`)
      } else {
        lines.push(`Response: HTTP ${String(entry.status ?? '?')} after ${String(entry.millis)} ms`)
        const back = Object.entries(entry.responseHeaders ?? {})
        if (back.length > 0) lines.push('Response headers:', ...back.map(([name, value]) => `  ${name}: ${value}`))
        lines.push('Response body:', entry.responseBody !== undefined && entry.responseBody.length > 0 ? indent(entry.responseBody) : '  (empty)')
      }
      return lines.join('\n')
    })]
    .join('\n\n')
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}
