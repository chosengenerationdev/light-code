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
  label: z.string().min(1),
  wireFormat: wireFormatSchema,
  baseUrl: z.string().min(1),
  model: z.string().min(1),
  auth: authSchema,
  headers: z.record(z.string(), z.string()).optional(),
})
export type ProviderProfile = z.infer<typeof providerProfileSchema>

export interface AuthStrategy {
  resolveHeaders(): Promise<Record<string, string>>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: string }

export interface ChatStreamOptions {
  signal?: AbortSignal
}

export interface ChatProvider {
  streamChat(messages: ChatMessage[], options?: ChatStreamOptions): AsyncGenerator<StreamChunk>
}
