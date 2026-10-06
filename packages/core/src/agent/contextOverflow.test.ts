import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, StreamChunk } from '../providers/types.js'
import { PathDenylist } from '../fs/denylist.js'
import { ToolRegistry, type ToolExecutionContext } from '../tools/index.js'
import { isContextOverflow } from '../context/compact.js'
import { runAgentTurn } from './loop.js'
import { Conversation } from './messages.js'

/**
 * Reported: "provide a way to compact when the token limit is reached". A provider refusing the
 * history as too long used to end the chat for good; now that refusal compacts and retries once.
 */
class Scripted implements ChatProvider {
  calls: ChatMessage[][] = []
  constructor(private readonly turns: StreamChunk[][]) {}
  async *streamChat(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    this.calls.push(messages)
    for (const chunk of this.turns[this.calls.length - 1] ?? []) yield chunk
  }
}

const context = (): ToolExecutionContext => ({
  fs: {} as ToolExecutionContext['fs'],
  terminal: {} as ToolExecutionContext['terminal'],
  workspaceRoot: '/w',
  denylist: new PathDenylist(),
  readFiles: new Set(),
})

function longConversation(): Conversation {
  const conversation = new Conversation()
  for (let i = 0; i < 12; i++) {
    conversation.addUserMessage(`question ${String(i)} ${'detail '.repeat(200)}`)
    conversation.addAssistantMessage(`answer ${String(i)} ${'explanation '.repeat(200)}`)
  }
  return conversation
}

describe('when the provider says the conversation is too long', () => {
  it('recognises the usual wordings, and not ordinary errors', () => {
    for (const text of [
      "This model's maximum context length is 8192 tokens.",
      'prompt is too long: 210000 tokens > 200000 maximum',
      'Request too large for gpt-4o',
      'The input token count exceeds the maximum number of tokens allowed',
      'context_length_exceeded',
    ]) {
      expect(isContextOverflow(text), text).toBe(true)
    }
    expect(isContextOverflow('401 Unauthorized')).toBe(false)
    expect(isContextOverflow('Rate limit reached, retry in 20s')).toBe(false)
  })

  it('compacts the older messages and sends the request again', async () => {
    const provider = new Scripted([
      [{ type: 'error', error: "This model's maximum context length is 8192 tokens." }],
      [{ type: 'text', text: 'Summary of the earlier questions.' }, { type: 'done' }],
      [{ type: 'text', text: 'Here is the answer.' }, { type: 'done' }],
    ])
    const conversation = longConversation()
    const errors: string[] = []
    const compacted: number[] = []
    await runAgentTurn(provider, conversation, 'and now?', new ToolRegistry(), context(), {
      onTextChunk: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onDone: () => undefined,
      onError: (message) => errors.push(message),
      onCompacted: (count) => compacted.push(count),
    })
    expect(errors).toEqual([])
    expect(compacted.length).toBe(1)
    expect(provider.calls.length).toBe(3)
    // The retry is shorter than the refused request, and starts from the summary.
    expect(provider.calls[2]?.length).toBeLessThan(provider.calls[0]?.length ?? 0)
    expect(JSON.stringify(provider.calls[2])).toContain('Summary of the earlier questions.')
  })

  it('says what to do when it still cannot fit, rather than retrying for ever', async () => {
    const overflow: StreamChunk[] = [{ type: 'error', error: 'prompt is too long' }]
    const provider = new Scripted([overflow, overflow, overflow])
    const conversation = new Conversation()
    const errors: string[] = []
    await runAgentTurn(provider, conversation, 'x'.repeat(50), new ToolRegistry(), context(), {
      onTextChunk: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onDone: () => undefined,
      onError: (message) => errors.push(message),
    })
    expect(errors.length).toBe(1)
    expect(errors[0]).toMatch(/could not be shortened enough.*new chat/s)
  })
})
