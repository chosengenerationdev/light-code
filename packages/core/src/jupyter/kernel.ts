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
}

const OUTPUT_CAP = 400_000

export class KernelSession {
  private kernel: { id: string; name: string } | undefined
  private channels: WebSocketConnection | undefined
  private readonly session = randomUUID()
  private readonly listeners = new Map<string, (message: KernelMessage) => void>()
  /** One run at a time: a kernel executes serially anyway, and interleaved output would be unreadable. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly client: JupyterClient,
    private readonly kernelName: string | undefined,
  ) {}

  run(code: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<RunOutput> {
    const next = this.queue.then(() => this.runNow(code, options))
    this.queue = next.catch(() => undefined)
    return next
  }

  private async ensure(): Promise<boolean> {
    if (this.kernel !== undefined && this.channels !== undefined && (await this.client.kernelAlive(this.kernel.id))) return false
    this.channels?.close()
    this.channels = undefined
    this.kernel = await this.client.startKernel(this.kernelName)
    const channels = await this.client.openChannels(this.kernel.id)
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
    channels.onClose(() => {
      if (this.channels === channels) this.channels = undefined
    })
    this.channels = channels
    return true
  }

  private async runNow(code: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<RunOutput> {
    const freshKernel = await this.ensure()
    const kernel = this.kernel
    const channels = this.channels
    if (kernel === undefined || channels === undefined) throw new JupyterError('The kernel is not connected.')

    const msgId = randomUUID()
    let text = ''
    const append = (part: string): void => {
      if (text.length < OUTPUT_CAP) text += part
    }
    let error: RunOutput['error']
    let gotReply = false
    let idle = false

    return new Promise<RunOutput>((resolve) => {
      let settled = false
      let interrupted: 'timedOut' | 'stopped' | undefined
      let stuck: ReturnType<typeof setTimeout> | undefined
      const finish = (extra: Partial<RunOutput> = {}): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (stuck !== undefined) clearTimeout(stuck)
        options.signal?.removeEventListener('abort', onAbort)
        this.listeners.delete(msgId)
        if (text.length >= OUTPUT_CAP) text += '\n… [output cut here]'
        resolve({
          text,
          ...(error !== undefined ? { error } : {}),
          freshKernel,
          kernelName: kernel.name,
          ...(interrupted !== undefined ? { [interrupted]: true } : {}),
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

      this.listeners.set(msgId, (message) => {
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
      channels.onClose((reason) => {
        if (!settled) {
          this.kernel = undefined
          error ??= { name: 'KernelLost', value: `The connection to the kernel closed (${reason}).`, traceback: '' }
          finish()
        }
      })

      channels.send(
        JSON.stringify({
          header: { msg_id: msgId, username: 'light-code', session: this.session, msg_type: 'execute_request', version: '5.3', date: new Date().toISOString() },
          parent_header: {},
          metadata: {},
          content: { code, silent: false, store_history: false, user_expressions: {}, allow_stdin: false, stop_on_error: false },
          buffers: [],
          channel: 'shell',
        }),
      )
    })
  }

  /** Ends the kernel; called when the session ends, so nothing is left running on the hub. */
  async dispose(): Promise<void> {
    this.channels?.close()
    this.channels = undefined
    const kernel = this.kernel
    this.kernel = undefined
    if (kernel !== undefined) await this.client.shutdownKernel(kernel.id).catch(() => undefined)
  }
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
