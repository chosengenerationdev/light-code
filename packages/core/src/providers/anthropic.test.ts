import { describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { AnthropicProvider, toAnthropicMessages } from './anthropic.js'
import { NoAuthStrategy } from './auth/apiKey.js'
import type { ProviderProfile, StreamChunk } from './types.js'

const profile: ProviderProfile = {
  id: 'a',
  label: 'Anthropic',
  wireFormat: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4',
  auth: { type: 'none' },
}

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    },
  })
}

class FakeHttpClient implements HttpClient {
  public lastBody: string | undefined
  public lastHeaders: Record<string, string> | undefined

  constructor(private readonly body: ReadableStream<Uint8Array> | null = null) {}

  async request(_url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.lastBody = options.body
    this.lastHeaders = options.headers
    return {
      status: 200,
      headers: {},
      text: async () => '',
      json: async <T>() => ({}) as T,
      body: this.body,
    }
  }
}

async function collect(generator: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of generator) chunks.push(chunk)
  return chunks
}

describe('toAnthropicMessages', () => {
  /** Sending the system prompt as a message is rejected outright. */
  it('lifts the system prompt out of the message list', () => {
    const { system, wireMessages } = toAnthropicMessages([
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'hi' },
    ])

    expect(system).toBe('You are helpful')
    expect(wireMessages).toHaveLength(1)
    expect(wireMessages[0]).toMatchObject({ role: 'user' })
  })

  it('renders assistant tool calls as tool_use blocks with parsed input', () => {
    const { wireMessages } = toAnthropicMessages([
      {
        role: 'assistant',
        content: 'Looking now.',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
      },
    ])

    expect(wireMessages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking now.' },
        { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    })
  })

  it('renders a tool result as a user message with a tool_result block', () => {
    const { wireMessages } = toAnthropicMessages([{ role: 'tool', toolCallId: 'c1', content: 'contents' }])

    expect(wireMessages[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'contents' }],
    })
  })

  /**
   * Two user messages in a row after one assistant turn is an invalid alternation and is
   * rejected — parallel tool calls produce exactly that shape unless results are merged.
   */
  it('merges consecutive tool results into one user message', () => {
    const { wireMessages } = toAnthropicMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'x', arguments: '{}' },
          { id: 'c2', name: 'y', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: 'r1' },
      { role: 'tool', toolCallId: 'c2', content: 'r2' },
    ])

    expect(wireMessages).toHaveLength(2)
    expect(wireMessages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
        { type: 'tool_result', tool_use_id: 'c2', content: 'r2' },
      ],
    })
  })

  it('does not merge a real user message into a preceding tool result', () => {
    const { wireMessages } = toAnthropicMessages([
      { role: 'tool', toolCallId: 'c1', content: 'r1' },
      { role: 'user', content: 'now do this' },
    ])
    expect(wireMessages).toHaveLength(2)
  })

  it('encodes images as base64 source blocks, before the text', () => {
    const { wireMessages } = toAnthropicMessages([
      { role: 'user', content: 'what is this', images: [{ mediaType: 'image/png', data: 'QUJD' }] },
    ])

    expect(wireMessages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        { type: 'text', text: 'what is this' },
      ],
    })
  })

  it('survives malformed tool arguments rather than throwing', () => {
    const { wireMessages } = toAnthropicMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: 'not json' }] },
    ])
    expect(wireMessages[0]).toMatchObject({ content: [{ type: 'tool_use', input: {} }] })
  })

  it('drops an assistant message with neither text nor calls, which Anthropic rejects', () => {
    const { wireMessages } = toAnthropicMessages([{ role: 'assistant', content: '' }])
    expect(wireMessages).toHaveLength(0)
  })
})

describe('AnthropicProvider request shape', () => {
  it('sends the version header and a required max_tokens', async () => {
    const client = new FakeHttpClient(sseStream(['data: {"type":"message_stop"}\n\n']))
    await collect(new AnthropicProvider(client, profile, new NoAuthStrategy()).streamChat([]))

    expect(client.lastHeaders?.['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(client.lastBody ?? '{}') as { max_tokens?: number; model?: string }
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(body.model).toBe('claude-sonnet-4')
  })

  it('honours a configured maxTokens', async () => {
    const client = new FakeHttpClient(sseStream(['data: {"type":"message_stop"}\n\n']))
    await collect(new AnthropicProvider(client, { ...profile, maxTokens: 1234 }, new NoAuthStrategy()).streamChat([]))

    expect((JSON.parse(client.lastBody ?? '{}') as { max_tokens?: number }).max_tokens).toBe(1234)
  })

  it('sends tools as input_schema', async () => {
    const client = new FakeHttpClient(sseStream(['data: {"type":"message_stop"}\n\n']))
    await collect(
      new AnthropicProvider(client, profile, new NoAuthStrategy()).streamChat([], {
        tools: [{ name: 'read_file', description: 'r', parameters: { type: 'object' } }],
      }),
    )

    const body = JSON.parse(client.lastBody ?? '{}') as { tools?: Record<string, unknown>[] }
    expect(body.tools?.[0]).toMatchObject({ name: 'read_file', input_schema: { type: 'object' } })
  })
})

describe('AnthropicProvider streaming', () => {
  it('yields text deltas', async () => {
    const client = new FakeHttpClient(
      sseStream([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    )

    const chunks = await collect(new AnthropicProvider(client, profile, new NoAuthStrategy()).streamChat([]))
    expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text)).toEqual(['Hel', 'lo'])
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })

  /** Tool input arrives as fragments that mean nothing until concatenated. */
  it('accumulates input_json_delta fragments into one tool call', async () => {
    const client = new FakeHttpClient(
      sseStream([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"read_file"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    )

    const chunks = await collect(new AnthropicProvider(client, profile, new NoAuthStrategy()).streamChat([]))
    const toolCall = chunks.find((c) => c.type === 'toolCall') as { toolCall: { arguments: string; name: string } }

    expect(toolCall.toolCall.name).toBe('read_file')
    expect(JSON.parse(toolCall.toolCall.arguments)).toEqual({ path: 'a.ts' })
  })

  it('defaults an argument-free tool call to {} rather than an empty string', async () => {
    const client = new FakeHttpClient(
      sseStream([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"noop"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    )

    const chunks = await collect(new AnthropicProvider(client, profile, new NoAuthStrategy()).streamChat([]))
    expect((chunks.find((c) => c.type === 'toolCall') as { toolCall: { arguments: string } }).toolCall.arguments).toBe('{}')
  })

  it('handles two tool calls at different block indexes', async () => {
    const client = new FakeHttpClient(
      sseStream([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"a"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"c2","name":"b"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        'data: {"type":"content_block_stop","index":1}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    )

    const chunks = await collect(new AnthropicProvider(client, profile, new NoAuthStrategy()).streamChat([]))
    expect(chunks.filter((c) => c.type === 'toolCall')).toHaveLength(2)
  })

  it('surfaces a mid-stream error event', async () => {
    const client = new FakeHttpClient(
      sseStream(['data: {"type":"error","error":{"message":"overloaded"}}\n\n']),
    )
    const chunks = await collect(new AnthropicProvider(client, profile, new NoAuthStrategy()).streamChat([]))
    expect(chunks).toEqual([{ type: 'error', error: 'overloaded' }])
  })

  it('handles an event split across chunk boundaries', async () => {
    const client = new FakeHttpClient(
      sseStream([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_de',
        'lta","text":"split"}}\n\ndata: {"type":"message_stop"}\n\n',
      ]),
    )

    const chunks = await collect(new AnthropicProvider(client, profile, new NoAuthStrategy()).streamChat([]))
    expect(chunks.filter((c) => c.type === 'text')).toEqual([{ type: 'text', text: 'split' }])
  })

  it('emits completed tool calls even if the stream ends without message_stop', async () => {
    const client = new FakeHttpClient(
      sseStream([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"a"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
      ]),
    )

    const chunks = await collect(new AnthropicProvider(client, profile, new NoAuthStrategy()).streamChat([]))
    expect(chunks.filter((c) => c.type === 'toolCall')).toHaveLength(1)
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })
})
