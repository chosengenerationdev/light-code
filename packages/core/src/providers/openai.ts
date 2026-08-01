import type { Logger } from '../logging/logger.js'
import type { HttpClient, HttpResponse } from '../platform/http.js'
import type {
  AuthStrategy,
  ChatMessage,
  ChatProvider,
  ChatStreamOptions,
  ProviderProfile,
  StreamChunk,
} from './types.js'

function describeRequestError(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Could not reach ${url}: ${message}`
}

/** OpenAI-compatible chat completions over Server-Sent Events. */
export class OpenAIProvider implements ChatProvider {
  constructor(
    private readonly http: HttpClient,
    private readonly profile: ProviderProfile,
    private readonly auth: AuthStrategy,
    private readonly logger?: Logger,
  ) {}

  async *streamChat(messages: ChatMessage[], options: ChatStreamOptions = {}): AsyncGenerator<StreamChunk> {
    const url = `${this.profile.baseUrl.replace(/\/+$/, '')}/chat/completions`
    this.logger?.debug('POST', url, `model=${this.profile.model}`)

    let response: HttpResponse
    try {
      const authHeaders = await this.auth.resolveHeaders()
      response = await this.http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders, ...this.profile.headers },
        body: JSON.stringify({ model: this.profile.model, messages, stream: true }),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
    } catch (error) {
      yield { type: 'error', error: describeRequestError(error, url) }
      return
    }

    this.logger?.debug('response status', String(response.status))

    if (response.status < 200 || response.status >= 300) {
      const bodyText = await response.text().catch(() => '')
      yield {
        type: 'error',
        error: `Request to ${url} failed with HTTP ${response.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ''}`,
      }
      return
    }

    if (response.body === null) {
      yield { type: 'error', error: `${url} returned no response body.` }
      return
    }

    yield* parseSseStream(response.body, url, options.signal, this.logger)
  }
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  url: string,
  signal: AbortSignal | undefined,
  logger: Logger | undefined,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length > 0) logger?.debug('sse line', trimmed)
        if (!trimmed.startsWith('data:')) continue

        const data = trimmed.slice('data:'.length).trim()
        if (data === '[DONE]') {
          yield { type: 'done' }
          return
        }

        try {
          const parsed: unknown = JSON.parse(data)
          const delta = extractDelta(parsed)
          if (delta) yield { type: 'text', text: delta }
        } catch {
          // Malformed SSE frame — skip it rather than aborting the whole stream.
        }
      }
    }
    yield { type: 'done' }
  } catch (error) {
    if (signal?.aborted) {
      yield { type: 'done' }
    } else {
      yield { type: 'error', error: describeRequestError(error, url) }
    }
  } finally {
    reader.releaseLock()
  }
}

function extractDelta(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null || !('choices' in parsed)) return undefined
  const choices = (parsed as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0] as { delta?: { content?: unknown } } | undefined
  const content = first?.delta?.content
  return typeof content === 'string' && content.length > 0 ? content : undefined
}
