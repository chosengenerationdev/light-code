import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { Logger } from '../logging/logger.js'
import { OFFICE_WORKER_SOURCE } from './workerSource.js'

/**
 * Talks to Excel and Outlook on this machine, through one long-lived PowerShell process.
 *
 * ## Why a persistent process
 *
 * Attaching to a running Office application takes about a second, and doing it per call would
 * make every question slow *and* risk launching a second Excel beside the one the user is
 * looking at. The worker keeps the COM handles and answers a request in milliseconds — the same
 * shape as the Python tool worker, for the same reasons.
 *
 * ## Why powershell.exe specifically
 *
 * `Marshal::GetActiveObject` is the only way to reach an Office application that is *already
 * running*, and it does not exist in .NET Core, so `pwsh` throws PlatformNotSupported. Attaching
 * to the live session is the whole point, so Windows PowerShell 5.1 is resolved deliberately
 * rather than taking whatever `powershell` happens to mean.
 *
 * ## Why nothing model-supplied ever reaches a command line
 *
 * Sheet names, ranges and search terms are model-authored text. They travel as JSON on stdin and
 * are only ever passed as *arguments* to COM methods (CLAUDE.md section 16). The script is
 * written to disk from a bundled constant, so there is nothing to interpolate and no shell.
 */

export interface OfficeRequest {
  op: string
  [key: string]: unknown
}

export interface OfficeBridgeOptions {
  /** Where the worker script is written. The host's storage directory. */
  storageDir: string
  logger: Logger
  /**
   * Per-request ceiling. Read from a function rather than fixed at construction, so raising the
   * tool timeout applies to the very next call instead of after a restart.
   */
  timeoutMs?: () => number | undefined
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Why a request ran out of time, offered rather than asserted, worded for the application asked.
 *
 * Causes offered, not asserted: the first version said a dialog was "usually" the reason, the
 * assistant relayed that as fact, and a user went looking for a popup that did not exist — twice.
 * A confident wrong diagnosis costs the person a search as well as the failure.
 */
export function describeTimeout(op: string, seconds: number): string {
  const restarted = 'The helper has been restarted, so the next request starts clean.'
  if (op.startsWith('outlook.')) {
    return (
      `Outlook did not answer within ${String(seconds)}s. ${restarted} ` +
      'Possible causes, roughly in order: the request covers more mail than it can read in that time ' +
      '(narrow it — a folder, a date range, fewer results); Outlook is busy syncing or sending and stayed ' +
      'busy throughout; Outlook is showing a window that waits for a click — its security prompt ' +
      '("A program is trying to access e-mail address information…") holds a request until somebody ' +
      'answers it. Raise the time in Settings → Tools if this machine is simply slow. ' +
      'Do not tell the user a window is open unless they can see one.'
    )
  }
  return (
    `Excel did not answer within ${String(seconds)}s. ${restarted} ` +
    'Raise it in Settings → Tools if this machine is simply slow. ' +
    'Possible causes, roughly in order: the request covers more than it can do in that ' +
    'time (a wide range — try a smaller scope), Excel is showing a dialog and waiting for a ' +
    'click, or it is busy with something else. ' +
    'Do not tell the user a dialog is open unless they can see one.'
  )
}

/** Windows only, and said plainly rather than failing later with a spawn error. */
export function officeSupported(): boolean {
  return process.platform === 'win32'
}

export class OfficeBridge {
  private child: ChildProcess | undefined
  private buffer = ''
  private counter = 0
  private readonly waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private scriptPath: string | undefined
  private starting: Promise<void> | undefined

  constructor(private readonly options: OfficeBridgeOptions) {}

  async request<T>(request: OfficeRequest): Promise<T> {
    if (!officeSupported()) {
      throw new Error('Excel and Outlook integration works on Windows only — this machine is not running Windows.')
    }
    await this.ensureStarted()

    const id = String(++this.counter)
    const timeoutMs = this.options.timeoutMs?.() ?? DEFAULT_TIMEOUT_MS

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        /*
         * The helper is restarted, not left to finish.
         *
         * It answers one request at a time, and a COM call that has not returned is still running
         * inside it after we stop waiting. Left alone, every request behind it queued and timed out
         * as well — which is what "Outlook might be busy", again and again, actually was: one stuck
         * call, and a dozen innocent ones failing behind it until it came back. A fresh helper
         * re-attaches in about a second; the stuck call dies with the old one.
         */
        this.restart()
        reject(new Error(describeTimeout(request.op, Math.round(timeoutMs / 1000))))
      }, timeoutMs)

      this.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })

      this.child?.stdin?.write(`${JSON.stringify({ id, ...request })}\n`)
    })
  }

  /**
   * Ends the helper and everything it started, so the next request starts a fresh one. `kill()`
   * alone does not reach grandchildren on Windows (§16), hence the process tree.
   */
  private restart(): void {
    const child = this.child
    this.child = undefined
    if (child === undefined) return
    const pid = child.pid
    // Whatever else was waiting on this helper would only time out in turn; say so now instead.
    for (const pending of this.waiting.values()) {
      pending.reject(new Error('The Excel/Outlook helper was restarted after an earlier request hung. Try again.'))
    }
    this.waiting.clear()
    if (pid !== undefined && process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => undefined)
    } else {
      child.kill()
    }
  }

  /** Started once, and shared: two callers racing must not spawn two PowerShell processes. */
  private async ensureStarted(): Promise<void> {
    if (this.child !== undefined && this.child.exitCode === null) return
    this.starting ??= this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async start(): Promise<void> {
    const target = path.join(this.options.storageDir, 'office-worker.ps1')
    /*
     * Written with a BOM.
     *
     * Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI, so any non-ASCII character in the
     * file becomes mojibake — which, in a string literal, is a parse error and a worker that
     * never starts. The generator also refuses non-ASCII source; this is the second belt.
     */
    await fs.mkdir(this.options.storageDir, { recursive: true })
    // Written as an escape: a literal byte-order mark in source is invisible and lint flags it.
    const BOM = '\uFEFF'
    await fs.writeFile(target, `${BOM}${OFFICE_WORKER_SOURCE}`, 'utf8')
    this.scriptPath = target

    const child = spawn(
      'powershell.exe',
      // -Sta: the COM message filter that rides out "busy" only works on a single-threaded apartment.
      ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', target],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    this.child = child
    this.buffer = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.consume(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      // A PowerShell parse error arrives here and nowhere else. Silently dropping it is how a
      // worker that never starts becomes a request that merely times out.
      this.options.logger.warn(`office worker: ${String(chunk).trim().slice(0, 500)}`)
    })
    child.on('exit', (code) => {
      // A helper replaced after a hang exits later; it must not clear its successor.
      if (this.child !== child) return
      this.child = undefined
      const error = new Error(`The Excel/Outlook helper stopped unexpectedly (exit ${String(code)}).`)
      for (const pending of this.waiting.values()) pending.reject(error)
      this.waiting.clear()
    })

    // Proves the process is alive and parsed before anything real depends on it.
    await this.request({ op: 'ping' })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
      if (line.length === 0) continue

      let message: { id?: string; ok?: boolean; result?: unknown; error?: string }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        // Not ours: PowerShell writes the odd banner or progress line. Logged rather than
        // treated as a protocol failure, since discarding a real answer would be worse.
        this.options.logger.warn(`office worker: unparsed output ${line.slice(0, 200)}`)
        continue
      }

      const pending = message.id === undefined ? undefined : this.waiting.get(message.id)
      if (pending === undefined) continue
      this.waiting.delete(message.id as string)

      if (message.ok === true) pending.resolve(message.result)
      else pending.reject(new Error(message.error ?? 'The Excel/Outlook helper reported an unknown failure.'))
    }
  }

  async dispose(): Promise<void> {
    const child = this.child
    this.child = undefined
    for (const pending of this.waiting.values()) {
      pending.reject(new Error('The Excel/Outlook helper was shut down.'))
    }
    this.waiting.clear()
    child?.stdin?.end()
    child?.kill()
    if (this.scriptPath !== undefined) {
      await fs.rm(this.scriptPath, { force: true }).catch(() => undefined)
    }
  }
}
