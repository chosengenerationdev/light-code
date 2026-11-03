import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import type { ObservedEvent } from './events.js'

/**
 * One observer - the Auditor or the Anti Hallucinator - as its own process (`fire-fs watch`, `observer.rs`),
 * supervised from here.
 *
 * ## The handoff, and why it cannot fail at the limit
 *
 * Asked: "when context limit hits handoff may fail I guess, so it has to be a separate agent process for the
 * handoff?" No process has to write anything when a context is full. Every reply the observer gives carries
 * its own running notes (`state`), and this supervisor keeps the latest plus the last few findings. When the
 * process says its context is past 70% (`handoff`), or it dies, the next process is started here with those
 * notes, and the events it had not reviewed yet are sent to it first. What is handed over already exists.
 *
 * A process that keeps dying is not restarted for ever: five starts in ten minutes and it stops, says why,
 * and recording carries on without it (the journal is written by the host, not by the observer).
 */

export interface ObserverModelSpec {
  wire: 'openai' | 'anthropic' | 'gemini'
  baseUrl: string
  model: string
  maxTokens?: number
  /** The profile's own extra headers. Auth headers are asked for per call, never put here. */
  headers?: Record<string, string>
  tls?: { ca?: string[]; cert?: string; key?: string; rejectUnauthorized?: boolean }
}

export type ObserverRole = 'auditor' | 'guard'

export interface ObserverStatus {
  role: ObserverRole
  state: 'starting' | 'running' | 'stopped' | 'retrying' | 'failed'
  /** How many processes this observer has had: 1 for the first, one more per handoff or restart. */
  generation: number
  handoffs: number
  tokens?: number
  window: number
  pid?: number
  lastError?: string
  /** Epoch ms of the last review the model answered. */
  lastReviewAt?: number
}

export interface ObserverAgentOptions {
  exe: string
  role: ObserverRole
  system: string
  window: number
  model: ObserverModelSpec
  /** Auth headers from the profile's strategy; `force` after a 401, so a token is refreshed. */
  resolveAuth(force: boolean): Promise<Record<string, string>>
  onResult(reply: unknown, raw: string): void
  onStatus(status: ObserverStatus): void
  log(message: string): void
  /** For tests: what starts the process. */
  start?: (exe: string) => ChildProcessWithoutNullStreams
}

const MAX_STARTS = 5
const START_WINDOW_MS = 10 * 60_000
const MAX_BUFFERED = 400
const MEMORY = 10

export class ObserverAgent {
  private child: ChildProcessWithoutNullStreams | undefined
  private stopped = false
  private starts: number[] = []
  private state = ''
  private recent: string[] = []
  /** Events sent while no process was there to take them. */
  private buffered: ObservedEvent[] = []
  private readonly status: ObserverStatus

  constructor(private readonly options: ObserverAgentOptions) {
    this.status = { role: options.role, state: 'starting', generation: 0, handoffs: 0, window: options.window }
  }

  get current(): ObserverStatus {
    return { ...this.status }
  }

  /** Something the next process should know: a finding or a note, in a line. Kept for the handoff. */
  remember(line: string): void {
    this.recent.push(line.slice(0, 400))
    if (this.recent.length > MEMORY) this.recent.shift()
  }

  /** The running notes plus recent findings: what a new process starts with. */
  handoffText(): string {
    const parts: string[] = []
    if (this.state.length > 0) parts.push(`Running notes:\n${this.state}`)
    if (this.recent.length > 0) parts.push(`Recent findings:\n${this.recent.map((r) => `- ${r}`).join('\n')}`)
    return parts.join('\n\n')
  }

  start(): void {
    this.stopped = false
    this.launch(undefined)
  }

  send(event: ObservedEvent): void {
    if (this.stopped) return
    if (!this.write({ type: 'event', event })) {
      this.buffered.push(event)
      if (this.buffered.length > MAX_BUFFERED) this.buffered.shift()
    }
  }

  /** Asks for a review now, of whatever is waiting. */
  flush(): void {
    this.write({ type: 'flush' })
  }

  stop(): void {
    this.stopped = true
    const child = this.child
    this.child = undefined
    if (child !== undefined) {
      this.writeTo(child, { type: 'stop' })
      child.stdin.end()
      setTimeout(() => child.kill(), 2_000).unref()
    }
    this.report({ state: 'stopped' })
  }

  private report(change: Partial<ObserverStatus>): void {
    Object.assign(this.status, change)
    this.options.onStatus({ ...this.status })
  }

  private write(message: unknown): boolean {
    return this.child !== undefined && this.writeTo(this.child, message)
  }

  private writeTo(child: ChildProcessWithoutNullStreams, message: unknown): boolean {
    if (child.stdin.destroyed || !child.stdin.writable) return false
    child.stdin.write(`${JSON.stringify(message)}\n`)
    return true
  }

  private launch(pending: readonly ObservedEvent[] | undefined): void {
    const now = Date.now()
    this.starts = this.starts.filter((at) => now - at < START_WINDOW_MS)
    if (this.starts.length >= MAX_STARTS) {
      this.report({ state: 'failed', lastError: `${this.status.lastError ?? 'It kept stopping'} - started ${String(MAX_STARTS)} times in ten minutes, so it was left stopped. Recording carries on; switch it off and on to try again.` })
      return
    }
    this.starts.push(now)
    let child: ChildProcessWithoutNullStreams
    try {
      child = (this.options.start ?? ((exe) => spawn(exe, ['watch'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })))(this.options.exe)
    } catch (error) {
      this.report({ state: 'failed', lastError: `Could not start ${this.options.exe}: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    this.child = child
    this.report({ state: 'starting', generation: this.status.generation + 1 })
    // A write to a process that has just died raises EPIPE as an 'error' event; unheard, it ends the host (§12ao).
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => {
      this.status.lastError = `Could not start ${this.options.exe}: ${error.message}`
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2_000)))
    let handedOff = false
    let fatal = false
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      switch (message['type']) {
        case 'ready':
          this.report({ state: 'running', ...(typeof message['pid'] === 'number' ? { pid: message['pid'] } : {}) })
          break
        case 'needAuth': {
          const id = message['id']
          this.options
            .resolveAuth(message['force'] === true)
            .then((headers) => this.writeTo(child, { type: 'auth', id, headers }))
            .catch((error: unknown) => this.writeTo(child, { type: 'auth', id, error: error instanceof Error ? error.message : String(error) }))
          break
        }
        case 'result': {
          const reply = message['reply'] ?? null
          const state = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>)['state'] : undefined
          if (typeof state === 'string' && state.trim().length > 0) this.state = state.trim().slice(0, 2_000)
          this.report({ state: 'running', lastReviewAt: Date.now() })
          this.options.onResult(reply, typeof message['raw'] === 'string' ? message['raw'] : '')
          break
        }
        case 'usage':
          if (typeof message['tokens'] === 'number') this.report({ tokens: message['tokens'] })
          break
        case 'error': {
          const text = typeof message['message'] === 'string' ? message['message'] : 'unknown error'
          fatal = message['fatal'] === true
          this.report({ state: fatal ? 'failed' : 'retrying', lastError: text })
          this.options.log(`${this.options.role}: ${text}`)
          break
        }
        case 'handoff': {
          handedOff = true
          // This process reads nothing more: from here events wait for the next one rather than going to it.
          if (this.child === child) this.child = undefined
          if (typeof message['state'] === 'string' && message['state'].length > 0) this.state = message['state']
          const rest = Array.isArray(message['pending']) ? (message['pending'] as ObservedEvent[]) : []
          this.options.log(`${this.options.role}: context at ${String(message['tokens'])} of ${String(this.options.window)} tokens - handing off to a new process`)
          this.status.handoffs += 1
          // Whatever arrives before the new process is up waits in `buffered`, in front of nothing older.
          this.buffered = [...rest, ...this.buffered]
          break
        }
      }
    })
    child.on('close', (code) => {
      if (this.child === child) this.child = undefined
      if (this.stopped || fatal) return
      if (!handedOff) {
        const reason = stderr.trim().split('\n').at(-1) ?? ''
        this.status.lastError = `The ${this.options.role === 'auditor' ? 'Auditor' : 'Anti Hallucinator'} process stopped (exit ${String(code)})${reason.length > 0 ? `: ${reason}` : ''}. Starting a new one from its notes.`
        this.options.log(this.status.lastError)
      }
      this.launch(undefined)
    })
    this.writeTo(child, {
      type: 'start',
      role: this.options.role,
      system: this.options.system,
      window: this.options.window,
      model: this.options.model,
      handoff: this.handoffText(),
    })
    const waiting = [...(pending ?? []), ...this.buffered]
    this.buffered = []
    for (const event of waiting) this.writeTo(child, { type: 'event', event })
  }
}
