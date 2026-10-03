import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * A language-server client: just enough of LSP to open a file and hear its diagnostics.
 *
 * Hand-written JSON-RPC over stdio (Content-Length framing) rather than a library: the protocol
 * used is a handful of messages, and a dependency is something every user downloads. Requests the
 * server makes of the client are answered with the minimum that keeps servers happy.
 */

export interface LspDiagnostic {
  line: number
  column: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  source?: string
  code?: string
}

/**
 * One key per file however a server spells its URI: servers differ on drive-letter case and on
 * escaping the colon (pyright sends file:///c%3A/...), and an exact-string match hears nothing.
 */
function keyFor(uri: string): string {
  try {
    const p = fileURLToPath(uri)
    return process.platform === 'win32' ? p.toLowerCase() : p
  } catch {
    return uri
  }
}

const SEVERITY = ['error', 'error', 'warning', 'info', 'hint'] as const

export class LspClient {
  private child: ChildProcess
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private versions = new Map<string, number>()
  private diagnostics = new Map<string, LspDiagnostic[]>()
  private waiters = new Map<string, (() => void)[]>()
  private ready: Promise<void>
  exited = false
  lastError: string | undefined

  constructor(
    readonly executable: string,
    args: string[],
    private readonly root: string,
    private readonly log: (line: string) => void,
  ) {
    // An npm shim (.cmd) needs a shell; the command and its arguments come from Light Code's own
    // catalogue or the user's settings, never from a model.
    const shim = /\.(cmd|bat)$/i.test(executable)
    this.child = shim
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${executable}"`, ...args], { cwd: root, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(executable, args, { cwd: root, windowsHide: true })
    this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text.length > 0) this.log(`[lsp ${executable}] ${text.slice(0, 400)}`)
    })
    this.child.on('error', (error) => {
      this.exited = true
      this.lastError = error.message
      for (const p of this.pending.values()) p.reject(error)
      this.pending.clear()
    })
    this.child.on('exit', (code) => {
      this.exited = true
      this.lastError ??= `exited with code ${String(code)}`
      for (const p of this.pending.values()) p.reject(new Error(`The language server ${this.lastError}.`))
      this.pending.clear()
    })
    this.ready = this.initialize()
  }

  private async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.root).href
    await this.request('initialize', {
      processId: process.pid,
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false, versionSupport: true },
        },
        workspace: { configuration: true, workspaceFolders: true },
        window: { workDoneProgress: true },
      },
      initializationOptions: {},
    })
    this.notify('initialized', {})
  }

  private send(message: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8')
    this.child.stdin?.write(Buffer.concat([Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, 'ascii'), body]))
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params })
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? NaN)
      if (Number.isNaN(length)) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      if (this.buffer.length < headerEnd + 4 + length) return
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')
      this.buffer = this.buffer.subarray(headerEnd + 4 + length)
      try {
        this.onMessage(JSON.parse(body) as Record<string, unknown>)
      } catch {
        // A malformed message from a server is its problem; the next one may be fine.
      }
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    if (typeof message.id === 'number' && ('result' in message || 'error' in message) && message.method === undefined) {
      const waiting = this.pending.get(message.id)
      this.pending.delete(message.id)
      const error = message.error as { message?: string } | undefined
      if (error !== undefined) waiting?.reject(new Error(error.message ?? 'Language server error'))
      else waiting?.resolve(message.result)
      return
    }
    const method = message.method as string | undefined
    if (method === undefined) return
    if (message.id !== undefined) {
      // A request from the server. The answers that keep common servers working.
      const params = message.params as { items?: unknown[] } | undefined
      const result = method === 'workspace/configuration' ? (params?.items ?? []).map(() => null) : method === 'workspace/workspaceFolders' ? [{ uri: pathToFileURL(this.root).href, name: 'workspace' }] : null
      this.send({ id: message.id, result })
      return
    }
    if (method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri: string; diagnostics: { range: { start: { line: number; character: number } }; severity?: number; message: string; source?: string; code?: string | number }[] }
      const key = keyFor(params.uri)
      this.diagnostics.set(
        key,
        params.diagnostics.map((d) => ({
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: SEVERITY[d.severity ?? 1] ?? 'error',
          message: d.message,
          ...(d.source !== undefined ? { source: d.source } : {}),
          ...(d.code !== undefined ? { code: String(d.code) } : {}),
        })),
      )
      for (const wake of this.waiters.get(key) ?? []) wake()
      this.waiters.delete(key)
    }
  }

  /**
   * Opens (or updates) a file with this content and waits for the server's diagnostics: the first
   * report after the change, then a short quiet period, since several servers report twice.
   */
  async diagnose(file: string, text: string, languageId: string, timeoutMs: number): Promise<LspDiagnostic[] | undefined> {
    await Promise.race([this.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('The language server did not start in time.')), timeoutMs))])
    const uri = pathToFileURL(file).href
    const key = keyFor(uri)
    const version = (this.versions.get(uri) ?? 0) + 1
    this.versions.set(uri, version)
    const arrived = new Promise<boolean>((resolve) => {
      const list = this.waiters.get(key) ?? []
      list.push(() => resolve(true))
      this.waiters.set(key, list)
      setTimeout(() => resolve(false), timeoutMs)
    })
    if (version === 1) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } })
    } else {
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
    }
    this.notify('textDocument/didSave', { textDocument: { uri }, text })
    const got = await arrived
    if (!got) return this.diagnostics.get(key)
    // A second, fuller report often follows the first quickly.
    await new Promise((resolve) => setTimeout(resolve, 400))
    return this.diagnostics.get(key)
  }

  dispose(): void {
    try {
      this.notify('exit', null)
    } catch {
      // Already gone.
    }
    this.child.kill()
  }
}
