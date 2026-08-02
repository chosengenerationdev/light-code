import { describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { NoAuthStrategy } from './auth/apiKey.js'
import { OpenAIProvider } from './openai.js'
import type { ProviderProfile, StreamChunk } from './types.js'

const profile: ProviderProfile = {
  id: 'test',
  label: 'Test',
  wireFormat: 'openai',
  baseUrl: 'https://gateway.example.com/v1',
  model: 'gpt-4o',
  auth: { type: 'none' },
}

class FakeHttpClient implements HttpClient {
  constructor(private readonly respond: (url: string, options?: HttpRequestOptions) => HttpResponse | Promise<HttpResponse>) {}

  async request(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.respond(url, options)
  }
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index += 1
      } else {
        controller.close()
      }
    },
  })
}

function throwingStream(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      throw error
    },
  })
}

function okResponse(body: ReadableStream<Uint8Array> | null): HttpResponse {
  return {
    status: 200,
    headers: {},
    text: async () => '',
    json: async <T>() => ({}) as T,
    body,
  }
}

async function collect(generator: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of generator) out.push(chunk)
  return out
}

describe('OpenAIProvider', () => {
  it('parses SSE deltas split across chunk boundaries', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
      'data: [DONE]\n\n'
    // Split mid-frame to prove the buffer correctly accumulates partial lines.
    const splitPoint = sse.indexOf('Hello') + 2
    const client = new FakeHttpClient(() => okResponse(streamFromChunks([sse.slice(0, splitPoint), sse.slice(splitPoint)])))

    const provider = new OpenAIProvider(client, profile, new NoAuthStrategy())
    const chunks = await collect(provider.streamChat([]))

    expect(chunks).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      { type: 'done' },
    ])
  })

  it('skips malformed SSE frames instead of aborting the stream', async () => {
    const sse = 'data: not-json\n\n' + 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' + 'data: [DONE]\n\n'
    const client = new FakeHttpClient(() => okResponse(streamFromChunks([sse])))

    const provider = new OpenAIProvider(client, profile, new NoAuthStrategy())
    const chunks = await collect(provider.streamChat([]))

    expect(chunks).toEqual([{ type: 'text', text: 'ok' }, { type: 'done' }])
  })

  it('surfaces a non-2xx response as a readable error naming the status and body', async () => {
    const client = new FakeHttpClient(() => ({
      status: 401,
      headers: {},
      text: async () => '{"error":"invalid api key"}',
      json: async <T>() => ({ error: 'invalid api key' }) as T,
      body: null,
    }))

    const provider = new OpenAIProvider(client, profile, new NoAuthStrategy())
    const chunks = await collect(provider.streamChat([]))

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.type).toBe('error')
    expect((chunks[0] as { error: string }).error).toContain('HTTP 401')
    expect((chunks[0] as { error: string }).error).toContain('invalid api key')
  })

  it('surfaces a network failure as a readable error naming the URL', async () => {
    const client = new FakeHttpClient(() => {
      throw new TypeError('fetch failed')
    })

    const provider = new OpenAIProvider(client, profile, new NoAuthStrategy())
    const chunks = await collect(provider.streamChat([]))

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.type).toBe('error')
    expect((chunks[0] as { error: string }).error).toContain('gateway.example.com')
  })

  it('treats an aborted stream as a clean stop, not an error', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = new FakeHttpClient(() => okResponse(throwingStream(new DOMException('Aborted', 'AbortError'))))

    const provider = new OpenAIProvider(client, profile, new NoAuthStrategy())
    const chunks = await collect(provider.streamChat([], { signal: controller.signal }))

    expect(chunks).toEqual([{ type: 'done' }])
  })

  it('reports a missing response body as an error', async () => {
    const client = new FakeHttpClient(() => okResponse(null))
    const provider = new OpenAIProvider(client, profile, new NoAuthStrategy())
    const chunks = await collect(provider.streamChat([]))

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.type).toBe('error')
    expect((chunks[0] as { error: string }).error).toContain('no response body')
  })

  it('accumulates a tool call streamed across multiple argument fragments', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n'
    const client = new FakeHttpClient(() => okResponse(streamFromChunks([sse])))

    const provider = new OpenAIProvider(client, profile, new NoAuthStrategy())
    const chunks = await collect(provider.streamChat([]))

    expect(chunks).toEqual([
      { type: 'toolCall', toolCall: { id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' } },
      { type: 'done' },
    ])
  })

  it('sends tools and tool_choice in the request body when tools are provided', async () => {
    let capturedBody: string | undefined
    const client = new FakeHttpClient((_url, options) => {
      capturedBody = options?.body
      return okResponse(streamFromChunks(['data: [DONE]\n\n']))
    })

    const provider = new OpenAIProvider(client, profile, new NoAuthStrategy())
    await collect(
      provider.streamChat([], {
        tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
      }),
    )

    const parsed = JSON.parse(capturedBody ?? '{}') as { tools?: unknown; tool_choice?: unknown }
    expect(parsed.tool_choice).toBe('auto')
    expect(parsed.tools).toEqual([
      { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } } },
    ])
  })

  it('maps assistant tool-call and tool-result messages to the wire format', async () => {
    let capturedBody: string | undefined
    const client = new FakeHttpClient((_url, options) => {
      capturedBody = options?.body
      return okResponse(streamFromChunks(['data: [DONE]\n\n']))
    })

    const provider = new OpenAIProvider(client, profile, new NoAuthStrategy())
    await collect(
      provider.streamChat([
        { role: 'user', content: 'read a.ts' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
        },
        { role: 'tool', toolCallId: 'call_1', content: 'file contents' },
      ]),
    )

    const parsed = JSON.parse(capturedBody ?? '{}') as { messages: Record<string, unknown>[] }
    expect(parsed.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    })
    expect(parsed.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'file contents' })
  })
})
