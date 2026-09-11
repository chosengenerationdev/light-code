import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { Logger } from '../logging/logger.js'

/**
 * Owns the Python worker process: one per workspace, restarted when it dies.
 *
 * Persistent rather than process-per-call because import and interpreter startup dominate a
 * short tool's runtime. The cost is that all tools share one interpreter and one virtualenv,
 * so dependency conflicts between tools are possible — a documented, accepted tradeoff
 * (§13), not an oversight.
 */

export interface WorkerToolDescription {
  name: string
  description: string
  schema: Record<string, unknown>
}

export interface WorkerCallResult {
  result: unknown
  /** Whatever the tool printed. Returned, not discarded — printing is how people debug. */
  stdout: string
}

export class PythonWorkerError extends Error {
  constructor(
    message: string,
    /** The Python traceback, when there is one. Fed back so the model can fix its own code. */
    readonly traceback?: string,
  ) {
    super(message)
    this.name = 'PythonWorkerError'
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface PythonWorkerOptions {
  /** Interpreter inside the shared virtualenv. */
  pythonPath: string
  /** Absolute path to `worker/main.py`. */
  workerScript: string
  /** Working directory for the child. */
  cwd: string
  /** Minimal by construction — see `minimalPythonEnv`. Never `process.env`. */
  env: NodeJS.ProcessEnv
  logger: Logger
  /**
   * Runs another tool on a Python tool's behalf.
   *
   * Supplied by the host, which is the only place that can see the registry, the approval gate
   * and whether anybody is present to answer one. Absent means the feature is off for this
   * session — an unattended scheduled run, where a prompt would never be answered.
   */
  callTool?:
    | ((name: string, args: Record<string, unknown>, caller: string) => Promise<unknown>)
    | undefined
  /** Per-call budget. A tool that hangs must not hang the turn. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

export class PythonWorker {
  private child: ChildProcessWithoutNullStreams | undefined
  private reader: Interface | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private disposed = false

  constructor(private readonly options: PythonWorkerOptions) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined && this.child.exitCode === null && !this.child.killed) return this.child

    const child = spawn(this.options.pythonPath, [this.options.workerScript], {
      cwd: this.options.cwd,
      env: this.options.env,
      windowsHide: true,
      // Never `shell: true`: arguments here include model-influenced paths, and a shell
      // would make those injectable (§16).
      shell: false,
    })

    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', (line) => this.onLine(line))

    /*
     * stderr must be drained, not merely ignored. An unread pipe fills its ~64KB OS buffer
     * and the child then blocks on its next write — presenting as a worker that hangs
     * partway through work. The same trap as MCP stdio servers in §11.
     */
    child.stderr.on('data', (chunk: Buffer) => {
      this.options.logger.warn('python worker stderr', chunk.toString('utf8').trimEnd())
    })

    child.on('exit', (code, signal) => {
      // Every in-flight call is now unanswerable. Rejecting is the only honest outcome —
      // leaving them pending would hang the turn on a process that no longer exists.
      const reason = new PythonWorkerError(
        `The Python worker exited (${signal ?? code ?? 'unknown'}). It will restart on the next call.`,
      )
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(reason)
      }
      this.pending.clear()
      this.child = undefined
    })

    child.on('error', (error) => this.options.logger.warn('python worker failed to start', String(error)))

    this.child = child
    return child
  }

  private onLine(line: string): void {
    let frame: {
      id?: unknown
      ok?: unknown
      value?: unknown
      error?: unknown
      traceback?: unknown
      callback?: unknown
      method?: unknown
      name?: unknown
      arguments?: unknown
      caller?: unknown
    }
    try {
      frame = JSON.parse(line) as typeof frame
    } catch {
      // Not a frame. Almost certainly the tool printing — logged, never fatal, because a
      // stray print must not be able to break the channel.
      this.options.logger.debug('python worker output', line)
      return
    }
    /*
     * A request coming *up* the pipe, from a tool calling another tool.
     *
     * The worker is otherwise a strict request/response loop, so this is the one frame that is
     * not an answer to something we asked. It is answered and the pending call is left alone —
     * the tool is still running, blocked on this reply.
     */
    if (typeof frame.callback === 'string') {
      void this.serveCallback(frame.callback, frame.name, frame.arguments, frame.caller)
      return
    }

    if (typeof frame.id !== 'number') return
    const entry = this.pending.get(frame.id)
    if (entry === undefined) return
    this.pending.delete(frame.id)
    clearTimeout(entry.timer)

    if (frame.ok === true) entry.resolve(frame.value)
    else {
      entry.reject(
        new PythonWorkerError(
          typeof frame.error === 'string' ? frame.error : 'The Python tool failed.',
          typeof frame.traceback === 'string' ? frame.traceback : undefined,
        ),
      )
    }
  }

  /**
   * Runs a tool on a Python tool's behalf and writes the answer back.
   *
   * The rules live in `options.callTool`, which the host supplies — this only carries the
   * message. Refusing here would put a policy decision in the transport, where nothing can see
   * the registry, the approval gate or whether anybody is present to answer.
   */
  private async serveCallback(
    token: string,
    name: unknown,
    args: unknown,
    caller: unknown,
  ): Promise<void> {
    const reply = (payload: Record<string, unknown>): void => {
      // Best effort: a worker that died mid-call has nothing to tell, and throwing here would
      // replace a tool's own error with a write failure on a closed pipe.
      try {
        this.child?.stdin?.write(`${JSON.stringify({ callback: token, ...payload })}\n`)
      } catch {
        this.options.logger.debug('python worker: could not answer a callback')
      }
    }

    if (this.options.callTool === undefined) {
      reply({
        ok: false,
        error:
          'This session cannot call other tools from a Python tool. That is the case during an ' +
          'unattended scheduled run, where nobody is present to approve one.',
      })
      return
    }
    if (typeof name !== 'string') {
      reply({ ok: false, error: 'call_tool needs the name of a tool.' })
      return
    }

    try {
      const value = await this.options.callTool(
        name,
        (args ?? {}) as Record<string, unknown>,
        typeof caller === 'string' ? caller : 'a Python tool',
      )
      reply({ ok: true, value })
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (this.disposed) return Promise.reject(new PythonWorkerError('The Python worker has been shut down.'))
    const child = this.start()
    const id = this.nextId++

    return new Promise<T>((resolve, reject) => {
      const budget = timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timer = setTimeout(() => {
        this.pending.delete(id)
        /*
         * The process is killed rather than abandoned. A hung tool holds the interpreter,
         * so every later call would queue behind it — and the whole tree goes, because a
         * tool that spawned a subprocess leaves it orphaned otherwise (§16).
         */
        void this.killTree().then(() => {
          reject(new PythonWorkerError(`The tool did not finish within ${Math.round(budget / 1000)}s and was stopped.`))
        })
      }, budget)

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  /** Confirms the interpreter runs and reports its version. */
  async ping(): Promise<string> {
    const value = await this.request<{ python: string }>('ping', {}, 15_000)
    return value.python
  }

  /** Parses, imports and derives the schema — without registering anything. */
  validate(name: string, filePath: string): Promise<WorkerToolDescription> {
    return this.request<WorkerToolDescription>('validate', { name, path: filePath })
  }

  describe(name: string, filePath: string): Promise<WorkerToolDescription> {
    return this.request<WorkerToolDescription>('describe', { name, path: filePath })
  }

  call(
    name: string,
    filePath: string,
    args: Record<string, unknown>,
    options: { reload?: boolean; timeoutMs?: number } = {},
  ): Promise<WorkerCallResult> {
    return this.request<WorkerCallResult>(
      'call',
      { name, path: filePath, arguments: args, reload: options.reload === true },
      options.timeoutMs,
    )
  }

  /**
   * `child.kill()` does not reach grandchildren on Windows — a tool that ran a subprocess
   * leaves it behind, and those accumulate across a session (§16).
   */
  async killTree(): Promise<void> {
    const child = this.child
    const pid = child?.pid
    this.child = undefined
    this.reader?.close()
    if (child === undefined || pid === undefined) return

    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve())
      })
      return
    }
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.killTree()
  }
}
