import type { Logger } from '../logging/logger.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { describeTlsError } from './auth/apigeeMtls.js'
import { toOpenAITools } from './schema.js'
import type {
  AuthStrategy,
  ChatMessage,
  ChatProvider,
  ChatStreamOptions,
  ProviderProfile,
  StreamChunk,
  ToolCall,
} from './types.js'

function describeRequestError(error: unknown, url: string): string {
  // TLS failures dominate here on a corporate gateway, and OpenSSL codes are unreadable —
  // §10 requires naming the actual cause instead.
  return `Could not reach ${url}: ${describeTlsError(error)}`
}

/** Maps our `ChatMessage` union to OpenAI's wire format for the `messages` array. */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'user' && message.images !== undefined && message.images.length > 0) {
    // OpenAI takes images as a `content` parts array with data URLs — note this is a
    // different encoding from Anthropic's `{media_type, data}` and Gemini's `inlineData`,
    // which is why `ImageAttachment` stores bare base64 and each adapter wraps it.
    const parts: Record<string, unknown>[] = message.images.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    }))
    if (message.content.length > 0) parts.push({ type: 'text', text: message.content })
    return { role: 'user', content: parts }
  }
  if (message.role === 'assistant') {
    const wire: Record<string, unknown> = { role: 'assistant', content: message.content }
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      wire.content = message.content.length > 0 ? message.content : null
      wire.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }))
    }
    return wire
  }
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  return { role: message.role, content: message.content }
}

/** OpenAI-compatible chat completions over Server-Sent Events, with tool-calling support. */
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

    const body: Record<string, unknown> = {
      model: this.profile.model,
      messages: messages.map(toWireMessage),
      stream: true,
    }
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = toOpenAITools(options.tools)
      body.tool_choice = 'auto'
    }

    let response: HttpResponse
    try {
      // A token that expires mid-generation aborts the response with no way to resume, so
      // it is replaced up front rather than discovered halfway through (§10).
      await this.auth.ensureTokenForStream?.()
      response = await this.send(url, body, options.signal)

      if (response.status === 401 && this.auth.onUnauthorized !== undefined) {
        this.logger?.debug('401 received; asking the auth strategy to refresh once')
        // Exactly one retry. `onUnauthorized` returning false is what stops a loop.
        if (await this.auth.onUnauthorized()) {
          response = await this.send(url, body, options.signal)
        }
      }
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

  private async send(url: string, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<HttpResponse> {
    const authHeaders = await this.auth.resolveHeaders()
    const tls = await this.auth.tls?.()
    const request: HttpRequestOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders, ...this.profile.headers },
      body: JSON.stringify(body),
    }
    if (signal !== undefined) request.signal = signal
    if (tls !== undefined) request.tls = tls
    return this.http.request(url, request)
  }
}

interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
}

interface ParsedChoice {
  delta: { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown; reasoning?: unknown }
  finishReason: string | undefined
}

function extractChoice(parsed: unknown): ParsedChoice | undefined {
  if (typeof parsed !== 'object' || parsed === null || !('choices' in parsed)) return undefined
  const choices = (parsed as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0] as { delta?: unknown; finish_reason?: unknown } | undefined
  const delta = (first?.delta ?? {}) as ParsedChoice['delta']
  const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason : undefined
  return { delta, finishReason }
}

function accumulateToolCallDeltas(accumulators: Map<number, ToolCallAccumulator>, toolCallsDelta: unknown): void {
  if (!Array.isArray(toolCallsDelta)) return
  for (const raw of toolCallsDelta) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const index = typeof entry.index === 'number' ? entry.index : 0
    const existing = accumulators.get(index) ?? { id: '', name: '', arguments: '' }
    if (typeof entry.id === 'string') existing.id = entry.id
    if (typeof entry.function?.name === 'string') existing.name = entry.function.name
    if (typeof entry.function?.arguments === 'string') existing.arguments += entry.function.arguments
    accumulators.set(index, existing)
  }
}

function* completedToolCalls(accumulators: Map<number, ToolCallAccumulator>): Generator<ToolCall> {
  for (const call of accumulators.values()) {
    if (call.id.length > 0 && call.name.length > 0) {
      yield { id: call.id, name: call.name, arguments: call.arguments }
    }
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
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>()

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
          const choice = extractChoice(parsed)
          if (choice === undefined) continue

          // DeepSeek calls it `reasoning_content`; several OpenAI-compatible gateways
          // (and vLLM) use `reasoning`. Accept both — the field name is the only
          // difference, and guessing wrong just silently drops the trace.
          const reasoning =
            typeof choice.delta.reasoning_content === 'string'
              ? choice.delta.reasoning_content
              : typeof choice.delta.reasoning === 'string'
                ? choice.delta.reasoning
                : undefined
          if (reasoning !== undefined && reasoning.length > 0) {
            yield { type: 'reasoning', text: reasoning }
          }
          if (typeof choice.delta.content === 'string' && choice.delta.content.length > 0) {
            yield { type: 'text', text: choice.delta.content }
          }
          accumulateToolCallDeltas(toolCallAccumulators, choice.delta.tool_calls)

          if (choice.finishReason === 'tool_calls') {
            for (const toolCall of completedToolCalls(toolCallAccumulators)) {
              yield { type: 'toolCall', toolCall }
            }
            yield { type: 'done' }
            return
          }
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
