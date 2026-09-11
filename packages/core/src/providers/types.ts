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
/**
 * TLS material for one connection, or globally.
 *
 * One schema for both so a profile, an OpenSearch cluster and the global block cannot drift
 * apart in what they accept. `platform/connectionTls.ts` owns how the two levels merge:
 * CAs accumulate, client identity is taken as a unit, `rejectUnauthorized` is
 * most-specific-wins.
 */
export const tlsSettingsSchema = z.object({
  /** Absolute path, or relative to the user-scope `certDir`. PEM, may hold a chain. */
  caFile: z.string().optional(),
  /** Client certificate — supplied with `keyFile`, or replaced by `pfxFile`. */
  certFile: z.string().optional(),
  keyFile: z.string().optional(),
  /** Corporate Windows PKI usually issues `.pfx`; supplied instead of certFile/keyFile. */
  pfxFile: z.string().optional(),
  /** A SecretStore reference for the key passphrase, never the passphrase itself (§15). */
  passphraseRef: z.string().optional(),
  /** `false` accepts any server certificate. See `TlsOptions.rejectUnauthorized`. */
  rejectUnauthorized: z.boolean().optional(),
  /**
   * `false` presents no client certificate to this connection even when one is configured
   * globally — for an endpoint that should not see your identity.
   */
  useGlobalClientCertificate: z.boolean().optional(),
})
export type TlsSettings = z.infer<typeof tlsSettingsSchema>

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
/**
 * A token produced by running a command, for a parent process that already owns the credential.
 *
 * See `auth/tokenCommand.ts` for why this exists rather than only `env:` — in short, a parent
 * cannot change a running child's environment, so a handed-over token cannot be refreshed and a
 * session outlives it.
 */
export const tokenCommandSchema = z.object({
  command: z
    .array(z.string().min(1))
    .min(1, 'Give the program and its arguments')
    .describe('argv. Spawned directly — nothing is parsed by a shell.'),
  cwd: z.string().optional(),
  tokenPath: z.string().optional(),
  expiresInPath: z.string().optional(),
  fallbackExpirySeconds: z.number().int().positive().optional(),
  refreshSkewSeconds: z.number().int().nonnegative().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  headerName: z.string().optional(),
  headerPrefix: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
})
export type TokenCommandConfig = z.infer<typeof tokenCommandSchema>

export const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  /**
   * `apiKeyRef` may name the environment as well as the secret store.
   *
   * `env:API_TOKEN` reads it from the process environment — see `auth/secretRef.ts`. Anything
   * else is a key into `SecretStore`, which is what the UI writes.
   */
  z.object({ type: z.literal('apiKey'), apiKeyRef: z.string().min(1) }),
  z.object({ type: z.literal('tokenCommand'), tokenCommand: tokenCommandSchema }),
  /**
   * A fixed header the gateway expects, with no API key involved.
   *
   * Each value is a *reference* — a secret-store key, or `env:NAME` — never a literal, because
   * the profile lives in the config file and §15 is explicit that a credential never does.
   */
  z.object({
    type: z.literal('header'),
    headers: z
      .array(
        z.object({
          name: z.string().min(1, 'Give the header name'),
          valueRef: z.string().min(1, 'Give the value, or env:NAME'),
          prefix: z.string().optional(),
        }),
      )
      .min(1, 'Add at least one header'),
  }),
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
  tls: tlsSettingsSchema.optional(),
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
  /**
   * The model's own reasoning, where the provider exposes it: DeepSeek and Qwen send
   * `reasoning_content`, Anthropic sends `thinking` blocks.
   *
   * Kept separate from `text` rather than concatenated, because it is not part of the
   * answer: it is shown differently, and it must not be fed back as assistant content on
   * the next turn.
   */
  | { type: 'reasoning'; text: string }
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
