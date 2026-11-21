import { randomUUID } from 'node:crypto'
import type { WebSocketConnection } from '../platform/http.js'
import { JupyterError, type JupyterClient } from './client.js'

/**
 * One kernel on the hub, kept for the session, and code run in it over the Jupyter messaging
 * protocol (v5, JSON frames).
 *
 * Kept rather than started per call because the point is the hub's environment, and a kernel takes
 * seconds to start; variables then persist between calls, which the tool description says. A kernel
 * that died (culled, restarted, server stopped) is replaced on the next call, and the result says the
 * earlier state is gone - not knowing that is how a model trusts a variable that no longer exists.
 *
 * ## The connection drops; the kernel usually does not
 *
 * Reported from real use: JupyterHub codebases stopped working until the agent was restarted. The
 * channel is one WebSocket through the hub's proxy, and proxies, VPNs and sleeping laptops drop it. It
 * used to be treated as the kernel being lost: the run in progress ended, and the next one started a new
 * kernel, so every variable went with it. Now, silently:
 *
 * - **A dropped channel is reconnected to the same kernel** when the hub says it is still there, with the
 *   same session id - so the server replays what the kernel sent meanwhile and a run cut off mid-way
 *   finishes normally. Only a kernel the hub no longer has is replaced.
 * - **A run whose answer was lost** (the server kept nothing) is noticed from the kernel going idle, and
 *   reported as finished-with-output-lost rather than waited on until its timeout.
 * - **A channel that went quiet without closing** - a half-open connection, which nothing reports - is
 *   found by a heartbeat on the control channel during a run, and reconnected.
 */

export interface RunOutput {
  /** stdout and stderr interleaved as they arrived, plus displayed results as text. */
  text: string
  error?: { name: string; value: string; traceback: string }
  timedOut?: boolean
  stopped?: boolean
  /** True when a new kernel had to be started for this run. */
  freshKernel: boolean
  kernelName: string
  /** True when the connection dropped during the run and was restored. */
  reconnected?: boolean
}

const OUTPUT_CAP = 400_000
/** Waits between reconnection attempts: about a minute in all. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
/** During a run: how often the control channel is asked for a reply, and how long it may take. */
const HEARTBEAT_EVERY_MS = 30_000
const HEARTBEAT_WAIT_MS = 20_000

type Recovery = 'reconnected' | 'kernel-gone' | 'unreachable'

export class KernelSession {
  private kernel: { id: string; name: string } | undefined
  private channels: WebSocketConnection | undefined
  private readonly session = randomUUID()
  private readonly listeners = new Map<string, (message: KernelMessage) => void>()
  /** Told when the channel drops, so a run in progress can wait for the reconnection. */
  private readonly dropListeners = new Set<(reason: string) => void>()
  private recovering: Promise<Recovery> | undefined
  /** One run at a time: a kernel executes serially anyway, and interleaved output would be unreadable. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Waits between attempts, replaceable so tests need not sleep for a minute. */
  constructor(
    private readonly client: JupyterClient,
    private readonly kernelName: string | undefined,
    private readonly timing: { reconnectDelaysMs?: readonly number[]; heartbeatEveryMs?: number; heartbeatWaitMs?: number; idleCheckMs?: number } = {},
  ) {}

  run(code: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<RunOutput> {
    const next = this.queue.then(() => this.runNow(code, options))
    this.queue = next.catch(() => undefined)
    return next
  }

  /** A connected channel to a live kernel; true when the kernel is new (earlier state gone). */
  private async ensure(): Promise<boolean> {
    if (this.kernel !== undefined) {
      if (this.channels !== undefined && (await this.client.kernelAlive(this.kernel.id))) return false
      // The channel dropped between runs: the same kernel, connected again, keeps its variables.
      if (this.channels === undefined) {
        const recovered = await this.recover()
        if (recovered === 'reconnected') return false
        if (recovered === 'unreachable') throw new JupyterError('Could not reconnect to the kernel on the hub; it may be busy or the hub unreachable. Try again shortly.')
      }
    }
    this.channels?.close()
    this.channels = undefined
    this.kernel = await this.client.startKernel(this.kernelName)
    await this.connect(this.kernel.id)
    return true
  }

  private async connect(kernelId: string): Promise<void> {
    const channels = await this.client.openChannels(kernelId, this.session)
    try {
      await channels.opened
    } catch (error) {
      throw new JupyterError(`Could not connect to the kernel on the hub: ${error instanceof Error ? error.message : String(error)}`)
    }
    channels.onMessage((text) => {
      let message: KernelMessage
      try {
        message = JSON.parse(text) as KernelMessage
      } catch {
        return
      }
      const parent = message.parent_header?.msg_id
      if (parent !== undefined) this.listeners.get(parent)?.(message)
    })
    channels.onClose((reason) => {
      if (this.channels !== channels) return
      this.channels = undefined
      for (const listener of [...this.dropListeners]) listener(reason)
    })
    this.channels = channels
  }

  /**
   * Reconnects to the kernel this session has, trying for about a minute. Shared by everything that
   * noticed the drop, so one reconnection is made.
   */
  private recover(): Promise<Recovery> {
    this.recovering ??= this.recoverNow().finally(() => {
      this.recovering = undefined
    })
    return this.recovering
  }

  private async recoverNow(): Promise<Recovery> {
    const kernel = this.kernel
    if (kernel === undefined) return 'kernel-gone'
    for (const delay of this.timing.reconnectDelaysMs ?? RECONNECT_DELAYS_MS) {
      if (this.kernel?.id !== kernel.id) return 'kernel-gone'
      if (this.channels !== undefined) return 'reconnected'
      let alive: boolean
      try {
        alive = await this.client.kernelAlive(kernel.id)
      } catch {
        // The hub itself is unreachable for now (or its server is being started again): wait and ask again.
        await sleep(delay)
        continue
      }
      if (!alive) {
        this.kernel = undefined
        return 'kernel-gone'
      }
      try {
        await this.connect(kernel.id)
        return 'reconnected'
      } catch {
        await sleep(delay)
      }
    }
    return 'unreachable'
  }

  private async runNow(code: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<RunOutput> {
    const freshKernel = await this.ensure()
    const kernel = this.kernel
    const first = this.channels
    if (kernel === undefined || first === undefined) throw new JupyterError('The kernel is not connected.')

    const msgId = randomUUID()
    let text = ''
    const append = (part: string): void => {
      if (text.length < OUTPUT_CAP) text += part
    }
    let error: RunOutput['error']
    let gotReply = false
    let idle = false
    let reconnected = false
    /** When anything last arrived for this run, or from the heartbeat. */
    let lastHeard = Date.now()

    return new Promise<RunOutput>((resolve) => {
      let settled = false
      let interrupted: 'timedOut' | 'stopped' | undefined
      let stuck: ReturnType<typeof setTimeout> | undefined
      let idleCheck: ReturnType<typeof setInterval> | undefined
      const finish = (extra: Partial<RunOutput> = {}): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(heartbeat)
        if (idleCheck !== undefined) clearInterval(idleCheck)
        if (stuck !== undefined) clearTimeout(stuck)
        options.signal?.removeEventListener('abort', onAbort)
        this.listeners.delete(msgId)
        this.dropListeners.delete(onDrop)
        if (text.length >= OUTPUT_CAP) text += '\n… [output cut here]'
        resolve({
          text,
          ...(error !== undefined ? { error } : {}),
          freshKernel,
          kernelName: kernel.name,
          ...(interrupted !== undefined ? { [interrupted]: true } : {}),
          ...(reconnected ? { reconnected: true } : {}),
          ...extra,
        })
      }
      /*
       * Interrupting does not end the run by itself: the kernel still reports the KeyboardInterrupt
       * and goes idle, and only then is it ready. Answering before that sent the next run into a
       * kernel still finishing this one. So the run ends when the kernel says it is idle - and a
       * kernel that ignores the interrupt (code stuck outside Python) is replaced, and the next
       * run says the earlier state is gone.
       */
      const interrupt = (reason: 'timedOut' | 'stopped'): void => {
        if (interrupted !== undefined) return
        interrupted = reason
        void this.client.interruptKernel(kernel.id).catch(() => undefined)
        stuck = setTimeout(() => {
          if (this.kernel?.id === kernel.id) {
            this.kernel = undefined
            this.channels?.close()
            this.channels = undefined
            void this.client.shutdownKernel(kernel.id).catch(() => undefined)
          }
          error ??= { name: 'KernelRestarted', value: 'The kernel did not respond to the interrupt, so it was shut down.', traceback: '' }
          finish()
        }, 15_000)
      }
      const timer = setTimeout(() => interrupt('timedOut'), options.timeoutMs)
      const onAbort = (): void => interrupt('stopped')
      options.signal?.addEventListener('abort', onAbort, { once: true })

      /*
       * The channel dropped mid-run. Reconnected with the same session, the server replays what the kernel
       * sent meanwhile, and the run finishes as if nothing happened. If the server kept nothing, the kernel
       * going idle without our answer is what tells us it finished.
       */
      const onDrop = (reason: string): void => {
        if (settled) return
        void this.recover().then((outcome) => {
          if (settled) return
          if (outcome === 'reconnected') {
            reconnected = true
            lastHeard = Date.now()
            watchForLostAnswer()
            return
          }
          error ??=
            outcome === 'kernel-gone'
              ? { name: 'KernelLost', value: `The kernel on the hub stopped while this ran (the connection closed: ${reason}). Its state is gone; the next run starts a new kernel.`, traceback: '' }
              : { name: 'ConnectionLost', value: `The connection to the hub dropped (${reason}) and could not be restored for about a minute. The kernel may still be running it; try again shortly - its state is kept if it is.`, traceback: '' }
          finish()
        })
      }
      this.dropListeners.add(onDrop)

      const watchForLostAnswer = (): void => {
        if (idleCheck !== undefined) return
        let idleSeen = 0
        idleCheck = setInterval(() => {
          if (settled || gotReply) return
          void this.client
            .kernelState(kernel.id)
            .then((state) => {
              if (settled || gotReply) return
              idleSeen = state === 'idle' ? idleSeen + 1 : 0
              // Twice, a few seconds apart: idle once can be the moment between two statements.
              if (idleSeen >= 2) {
                error ??= {
                  name: 'OutputLost',
                  value: 'The connection dropped during this run and was restored, but the hub kept none of its output. The run has finished on the hub; check its effects, or run it again.',
                  traceback: '',
                }
                finish()
              }
            })
            .catch(() => undefined)
        }, this.timing.idleCheckMs ?? 5_000)
      }

      /*
       * Half-open connections: a drop nothing reports. Every so often during a run the control channel (answered
       * even while the kernel is busy) is asked for kernel_info; nothing at all heard for too long means the
       * channel is dead, so it is closed - which starts the reconnection above.
       */
      const heartbeat = setInterval(() => {
        if (settled) return
        const channels = this.channels
        if (channels === undefined) return
        if (Date.now() - lastHeard > (this.timing.heartbeatEveryMs ?? HEARTBEAT_EVERY_MS) + (this.timing.heartbeatWaitMs ?? HEARTBEAT_WAIT_MS)) {
          channels.close()
          return
        }
        const beat = randomUUID()
        this.listeners.set(beat, () => {
          lastHeard = Date.now()
          this.listeners.delete(beat)
        })
        setTimeout(() => this.listeners.delete(beat), (this.timing.heartbeatWaitMs ?? HEARTBEAT_WAIT_MS) * 2)
        try {
          channels.send(frame(beat, this.session, 'kernel_info_request', {}, 'control'))
        } catch {
          // Not open any more; the close will have been reported.
        }
      }, this.timing.heartbeatEveryMs ?? HEARTBEAT_EVERY_MS)

      this.listeners.set(msgId, (message) => {
        lastHeard = Date.now()
        const content = message.content ?? {}
        switch (message.msg_type ?? message.header?.msg_type) {
          case 'stream':
            append(String(content.text ?? ''))
            break
          case 'execute_result':
          case 'display_data': {
            const data = (content.data ?? {}) as Record<string, unknown>
            const plain = data['text/plain']
            if (typeof plain === 'string') append(`${plain}\n`)
            else if (data['image/png'] !== undefined) append('[an image was displayed]\n')
            break
          }
          case 'error':
            error = {
              name: String(content.ename ?? 'Error'),
              value: String(content.evalue ?? ''),
              traceback: stripAnsi(((content.traceback as string[] | undefined) ?? []).join('\n')),
            }
            break
          case 'execute_reply':
            gotReply = true
            if (content.status === 'aborted') {
              error ??= { name: 'Skipped', value: 'The kernel skipped this run without running it. Run it again.', traceback: '' }
            }
            break
          case 'status':
            if (content.execution_state === 'idle') idle = true
            break
        }
        if (gotReply && idle) finish()
      })

      try {
        first.send(frame(msgId, this.session, 'execute_request', { code, silent: false, store_history: false, user_expressions: {}, allow_stdin: false, stop_on_error: false }, 'shell'))
      } catch {
        // Closed between connecting and sending: the drop handler reconnects, and the run is asked for again.
        void this.recover().then((outcome) => {
          if (settled) return
          if (outcome === 'reconnected' && this.channels !== undefined) {
            try {
              this.channels.send(frame(msgId, this.session, 'execute_request', { code, silent: false, store_history: false, user_expressions: {}, allow_stdin: false, stop_on_error: false }, 'shell'))
              return
            } catch {
              // Falls through to the error below.
            }
          }
          error ??= { name: 'ConnectionLost', value: 'Could not send the code to the kernel: the connection to the hub dropped. Try again shortly.', traceback: '' }
          finish()
        })
      }
    })
  }

  /** Ends the kernel; called when the session ends, so nothing is left running on the hub. */
  async dispose(): Promise<void> {
    const channels = this.channels
    this.channels = undefined
    channels?.close()
    const kernel = this.kernel
    this.kernel = undefined
    if (kernel !== undefined) await this.client.shutdownKernel(kernel.id).catch(() => undefined)
  }
}

function frame(msgId: string, session: string, type: string, content: Record<string, unknown>, channel: 'shell' | 'control'): string {
  return JSON.stringify({
    header: { msg_id: msgId, username: 'light-code', session, msg_type: type, version: '5.3', date: new Date().toISOString() },
    parent_header: {},
    metadata: {},
    content,
    buffers: [],
    channel,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface KernelMessage {
  header?: { msg_type?: string }
  msg_type?: string
  parent_header?: { msg_id?: string }
  content?: Record<string, unknown>
}

/** Tracebacks arrive coloured for a terminal. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}
