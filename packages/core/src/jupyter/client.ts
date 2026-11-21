import type { HttpClient, HttpResponse, TlsOptions, WebSocketConnection } from '../platform/http.js'
import { serverBase, type JupyterHubSpec } from './spec.js'

/**
 * The Jupyter Server REST API behind a JupyterHub user server - files (`/api/contents`) and kernels
 * (`/api/kernels`) - over the one `HttpClient` (invariant 2).
 *
 * The token goes in `Authorization: token ...` on every call and on the kernel WebSocket, never in a
 * URL: a URL ends up in logs and proxies. It is fetched per call, so a replaced token takes effect at
 * once. Requests only ever go to the server base built from the spec - every path is joined segment
 * by segment and encoded, and `..` is refused before anything is sent.
 */

export interface RemoteEntry {
  name: string
  /** Relative to the server's root, `/`-separated. */
  path: string
  type: 'directory' | 'file' | 'notebook'
  lastModified: string
  size?: number
}

export class JupyterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export class JupyterClient {
  private readonly base: string

  constructor(
    private readonly http: HttpClient,
    private readonly spec: JupyterHubSpec,
    private readonly token: () => Promise<string | undefined>,
    private readonly tls: () => Promise<TlsOptions | undefined>,
  ) {
    this.base = serverBase(spec)
  }

  /** Where the hub's own page is, for telling somebody to go and start their server. */
  hubHome(): string {
    return `${this.spec.url.replace(/\/+$/, '')}/hub/home`
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.token()
    if (token === undefined || token.length === 0) {
      throw new JupyterError('No JupyterHub token is stored for this codebase. Add one in Fire Code (right-click → JupyterHub settings…).')
    }
    return { Authorization: `token ${token}`, 'Content-Type': 'application/json' }
  }

  /**
   * One call to the user's server.
   *
   * **Bounded** (`deadlineMs`, two minutes unless the call says otherwise): a connection that went quiet
   * - a VPN reconnect, a proxy dropping an idle socket - is never told so, and without a limit the call,
   * and the agent waiting on it, hung until somebody restarted the agent (reported from real use).
   * **A stopped server is started** once and the call made again: hubs cull idle servers, and "start it
   * at the hub's page and try again" was a restart the user had to notice and do by hand.
   */
  private async call(
    method: string,
    apiPath: string,
    body?: unknown,
    signal?: AbortSignal,
    options: { deadlineMs?: number; afterStart?: boolean } = {},
  ): Promise<HttpResponse> {
    const tls = await this.tls()
    const headers = await this.headers()
    const deadlineMs = options.deadlineMs ?? CALL_DEADLINE_MS
    const send = async (): Promise<HttpResponse> => {
      const bounded = withDeadline(signal, deadlineMs)
      try {
        return await this.http.request(`${this.base}${apiPath}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: bounded.signal,
          ...(tls !== undefined ? { tls } : {}),
        })
      } catch (error) {
        throw bounded.timedOut() ? new JupyterError(`JupyterHub at ${this.spec.url} did not answer within ${String(Math.round(deadlineMs / 1000))} seconds.`) : error
      } finally {
        bounded.clear()
      }
    }
    let response: HttpResponse
    try {
      response = await send()
    } catch (first) {
      // A dropped connection is retried once - but only a read, which is safe to repeat. A save or
      // a kernel start might have happened before the connection dropped.
      if (method !== 'GET' || signal?.aborted === true) throw this.unreachable(first)
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        response = await send()
      } catch (second) {
        throw this.unreachable(second)
      }
    }
    if (response.status === 401 || response.status === 403) {
      throw new JupyterError(
        `JupyterHub refused the token (${String(response.status)}). It may have expired, or lack access to ${this.spec.user}'s server - ` +
          `create one on the hub's Token page and save it in Fire Code.`,
        response.status,
      )
    }
    // A stopped server answers API calls with 424 or 503 (or the hub's HTML spawn page).
    const type = response.headers['content-type'] ?? ''
    if (response.status === 424 || response.status === 503 || (response.status < 300 && type.includes('text/html'))) {
      // Nothing ran on a stopped server, so even a save is safe to send again once it is up.
      if (options.afterStart !== true && (await this.startServer())) return this.call(method, apiPath, body, signal, { ...options, afterStart: true })
      throw new JupyterError(`${this.spec.user}'s JupyterHub server is not running, and starting it did not work. Start it at ${this.hubHome()} and try again.`, response.status)
    }
    return response
  }

  private starting: Promise<boolean> | undefined

  /**
   * Asks the hub to start the user's server and waits until it is ready (up to three minutes). True when it
   * is. Shared by every call that found it stopped, so one start is asked for, not one per call. False -
   * never thrown - when the token may not start servers or the hub refuses: the caller then says so.
   */
  startServer(): Promise<boolean> {
    this.starting ??= this.startServerNow().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async startServerNow(): Promise<boolean> {
    const hub = `${this.spec.url.replace(/\/+$/, '')}/hub/api/users/${encodeURIComponent(this.spec.user)}`
    const tls = await this.tls()
    const headers = await this.headers()
    const ask = async (method: string, url: string): Promise<HttpResponse | undefined> => {
      const bounded = withDeadline(undefined, 30_000)
      try {
        return await this.http.request(url, { method, headers, signal: bounded.signal, ...(tls !== undefined ? { tls } : {}) })
      } catch {
        return undefined
      } finally {
        bounded.clear()
      }
    }
    const named = this.spec.server
    const started = await ask('POST', named !== undefined ? `${hub}/servers/${encodeURIComponent(named)}` : `${hub}/server`)
    // 201 started, 202 starting, 400 already running or starting.
    if (started === undefined || ![201, 202, 400].includes(started.status)) return false
    const until = Date.now() + 180_000
    while (Date.now() < until) {
      const user = await ask('GET', hub)
      if (user !== undefined && user.status < 300) {
        try {
          const model = (await user.json()) as { server?: unknown; pending?: unknown; servers?: Record<string, { ready?: unknown }> }
          const entry = model.servers?.[named ?? '']
          if (entry?.ready === true) return true
          // Hubs that do not list servers: a URL and nothing pending means up.
          if (model.servers === undefined && named === undefined && typeof model.server === 'string' && (model.pending === null || model.pending === undefined)) return true
        } catch {
          // Not JSON; asked again.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
    return false
  }

  private unreachable(error: unknown): JupyterError {
    if (error instanceof JupyterError) return error
    const cause = (error as { cause?: { message?: string } } | undefined)?.cause?.message
    const message = error instanceof Error ? error.message : String(error)
    return new JupyterError(`Could not reach JupyterHub at ${this.spec.url}: ${cause ?? message}`)
  }

  private async failure(response: HttpResponse, what: string): Promise<JupyterError> {
    let detail = ''
    try {
      const body = (await response.json()) as { message?: string; reason?: string }
      detail = body.message ?? body.reason ?? ''
    } catch {
      // No JSON body; the status says enough.
    }
    return new JupyterError(`${what} failed (${String(response.status)})${detail.length > 0 ? `: ${detail}` : '.'}`, response.status)
  }

  /** A folder's entries, or one entry's metadata. Undefined when nothing is at that path. */
  async list(remote: string, signal?: AbortSignal): Promise<RemoteEntry[] | undefined> {
    const response = await this.call('GET', `api/contents/${encodePath(remote)}?content=1`, undefined, signal)
    if (response.status === 404) return undefined
    if (response.status >= 300) throw await this.failure(response, `Listing ${remote || 'the top folder'}`)
    const model = (await response.json()) as RawModel
    if (model.type !== 'directory' || !Array.isArray(model.content)) return [toEntry(model)]
    return (model.content as RawModel[]).map(toEntry)
  }

  /** One entry's metadata without its content; undefined when absent. */
  async stat(remote: string, signal?: AbortSignal): Promise<RemoteEntry | undefined> {
    const response = await this.call('GET', `api/contents/${encodePath(remote)}?content=0`, undefined, signal)
    if (response.status === 404) return undefined
    if (response.status >= 300) throw await this.failure(response, `Checking ${remote}`)
    return toEntry((await response.json()) as RawModel)
  }

  /**
   * A file's bytes. Asked for as text first (notebooks too, as their raw JSON), and as base64 when
   * the server says it is not text.
   */
  async read(remote: string, signal?: AbortSignal): Promise<{ bytes: Buffer; lastModified: string }> {
    let response = await this.call('GET', `api/contents/${encodePath(remote)}?type=file&format=text&content=1`, undefined, signal)
    if (response.status === 400) {
      response = await this.call('GET', `api/contents/${encodePath(remote)}?type=file&format=base64&content=1`, undefined, signal)
    }
    if (response.status >= 300) throw await this.failure(response, `Reading ${remote}`)
    const model = (await response.json()) as RawModel
    const content = typeof model.content === 'string' ? model.content : ''
    return {
      bytes: model.format === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8'),
      lastModified: String(model.last_modified ?? ''),
    }
  }

  /** Saves a file (text when it is valid UTF-8, base64 otherwise); returns the hub's new timestamp. */
  async write(remote: string, bytes: Buffer, signal?: AbortSignal): Promise<string> {
    const text = bytes.toString('utf8')
    const isText = Buffer.from(text, 'utf8').equals(bytes)
    const response = await this.call(
      'PUT',
      `api/contents/${encodePath(remote)}`,
      { type: 'file', format: isText ? 'text' : 'base64', content: isText ? text : bytes.toString('base64') },
      signal,
    )
    if (response.status >= 300) throw await this.failure(response, `Saving ${remote}`)
    return String(((await response.json()) as RawModel).last_modified ?? '')
  }

  /** Creates a folder and any missing parents. */
  async ensureFolder(remote: string, signal?: AbortSignal): Promise<void> {
    const parts = remote.split('/').filter((p) => p.length > 0)
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join('/')
      if ((await this.stat(folder, signal)) !== undefined) continue
      const response = await this.call('PUT', `api/contents/${encodePath(folder)}`, { type: 'directory' }, signal)
      if (response.status >= 300) throw await this.failure(response, `Creating the folder ${folder}`)
    }
  }

  async kernelSpecs(): Promise<{ default: string; names: { name: string; label: string; language: string }[] }> {
    const response = await this.call('GET', 'api/kernelspecs')
    if (response.status >= 300) throw await this.failure(response, 'Listing kernels')
    const body = (await response.json()) as { default?: string; kernelspecs?: Record<string, { spec?: { display_name?: string; language?: string } }> }
    return {
      default: body.default ?? 'python3',
      names: Object.entries(body.kernelspecs ?? {}).map(([name, value]) => ({
        name,
        label: value.spec?.display_name ?? name,
        language: value.spec?.language ?? '',
      })),
    }
  }

  async startKernel(name: string | undefined): Promise<{ id: string; name: string }> {
    // `path: ''` starts it in the server's file root, where the contents paths are; without it a
    // kernel starts wherever the server process happens to be.
    const response = await this.call('POST', 'api/kernels', { path: '', ...(name !== undefined ? { name } : {}) }, undefined, { deadlineMs: 90_000 })
    if (response.status >= 300) throw await this.failure(response, `Starting a${name !== undefined ? ` ${name}` : ''} kernel`)
    const body = (await response.json()) as { id: string; name: string }
    return { id: body.id, name: body.name }
  }

  async kernelAlive(id: string): Promise<boolean> {
    return (await this.kernelState(id)) !== undefined
  }

  /** The kernel's `execution_state` (idle, busy, starting...), or undefined when it no longer exists. */
  async kernelState(id: string): Promise<string | undefined> {
    const response = await this.call('GET', `api/kernels/${encodeURIComponent(id)}`, undefined, undefined, { deadlineMs: 20_000 })
    if (response.status >= 300) return undefined
    try {
      const model = (await response.json()) as { execution_state?: unknown }
      return typeof model.execution_state === 'string' ? model.execution_state : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  async interruptKernel(id: string): Promise<void> {
    await this.call('POST', `api/kernels/${encodeURIComponent(id)}/interrupt`, undefined, undefined, { deadlineMs: 20_000 })
  }

  async shutdownKernel(id: string): Promise<void> {
    await this.call('DELETE', `api/kernels/${encodeURIComponent(id)}`, undefined, undefined, { deadlineMs: 20_000 })
  }

  /**
   * The kernel's message channel, authenticated by header like every other call. With `session`, the server
   * keeps what the kernel sends while the channel is down and replays it when the same session reconnects
   * - which is what lets a run cut off mid-way finish (`kernel.ts`).
   */
  async openChannels(id: string, session?: string): Promise<WebSocketConnection> {
    if (this.http.openWebSocket === undefined) throw new JupyterError('This host cannot open the WebSocket a kernel needs.')
    const query = session !== undefined ? `?session_id=${encodeURIComponent(session)}` : ''
    const url = `${this.base.replace(/^http/i, 'ws')}api/kernels/${encodeURIComponent(id)}/channels${query}`
    const tls = await this.tls()
    const headers = await this.headers()
    delete headers['Content-Type']
    return this.http.openWebSocket(url, { headers, ...(tls !== undefined ? { tls } : {}) })
  }
}

interface RawModel {
  name?: string
  path?: string
  type?: string
  last_modified?: string
  size?: number | null
  format?: string | null
  content?: unknown
}

function toEntry(model: RawModel): RemoteEntry {
  const type = model.type === 'directory' || model.type === 'notebook' ? model.type : 'file'
  return {
    name: model.name ?? '',
    path: model.path ?? '',
    type,
    lastModified: String(model.last_modified ?? ''),
    ...(typeof model.size === 'number' ? { size: model.size } : {}),
  }
}

/** Each segment encoded on its own, so a name with `#` or `?` cannot change what is asked for. */
export function encodePath(remote: string): string {
  const parts = remote.split('/').filter((p) => p.length > 0)
  if (parts.some((p) => p === '..' || p === '.')) throw new JupyterError(`"${remote}" is not a path inside the server.`)
  return parts.map(encodeURIComponent).join('/')
}

/** How long one call to the hub may take before it counts as lost, unless the call says otherwise. */
const CALL_DEADLINE_MS = 120_000

/** The caller's signal, plus a deadline of our own; `timedOut` says which one ended it. */
function withDeadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut: () => boolean; clear: () => void } {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, ms)
  const onAbort = (): void => controller.abort()
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => expired,
    clear: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}
