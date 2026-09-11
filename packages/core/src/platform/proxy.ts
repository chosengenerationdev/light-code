/**
 * Which proxy, if any, an outbound request should go through.
 *
 * ## Why this exists at all
 *
 * Reported from a Linux server: every other process on the machine reached the LLM gateway, and
 * Light Code alone hung. The cause is not the network. `undici` — what `HttpClient` uses, because
 * Node's built-in `fetch` cannot present a client certificate — **does not read `HTTP_PROXY` or
 * `HTTPS_PROXY`**. curl, wget, python-requests, pip and most of the rest of a corporate Linux box
 * do. So on a machine whose egress goes through a proxy, everything else is routed and we alone
 * attempt a direct connection, which a firewall drops silently rather than refusing — and a
 * dropped connection waits for the kernel.
 *
 * That is exactly the shape of "only our process was stuck": nothing is broken, we are simply the
 * one program not obeying the convention the machine is configured around.
 *
 * ## Why the rules are written out rather than taken from a library
 *
 * `NO_PROXY` has no specification, only thirty years of near-agreement, and the disagreements are
 * in the corners: a leading dot, a bare `*`, a port, an IP. Getting one wrong means either
 * tunnelling something that should stay local — which breaks an internal host — or bypassing the
 * proxy for something that needs it, which is the hang this fixes, moved.
 *
 * The rules implemented, matching curl and the Go standard library:
 * - `*` alone disables proxying entirely.
 * - An entry may carry a port (`gateway.corp:8443`), and then it matches only that port.
 * - A leading dot (`.corp.internal`) matches the domain and any subdomain.
 * - Without a leading dot, an entry matches the host itself *and* its subdomains — which is what
 *   people mean when they write `corp.internal`, and what curl does.
 * - Matching is case-insensitive; entries are separated by commas and may carry spaces.
 * - `localhost` and loopback literals are never proxied, whatever the variables say.
 */

/** Lower-case first: the convention is lower-case wins, because a shell exports it that way. */
function fromEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name.toLowerCase()] ?? env[name.toUpperCase()]
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

/** Loopback is never proxied — a proxy for 127.0.0.1 is always a misconfiguration. */
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80'
}

/** True when `NO_PROXY` says this destination must be reached directly. */
export function bypassesProxy(target: URL, noProxy: string | undefined): boolean {
  if (noProxy === undefined) return false
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = target.port !== '' ? target.port : defaultPort(target.protocol)

  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase()
    if (entry.length === 0) continue
    if (entry === '*') return true

    // An entry may pin a port. Without one it matches every port on that host.
    const at = entry.lastIndexOf(':')
    const hasPort = at > 0 && /^\d+$/.test(entry.slice(at + 1))
    const entryHost = hasPort ? entry.slice(0, at) : entry
    const entryPort = hasPort ? entry.slice(at + 1) : undefined
    if (entryPort !== undefined && entryPort !== port) continue

    const bare = entryHost.startsWith('.') ? entryHost.slice(1) : entryHost
    // The host itself, or anything under it. `.corp` and `corp` behave alike here, deliberately:
    // writing the dot is a habit, not a different intention.
    if (host === bare || host.endsWith(`.${bare}`)) return true
  }
  return false
}

export interface ProxyChoice {
  /** The proxy to send this request through. */
  uri: string
  /** `Proxy-Authorization`, when the proxy URL carried credentials. Never logged. */
  token?: string
  /** The proxy URL with any password removed, safe to show a user or write to a log. */
  redacted: string
}

/**
 * The proxy for one destination, or undefined to connect directly.
 *
 * `HTTPS_PROXY` governs `https:` targets and `HTTP_PROXY` governs `http:` ones — note that is the
 * *target's* scheme, not the proxy's: an `https:` gateway is almost always reached through a
 * plain-HTTP `CONNECT` proxy, and reading it the other way is a classic misconfiguration.
 */
export function proxyForUrl(
  target: URL,
  env: NodeJS.ProcessEnv = process.env,
): ProxyChoice | undefined {
  if (isLoopback(target.hostname)) return undefined

  const configured =
    target.protocol === 'https:' ? fromEnv(env, 'HTTPS_PROXY') : fromEnv(env, 'HTTP_PROXY')
  // `ALL_PROXY` is the fallback both curl and the Go library honour.
  const uri = configured ?? fromEnv(env, 'ALL_PROXY')
  if (uri === undefined) return undefined
  if (bypassesProxy(target, fromEnv(env, 'NO_PROXY'))) return undefined

  let parsed: URL
  try {
    // A bare `host:port` is what people write half the time, and refusing it would mean a proxy
    // silently not applied — the failure this whole file exists to remove.
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `http://${uri}`)
  } catch {
    return undefined
  }

  const username = decodeURIComponent(parsed.username)
  const password = decodeURIComponent(parsed.password)
  const hasCredentials = username.length > 0 || password.length > 0

  /*
   * Credentials are stripped from the URI and sent as a header instead.
   *
   * undici 5's ProxyAgent does not read them out of the URI, so leaving them there means an
   * authenticating proxy answers 407 and the user is told their gateway refused them. Carrying
   * them separately also keeps the password out of anything that prints the URI (§15).
   */
  parsed.username = ''
  parsed.password = ''

  const redacted = hasCredentials ? `${parsed.origin} (with credentials)` : parsed.origin

  return {
    uri: parsed.origin,
    ...(hasCredentials
      ? { token: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
      : {}),
    redacted,
  }
}

/**
 * What the environment says, for a diagnostic.
 *
 * Reported rather than inferred by the reader: "which proxy am I going through" is the question
 * nobody thinks to ask until something hangs, and it is the one this machine can answer exactly.
 * Passwords never appear.
 */
export function describeProxyEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const parts: string[] = []
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const value = fromEnv(env, name)
    if (value === undefined) continue
    if (name === 'NO_PROXY') {
      parts.push(`${name}=${value}`)
      continue
    }
    try {
      const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`)
      const credentials = parsed.username.length > 0 || parsed.password.length > 0
      parts.push(`${name}=${parsed.origin}${credentials ? ' (with credentials)' : ''}`)
    } catch {
      parts.push(`${name}=<unparseable>`)
    }
  }
  return parts.length > 0 ? parts.join(', ') : undefined
}
