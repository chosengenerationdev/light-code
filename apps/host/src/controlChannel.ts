import type { MonitorAnswer, MonitorExecutorChannel, MonitoringChannel, MonitorRequest } from '@light-code/core'

/**
 * Fire Code's control channel (`--control-stdin`): this host's stdin, after the vault key, carries Fire
 * Code's answers, one JSON line each; this host's stdout carries its questions on `light-code-monitor:`
 * lines. Monitoring is the only user. A pipe the parent holds, so there is no socket or port to secure and
 * nothing else on the machine can reach it.
 */

const PREFIX = 'light-code-monitor: '
/** How long an agent waits for Fire Code to answer. Fire Code answers at once; this only covers it being gone. */
const REPLY_TIMEOUT_MS = 30_000

interface Waiting {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class StdioControl {
  private readonly waiting = new Map<string, Waiting>()
  private requestHandler: ((request: MonitorRequest) => Promise<MonitorAnswer>) | undefined
  private buffer = ''
  private next = 0

  constructor(private readonly write: (line: string) => void = (line) => void process.stdout.write(line)) {}

  /** Starts reading: `rest` is whatever arrived after the key on the same read. */
  start(rest: string, input: NodeJS.ReadableStream = process.stdin): void {
    this.feed(rest)
    input.setEncoding?.('utf8')
    input.on('data', (chunk: string | Buffer) => this.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
    // Fire Code gone: nobody will answer what is waiting.
    input.on('end', () => {
      for (const [id, w] of this.waiting) {
        clearTimeout(w.timer)
        w.reject(new Error('Fire Code is no longer listening.'))
        this.waiting.delete(id)
      }
    })
    input.resume()
  }

  feed(chunk: string): void {
    this.buffer += chunk
    let at = this.buffer.indexOf('\n')
    while (at !== -1) {
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      if (line.length > 0) this.handle(line)
      at = this.buffer.indexOf('\n')
    }
  }

  private send(message: Record<string, unknown>): void {
    // JSON keeps it to one line whatever it holds, so Fire Code can split on lines.
    this.write(`${PREFIX}${JSON.stringify(message)}\n`)
  }

  private handle(line: string): void {
    let message: { type?: string; id?: unknown; ok?: boolean; data?: unknown; error?: string } & Record<string, unknown>
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    if (message.type === 'monitorReply' && typeof message.id === 'string') {
      const w = this.waiting.get(message.id)
      if (w === undefined) return
      this.waiting.delete(message.id)
      clearTimeout(w.timer)
      if (message.ok === true) w.resolve(message.data)
      else w.reject(new Error(message.error ?? 'Fire Code refused.'))
      return
    }
    if (message.type === 'monitorRequest' && typeof message.id === 'string' && this.requestHandler !== undefined) {
      const id = message.id
      const kind = message['kind']
      const args = (message['args'] ?? {}) as Record<string, unknown>
      const request: MonitorRequest | undefined =
        kind === 'fetch'
          ? { kind, id, tool: String(message['tool'] ?? ''), args, timeoutMs: Number(message['timeoutMs'] ?? 120_000) }
          : kind === 'store'
            ? { kind, id, op: String(message['op'] ?? ''), storeId: String(message['storeId'] ?? ''), index: String(message['index'] ?? ''), args }
            : kind === 'explain'
              ? { kind, id, context: (message['context'] ?? {}) as Record<string, unknown> }
              : kind === 'probe'
                ? { kind, id, tool: String(message['tool'] ?? '') }
              : kind === 'skill' && (message['op'] === 'write' || message['op'] === 'delete')
                ? {
                    kind,
                    id,
                    op: message['op'] === 'write' ? 'write' : 'delete',
                    name: String(message['name'] ?? ''),
                    file: String(message['file'] ?? ''),
                    ...(typeof message['content'] === 'string' ? { content: message['content'] } : {}),
                  }
                : undefined
      if (request === undefined) {
        this.send({ type: 'answer', id, ok: false, error: `"${String(kind)}" is not something this host answers.` })
        return
      }
      void this.requestHandler(request)
        .catch((error: unknown): MonitorAnswer => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        .then((answer) => this.send({ type: 'answer', id, ...answer }))
    }
  }

  /** What a chat's agent asks the monitoring engine through. */
  channel(): MonitoringChannel {
    return {
      request: (op, args = {}) =>
        new Promise((resolve, reject) => {
          const id = `r${String(++this.next)}`
          const timer = setTimeout(() => {
            this.waiting.delete(id)
            reject(new Error('Fire Code did not answer. Is monitoring switched on in Settings → Monitoring?'))
          }, REPLY_TIMEOUT_MS)
          this.waiting.set(id, { resolve, reject, timer })
          this.send({ type: 'request', id, op, args })
        }),
    }
  }

  /** The executor's side: answer fetches, and say so once ready. */
  executor(): MonitorExecutorChannel {
    return {
      serve: (handler) => {
        this.requestHandler = handler
        this.send({ type: 'ready' })
      },
    }
  }
}
