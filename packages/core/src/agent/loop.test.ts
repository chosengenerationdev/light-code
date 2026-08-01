import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, StreamChunk } from '../providers/types.js'
import { runAgentTurn } from './loop.js'
import { Conversation } from './messages.js'

class ScriptedProvider implements ChatProvider {
  public receivedMessages: ChatMessage[] = []

  constructor(private readonly chunks: StreamChunk[]) {}

  async *streamChat(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    this.receivedMessages = messages
    for (const chunk of this.chunks) yield chunk
  }
}

describe('runAgentTurn', () => {
  it('streams text chunks, appends the assistant turn, and calls onDone', async () => {
    const provider = new ScriptedProvider([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'done' },
    ])
    const conversation = new Conversation('you are a test assistant')
    const chunks: string[] = []
    let done = false

    await runAgentTurn(provider, conversation, 'hi', {
      onTextChunk: (text) => chunks.push(text),
      onDone: () => {
        done = true
      },
      onError: () => {
        throw new Error('should not be called')
      },
    })

    expect(chunks).toEqual(['Hel', 'lo'])
    expect(done).toBe(true)
    expect(conversation.toArray()).toEqual([
      { role: 'system', content: 'you are a test assistant' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
    ])
    expect(provider.receivedMessages).toEqual([
      { role: 'system', content: 'you are a test assistant' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('calls onError without appending an assistant turn when no text preceded the error', async () => {
    const provider = new ScriptedProvider([{ type: 'error', error: 'network exploded' }])
    const conversation = new Conversation()
    let errorMessage: string | undefined
    let doneCalled = false

    await runAgentTurn(provider, conversation, 'hi', {
      onTextChunk: () => {
        throw new Error('should not be called')
      },
      onDone: () => {
        doneCalled = true
      },
      onError: (message) => {
        errorMessage = message
      },
    })

    expect(errorMessage).toBe('network exploded')
    expect(doneCalled).toBe(false)
    expect(conversation.toArray()).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('preserves partial text in conversation history when a late error cuts the stream short', async () => {
    const provider = new ScriptedProvider([
      { type: 'text', text: 'partial' },
      { type: 'error', error: 'connection dropped' },
    ])
    const conversation = new Conversation()
    let errorMessage: string | undefined
    let doneCalled = false

    await runAgentTurn(provider, conversation, 'hi', {
      onTextChunk: () => {},
      onDone: () => {
        doneCalled = true
      },
      onError: (message) => {
        errorMessage = message
      },
    })

    expect(errorMessage).toBe('connection dropped')
    expect(doneCalled).toBe(false)
    expect(conversation.toArray()).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'partial' },
    ])
  })

  it('surfaces an empty response as an error instead of silently doing nothing', async () => {
    const provider = new ScriptedProvider([{ type: 'done' }])
    const conversation = new Conversation()
    let errorMessage: string | undefined
    let doneCalled = false

    await runAgentTurn(provider, conversation, 'hi', {
      onTextChunk: () => {
        throw new Error('should not be called')
      },
      onDone: () => {
        doneCalled = true
      },
      onError: (message) => {
        errorMessage = message
      },
    })

    expect(errorMessage).toContain('without returning any text')
    expect(doneCalled).toBe(false)
    expect(conversation.toArray()).toEqual([{ role: 'user', content: 'hi' }])
  })
})
