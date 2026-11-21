import type { Logger } from '../logging/logger.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { describeTlsError } from './auth/apigeeMtls.js'
import { isGeminiModel, requiresSignature, restoreArguments, SKIP_SIGNATURE, toGeminiCompatTools, type Reshaped } from './geminiCompat.js'
import { toOpenAITools } from './schema.js'
import { applyThinking } from './thinking.js'
import { ThinkTagSplitter } from './thinkTags.js'
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

/**
 * What differs on the wire for Gemini (`geminiCompat.ts`). Undefined for every other model, and then
 * nothing here changes - the condition the Gemini work was asked for under, with Qwen in daily use.
 */
interface GeminiWire {
  /** Whether a call without a signature gets the skip placeholder (Gemini 3 and later). */
  requiresSignature: boolean
}

/** Maps our `ChatMessage` union to OpenAI's wire format for the `messages` array. */
function toWireMessage(message: ChatMessage, gemini?: GeminiWire): Record<string, unknown> {
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
      wire.tool_calls = message.toolCalls.map((call) => {
        const entry: Record<string, unknown> = { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }
        // Gemini refuses a request whose earlier calls come back without their signatures.
        const signature = call.signature ?? (gemini?.requiresSignature === true ? SKIP_SIGNATURE : undefined)
        if (gemini !== undefined && signature !== undefined) entry.extra_content = { google: { thought_signature: signature } }
        return entry
      })
    }
    return wire
  }
  if (message.role === 'tool') {
    // Gemini refuses an empty function response; a tool that printed nothing still answered.
    const content = gemini !== undefined && message.content.length === 0 ? '(no output)' : message.content
    return { role: 'tool', tool_call_id: message.toolCallId, content }
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

    const gemini: GeminiWire | undefined = isGeminiModel(this.profile.model, this.profile.baseUrl)
      ? { requiresSignature: requiresSignature(this.profile.model) }
      : undefined
    const body: Record<string, unknown> = {
      model: this.profile.model,
      messages: messages.map((message) => toWireMessage(message, gemini)),
      stream: true,
    }
    let reshaped: Map<string, Reshaped[]> | undefined
    if (options.tools !== undefined && options.tools.length > 0) {
      if (gemini !== undefined) {
        const converted = toGeminiCompatTools(options.tools)
        body.tools = converted.tools
        reshaped = converted.reshaped
      } else {
        body.tools = toOpenAITools(options.tools)
      }
      body.tool_choice = 'auto'
    }
    // The real token count, in a last chunk (OpenAI, vLLM, most gateways). A gateway that refuses the field is
    // asked again without it, and remembered.
    const usageKey = this.profile.baseUrl.replace(/\/+$/, '')
    if (!NO_STREAM_USAGE.has(usageKey)) body.stream_options = { include_usage: true }
    if (this.profile.temperature !== undefined) body.temperature = this.profile.temperature
    if (this.profile.topP !== undefined) body.top_p = this.profile.topP
    applyThinking(body, 'openai', this.profile.thinking, this.profile.maxTokens)
    /*
     * Gemini thinks with `reasoning_effort` like any reasoning model, but shows nothing of it unless
     * asked. Asked only when thinking is switched on for the profile, and dropped for good if the
     * gateway refuses the field - the same treatment as `stream_options`.
     */
    const thoughtsKey = `${usageKey}|thoughts`
    if (gemini !== undefined && this.profile.thinking !== undefined && this.profile.thinking.level !== 'off' && !NO_STREAM_USAGE.has(thoughtsKey)) {
      body.extra_body = { google: { thinking_config: { include_thoughts: true } } }
    }

    let response: HttpResponse
    try {
      // A token that expires mid-generation aborts the response with no way to resume, so
      // it is replaced up front rather than discovered halfway through (§10).
      await this.auth.ensureTokenForStream?.()
      response = await this.send(url, body, options.signal)

      if (response.status >= 400 && response.status < 500 && response.status !== 401 && (body.stream_options !== undefined || body.extra_body !== undefined)) {
        const text = await response.text().catch(() => '')
        if (body.stream_options !== undefined && /stream_options|include_usage/i.test(text)) {
          NO_STREAM_USAGE.add(usageKey)
          delete body.stream_options
          response = await this.send(url, body, options.signal)
        } else if (body.extra_body !== undefined && /extra_body|thinking_config|include_thoughts/i.test(text)) {
          NO_STREAM_USAGE.add(thoughtsKey)
          delete body.extra_body
          response = await this.send(url, body, options.signal)
        } else {
          yield { type: 'error', error: `Request to ${url} failed with HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}` }
          return
        }
      }

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

    yield* parseSseStream(response.body, url, options.signal, this.logger, gemini !== undefined ? { reshaped } : undefined)
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

/** Gateways that refused `stream_options`, by base URL: asked without it from then on. */
const NO_STREAM_USAGE = new Set<string>()

/** The usage an OpenAI-style chunk carries, if any. */
export function usageFrom(parsed: unknown): Extract<StreamChunk, { type: 'usage' }> | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const usage = (parsed as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } } | null }).usage
  if (usage === undefined || usage === null || typeof usage.prompt_tokens !== 'number') return undefined
  return {
    type: 'usage',
    inputTokens: usage.prompt_tokens,
    ...(typeof usage.completion_tokens === 'number' ? { outputTokens: usage.completion_tokens } : {}),
    ...(typeof usage.prompt_tokens_details?.cached_tokens === 'number' ? { cachedTokens: usage.prompt_tokens_details.cached_tokens } : {}),
  }
}

interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
  signature?: string
}

/** Gemini's stream, read as Gemini sends it (`geminiCompat.ts`). Absent for every other model. */
interface GeminiStream {
  reshaped: Map<string, Reshaped[]> | undefined
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

function accumulateToolCallDeltas(accumulators: Map<number, ToolCallAccumulator>, toolCallsDelta: unknown, gemini?: GeminiStream): void {
  if (!Array.isArray(toolCallsDelta)) return
  for (const raw of toolCallsDelta) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as {
      index?: unknown
      id?: unknown
      function?: { name?: unknown; arguments?: unknown }
      extra_content?: { google?: { thought_signature?: unknown } }
    }
    const index = typeof entry.index === 'number' ? entry.index : gemini !== undefined ? geminiIndex(accumulators, entry) : 0
    const existing = accumulators.get(index) ?? { id: '', name: '', arguments: '' }
    if (typeof entry.id === 'string') existing.id = entry.id
    if (typeof entry.function?.name === 'string') existing.name = entry.function.name
    if (typeof entry.function?.arguments === 'string') existing.arguments += entry.function.arguments
    const signature = entry.extra_content?.google?.thought_signature
    if (gemini !== undefined && typeof signature === 'string' && signature.length > 0) existing.signature = signature
    accumulators.set(index, existing)
  }
}

/**
 * Where a Gemini call without an `index` belongs: with the call of the same id, else a new slot when it
 * names a function (Gemini sends each parallel call whole), else the last one (a continuation).
 */
function geminiIndex(accumulators: Map<number, ToolCallAccumulator>, entry: { id?: unknown; function?: { name?: unknown } }): number {
  if (typeof entry.id === 'string' && entry.id.length > 0) {
    for (const [index, call] of accumulators) if (call.id === entry.id) return index
  }
  if (typeof entry.function?.name === 'string' && entry.function.name.length > 0) return accumulators.size
  return Math.max(0, accumulators.size - 1)
}

function* completedToolCalls(accumulators: Map<number, ToolCallAccumulator>, gemini?: GeminiStream): Generator<ToolCall> {
  let position = 0
  for (const call of accumulators.values()) {
    position += 1
    // Gemini may leave out the id; everything after this pairs a result with its call by id.
    const id = call.id.length > 0 ? call.id : gemini !== undefined ? `call_${String(Date.now())}_${String(position)}` : ''
    if (id.length > 0 && call.name.length > 0) {
      yield {
        id,
        name: call.name,
        arguments: gemini !== undefined ? restoreArguments(call.arguments, gemini.reshaped?.get(call.name)) : call.arguments,
        ...(call.signature !== undefined ? { signature: call.signature } : {}),
      }
    }
  }
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  url: string,
  signal: AbortSignal | undefined,
  logger: Logger | undefined,
  gemini?: GeminiStream,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // Gemini's thoughts, when asked for over this endpoint, arrive in the content as `<thought>` tags.
  const thinking = new ThinkTagSplitter(gemini !== undefined ? 'thought' : 'think')
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>()
  // After a tool call, the usage chunk is still to come: read on for it, but briefly - a gateway that never
  // closes the stream must not turn a finished reply into a stalled one.
  let finishedAt: number | undefined
  const AFTER_FINISH_MS = 5000

  try {
    while (true) {
      let next: Awaited<ReturnType<typeof reader.read>> | 'late'
      if (finishedAt === undefined) next = await reader.read()
      else {
        const left = Math.max(0, AFTER_FINISH_MS - (Date.now() - finishedAt))
        let timer: ReturnType<typeof setTimeout> | undefined
        next = await Promise.race([
          reader.read(),
          new Promise<'late'>((resolve) => {
            timer = setTimeout(() => resolve('late'), left)
          }),
        ])
        clearTimeout(timer)
      }
      if (next === 'late') {
        void reader.cancel().catch(() => undefined)
        yield { type: 'done' }
        return
      }
      const { done, value } = next
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
          yield* unannouncedToolCalls()
          yield { type: 'done' }
          return
        }

        try {
          const parsed: unknown = JSON.parse(data)
          const usage = usageFrom(parsed)
          if (usage !== undefined) yield usage
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
            /*
             * Qwen3 and friends put their thinking in the content, wrapped in `<think>` tags,
             * unless whoever serves them switched a reasoning parser on. Routed to the reasoning
             * channel here so it renders as a trace and, more importantly, never enters the
             * conversation — otherwise it is re-sent on every later request, and the models that
             * emit these tags are the ones with the least context to spare. See `thinkTags.ts`.
             */
            const split = thinking.push(choice.delta.content)
            if (split.reasoning.length > 0) yield { type: 'reasoning', text: split.reasoning }
            if (split.text.length > 0) yield { type: 'text', text: split.text }
          }
          accumulateToolCallDeltas(toolCallAccumulators, choice.delta.tool_calls, gemini)

          if (choice.finishReason === 'tool_calls' && finishedAt === undefined) {
            for (const toolCall of completedToolCalls(toolCallAccumulators, gemini)) {
              yield { type: 'toolCall', toolCall }
            }
            finishedAt = Date.now()
          }
        } catch {
          // Malformed SSE frame — skip it rather than aborting the whole stream.
        }
      }
    }
    yield* unannouncedToolCalls()
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

  /*
   * Tool calls the stream made but never announced with `finish_reason: "tool_calls"`: Gemini ends such a
   * stream with "stop", and so do some vLLM builds. They used to be dropped, which reads as the model
   * describing a step and then doing nothing. A stream that did announce them yields nothing more here.
   */
  function* unannouncedToolCalls(): Generator<StreamChunk> {
    if (finishedAt !== undefined) return
    finishedAt = Date.now()
    for (const toolCall of completedToolCalls(toolCallAccumulators, gemini)) yield { type: 'toolCall', toolCall }
  }
}
