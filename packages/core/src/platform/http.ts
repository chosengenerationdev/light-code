import { createHash } from 'node:crypto'
import { Agent, ProxyAgent, WebSocket, fetch as undiciFetch, type Dispatcher } from 'undici'
import { describeProxyEnvironment, proxyForUrl } from './proxy.js'
import { buildConnectOptions } from './tls.js'

/**
 * How long a connection (TCP and TLS, through any proxy) may take to come up.
 *
 * undici's own default is 10 seconds, and Node's `https` - what most other clients use, Roo Code's
 * among them - has none at all. Reported: on a day the office network was slow, every request from
 * Light Code and Fire Code failed while Roo Code talked to the same gateway as if nothing was wrong.
 * A slow handshake through an inspecting proxy is not a dead host; a minute still ends a truly
 * unreachable one, and the failure is then retried (`agent/transient.ts`).
 */
export const CONNECT_TIMEOUT_MS = 60_000

/**
 * How long one address is tried before the next is (Happy Eyeballs). Node's default is 250 ms, which
 * a slow link exceeds on every address, abandoning each attempt that would have succeeded.
 */
const FAMILY_ATTEMPT_MS = 1_000

/**
 * Client TLS material for mutual-TLS gateways. Buffers, not paths — reading and
 * validating the files is `providers/auth/certs.ts`'s job, so this layer never touches
 * the filesystem and the cert deny list (invariant 6) has a single enforcement point.
 */
export interface TlsOptions {
  cert?: Buffer
  key?: Buffer
  pfx?: Buffer
  passphrase?: string
  /** Extra CA roots — corporate TLS interception otherwise breaks the one real connection. */
  ca?: Buffer[]
  /**
   * Set `false` to accept any server certificate.
   *
   * This disables the guarantee that you are talking to who you think you are: an attacker
   * positioned on the network can read and modify the traffic, including the API key, and
   * nothing will detect it. Supplying the corporate root through `ca` is the correct fix
   * and keeps verification on.
   *
   * It exists because "my gateway uses an internal CA I cannot easily export" is a real
   * situation that otherwise blocks the product entirely, and people will reach for a
   * worse workaround. It is off by default, per-profile, and the UI states the cost.
   */
  rejectUnauthorized?: boolean
}

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /**
   * A body that is bytes rather than text. Wins over `body` when both are set.
   *
   * Separate from `body` rather than widening it, deliberately. A string body is encoded as UTF-8,
   * which silently corrupts anything that is not text — a PNG round-tripped through a string is a
   * file nobody can open, and nothing reports it. Making binary its own field means a caller
   * chooses it on purpose, and it left every existing caller and test fake untouched.
   */
  bodyBytes?: Uint8Array
  signal?: AbortSignal
  tls?: TlsOptions
  /**
   * A proxy for this request alone, in HTTP_PROXY/HTTPS_PROXY/NO_PROXY terms (URLs may carry
   * user:password, sent as Proxy-Authorization). Used whether or not the client reads the environment:
   * `http_request` routes through the one configured in Settings → Network.
   */
  proxy?: { http?: string | undefined; https?: string | undefined; noProxy?: string | undefined }
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
  body: ReadableStream<Uint8Array> | null
}

/**
 * The sole outbound network egress point (invariant 2). `fetch` and friends are
 * ESLint-banned everywhere else in the repo — this file is the one exemption.
 */
export interface HttpClient {
  request(url: string, options?: HttpRequestOptions): Promise<HttpResponse>
  /**
   * A WebSocket through the same TLS material and proxy routing as `request` - a Jupyter kernel
   * speaks only over one. Optional, so test fakes and hosts without it simply lack the feature.
   */
  openWebSocket?(url: string, options?: { headers?: Record<string, string>; tls?: TlsOptions }): WebSocketConnection
  /**
   * A standard fetch going out the same way as `request` - its TLS material, the Windows certificate store and proxy
   * routing - for a library that takes one (the MCP SDK's HTTP transports). Optional, like `openWebSocket`.
   */
  fetchFunction?(tls?: TlsOptions): (url: string | URL, init?: RequestInit) => Promise<Response>
}

/** The few things a caller needs from a WebSocket: text frames in and out, and its end. */
export interface WebSocketConnection {
  /** Resolves once connected; rejects with the reason it could not be. */
  readonly opened: Promise<void>
  send(text: string): void
  close(): void
  onMessage(listener: (text: string) => void): void
  onClose(listener: (reason: string) => void): void
}

/**
 * Identity of the *material*, so an agent is reused across requests but rebuilt the moment
 * a certificate is rotated on disk.
 *
 * This hashes the content rather than comparing byte lengths. A renewed certificate is
 * overwhelmingly likely to be the same length as the one it replaces — same key size, same
 * issuer, same subject — so a length-based key would keep serving the retired certificate
 * until the extension host restarted, which is exactly the failure the rotation support is
 * meant to prevent. The digest never leaves this map and no key bytes are retained.
 */
function tlsKey(tls: TlsOptions): string {
  const hash = createHash('sha256')
  for (const part of [tls.cert, tls.key, tls.pfx, ...(tls.ca ?? [])]) {
    hash.update(part ?? Buffer.alloc(0))
    hash.update('|')
  }
  hash.update(tls.passphrase ?? '')
  /*
   * Whether the certificate is checked is part of the connection: without it in the key, two connections with the same
   * certificates shared one pooled agent, and whichever was made first decided for both - a connection told not to
   * verify kept verifying, and one that must verify could be handed an agent that does not (found by
   * mcp/httpsCertificate.test.ts).
   */
  hash.update(tls.rejectUnauthorized === false ? '|noverify' : '|verify')
  return hash.digest('hex')
}

/**
 * Uses `undici` rather than global `fetch` because Node's built-in fetch has no supported
 * way to present a client certificate. Same WHATWG API and streaming body, so nothing
 * downstream changes.
 */
export interface FetchHttpClientOptions {
  /**
   * Route through `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`, the way the rest of the machine does.
   *
   * Off by default, and that default is deliberate rather than cautious. The VS Code extension has
   * worked for a long time without it, on machines that may well have those variables set for
   * other tools; switching it on there could route a gateway that is reachable directly through a
   * proxy that has never seen it. The Node host asks for it, because a server is exactly where
   * egress is proxied and where nothing else would explain "every other process connects".
   *
   * See `proxy.ts` for why `undici` needs telling at all.
   */
  useEnvProxy?: boolean
  /** Overrides the environment read for proxy settings. For tests. */
  env?: NodeJS.ProcessEnv
}

export class FetchHttpClient implements HttpClient {
  /** Agents are pooled: building one per request would discard connection reuse entirely. */
  private readonly agents = new Map<string, Agent>()
  /** Pooled per proxy *and* per TLS material, since a renewed certificate must rebuild both. */
  private readonly proxyAgents = new Map<string, ProxyAgent>()

  constructor(private readonly options: FetchHttpClientOptions = {}) {}

  /** What the environment says, redacted, for a diagnostic. Undefined when nothing is set. */
  proxyDescription(): string | undefined {
    if (this.options.useEnvProxy !== true) return undefined
    return describeProxyEnvironment(this.options.env ?? process.env)
  }

  /**
   * The dispatcher for one destination: a proxy tunnel where the environment asks for one.
   *
   * Note the TLS material goes on `requestTls`, not `connect`. The proxy hop is its own
   * connection; the certificate identifying *us* belongs to the tunnelled request, and putting it
   * on the outer hop would present a client certificate to the proxy and none to the gateway —
   * a handshake failure pointing at neither.
   */
  private proxyFor(target: URL, tls: TlsOptions | undefined, explicit?: HttpRequestOptions['proxy']): ProxyAgent | undefined {
    const env: NodeJS.ProcessEnv | undefined =
      explicit !== undefined
        ? {
            ...(explicit.http !== undefined ? { HTTP_PROXY: explicit.http } : {}),
            ...(explicit.https !== undefined ? { HTTPS_PROXY: explicit.https } : {}),
            ...(explicit.noProxy !== undefined ? { NO_PROXY: explicit.noProxy } : {}),
          }
        : this.options.useEnvProxy === true
          ? (this.options.env ?? process.env)
          : undefined
    if (env === undefined) return undefined
    const choice = proxyForUrl(target, env)
    if (choice === undefined) return undefined

    // The credentials are part of the key: two proxies at one address with different logins are two agents.
    const key = `${choice.uri}|${choice.token === undefined ? '' : createHash('sha256').update(choice.token).digest('hex')}|${tls === undefined ? 'none' : tlsKey(tls)}`
    const existing = this.proxyAgents.get(key)
    if (existing !== undefined) return existing

    const agent = new ProxyAgent({
      uri: choice.uri,
      ...(choice.token !== undefined ? { token: choice.token } : {}),
      requestTls: {
        ...(tls !== undefined ? buildConnectOptions(tls) : { ca: buildConnectOptions({}).ca }),
        // Happy Eyeballs. Without it a host whose AAAA record is black-holed — ordinary on a
        // corporate network with partial IPv6 — hangs instead of falling back to IPv4.
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: FAMILY_ATTEMPT_MS,
        timeout: CONNECT_TIMEOUT_MS,
      },
      proxyTls: { timeout: CONNECT_TIMEOUT_MS },
    })
    this.proxyAgents.set(key, agent)
    return agent
  }

  private agentFor(tls: TlsOptions): Agent {
    const key = tlsKey(tls)
    const existing = this.agents.get(key)
    if (existing !== undefined) return existing

    // `buildConnectOptions` merges the bundled roots and NODE_EXTRA_CA_CERTS into any
    // configured CA. Passing `ca` straight through would *replace* the default trust
    // store — see platform/tls.ts.
    const agent = new Agent({
      connect: {
        ...buildConnectOptions(tls),
        // Happy Eyeballs, for the same reason as the proxy path: a black-holed AAAA record is a
        // hang rather than an error, and every other client on the machine falls back.
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: FAMILY_ATTEMPT_MS,
        timeout: CONNECT_TIMEOUT_MS,
      },
    })
    this.agents.set(key, agent)
    return agent
  }

  /** Drops pooled agents so the next request rebuilds TLS — call when certs change on disk. */
  resetTlsAgents(): void {
    for (const agent of this.agents.values()) void agent.close()
    this.agents.clear()
    for (const agent of this.proxyAgents.values()) void agent.close()
    this.proxyAgents.clear()
  }

  fetchFunction(tls?: TlsOptions): (url: string | URL, init?: RequestInit) => Promise<Response> {
    return async (url, init) => {
      const target = new URL(String(url))
      const dispatcher = (this.proxyFor(target, tls) ?? this.agentFor(tls ?? {})) as unknown as Dispatcher
      // undici's own fetch, given the dispatcher: the global fetch has no way to take one.
      const response = await undiciFetch(target, { ...(init as Record<string, unknown>), dispatcher } as Parameters<typeof undiciFetch>[1])
      return response as unknown as Response
    }
  }

  openWebSocket(url: string, options: { headers?: Record<string, string>; tls?: TlsOptions } = {}): WebSocketConnection {
    let target: URL | undefined
    try {
      // The proxy rules are written for http(s); a ws(s) URL goes the way its http twin would.
      target = new URL(url.replace(/^ws/i, 'http'))
    } catch {
      // Left to the WebSocket to reject.
    }
    const proxy = target === undefined ? undefined : this.proxyFor(target, options.tls, (options as HttpRequestOptions).proxy)
    const dispatcher = (proxy ?? this.agentFor(options.tls ?? {})) as unknown as Dispatcher
    const socket = new WebSocket(url, { dispatcher, ...(options.headers !== undefined ? { headers: options.headers } : {}) })
    const messages: ((text: string) => void)[] = []
    const closes: ((reason: string) => void)[] = []
    let closed = false
    const finish = (reason: string): void => {
      if (closed) return
      closed = true
      for (const listener of closes) listener(reason)
    }
    const opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', (event) => {
        const detail = (event as { error?: unknown }).error
        const reason = detail instanceof Error ? describeCause(detail) : 'the connection failed'
        reject(new Error(reason))
        finish(reason)
      })
    })
    // Rejected only for whoever awaits it; an unawaited rejection must not end the process.
    opened.catch(() => undefined)
    socket.addEventListener('message', (event) => {
      const data = (event as { data: unknown }).data
      if (typeof data === 'string') for (const listener of messages) listener(data)
    })
    socket.addEventListener('close', (event) => {
      const { code, reason } = event as unknown as { code: number; reason: string }
      finish(reason.length > 0 ? reason : `closed (${String(code)})`)
    })
    return {
      opened,
      send: (text) => socket.send(text),
      close: () => socket.close(),
      onMessage: (listener) => messages.push(listener),
      onClose: (listener) => closes.push(listener),
    }
  }

  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const init: Parameters<typeof undiciFetch>[1] = {}
    if (options.method !== undefined) init.method = options.method
    if (options.headers !== undefined) init.headers = options.headers
    if (options.body !== undefined) init.body = options.body
    // After `body`, so bytes win: the two are never both meant, and silently sending the text one
    // would be the corruption this field exists to avoid.
    if (options.bodyBytes !== undefined) init.body = options.bodyBytes
    if (options.signal !== undefined) init.signal = options.signal

    /*
     * A dispatcher is chosen even when no TLS material is configured.
     *
     * Before this, a request with no `tls` used undici's global dispatcher — which is exactly the
     * one that ignores the proxy environment. So the plainest case, an API key against a gateway,
     * was the one that could not be routed.
     */
    let target: URL | undefined
    try {
      target = new URL(url)
    } catch {
      // Left to `fetch` to reject, which says more about a malformed URL than anything here could.
    }
    const proxy = target === undefined ? undefined : this.proxyFor(target, options.tls, (options as HttpRequestOptions).proxy)
    if (proxy !== undefined) init.dispatcher = proxy as unknown as Dispatcher
    else if (options.tls !== undefined) init.dispatcher = this.agentFor(options.tls) as Dispatcher

    const response = await undiciFetch(url, init)
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text: () => response.text(),
      json: <T>() => response.json() as Promise<T>,
      body: response.body as ReadableStream<Uint8Array> | null,
    }
  }
}

/** undici hides the real reason on `.cause`, sometimes twice over; the innermost message says most. */
function describeCause(error: Error): string {
  let current: unknown = error
  let message = error.message
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current.message.length > 0) message = current.message
    current = (current as { cause?: unknown }).cause
  }
  return message
}
