import { createHash } from 'node:crypto'
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { buildConnectOptions } from './tls.js'

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
}

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  tls?: TlsOptions
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
  return hash.digest('hex')
}

/**
 * Uses `undici` rather than global `fetch` because Node's built-in fetch has no supported
 * way to present a client certificate. Same WHATWG API and streaming body, so nothing
 * downstream changes.
 */
export class FetchHttpClient implements HttpClient {
  /** Agents are pooled: building one per request would discard connection reuse entirely. */
  private readonly agents = new Map<string, Agent>()

  private agentFor(tls: TlsOptions): Agent {
    const key = tlsKey(tls)
    const existing = this.agents.get(key)
    if (existing !== undefined) return existing

    // `buildConnectOptions` merges the bundled roots and NODE_EXTRA_CA_CERTS into any
    // configured CA. Passing `ca` straight through would *replace* the default trust
    // store — see platform/tls.ts.
    const agent = new Agent({ connect: buildConnectOptions(tls) })
    this.agents.set(key, agent)
    return agent
  }

  /** Drops pooled agents so the next request rebuilds TLS — call when certs change on disk. */
  resetTlsAgents(): void {
    for (const agent of this.agents.values()) void agent.close()
    this.agents.clear()
  }

  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const init: Parameters<typeof undiciFetch>[1] = {}
    if (options.method !== undefined) init.method = options.method
    if (options.headers !== undefined) init.headers = options.headers
    if (options.body !== undefined) init.body = options.body
    if (options.signal !== undefined) init.signal = options.signal
    if (options.tls !== undefined) init.dispatcher = this.agentFor(options.tls) as Dispatcher

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
