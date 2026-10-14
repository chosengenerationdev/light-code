import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({}))

import { toLmMessages, type LmTypes } from './languageModels.js'

/**
 * Our conversation as VS Code's Language Model messages. Fakes stand in for VS Code's part classes,
 * recording what they were built with - the shapes are VS Code's, the decisions are ours.
 */
class Text {
  constructor(readonly value: string) {}
}
class ToolCall {
  constructor(readonly callId: string, readonly name: string, readonly input: object) {}
}
class ToolResult {
  constructor(readonly callId: string, readonly content: unknown[]) {}
}
class Message {
  constructor(readonly role: number, readonly content: unknown[]) {}
}
const lm = (withImages: boolean): LmTypes =>
  ({
    lm: { selectChatModels: async () => [] },
    LanguageModelChatMessage: Message,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
    LanguageModelTextPart: Text,
    LanguageModelToolCallPart: ToolCall,
    LanguageModelToolResultPart: ToolResult,
    ...(withImages ? { LanguageModelDataPart: { image: (data: Uint8Array, mimeType: string) => ({ image: data.length, mimeType }) } } : {}),
  }) as unknown as LmTypes

describe('messages for VS Code language models', () => {
  it('puts the system prompt first as user text, and merges neighbours of one role', () => {
    const out = toLmMessages(
      [
        { role: 'system', content: 'You are Light Code.' },
        { role: 'user', content: 'Read a.ts' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }] },
        { role: 'tool', toolCallId: 'c1', content: '1 | export {}' },
        { role: 'user', content: 'and now?' },
      ],
      lm(false),
    ) as Message[]
    expect(out.map((m) => m.role)).toEqual([1, 2, 1])
    expect(out[0]!.content).toEqual([new Text('You are Light Code.'), new Text('Read a.ts')])
    expect(out[1]!.content).toEqual([new ToolCall('c1', 'read_file', { path: 'a.ts' })])
    expect(out[2]!.content).toEqual([new ToolResult('c1', [new Text('1 | export {}')]), new Text('and now?')])
  })

  it('a tool call whose arguments did not parse keeps its id, so its result still pairs', () => {
    const [, assistant] = toLmMessages(
      [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'trying', toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{not json' }] },
      ],
      lm(false),
    ) as Message[]
    expect(assistant!.content).toEqual([new Text('trying'), new ToolCall('c2', 'read_file', {})])
  })

  it('passes an image where VS Code can, and says so where it cannot', () => {
    const message = { role: 'user' as const, content: 'see', images: [{ mediaType: 'image/png', data: Buffer.from('abc').toString('base64') }] }
    expect((toLmMessages([message], lm(true)) as Message[])[0]!.content[1]).toEqual({ image: 3, mimeType: 'image/png' })
    expect(((toLmMessages([message], lm(false)) as Message[])[0]!.content[1] as Text).value).toContain('cannot pass images')
  })
})
