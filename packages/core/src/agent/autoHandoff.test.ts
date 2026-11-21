import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, StreamChunk } from '../providers/types.js'
import { PathDenylist } from '../fs/denylist.js'
import { ToolRegistry, type ToolExecutionContext } from '../tools/index.js'
import { runAgentTurn, type AgentTurnEvents } from './loop.js'
import { Conversation } from './messages.js'

/**
 * Asked for: "a checkbox, when enabled it should auto handoff to new session when context limit is hit". With it on,
 * the loop does not compact: it tells the host the chat is full and ends the turn, and the host writes the handoff.
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

function events(log: { errors: string[]; done: number; compacted: number }): AgentTurnEvents {
  return {
    onTextChunk: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onDone: () => void (log.done += 1),
    onError: (message) => log.errors.push(message),
    onCompacted: () => void (log.compacted += 1),
  }
}

describe('handing off at the context limit', () => {
  it('stops before sending when the chat is near a known window, without compacting', async () => {
    const provider = new Scripted([[{ type: 'text', text: 'never sent' }, { type: 'done' }]])
    const log = { errors: [] as string[], done: 0, compacted: 0 }
    let full = 0
    await runAgentTurn(provider, longConversation(), 'and now?', new ToolRegistry(), context(), events(log), {
      contextWindow: 4_000,
      contextWindowKnown: true,
      autoCompact: false,
      onContextFull: () => void (full += 1),
    })
    expect(full).toBe(1)
    expect(provider.calls).toHaveLength(0)
    expect(log).toEqual({ errors: [], done: 1, compacted: 0 })
  })

  it('stops quietly when the provider refuses the chat as too long', async () => {
    const provider = new Scripted([[{ type: 'error', error: "This model's maximum context length is 8192 tokens." }]])
    const log = { errors: [] as string[], done: 0, compacted: 0 }
    let full = 0
    await runAgentTurn(provider, longConversation(), 'and now?', new ToolRegistry(), context(), events(log), {
      autoCompact: false,
      onContextFull: () => void (full += 1),
    })
    expect(full).toBe(1)
    expect(log.errors).toEqual([])
    expect(log.compacted).toBe(0)
  })

  it('leaves compacting automatically as it was when that is on', async () => {
    const provider = new Scripted([
      [{ type: 'text', text: 'Summary.' }, { type: 'done' }],
      [{ type: 'text', text: 'Answer.' }, { type: 'done' }],
    ])
    const log = { errors: [] as string[], done: 0, compacted: 0 }
    let full = 0
    await runAgentTurn(provider, longConversation(), 'and now?', new ToolRegistry(), context(), events(log), {
      contextWindow: 4_000,
      contextWindowKnown: true,
      autoCompact: true,
      onContextFull: () => void (full += 1),
    })
    expect(full).toBe(0)
    expect(log.compacted).toBe(1)
  })
})
