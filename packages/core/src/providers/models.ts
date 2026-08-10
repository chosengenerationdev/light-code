import type { HttpClient } from '../platform/http.js'
import { describeTlsError } from './auth/apigeeMtls.js'
import type { AuthStrategy, ProviderProfile } from './types.js'

export interface ModelCapabilities {
  /** Total context window in tokens. */
  contextWindow: number
  supportsVision: boolean
  supportsTools: boolean
  /** True when these values came from the table rather than the conservative default. */
  known: boolean
}

/**
 * Models endpoints do not report context window, vision, or tool support, so it is kept
 * locally (§9). Keyed by the substring that identifies a family, because gateways prefix
 * and suffix model ids freely (`corp-openai-gpt-4o-v2`).
 *
 * Ordered longest-key-first at lookup time so `gpt-4o-mini` wins over `gpt-4o`.
 */
const MODEL_TABLE: Record<string, Omit<ModelCapabilities, 'known'>> = {
  'gpt-4o-mini': { contextWindow: 128_000, supportsVision: true, supportsTools: true },
  'gpt-4o': { contextWindow: 128_000, supportsVision: true, supportsTools: true },
  'gpt-4.1-mini': { contextWindow: 1_047_576, supportsVision: true, supportsTools: true },
  'gpt-4.1': { contextWindow: 1_047_576, supportsVision: true, supportsTools: true },
  'gpt-4-turbo': { contextWindow: 128_000, supportsVision: true, supportsTools: true },
  'gpt-4': { contextWindow: 8_192, supportsVision: false, supportsTools: true },
  'gpt-3.5-turbo': { contextWindow: 16_385, supportsVision: false, supportsTools: true },
  o3: { contextWindow: 200_000, supportsVision: true, supportsTools: true },
  'o4-mini': { contextWindow: 200_000, supportsVision: true, supportsTools: true },

  'claude-opus-4': { contextWindow: 200_000, supportsVision: true, supportsTools: true },
  'claude-sonnet-4': { contextWindow: 200_000, supportsVision: true, supportsTools: true },
  'claude-3-7-sonnet': { contextWindow: 200_000, supportsVision: true, supportsTools: true },
  'claude-3-5-sonnet': { contextWindow: 200_000, supportsVision: true, supportsTools: true },
  'claude-3-5-haiku': { contextWindow: 200_000, supportsVision: true, supportsTools: true },

  'gemini-2.5-pro': { contextWindow: 1_048_576, supportsVision: true, supportsTools: true },
  'gemini-2.5-flash': { contextWindow: 1_048_576, supportsVision: true, supportsTools: true },
  'gemini-2.0-flash': { contextWindow: 1_048_576, supportsVision: true, supportsTools: true },

  'deepseek-reasoner': { contextWindow: 65_536, supportsVision: false, supportsTools: false },
  'deepseek-chat': { contextWindow: 65_536, supportsVision: false, supportsTools: true },

  'llama-3.3': { contextWindow: 128_000, supportsVision: false, supportsTools: true },
  'llama-3.1': { contextWindow: 128_000, supportsVision: false, supportsTools: true },
  mistral: { contextWindow: 32_768, supportsVision: false, supportsTools: true },

  // Qwen. Widely self-hosted behind an OpenAI-compatible gateway, so the ids that arrive
  // are often prefixed or suffixed — substring matching handles that, and the bare
  // `qwen` entry catches versions not listed here rather than dropping to the default.
  'qwen2.5-coder': { contextWindow: 131_072, supportsVision: false, supportsTools: true },
  'qwen2.5-vl': { contextWindow: 131_072, supportsVision: true, supportsTools: true },
  'qwen2.5': { contextWindow: 131_072, supportsVision: false, supportsTools: true },
  'qwen3-coder': { contextWindow: 262_144, supportsVision: false, supportsTools: true },
  'qwen3-vl': { contextWindow: 262_144, supportsVision: true, supportsTools: true },
  qwen3: { contextWindow: 131_072, supportsVision: false, supportsTools: true },
  'qwen-vl': { contextWindow: 131_072, supportsVision: true, supportsTools: true },
  'qwen-max': { contextWindow: 131_072, supportsVision: false, supportsTools: true },
  'qwen-plus': { contextWindow: 131_072, supportsVision: false, supportsTools: true },
  'qwen-turbo': { contextWindow: 1_000_000, supportsVision: false, supportsTools: true },
  qwq: { contextWindow: 131_072, supportsVision: false, supportsTools: true },
  qwen: { contextWindow: 32_768, supportsVision: false, supportsTools: true },

  // Gemma. Open-weight, so the deployed context window is whatever the server was started
  // with — these are the model's own maximums and a self-hosted deployment is often
  // configured lower. Override per profile when it matters.
  'gemma-3n': { contextWindow: 32_768, supportsVision: true, supportsTools: true },
  'gemma-3': { contextWindow: 131_072, supportsVision: true, supportsTools: true },
  'gemma-2': { contextWindow: 8_192, supportsVision: false, supportsTools: true },
  gemma: { contextWindow: 131_072, supportsVision: true, supportsTools: true },
}

/**
 * A note on `supportsTools` for open-weight models: whether tool calling works is a
 * property of the **server**, not the model. vLLM, llama.cpp and Ollama each apply their
 * own template, so the same Gemma or Qwen build may or may not emit tool calls depending
 * on how it was started. Nothing gates on this field, so it is set optimistically —
 * reporting "no tool support" for a model that works would be worse than saying nothing.
 */

/**
 * What an unrecognised id gets. Gateway aliases are common and often opaque, so the
 * default is deliberately small — a too-small window wastes budget, a too-large one gets
 * the request rejected mid-task (§9: "Unknown IDs default conservatively").
 */
const CONSERVATIVE_DEFAULT: Omit<ModelCapabilities, 'known'> = {
  contextWindow: 32_768,
  supportsVision: false,
  supportsTools: true,
}

const TABLE_KEYS_BY_SPECIFICITY = Object.keys(MODEL_TABLE).sort((a, b) => b.length - a.length)

export function lookupModelCapabilities(modelId: string): ModelCapabilities {
  const normalized = modelId.toLowerCase()
  for (const key of TABLE_KEYS_BY_SPECIFICITY) {
    if (normalized.includes(key)) {
      return { ...(MODEL_TABLE[key] as Omit<ModelCapabilities, 'known'>), known: true }
    }
  }
  return { ...CONSERVATIVE_DEFAULT, known: false }
}

/** Optional fields are explicitly `| undefined`: these come from a zod `.optional()` schema. */
export interface ModelCapabilityOverrides {
  contextWindow?: number | undefined
  supportsVision?: boolean | undefined
  supportsTools?: boolean | undefined
}

/** Per-profile overrides win over the table, which wins over the conservative default. */
export function resolveModelCapabilities(
  modelId: string,
  overrides: ModelCapabilityOverrides | undefined,
): ModelCapabilities {
  const base = lookupModelCapabilities(modelId)
  if (overrides === undefined) return base
  return {
    contextWindow: overrides.contextWindow ?? base.contextWindow,
    supportsVision: overrides.supportsVision ?? base.supportsVision,
    supportsTools: overrides.supportsTools ?? base.supportsTools,
    known: base.known || Object.values(overrides).some((value) => value !== undefined),
  }
}

export interface ListModelsResult {
  ids: string[]
  /**
   * Set when the catalogue could not be fetched. The dropdown must never be a hard
   * dependency (§9) — gateways routinely 404 this endpoint — so this is a note shown
   * beside a still-usable free-text field, not an error that blocks anything.
   */
  warning?: string
}

function extractModelIds(payload: unknown): string[] {
  const container = payload as { data?: unknown; models?: unknown } | null
  const list = Array.isArray(container?.data)
    ? container.data
    : Array.isArray(container?.models)
      ? container.models
      : Array.isArray(payload)
        ? payload
        : []

  const ids: string[] = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      ids.push(entry)
      continue
    }
    const record = entry as { id?: unknown; name?: unknown } | null
    // Gemini's `/v1beta/models` uses `name`; OpenAI-compatible uses `id`.
    const id = typeof record?.id === 'string' ? record.id : typeof record?.name === 'string' ? record.name : undefined
    if (id !== undefined) ids.push(id.replace(/^models\//, ''))
  }
  return [...new Set(ids)].sort()
}

/**
 * Fetches the provider's catalogue. Never throws: a failure returns an empty list plus a
 * warning, because the caller always keeps free-text entry available.
 */
export async function listModels(
  http: HttpClient,
  profile: Pick<ProviderProfile, 'baseUrl' | 'headers'>,
  auth: AuthStrategy,
  signal?: AbortSignal,
): Promise<ListModelsResult> {
  const url = `${profile.baseUrl.replace(/\/+$/, '')}/models`

  let authHeaders: Record<string, string>
  try {
    authHeaders = await auth.resolveHeaders()
  } catch (error) {
    return { ids: [], warning: error instanceof Error ? error.message : String(error) }
  }

  try {
    const tls = await auth.tls?.()
    const response = await http.request(url, {
      method: 'GET',
      headers: { ...authHeaders, ...profile.headers },
      ...(signal !== undefined ? { signal } : {}),
      ...(tls !== undefined ? { tls } : {}),
    })

    if (response.status === 404) {
      return { ids: [], warning: `${url} returned 404. This gateway does not publish a model list — type the model id.` }
    }
    if (response.status < 200 || response.status >= 300) {
      return { ids: [], warning: `${url} returned HTTP ${response.status}. Type the model id instead.` }
    }

    const ids = extractModelIds(await response.json())
    if (ids.length === 0) {
      return { ids: [], warning: `${url} returned no models. Type the model id instead.` }
    }
    return { ids }
  } catch (error) {
    return { ids: [], warning: `Could not reach ${url}: ${describeTlsError(error)}` }
  }
}
