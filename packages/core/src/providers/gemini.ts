import { randomUUID } from 'node:crypto'
import type { Logger } from '../logging/logger.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { describeTlsError } from './auth/apigeeMtls.js'
import { toGeminiTools } from './schema.js'
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
 * Gemini's `generateContent` diverges from the other two more than Anthropic does:
 *
 * 1. **The model id is in the URL path**, not the body:
 *    `/models/{model}:streamGenerateContent`.
 * 2. **`alt=sse` is required** for a real event stream. Without it the response is a JSON
 *    array delivered in chunks, which looks like it works until a large response arrives
 *    split mid-object.
 * 3. **The assistant role is called `model`**, and the system prompt is
 *    `systemInstruction`, a separate field.
 * 4. **Function calls carry no id.** Everything upstream — the loop, the transcript, the
 *    approval gate — keys tool results by id, so one is synthesised here and mapped back
 *    by *name* on the way out, which is all Gemini gives us to match on.
 */
export class GeminiProvider implements ChatProvider {
  constructor(
    private readonly http: HttpClient,
    private readonly profile: ProviderProfile,
    private readonly auth: AuthStrategy,
    private readonly logger?: Logger,
  ) {}

  async *streamChat(messages: ChatMessage[], options: ChatStreamOptions = {}): AsyncGenerator<StreamChunk> {
    const base = this.profile.baseUrl.replace(/\/+$/, '')
    const url = `${base}/models/${encodeURIComponent(this.profile.model)}:streamGenerateContent?alt=sse`
    this.logger?.debug('POST', url)

    const { systemInstruction, contents } = toGeminiContents(messages)
    const body: Record<string, unknown> = { contents }
    if (systemInstruction !== undefined) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] }
    }
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = toGeminiTools(options.tools)
    }
    if (this.profile.maxTokens !== undefined) {
      body.generationConfig = { maxOutputTokens: this.profile.maxTokens }
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

    yield* parseGeminiStream(response.body, url, options.signal)
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

interface GeminiPayload {
  systemInstruction: string | undefined
  contents: Record<string, unknown>[]
}

/**
 * Tool-call ids, remembered per conversation so a `functionResponse` can be matched back to
 * the call it answers. Gemini matches on **name**, so this maps our id to the name.
 */
function buildIdToName(messages: readonly ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const toolCall of message.toolCalls ?? []) map.set(toolCall.id, toolCall.name)
  }
  return map
}

export function toGeminiContents(messages: readonly ChatMessage[]): GeminiPayload {
  const systemInstruction = messages.find((message) => message.role === 'system')?.content
  const idToName = buildIdToName(messages)
  const contents: Record<string, unknown>[] = []

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      // Gemini has no tool role; a result is a `user` turn containing a functionResponse.
      // It is matched to its call by name, which is why the id map above exists.
      const part = {
        functionResponse: {
          name: idToName.get(message.toolCallId) ?? message.toolCallId,
          response: { result: message.content },
        },
      }
      const previous = contents[contents.length - 1]
      if (previous?.role === 'user' && Array.isArray(previous.parts) && isFunctionResponseParts(previous.parts)) {
        ;(previous.parts as unknown[]).push(part)
      } else {
        contents.push({ role: 'user', parts: [part] })
      }
      continue
    }

    if (message.role === 'user') {
      const parts: Record<string, unknown>[] = []
      for (const image of message.images ?? []) {
        parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } })
      }
      if (message.content.length > 0) parts.push({ text: message.content })
      contents.push({ role: 'user', parts: parts.length > 0 ? parts : [{ text: '' }] })
      continue
    }

    const parts: Record<string, unknown>[] = []
    if (message.content.length > 0) parts.push({ text: message.content })
    for (const toolCall of message.toolCalls ?? []) {
      parts.push({ functionCall: { name: toolCall.name, args: safeParseArguments(toolCall.arguments) } })
    }
    // Gemini calls the assistant "model".
    if (parts.length > 0) contents.push({ role: 'model', parts })
  }

  return { systemInstruction, contents }
}

function isFunctionResponseParts(parts: unknown[]): boolean {
  return parts.length > 0 && parts.every((part) => (part as { functionResponse?: unknown }).functionResponse !== undefined)
}

function safeParseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw.length > 0 ? raw : '{}')
  } catch {
    return {}
  }
}

async function* parseGeminiStream(
  body: ReadableStream<Uint8Array>,
  url: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const toolCalls: ToolCall[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice('data:'.length).trim()
        if (data.length === 0) continue

        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(data) as Record<string, unknown>
        } catch {
          continue
        }

        const candidates = parsed.candidates
        if (!Array.isArray(candidates) || candidates.length === 0) continue
        const candidate = candidates[0] as { content?: { parts?: unknown } } | undefined
        const parts = candidate?.content?.parts
        if (!Array.isArray(parts)) continue

        for (const rawPart of parts) {
          const part = rawPart as { text?: unknown; functionCall?: { name?: unknown; args?: unknown } }
          if (typeof part.text === 'string' && part.text.length > 0) {
            yield { type: 'text', text: part.text }
          }
          if (part.functionCall !== undefined && typeof part.functionCall.name === 'string') {
            // Gemini supplies no call id; everything upstream needs one to pair the result.
            toolCalls.push({
              id: randomUUID(),
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            })
          }
        }
      }
    }

    for (const toolCall of toolCalls) yield { type: 'toolCall', toolCall }
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
