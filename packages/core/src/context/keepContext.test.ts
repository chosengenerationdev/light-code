import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, StreamChunk } from '../providers/types.js'
import { PathDenylist } from '../fs/denylist.js'
import { ToolRegistry, type ToolExecutionContext } from '../tools/index.js'
import { runAgentTurn, type AgentTurnEvents } from '../agent/loop.js'
import { Conversation } from '../agent/messages.js'
import { resolveModelCapabilities } from '../providers/models.js'
import { compactHistory } from './compact.js'

/**
 * Reported: "Light Code is missing a lot of context from the chat history". Three causes, each
 * pinned here: unknown models were compacted against a 32k guess, a flat twelve messages were kept
 * whatever the window, and the user's own requests were paraphrased away. And, asked for directly
 * afterwards: compaction is the user's call unless they switch it on.
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

const events = (errors: string[], compacted: number[]): AgentTurnEvents => ({
  onTextChunk: () => undefined,
  onToolCall: () => undefined,
  onToolResult: () => undefined,
  onDone: () => undefined,
  onError: (message) => errors.push(message),
  onCompacted: (count) => compacted.push(count),
})

function history(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `please use endpoint v${String(i)} ${'detail '.repeat(100)}` })
    messages.push({ role: 'assistant', content: `done ${String(i)} ${'explanation '.repeat(300)}` })
  }
  return messages
}

describe('the context window compaction acts on', () => {
  it('is never a guess', () => {
    expect(resolveModelCapabilities('corp-alias-7', undefined).contextWindowKnown).toBe(false)
    expect(resolveModelCapabilities('corp-alias-7', { contextWindow: 128_000 }).contextWindowKnown).toBe(true)
    // An override of something else is not a known window.
    expect(resolveModelCapabilities('corp-alias-7', { supportsVision: true }).contextWindowKnown).toBe(false)
  })

  it('knows newer families rather than treating them as 32k', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-4-5', 'gpt-5-mini', 'gemini-3-pro', 'deepseek-v3.1']) {
      const capabilities = resolveModelCapabilities(id, undefined)
      expect(capabilities.contextWindowKnown, id).toBe(true)
      expect(capabilities.contextWindow, id).toBeGreaterThan(100_000)
    }
  })
})

describe('compaction', () => {
  it('carries every request the user made, word for word, through repeated summaries', async () => {
    const first = await compactHistory(history(10), new Scripted([[{ type: 'text', text: 'notes one' }]]), { keepRecent: 4 })
    expect(first.compacted).toBe(true)
    const summary = first.messages.find((m) => m.content.startsWith('[Earlier')) as ChatMessage
    expect(summary.content).toContain('please use endpoint v0')
    expect(summary.content).toContain('please use endpoint v7')

    // Compacted again later: the earlier requests must survive the second summary too.
    const later = [...first.messages, ...history(6).map((m) => ({ ...m, content: m.content.replace('endpoint', 'later endpoint') }))]
    const second = await compactHistory(later, new Scripted([[{ type: 'text', text: 'notes two' }]]), { keepRecent: 4 })
    const again = second.messages.find((m) => m.content.startsWith('[Earlier')) as ChatMessage
    expect(again.content).toContain('please use endpoint v0')
    expect(again.content).toContain('please use later endpoint v3')
    expect(again.content).toContain('notes two')
    expect(again.content.match(/\[What the user said/g)).toHaveLength(1)
  })

  it('keeps as much recent history as the token budget allows, not a flat dozen', async () => {
    const messages = history(20)
    const flat = await compactHistory(messages, new Scripted([[{ type: 'text', text: 'n' }]]), { keepRecent: 4 })
    const budgeted = await compactHistory(messages, new Scripted([[{ type: 'text', text: 'n' }]]), {
      keepRecent: 4,
      keepRecentTokens: 8_000,
    })
    expect(budgeted.summarisedCount).toBeLessThan(flat.summarisedCount)
  })
})

describe('automatic compaction is a switch', () => {
  const overflow: StreamChunk[] = [{ type: 'error', error: "This model's maximum context length is 8192 tokens." }]

  it('when off, never summarises by itself and points at Compact now instead', async () => {
    const provider = new Scripted([overflow])
    const conversation = new Conversation()
    for (const message of history(10)) {
      if (message.role === 'user') conversation.addUserMessage(message.content)
      else conversation.addAssistantMessage(message.content)
    }
    const errors: string[] = []
    const compacted: number[] = []
    await runAgentTurn(provider, conversation, 'and now?', new ToolRegistry(), context(), events(errors, compacted), {
      autoCompact: false,
      contextWindow: 4_000,
    })
    expect(compacted).toEqual([])
    expect(provider.calls).toHaveLength(1)
    expect(errors[0]).toContain('Compact now')
  })

  it('when the window is a guess, does not compact ahead of the provider', async () => {
    const provider = new Scripted([[{ type: 'text', text: 'fine' }, { type: 'done' }]])
    const conversation = new Conversation()
    for (const message of history(10)) {
      if (message.role === 'user') conversation.addUserMessage(message.content)
      else conversation.addAssistantMessage(message.content)
    }
    const compacted: number[] = []
    await runAgentTurn(provider, conversation, 'and now?', new ToolRegistry(), context(), events([], compacted), {
      contextWindow: 4_000,
      contextWindowKnown: false,
    })
    expect(compacted).toEqual([])
    expect(provider.calls).toHaveLength(1)
  })
})
