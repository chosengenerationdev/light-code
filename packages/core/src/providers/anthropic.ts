import type { Logger } from '../logging/logger.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { describeTlsError } from './auth/apigeeMtls.js'
import { toAnthropicTools } from './schema.js'
import type {
  AuthStrategy,
  ChatMessage,
  ChatProvider,
  ChatStreamOptions,
  ProviderProfile,
  StreamChunk,
  ToolCall,
} from './types.js'

/**
 * Pinned rather than tracking latest. Anthropic's API is versioned by this header, and a
 * silently newer version could change the streaming event shape under us.
 */
const ANTHROPIC_VERSION = '2023-06-01'

/** Anthropic requires `max_tokens`; there is no "use the model default". */
const DEFAULT_MAX_TOKENS = 8_192

interface AnthropicContentBlock {
  type: string
  [key: string]: unknown
}

/**
 * Anthropic differs from OpenAI in three ways that matter, and each one is a silent failure
 * if missed:
 *
 * 1. **The system prompt is a top-level `system` parameter**, not a message with
 *    `role: "system"`. Sending it as a message is rejected.
 * 2. **Tool results are `user` messages** containing `tool_result` blocks, not a distinct
 *    `tool` role. Consecutive results must be merged into one user message.
 * 3. **Content is a block array**, so text and `tool_use` coexist in one assistant message.
 */
export class AnthropicProvider implements ChatProvider {
  constructor(
    private readonly http: HttpClient,
    private readonly profile: ProviderProfile,
    private readonly auth: AuthStrategy,
    private readonly logger?: Logger,
  ) {}

  async *streamChat(messages: ChatMessage[], options: ChatStreamOptions = {}): AsyncGenerator<StreamChunk> {
    const url = `${this.profile.baseUrl.replace(/\/+$/, '')}/messages`
    this.logger?.debug('POST', url, `model=${this.profile.model}`)

    const { system, wireMessages } = toAnthropicMessages(messages)
    const body: Record<string, unknown> = {
      model: this.profile.model,
      max_tokens: this.profile.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: wireMessages,
      stream: true,
    }
    if (system !== undefined) body.system = system
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = toAnthropicTools(options.tools)
    }

    let response: HttpResponse
    try {
      await this.auth.ensureTokenForStream?.()
      response = await this.send(url, body, options.signal)
      if (response.status === 401 && this.auth.onUnauthorized !== undefined) {
        if (await this.auth.onUnauthorized()) response = await this.send(url, body, options.signal)
      }
    } catch (error) {
      yield { type: 'error', error: `Could not reach ${url}: ${describeTlsError(error)}` }
      return
    }

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

    yield* parseAnthropicStream(response.body, url, options.signal, this.logger)
  }

  private async send(url: string, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<HttpResponse> {
    const authHeaders = await this.auth.resolveHeaders()
    const tls = await this.auth.tls?.()
    const request: HttpRequestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        ...authHeaders,
        ...this.profile.headers,
      },
      body: JSON.stringify(body),
    }
    if (signal !== undefined) request.signal = signal
    if (tls !== undefined) request.tls = tls
    return this.http.request(url, request)
  }
}

interface AnthropicMessagesPayload {
  system: string | undefined
  wireMessages: Record<string, unknown>[]
}

/**
 * Maps our message union onto Anthropic's shape.
 *
 * The subtle part is tool results. Ours are separate `tool` messages; Anthropic wants them
 * as `tool_result` blocks inside a `user` message, and **consecutive results must be
 * merged into a single user message** — sending two user messages in a row after one
 * assistant turn is rejected as an invalid alternation.
 */
export function toAnthropicMessages(messages: readonly ChatMessage[]): AnthropicMessagesPayload {
  // Anthropic takes the system prompt as a top-level parameter, not a message.
  const system = messages.find((message) => message.role === 'system')?.content
  const wireMessages: Record<string, unknown>[] = []

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }
      const previous = wireMessages[wireMessages.length - 1]
      // Merge into the preceding user message when that message is itself tool results.
      if (previous?.role === 'user' && Array.isArray(previous.content) && isToolResultBlocks(previous.content)) {
        ;(previous.content as unknown[]).push(block)
      } else {
        wireMessages.push({ role: 'user', content: [block] })
      }
      continue
    }

    if (message.role === 'user') {
      const blocks: AnthropicContentBlock[] = []
      for (const image of message.images ?? []) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.data },
        })
      }
      // Text after images: the question usually refers to the picture above it.
      if (message.content.length > 0) blocks.push({ type: 'text', text: message.content })
      wireMessages.push({ role: 'user', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] })
      continue
    }

    const blocks: AnthropicContentBlock[] = []
    if (message.content.length > 0) blocks.push({ type: 'text', text: message.content })
    for (const toolCall of message.toolCalls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        // Anthropic wants a parsed object; ours is the raw JSON string the model emitted.
        input: safeParseArguments(toolCall.arguments),
      })
    }
    if (blocks.length > 0) wireMessages.push({ role: 'assistant', content: blocks })
  }

  return { system, wireMessages }
}

function isToolResultBlocks(content: unknown[]): boolean {
  return content.length > 0 && content.every((block) => (block as { type?: string }).type === 'tool_result')
}

/** Malformed arguments must not abort the request — the model gets a tool error instead. */
function safeParseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw.length > 0 ? raw : '{}')
  } catch {
    return {}
  }
}

interface ToolUseAccumulator {
  id: string
  name: string
  json: string
}

/**
 * Anthropic's SSE carries named event types and, unlike OpenAI, indexes content blocks
 * explicitly. Tool arguments arrive as `input_json_delta` fragments that must be
 * concatenated per block index until `content_block_stop`.
 */
async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
  url: string,
  signal: AbortSignal | undefined,
  logger: Logger | undefined,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const toolUses = new Map<number, ToolUseAccumulator>()
  const completed: ToolCall[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        // `event:` lines are redundant — every payload repeats its own `type`.
        if (!trimmed.startsWith('data:')) continue

        const data = trimmed.slice('data:'.length).trim()
        if (data.length === 0) continue

        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(data) as Record<string, unknown>
        } catch {
          continue // Malformed frame — skip rather than abort the stream.
        }

        const eventType = parsed.type
        if (eventType === 'content_block_start') {
          const index = typeof parsed.index === 'number' ? parsed.index : 0
          const block = parsed.content_block as { type?: string; id?: string; name?: string } | undefined
          if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            toolUses.set(index, { id: block.id, name: block.name, json: '' })
          }
        } else if (eventType === 'content_block_delta') {
          const index = typeof parsed.index === 'number' ? parsed.index : 0
          const delta = parsed.delta as
            | { type?: string; text?: unknown; partial_json?: unknown; thinking?: unknown }
            | undefined
          if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
            yield { type: 'reasoning', text: delta.thinking }
          } else if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
            yield { type: 'text', text: delta.text }
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const accumulator = toolUses.get(index)
            if (accumulator !== undefined) accumulator.json += delta.partial_json
          }
        } else if (eventType === 'content_block_stop') {
          const index = typeof parsed.index === 'number' ? parsed.index : 0
          const accumulator = toolUses.get(index)
          if (accumulator !== undefined) {
            // An empty-input tool arrives with no deltas at all, so default to `{}`.
            completed.push({
              id: accumulator.id,
              name: accumulator.name,
              arguments: accumulator.json.length > 0 ? accumulator.json : '{}',
            })
            toolUses.delete(index)
          }
        } else if (eventType === 'message_stop') {
          for (const toolCall of completed) yield { type: 'toolCall', toolCall }
          yield { type: 'done' }
          return
        } else if (eventType === 'error') {
          const error = parsed.error as { message?: unknown } | undefined
          const message = typeof error?.message === 'string' ? error.message : 'The provider reported an error.'
          logger?.debug('anthropic stream error', message)
          yield { type: 'error', error: message }
          return
        }
      }
    }

    // Stream ended without `message_stop` — emit whatever completed rather than losing it.
    for (const toolCall of completed) yield { type: 'toolCall', toolCall }
    yield { type: 'done' }
  } catch (error) {
    if (signal?.aborted) {
      yield { type: 'done' }
    } else {
      yield { type: 'error', error: `Could not reach ${url}: ${describeTlsError(error)}` }
    }
  } finally {
    reader.releaseLock()
  }
}
