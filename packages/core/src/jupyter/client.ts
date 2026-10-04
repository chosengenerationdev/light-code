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

  private async call(method: string, apiPath: string, body?: unknown, signal?: AbortSignal): Promise<HttpResponse> {
    const tls = await this.tls()
    const headers = await this.headers()
    const send = (): Promise<HttpResponse> =>
      this.http.request(`${this.base}${apiPath}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal !== undefined ? { signal } : {}),
        ...(tls !== undefined ? { tls } : {}),
      })
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
      throw new JupyterError(`${this.spec.user}'s JupyterHub server is not running. Start it at ${this.hubHome()} and try again.`, response.status)
    }
    return response
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
    const response = await this.call('POST', 'api/kernels', { path: '', ...(name !== undefined ? { name } : {}) })
    if (response.status >= 300) throw await this.failure(response, `Starting a${name !== undefined ? ` ${name}` : ''} kernel`)
    const body = (await response.json()) as { id: string; name: string }
    return { id: body.id, name: body.name }
  }

  async kernelAlive(id: string): Promise<boolean> {
    const response = await this.call('GET', `api/kernels/${encodeURIComponent(id)}`)
    return response.status < 300
  }

  async interruptKernel(id: string): Promise<void> {
    await this.call('POST', `api/kernels/${encodeURIComponent(id)}/interrupt`)
  }

  async shutdownKernel(id: string): Promise<void> {
    await this.call('DELETE', `api/kernels/${encodeURIComponent(id)}`)
  }

  /** The kernel's message channel, authenticated by header like every other call. */
  async openChannels(id: string): Promise<WebSocketConnection> {
    if (this.http.openWebSocket === undefined) throw new JupyterError('This host cannot open the WebSocket a kernel needs.')
    const url = `${this.base.replace(/^http/i, 'ws')}api/kernels/${encodeURIComponent(id)}/channels`
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
