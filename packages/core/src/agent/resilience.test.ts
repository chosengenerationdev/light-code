import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, ChatStreamOptions, StreamChunk } from '../providers/types.js'
import { PathDenylist } from '../fs/denylist.js'
import { ToolRegistry, type ToolExecutionContext } from '../tools/index.js'
import { runAgentTurn, type AgentTurnEvents, type RetryInfo, type RunAgentTurnOptions } from './loop.js'
import { Conversation } from './messages.js'
import { isTransientError, retryDelayMs } from './transient.js'

/**
 * Reported together: a prompt that "stays in thinking even for 2656 seconds", and "we should have
 * something to retry if we face any API connectivity issues". A silent stream is now stopped and
 * sent again, and a failure a second attempt usually gets past is retried before it is shown.
 */

/** Each call plays one script; `'hang'` never yields again, like a connection dropped without closing. */
class Scripted implements ChatProvider {
  calls = 0
  aborted: boolean[] = []
  constructor(private readonly turns: (StreamChunk[] | 'hang')[]) {}
  async *streamChat(_messages: ChatMessage[], options: ChatStreamOptions = {}): AsyncGenerator<StreamChunk> {
    const turn = this.turns[this.calls++] ?? []
    if (turn === 'hang') {
      yield { type: 'reasoning', text: 'thinking…' }
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve()))
      this.aborted.push(options.signal?.aborted === true)
      return
    }
    for (const chunk of turn) yield chunk
  }
}

const context = (): ToolExecutionContext => ({
  fs: {} as ToolExecutionContext['fs'],
  terminal: {} as ToolExecutionContext['terminal'],
  workspaceRoot: '/w',
  denylist: new PathDenylist(),
  readFiles: new Set(),
})

async function run(
  provider: ChatProvider,
  options: RunAgentTurnOptions = {},
): Promise<{ errors: string[]; retries: RetryInfo[]; text: string[]; done: number }> {
  const errors: string[] = []
  const retries: RetryInfo[] = []
  const text: string[] = []
  let done = 0
  const events: AgentTurnEvents = {
    onTextChunk: (chunk) => text.push(chunk),
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onDone: () => done++,
    onError: (message) => errors.push(message),
    onRetry: (info) => retries.push(info),
  }
  await runAgentTurn(provider, new Conversation(), 'hello', new ToolRegistry(), context(), events, {
    retryDelayMs: () => 1,
    ...options,
  })
  return { errors, retries, text, done }
}

describe('which failures are worth sending again', () => {
  it('retries a dropped connection, a gateway error and an overload', () => {
    for (const message of [
      'Could not reach https://gw/v1/chat/completions: read ECONNRESET',
      'Request to https://gw/v1/chat/completions failed with HTTP 502: Bad Gateway',
      'Request to https://gw failed with HTTP 429: Too Many Requests',
      'Request to https://api failed with HTTP 529: {"type":"overloaded_error"}',
      'No reply from gw.example within 45s.',
      'Could not reach https://gw: other side closed',
    ]) {
      expect(isTransientError(message), message).toBe(true)
    }
  })

  it('never retries what would fail the same way again', () => {
    for (const message of [
      'Request to https://gw failed with HTTP 401: Unauthorized',
      'Request to https://gw failed with HTTP 400: invalid tool schema',
      'Could not reach https://gw: unable to verify the first certificate',
      "This model's maximum context length is 8192 tokens.",
      'credential missing for profile gateway — reconfigure',
    ]) {
      expect(isTransientError(message), message).toBe(false)
    }
  })

  it('waits a little longer each time, and never long', () => {
    const fixed = (): number => 0.5
    expect(retryDelayMs(1, fixed)).toBeLessThan(retryDelayMs(2, fixed))
    expect(retryDelayMs(10, fixed)).toBeLessThanOrEqual(30_000)
  })
})

describe('a request that fails', () => {
  it('is sent again after a transient failure, and the reply arrives', async () => {
    const provider = new Scripted([
      [{ type: 'text', text: 'Hal' }, { type: 'error', error: 'Request to https://gw failed with HTTP 503: unavailable' }],
      [{ type: 'text', text: 'Hello there.' }, { type: 'done' }],
    ])
    const result = await run(provider)
    expect(result.errors).toEqual([])
    expect(provider.calls).toBe(2)
    expect(result.retries).toHaveLength(1)
    expect(result.retries[0]?.reason).toContain('HTTP 503')
    expect(result.done).toBe(1)
  })

  it('is shown at once when retrying cannot help', async () => {
    const provider = new Scripted([[{ type: 'error', error: 'Request to https://gw failed with HTTP 401: bad key' }]])
    const result = await run(provider)
    expect(provider.calls).toBe(1)
    expect(result.retries).toEqual([])
    expect(result.errors[0]).toContain('401')
  })

  it('stops after the configured number of retries and shows the error', async () => {
    const failing: StreamChunk[] = [{ type: 'error', error: 'Could not reach https://gw: ECONNRESET' }]
    const provider = new Scripted([failing, failing, failing])
    const result = await run(provider, { retries: 2 })
    expect(provider.calls).toBe(3)
    expect(result.retries.map((r) => r.retry)).toEqual([1, 2])
    expect(result.errors[0]).toContain('ECONNRESET')
  })
})

describe('a request that goes silent', () => {
  it('is stopped and sent again instead of waiting for ever', async () => {
    const provider = new Scripted(['hang', [{ type: 'text', text: 'Back again.' }, { type: 'done' }]])
    const result = await run(provider, { stallSeconds: 0.05 })
    expect(result.errors).toEqual([])
    expect(provider.calls).toBe(2)
    expect(provider.aborted).toEqual([true])
    expect(result.retries[0]?.reason).toContain('sent nothing')
  })

  it('says what happened when every attempt stalls', async () => {
    const provider = new Scripted(['hang', 'hang'])
    const result = await run(provider, { stallSeconds: 0.05, retries: 1 })
    expect(provider.calls).toBe(2)
    expect(result.errors[0]).toContain('sent nothing')
    expect(result.errors[0]).toContain('tried 2 times')
  })

  it('is not retried once the user has cancelled', async () => {
    const controller = new AbortController()
    const provider = new Scripted(['hang', [{ type: 'text', text: 'never' }, { type: 'done' }]])
    setTimeout(() => controller.abort(), 20)
    const result = await run(provider, { stallSeconds: 5, signal: controller.signal })
    expect(provider.calls).toBe(1)
    expect(result.retries).toEqual([])
  })
})
