import { describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse, WebSocketConnection } from '../platform/http.js'
import { JupyterClient } from './client.js'
import { KernelSession } from './kernel.js'
import type { JupyterHubSpec } from './spec.js'

/*
 * Reported from real use: JupyterHub codebases stopped working until the agent was restarted, and a message
 * had to be sent to get going again. The channel to the kernel is a WebSocket through the hub's proxy, and it
 * drops. These drive the session against a fake hub that drops it at the worst moments.
 */

interface FakeKernel {
  id: string
  alive: boolean
  /** Messages the server kept for a session while its channel was down. */
  buffered: string[]
}

/** A hub with kernels, channels that can be cut, and replay of what a session missed. */
class FakeHub {
  kernels: FakeKernel[] = []
  started = 0
  open: { socket: FakeSocket; kernel: FakeKernel; session: string | undefined }[] = []
  /** When set, the next execute_request's answer is held until `release` (the cut happens meanwhile). */
  holdNext = false
  held: (() => void) | undefined
  /** When true, the server keeps nothing for a dropped session. */
  noReplay = false
  reachable = true

  client(): Pick<JupyterClient, 'startKernel' | 'kernelAlive' | 'kernelState' | 'openChannels' | 'interruptKernel' | 'shutdownKernel'> {
    return {
      startKernel: async () => {
        this.started += 1
        const kernel = { id: `k${String(this.started)}`, alive: true, buffered: [] }
        this.kernels.push(kernel)
        return { id: kernel.id, name: 'python3' }
      },
      kernelAlive: async (id) => {
        if (!this.reachable) throw new Error('unreachable')
        return this.kernels.some((k) => k.id === id && k.alive)
      },
      kernelState: async (id) => (this.kernels.some((k) => k.id === id && k.alive) ? 'idle' : undefined),
      openChannels: async (id, session) => {
        const kernel = this.kernels.find((k) => k.id === id)
        if (kernel === undefined || !this.reachable) throw new Error('no such kernel')
        const socket = new FakeSocket((text) => this.receive(kernel, socket, text))
        this.open.push({ socket, kernel, session })
        // The session's missed messages, replayed on reconnect.
        setTimeout(() => {
          for (const message of kernel.buffered.splice(0)) socket.deliver(message)
        }, 0)
        return socket
      },
      interruptKernel: async () => undefined,
      shutdownKernel: async () => undefined,
    }
  }

  /** Cuts the live channel, as a proxy timeout or VPN reconnect does. */
  cut(): void {
    for (const entry of this.open) entry.socket.drop('closed (1006)')
    this.open = []
  }

  private receive(kernel: FakeKernel, socket: FakeSocket, text: string): void {
    const message = JSON.parse(text) as { header: { msg_id: string; msg_type: string } }
    const reply = (type: string, content: Record<string, unknown>): string =>
      JSON.stringify({ header: { msg_type: type }, msg_type: type, parent_header: { msg_id: message.header.msg_id }, content })
    if (message.header.msg_type === 'kernel_info_request') {
      socket.deliver(reply('kernel_info_reply', {}))
      return
    }
    const answer = [reply('stream', { text: 'hello\n' }), reply('execute_reply', { status: 'ok' }), reply('status', { execution_state: 'idle' })]
    const send = (): void => {
      const live = this.open.find((entry) => entry.kernel === kernel && !entry.socket.closed)
      if (live !== undefined) for (const m of answer) live.socket.deliver(m)
      else if (!this.noReplay) kernel.buffered.push(...answer)
    }
    if (this.holdNext) {
      this.holdNext = false
      this.held = send
    } else setTimeout(send, 0)
  }
}

class FakeSocket implements WebSocketConnection {
  readonly opened = Promise.resolve()
  closed = false
  private readonly messages: ((text: string) => void)[] = []
  private readonly closes: ((reason: string) => void)[] = []
  constructor(private readonly onSend: (text: string) => void) {}
  send(text: string): void {
    if (this.closed) throw new Error('InvalidStateError')
    this.onSend(text)
  }
  close(): void {
    this.drop('closed by us')
  }
  drop(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closes) listener(reason)
  }
  deliver(text: string): void {
    if (!this.closed) for (const listener of this.messages) listener(text)
  }
  onMessage(listener: (text: string) => void): void {
    this.messages.push(listener)
  }
  onClose(listener: (reason: string) => void): void {
    this.closes.push(listener)
  }
}

const fast = { reconnectDelaysMs: [5, 5, 5], heartbeatEveryMs: 60_000, heartbeatWaitMs: 60_000, idleCheckMs: 10 }
const session = (hub: FakeHub): KernelSession => new KernelSession(hub.client() as unknown as JupyterClient, undefined, fast)
const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('the kernel channel drops, the kernel does not', () => {
  it('reconnects to the same kernel between runs, so its variables survive', async () => {
    const hub = new FakeHub()
    const kernel = session(hub)
    expect((await kernel.run('x = 1', { timeoutMs: 5_000 })).freshKernel).toBe(true)
    hub.cut()
    const second = await kernel.run('print(x)', { timeoutMs: 5_000 })
    expect(second.freshKernel).toBe(false)
    expect(second.error).toBeUndefined()
    expect(hub.started).toBe(1)
  })

  it('finishes a run cut off mid-way, from what the hub replays', async () => {
    const hub = new FakeHub()
    const kernel = session(hub)
    await kernel.run('setup', { timeoutMs: 5_000 })
    hub.holdNext = true
    const running = kernel.run('long()', { timeoutMs: 5_000 })
    await tick()
    hub.cut()
    hub.held?.()
    const result = await running
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('hello\n')
    expect(result.reconnected).toBe(true)
    expect(hub.started).toBe(1)
  })

  it('says the output was lost when the hub kept none, instead of waiting for the timeout', async () => {
    const hub = new FakeHub()
    hub.noReplay = true
    const kernel = session(hub)
    await kernel.run('setup', { timeoutMs: 5_000 })
    hub.holdNext = true
    const running = kernel.run('long()', { timeoutMs: 60_000 })
    await tick()
    hub.cut()
    hub.held?.()
    const result = await running
    expect(result.error?.name).toBe('OutputLost')
    expect(result.timedOut).toBeUndefined()
  })

  it('starts a new kernel, and says so, only when the hub no longer has the old one', async () => {
    const hub = new FakeHub()
    const kernel = session(hub)
    await kernel.run('x = 1', { timeoutMs: 5_000 })
    hub.cut()
    for (const k of hub.kernels) k.alive = false
    const next = await kernel.run('print(x)', { timeoutMs: 5_000 })
    expect(next.freshKernel).toBe(true)
    expect(hub.started).toBe(2)
  })

  it('waits out a hub that is briefly unreachable', async () => {
    const hub = new FakeHub()
    const kernel = session(hub)
    await kernel.run('x = 1', { timeoutMs: 5_000 })
    hub.cut()
    hub.reachable = false
    setTimeout(() => {
      hub.reachable = true
    }, 8)
    const next = await kernel.run('print(x)', { timeoutMs: 5_000 })
    expect(next.freshKernel).toBe(false)
    expect(hub.started).toBe(1)
  })

  it('reconnects a channel that went quiet without closing', async () => {
    const hub = new FakeHub()
    const kernel = new KernelSession(hub.client() as unknown as JupyterClient, undefined, { ...fast, heartbeatEveryMs: 20, heartbeatWaitMs: 20 })
    await kernel.run('setup', { timeoutMs: 5_000 })
    // Half-open: everything sent is swallowed, nothing comes back, nothing closes.
    const silent = hub.open[0]?.socket as FakeSocket
    ;(silent as unknown as { onSend: (text: string) => void }).onSend = () => undefined
    hub.holdNext = true
    const running = kernel.run('long()', { timeoutMs: 5_000 })
    await tick(120)
    hub.held?.()
    const result = await running
    expect(silent.closed).toBe(true)
    expect(result.reconnected).toBe(true)
  })
})

describe('a hub server stopped by idle culling', () => {
  it('is started again and the call made, instead of telling the user to do it', async () => {
    const spec: JupyterHubSpec = { url: 'https://hub.example.test', user: 'ann', folders: ['p'], tokenRef: 't' }
    let running = false
    const asked: string[] = []
    const http: HttpClient = {
      async request(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
        asked.push(`${options?.method ?? 'GET'} ${url.replace(spec.url, '')}`)
        const respond = (status: number, body: unknown): HttpResponse => ({
          status,
          headers: { 'content-type': 'application/json' },
          text: async () => JSON.stringify(body),
          json: async <T>() => body as T,
          body: null,
        })
        if (url.endsWith('/hub/api/users/ann/server')) {
          running = true
          return respond(202, {})
        }
        if (url.endsWith('/hub/api/users/ann')) return respond(200, { servers: { '': { ready: running } } })
        if (!running) return respond(503, { message: 'not running' })
        return respond(200, { id: 'k1', name: 'python3', execution_state: 'idle' })
      },
    }
    const client = new JupyterClient(http, spec, async () => 'token', async () => undefined)
    expect(await client.kernelAlive('k1')).toBe(true)
    expect(asked).toEqual([
      'GET /user/ann/api/kernels/k1',
      'POST /hub/api/users/ann/server',
      'GET /hub/api/users/ann',
      'GET /user/ann/api/kernels/k1',
    ])
  })

  it('says so plainly when the token may not start it', async () => {
    const spec: JupyterHubSpec = { url: 'https://hub.example.test', user: 'ann', folders: ['p'], tokenRef: 't' }
    const http: HttpClient = {
      async request(url: string): Promise<HttpResponse> {
        const status = url.includes('/hub/api/') ? 403 : 503
        return { status, headers: { 'content-type': 'application/json' }, text: async () => '{}', json: async <T>() => ({}) as T, body: null }
      },
    }
    const client = new JupyterClient(http, spec, async () => 'token', async () => undefined)
    await expect(client.kernelAlive('k1')).rejects.toThrow(/not running, and starting it did not work/)
  })
})
