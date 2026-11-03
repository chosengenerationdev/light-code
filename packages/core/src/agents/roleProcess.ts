import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import type { ObserverModelSpec } from '../observers/process.js'

/**
 * One specialist of the agent team as its own process (`fire-fs agent`, `role_agent.rs`), supervised from here.
 *
 * Asked for: "each agent should have its own rust process and its own context ... main agent's context should
 * not include these subagents contexts". The process keeps the specialist's conversation for the chat; the main
 * agent sees only each answer. Its tool calls come back here (`runTool`) and run under the consultation's rules
 * - reads free, everything else through the user's approval - exactly as `runConsultation` runs them.
 *
 * Near its context limit the process hands off **by itself**: it asks its own model for the key points while
 * there is room, and starts a fresh conversation with them. What it reports is kept here too, so a process that
 * dies is restarted from the latest key points rather than from nothing.
 *
 * One question at a time per specialist (they are queued), and a tool set that changes - a role made read-only
 * by a strategy, write access switched on - starts a new process from the key points, because a process takes
 * its tools once.
 */

export interface RoleProcessOptions {
  exe: string
  role: string
  system: string
  window: number
  model: ObserverModelSpec
  /** The tools, already in the wire format's own shape (`toOpenAITools` and its siblings). */
  tools: unknown[]
  resolveAuth(force: boolean): Promise<Record<string, string>>
  log(message: string): void
  /** For tests: what starts the process. */
  start?: (exe: string) => ChildProcessWithoutNullStreams
}

export interface RoleAnswer {
  text: string
  steps: number
  truncated: boolean
}

export interface RoleAsk {
  prompt: string
  maxSteps: number
  /** False: answer from what it was told, no tools this time. */
  tools: boolean
  runTool(name: string, argumentsText: string): Promise<string>
  onStep?: (name: string) => void
  signal?: AbortSignal | undefined
}

export interface RoleProcessStatus {
  role: string
  generation: number
  handoffs: number
  tokens?: number
  window: number
  pid?: number
}

interface Pending {
  id: number
  ask: RoleAsk
  resolve: (answer: RoleAnswer) => void
  reject: (error: Error) => void
}

const MAX_STARTS = 5
const START_WINDOW_MS = 10 * 60_000

export class RoleProcess {
  private child: ChildProcessWithoutNullStreams | undefined
  private notes = ''
  private starts: number[] = []
  private nextId = 0
  private current: Pending | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false
  private failure: string | undefined
  readonly status: RoleProcessStatus

  constructor(private readonly options: RoleProcessOptions) {
    this.status = { role: options.role, generation: 0, handoffs: 0, window: options.window }
  }

  /** The key points it last handed over, for a successor with different tools. */
  get keyPoints(): string {
    return this.notes
  }

  set keyPoints(value: string) {
    this.notes = value
  }

  /** Asks one question; questions to one specialist are answered in order. */
  consult(ask: RoleAsk): Promise<RoleAnswer> {
    const run = this.queue.then(() => this.one(ask))
    this.queue = run.catch(() => undefined)
    return run
  }

  stop(): void {
    this.stopped = true
    const child = this.child
    this.child = undefined
    if (child !== undefined) {
      this.write(child, { type: 'stop' })
      child.stdin.end()
      setTimeout(() => child.kill(), 2_000).unref()
    }
    this.current?.reject(new Error('The specialist was stopped.'))
    this.current = undefined
  }

  private write(child: ChildProcessWithoutNullStreams, message: unknown): void {
    if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private one(ask: RoleAsk): Promise<RoleAnswer> {
    if (this.stopped) return Promise.reject(new Error('The specialist was stopped.'))
    if (ask.signal?.aborted === true) return Promise.reject(new Error('cancelled'))
    const child = this.child ?? this.launch()
    if (child === undefined) return Promise.reject(new Error(this.failure ?? `The ${this.options.role} process could not start.`))
    return new Promise<RoleAnswer>((resolve, reject) => {
      const id = ++this.nextId
      this.current = { id, ask, resolve, reject }
      const onAbort = (): void => {
        this.write(child, { type: 'cancel', id })
        if (this.current?.id === id) {
          this.current = undefined
          reject(new Error('cancelled'))
        }
      }
      ask.signal?.addEventListener('abort', onAbort, { once: true })
      this.write(child, { type: 'ask', id, prompt: ask.prompt, maxSteps: ask.maxSteps, tools: ask.tools })
    })
  }

  private launch(): ChildProcessWithoutNullStreams | undefined {
    const now = Date.now()
    this.starts = this.starts.filter((at) => now - at < START_WINDOW_MS)
    if (this.starts.length >= MAX_STARTS) {
      this.failure = `${this.failure ?? `The ${this.options.role} process kept stopping`} - started ${String(MAX_STARTS)} times in ten minutes, so it is left stopped for now.`
      return undefined
    }
    this.starts.push(now)
    let child: ChildProcessWithoutNullStreams
    try {
      child = (this.options.start ?? ((exe) => spawn(exe, ['agent'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })))(this.options.exe)
    } catch (error) {
      this.failure = `Could not start ${this.options.exe}: ${error instanceof Error ? error.message : String(error)}`
      return undefined
    }
    this.child = child
    this.status.generation += 1
    // A write to a process that has just died raises EPIPE; unheard, it would end the host (§12ao).
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => {
      this.failure = `Could not start ${this.options.exe}: ${error.message}`
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2_000)))
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      this.handle(child, message)
    })
    child.on('close', (code) => {
      if (this.child === child) this.child = undefined
      const pending = this.current
      this.current = undefined
      if (this.stopped) return
      const reason = stderr.trim().split('\n').at(-1) ?? ''
      this.failure ??= `The ${this.options.role} process stopped (exit ${String(code)})${reason.length > 0 ? `: ${reason}` : ''}.`
      this.options.log(this.failure)
      // The question in flight is answered with the failure; the next one starts a new process from the key points.
      pending?.reject(new Error(`${this.failure} Ask again - a fresh ${this.options.role} starts from its key points.`))
      this.failure = undefined
    })
    this.write(child, {
      type: 'start',
      role: this.options.role,
      system: this.options.system,
      window: this.options.window,
      model: this.options.model,
      tools: this.options.tools,
      handoff: this.notes,
    })
    return child
  }

  private handle(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
    const pending = this.current
    switch (message['type']) {
      case 'ready':
        if (typeof message['pid'] === 'number') this.status.pid = message['pid']
        break
      case 'needAuth': {
        const id = message['id']
        this.options
          .resolveAuth(message['force'] === true)
          .then((headers) => this.write(child, { type: 'auth', id, headers }))
          .catch((error: unknown) => this.write(child, { type: 'auth', id, error: error instanceof Error ? error.message : String(error) }))
        break
      }
      case 'needTool': {
        const callId = message['callId']
        const name = typeof message['name'] === 'string' ? message['name'] : ''
        const args = typeof message['arguments'] === 'string' ? message['arguments'] : '{}'
        if (pending === undefined || message['id'] !== pending.id) {
          this.write(child, { type: 'toolResult', callId, content: 'The question this belonged to was cancelled.' })
          break
        }
        pending.ask
          .runTool(name, args)
          .catch((error: unknown) => `That failed: ${error instanceof Error ? error.message : String(error)}`)
          .then((content) => this.write(child, { type: 'toolResult', callId, content }))
        break
      }
      case 'step':
        if (pending !== undefined && typeof message['name'] === 'string') pending.ask.onStep?.(message['name'])
        break
      case 'answer':
        if (pending !== undefined && message['id'] === pending.id) {
          this.current = undefined
          pending.resolve({ text: typeof message['text'] === 'string' ? message['text'] : '', steps: Number(message['steps'] ?? 0), truncated: message['truncated'] === true })
        }
        break
      case 'usage':
        if (typeof message['tokens'] === 'number') this.status.tokens = message['tokens']
        break
      case 'handoff':
        if (typeof message['notes'] === 'string') this.notes = message['notes']
        this.status.handoffs += 1
        this.options.log(`${this.options.role}: context at ${String(message['tokens'])} of ${String(this.options.window)} tokens - started a fresh session from its key points`)
        break
      case 'error': {
        const text = typeof message['message'] === 'string' ? message['message'] : 'unknown error'
        if (message['fatal'] === true) {
          this.failure = text
          this.stopped = true
          pending?.reject(new Error(text))
          this.current = undefined
        } else if (pending !== undefined && message['id'] === pending.id) {
          this.current = undefined
          pending.reject(new Error(text))
        }
        break
      }
    }
  }
}
