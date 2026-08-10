import { z } from 'zod'
import type { TlsOptions } from '../platform/http.js'

/** All three wire formats from Phase 7. Auth is a separate axis (§10), not implied by this. */
export const wireFormatSchema = z.enum(['openai', 'anthropic', 'gemini'])
export type WireFormat = z.infer<typeof wireFormatSchema>

/**
 * Certificate material for `apigeeMtls`. A directory plus filenames, per §10 — filenames
 * resolve against `certDir`, absolute paths override it. `certDir` may be omitted here to
 * inherit the top-level user-scope `certDir`.
 */
export const certConfigSchema = z.object({
  certDir: z.string().min(1).optional(),
  certFile: z.string().optional(),
  keyFile: z.string().optional(),
  /** Corporate Windows PKI usually issues `.pfx`; supplied instead of certFile/keyFile. */
  pfxFile: z.string().optional(),
  caFile: z.string().optional(),
  /** A SecretStore reference, never the passphrase itself (§15). */
  passphraseRef: z.string().optional(),
})
export type CertConfigInput = z.infer<typeof certConfigSchema>

/**
 * Every Apigee field is optional with a working default in the strategy — gateways differ
 * on all of it and there is no endpoint we could safely hardcode (invariant 3).
 */
export const apigeeMtlsSettingsSchema = z.object({
  tokenUrl: z.string().url('Must be a valid URL').optional(),
  grantType: z.string().optional(),
  clientId: z.string().optional(),
  /** A SecretStore reference, never the secret itself (§15). */
  clientSecretRef: z.string().optional(),
  scope: z.string().optional(),
  extraTokenParams: z.record(z.string(), z.string()).optional(),
  tokenHeaderName: z.string().optional(),
  tokenHeaderPrefix: z.string().optional(),
  tokenPath: z.string().optional(),
  expiresInPath: z.string().optional(),
  fallbackExpirySeconds: z.number().int().positive().optional(),
  refreshSkewSeconds: z.number().int().nonnegative().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
})
export type ApigeeMtlsSettingsInput = z.infer<typeof apigeeMtlsSettingsSchema>

/**
 * Auth is a separate pluggable axis from wire format, so any strategy composes with
 * any adapter — see CLAUDE.md §10.
 *
 * `apigeeMtls` **replaces** the API key rather than supplementing it; the discriminated
 * union is what makes that structural, so the two can never both be live at once.
 */
export const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('apiKey'), apiKeyRef: z.string().min(1) }),
  z.object({
    type: z.literal('apigeeMtls'),
    certs: certConfigSchema,
    apigee: apigeeMtlsSettingsSchema,
  }),
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
  /**
   * Connection trust, independent of authentication.
   *
   * Separate from `auth.certs` on purpose: a *client* certificate is how the gateway
   * identifies you, whereas this is how you decide to trust the gateway. Most corporate
   * users need the second without the first — an ordinary API key behind a TLS-intercepting
   * proxy — and tying the two together left them with no way to supply a CA at all.
   *
   * Safe to keep here rather than under a separate invariant-5 entry: the whole `profiles`
   * list is already user-scope only, so a workspace cannot switch verification off.
   */
  tls: z
    .object({
      /** Absolute path, or relative to the user-scope `certDir`. PEM, may hold a chain. */
      caFile: z.string().optional(),
      /** `false` accepts any server certificate. See `TlsOptions.rejectUnauthorized`. */
      rejectUnauthorized: z.boolean().optional(),
    })
    .optional(),
  /**
   * Anthropic *requires* `max_tokens` — there is no "use the model default" — so this has
   * a working fallback in the adapter rather than being mandatory here.
   */
  maxTokens: z.number().int().positive().optional(),
  /**
   * Per-profile corrections to the local capability table (§9). Needed because gateway
   * aliases hide the underlying model, so the table cannot recognise them.
   */
  modelCapabilities: z
    .object({
      contextWindow: z.number().int().positive().optional(),
      supportsVision: z.boolean().optional(),
      supportsTools: z.boolean().optional(),
    })
    .optional(),
})
export type ProviderProfile = z.infer<typeof providerProfileSchema>

export interface AuthStrategy {
  resolveHeaders(): Promise<Record<string, string>>
  /**
   * Client TLS material, for gateways that require mutual TLS. Returned per request so a
   * rotated certificate takes effect without rebuilding the strategy.
   */
  tls?(): Promise<TlsOptions | undefined>
  /**
   * Called once after a 401. Returning `true` means the credential was refreshed and the
   * request is worth retrying exactly once. Lives here rather than in the provider because
   * only the strategy knows whether a retry could possibly help — and returning `false`
   * is what stops a refresh/401 loop.
   */
  onUnauthorized?(): Promise<boolean>
  /**
   * Called before opening a stream. Strategies with expiring credentials replace one that
   * would not outlive a long generation — expiry mid-stream aborts the response.
   */
  ensureTokenForStream?(): Promise<void>
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
 * An image attached to a user message. Base64 without the `data:` prefix, because each
 * wire format wants it differently — OpenAI wants a data URL, Anthropic wants
 * `{media_type, data}`, Gemini wants `inline_data` — and only the adapter should know that.
 */
export interface ImageAttachment {
  /** e.g. `image/png`. Providers reject anything outside a small supported set. */
  mediaType: string
  /** Base64-encoded bytes, no `data:image/png;base64,` prefix. */
  data: string
}

/**
 * A discriminated union rather than one flat shape: `assistant` optionally carries
 * `toolCalls`, `tool` carries a `toolCallId` linking a result back to its call, and only
 * `user` carries images. None of those make sense on the other roles.
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ImageAttachment[] }
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
