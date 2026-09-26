import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { PathDenylist } from '../fs/denylist.js'
import type { ChatMessage, ChatProvider, StreamChunk } from '../providers/types.js'
import { ToolRegistry, type Tool, type ToolExecutionContext, type ToolResult } from '../tools/index.js'
import { runAgentTurn, type AgentTurnEvents } from './loop.js'
import { Conversation } from './messages.js'

/**
 * Images a tool fetched — the pictures on a Confluence page — reaching the model.
 *
 * A tool message is text on every wire format, so they travel as a user message straight after
 * the result, the path a screenshot pasted mid-turn already takes. A model that cannot see images
 * is told they were not shown, so it does not describe a picture it never saw.
 */

class OneCall implements ChatProvider {
  public seen: ChatMessage[][] = []
  async *streamChat(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    this.seen.push(messages)
    if (this.seen.length === 1) {
      yield { type: 'toolCall', toolCall: { id: 'c1', name: 'look', arguments: '{}' } }
    } else {
      yield { type: 'text', text: 'done' }
    }
    yield { type: 'done' }
  }
}

const IMAGE = { label: 'arch.png', mediaType: 'image/png', data: 'AAAA' }

const tool: Tool = {
  name: 'look',
  group: 'read',
  description: 'returns a picture',
  parametersSchema: z.object({}).loose(),
  execute: async (): Promise<ToolResult> => ({ content: 'page text', images: [IMAGE] }),
}

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

async function run(supportsVision: boolean): Promise<ChatMessage[]> {
  const provider = new OneCall()
  const registry = new ToolRegistry()
  registry.register(tool)
  await runAgentTurn(provider, new Conversation(), 'go', registry, context(), events, {
    maxIterations: 4,
    supportsVision,
  })
  return provider.seen.at(-1) ?? []
}

describe('images a tool returns', () => {
  it('reach a model that can see them, after the result, labelled as from the tool', async () => {
    const messages = await run(true)
    const resultAt = messages.findIndex((message) => message.role === 'tool')
    const next = messages[resultAt + 1] as { role: string; content: string; images?: unknown[] }
    expect(next.role).toBe('user')
    expect(next.content).toContain('not typed by the user')
    expect(next.images).toEqual([{ mediaType: 'image/png', data: 'AAAA' }])
  })

  it('are reported as not shown to a model that cannot see them', async () => {
    const messages = await run(false)
    const result = messages.find((message) => message.role === 'tool')
    expect(result?.content).toContain('were fetched but not shown')
    expect(messages.some((message) => 'images' in message && message.images !== undefined)).toBe(false)
  })
})
