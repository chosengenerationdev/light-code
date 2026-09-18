import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { PathDenylist } from '../fs/denylist.js'
import type { ChatMessage, ChatProvider, StreamChunk } from '../providers/types.js'
import { ToolRegistry, type Tool, type ToolExecutionContext, type ToolResult } from '../tools/index.js'
import { runAgentTurn, type AgentTurnEvents } from './loop.js'
import { Conversation } from './messages.js'

/**
 * A screenshot pasted into a message sent while the turn was running.
 *
 * Reported from real use: attachments on a queued message were lost. The queue held only text, so
 * the words arrived and the picture they were about did not — and the model was then asked about
 * something it had never been shown, which reads as it ignoring the attachment.
 */

class OneCall implements ChatProvider {
  public seen: ChatMessage[][] = []
  async *streamChat(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    this.seen.push(messages)
    if (this.seen.length === 1) {
      yield { type: 'toolCall', toolCall: { id: 'c1', name: 'work', arguments: '{}' } }
    } else {
      yield { type: 'text', text: 'done' }
    }
    yield { type: 'done' }
  }
}

const fakeTool = (name: string): Tool => ({
  name,
  group: 'always',
  description: 'test tool',
  parametersSchema: z.object({}).loose(),
  execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
})

const context = (): ToolExecutionContext => ({
  fs: {} as ToolExecutionContext['fs'],
  terminal: {} as ToolExecutionContext['terminal'],
  workspaceRoot: '/workspace',
  denylist: new PathDenylist(),
  readFiles: new Set(),
})

const events = {
  onTextChunk: () => {},
  onText: () => {},
  onToolCall: () => {},
  onToolResult: () => {},
  onError: () => {},
  onDone: () => {},
} as unknown as AgentTurnEvents

const IMAGE = { mediaType: 'image/png', data: 'AAAA' }

describe('a queued message with an attachment', () => {
  const run = async (): Promise<ChatMessage[][]> => {
    const provider = new OneCall()
    const registry = new ToolRegistry()
    registry.register(fakeTool('work'))
    let given = false

    await runAgentTurn(provider, new Conversation(), 'go', registry, context(), events, {
      maxIterations: 4,
      drainQueuedMessages: () => {
        if (given) return []
        given = true
        return [{ text: 'look at this', images: [IMAGE] }]
      },
    })
    return provider.seen
  }

  it('reaches the model with its image, not just its text', async () => {
    const seen = await run()
    const last = seen.at(-1) ?? []
    const queued = last.find((message) => message.role === 'user' && message.content === 'look at this')

    expect(queued).toBeDefined()
    expect((queued as { images?: unknown[] }).images).toEqual([IMAGE])
  })

  it('still carries the text', async () => {
    const seen = await run()
    const contents = (seen.at(-1) ?? []).map((message) => message.content)
    expect(contents).toContain('look at this')
  })

  /* A message with no attachment must not grow an empty `images` field. */
  it('adds nothing when there was no attachment', async () => {
    const provider = new OneCall()
    const registry = new ToolRegistry()
    registry.register(fakeTool('work'))
    let given = false

    await runAgentTurn(provider, new Conversation(), 'go', registry, context(), events, {
      maxIterations: 4,
      drainQueuedMessages: () => {
        if (given) return []
        given = true
        return [{ text: 'just words' }]
      },
    })

    const queued = (provider.seen.at(-1) ?? []).find((message) => message.content === 'just words')
    expect(queued).not.toHaveProperty('images')
  })
})
