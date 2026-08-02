import { z } from 'zod'

/** Only OpenAI-compatible ships in Phase 2. Anthropic/Gemini formats land in Phase 7. */
export const wireFormatSchema = z.enum(['openai'])
export type WireFormat = z.infer<typeof wireFormatSchema>

/**
 * Auth is a separate pluggable axis from wire format, so any strategy composes with
 * any adapter — see CLAUDE.md §10. `apigeeMtls` lands in Phase 6.
 */
export const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('apiKey'), apiKeyRef: z.string().min(1) }),
])
export type Auth = z.infer<typeof authSchema>

export const providerProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1, 'Label is required'),
  wireFormat: wireFormatSchema,
  baseUrl: z.string().min(1, 'Base URL is required').url('Must be a valid URL'),
  model: z.string().min(1, 'Model is required'),
  auth: authSchema,
  headers: z.record(z.string(), z.string()).optional(),
})
export type ProviderProfile = z.infer<typeof providerProfileSchema>

export interface AuthStrategy {
  resolveHeaders(): Promise<Record<string, string>>
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the tool's parameters. */
  parameters: unknown
}

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string — the tool executor parses and validates it, not the provider. */
  arguments: string
}

/**
 * A discriminated union rather than one flat shape: `assistant` optionally carries
 * `toolCalls`, `tool` carries a `toolCallId` linking a result back to its call. Neither
 * makes sense on `system`/`user` messages.
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; toolCall: ToolCall }
  | { type: 'done' }
  | { type: 'error'; error: string }

export interface ChatStreamOptions {
  signal?: AbortSignal
  /** Omit to disable tool-calling for this turn (e.g. a provider profile with no tools enabled). */
  tools?: ToolDefinition[]
}

export interface ChatProvider {
  streamChat(messages: ChatMessage[], options?: ChatStreamOptions): AsyncGenerator<StreamChunk>
}
