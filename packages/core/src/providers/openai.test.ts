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
})
