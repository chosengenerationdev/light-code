import { describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { NoAuthStrategy } from './auth/apiKey.js'
import { GeminiProvider, toGeminiContents } from './gemini.js'
import type { ProviderProfile, StreamChunk } from './types.js'

const profile: ProviderProfile = {
  id: 'g',
  label: 'Gemini',
  wireFormat: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.5-pro',
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
  public lastUrl: string | undefined
  public lastBody: string | undefined

  constructor(private readonly body: ReadableStream<Uint8Array> | null = null) {}

  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.lastUrl = url
    this.lastBody = options.body
    return { status: 200, headers: {}, text: async () => '', json: async <T>() => ({}) as T, body: this.body }
  }
}

async function collect(generator: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of generator) chunks.push(chunk)
  return chunks
}

describe('toGeminiContents', () => {
  it('lifts the system prompt into systemInstruction', () => {
    const { systemInstruction, contents } = toGeminiContents([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ])
    expect(systemInstruction).toBe('be helpful')
    expect(contents).toHaveLength(1)
  })

  /** Gemini calls the assistant "model"; sending "assistant" is rejected. */
  it('renames the assistant role to model', () => {
    const { contents } = toGeminiContents([{ role: 'assistant', content: 'hello' }])
    expect(contents[0]).toEqual({ role: 'model', parts: [{ text: 'hello' }] })
  })

  it('renders a tool call as functionCall with parsed args', () => {
    const { contents } = toGeminiContents([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }] },
    ])
    expect(contents[0]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] })
  })

  /**
   * Gemini matches a response to its call by **name**, not by id — ours are keyed by id, so
   * the mapping has to be reconstructed or the model sees a response to a tool it never
   * called.
   */
  it('maps a tool result back to the call name, not the id', () => {
    const { contents } = toGeminiContents([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-abc', name: 'read_file', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call-abc', content: 'file contents' },
    ])

    expect(contents[1]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'read_file', response: { result: 'file contents' } } }],
    })
  })

  it('merges consecutive function responses into one turn', () => {
    const { contents } = toGeminiContents([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'a', arguments: '{}' },
          { id: 'c2', name: 'b', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: 'r1' },
      { role: 'tool', toolCallId: 'c2', content: 'r2' },
    ])

    expect(contents).toHaveLength(2)
    expect((contents[1] as { parts: unknown[] }).parts).toHaveLength(2)
  })

  it('encodes images as inlineData', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'what is this', images: [{ mediaType: 'image/jpeg', data: 'QUJD' }] },
    ])

    expect(contents[0]).toEqual({
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }, { text: 'what is this' }],
    })
  })

  it('falls back to the id when the call is missing from history', () => {
    const { contents } = toGeminiContents([{ role: 'tool', toolCallId: 'orphan', content: 'r' }])
    expect(JSON.stringify(contents)).toContain('orphan')
  })
})

describe('GeminiProvider request shape', () => {
  it('puts the model in the path and requests a real SSE stream', async () => {
    const client = new FakeHttpClient(sseStream([]))
    await collect(new GeminiProvider(client, profile, new NoAuthStrategy()).streamChat([]))

    expect(client.lastUrl).toContain('/models/gemini-2.5-pro:streamGenerateContent')
    // Without alt=sse the response is a chunked JSON array, which parses fine right up
    // until a large response splits mid-object.
    expect(client.lastUrl).toContain('alt=sse')
  })

  it('url-encodes a model id containing a slash', async () => {
    const client = new FakeHttpClient(sseStream([]))
    await collect(
      new GeminiProvider(client, { ...profile, model: 'tunedModels/my-model' }, new NoAuthStrategy()).streamChat([]),
    )
    expect(client.lastUrl).toContain('tunedModels%2Fmy-model')
  })

  it('sends tools as functionDeclarations', async () => {
    const client = new FakeHttpClient(sseStream([]))
    await collect(
      new GeminiProvider(client, profile, new NoAuthStrategy()).streamChat([], {
        tools: [{ name: 'read_file', description: 'r', parameters: { type: 'object' } }],
      }),
    )

    const body = JSON.parse(client.lastBody ?? '{}') as { tools?: { functionDeclarations?: unknown[] }[] }
    expect(body.tools?.[0]?.functionDeclarations).toHaveLength(1)
  })
})

describe('GeminiProvider streaming', () => {
  it('yields text parts', async () => {
    const client = new FakeHttpClient(
      sseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      ]),
    )

    const chunks = await collect(new GeminiProvider(client, profile, new NoAuthStrategy()).streamChat([]))
    expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text)).toEqual(['Hel', 'lo'])
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })

  /** Everything upstream keys results by id, so one has to be synthesised. */
  it('synthesises an id for a function call, since Gemini supplies none', async () => {
    const client = new FakeHttpClient(
      sseStream(['data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.ts"}}}]}}]}\n\n']),
    )

    const chunks = await collect(new GeminiProvider(client, profile, new NoAuthStrategy()).streamChat([]))
    const toolCall = (chunks.find((c) => c.type === 'toolCall') as { toolCall: { id: string; name: string; arguments: string } })
      .toolCall

    expect(toolCall.name).toBe('read_file')
    expect(toolCall.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(JSON.parse(toolCall.arguments)).toEqual({ path: 'a.ts' })
  })

  it('handles an event split across chunk boundaries', async () => {
    const client = new FakeHttpClient(
      sseStream(['data: {"candidates":[{"content":{"parts":[{"text":"spl', 'it"}]}}]}\n\n']),
    )
    const chunks = await collect(new GeminiProvider(client, profile, new NoAuthStrategy()).streamChat([]))
    expect(chunks.filter((c) => c.type === 'text')).toEqual([{ type: 'text', text: 'split' }])
  })

  it('skips a malformed frame rather than aborting the stream', async () => {
    const client = new FakeHttpClient(
      sseStream(['data: {not json}\n\n', 'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n']),
    )
    const chunks = await collect(new GeminiProvider(client, profile, new NoAuthStrategy()).streamChat([]))
    expect(chunks.filter((c) => c.type === 'text')).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('reports a non-2xx response with its status', async () => {
    const failing: HttpClient = {
      async request(): Promise<HttpResponse> {
        return {
          status: 400,
          headers: {},
          text: async () => '{"error":{"message":"bad request"}}',
          json: async <T>() => ({}) as T,
          body: null,
        }
      },
    }

    const chunks = await collect(new GeminiProvider(failing, profile, new NoAuthStrategy()).streamChat([]))
    expect(chunks[0]).toMatchObject({ type: 'error' })
    expect((chunks[0] as { error: string }).error).toContain('400')
  })
})
