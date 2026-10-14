import type { ListModelsResult } from './models.js'
import type { TestConnectionResult } from './testConnection.js'
import type { ChatMessage, ChatProvider, ChatStreamOptions, StreamChunk, ToolDefinition } from './types.js'

/**
 * Language models the *host* provides - GitHub Copilot through VS Code's Language Model API.
 *
 * Asked for: "if it is already configured in VS Code, user should be able to re-use it easily for light
 * code or fire code". The supported way is `vscode.lm`: VS Code asks the person once whether Light Code
 * may use Copilot, then makes every request with Copilot's own sign-in. Light Code never sees a GitHub
 * token and opens no connection for it, so invariants 2 and 3 are untouched - the request is VS Code's.
 * Copying Copilot's token and calling GitHub directly was refused: an unofficial interface, against
 * GitHub's terms for other clients, and the kind of thing a managed machine raises an alert about.
 *
 * Inside VS Code this is the extension's own `vscode.lm` (`apps/vscode/src/platform/languageModels.ts`).
 * Fire Code, the Node host and the JetBrains plugin have no `vscode`, so they reach a running VS Code
 * window through a per-user relay (`platform/node/lmRelay.ts`) - which is why this interface carries
 * plain JSON (`ChatMessage`, `StreamChunk`) and nothing of VS Code's own types.
 */
export interface HostModelInfo {
  /** What a profile stores as its model. */
  id: string
  name: string
  /** `copilot`, or another extension that contributes models. */
  vendor: string
  family?: string
  /** The model's input limit, which Copilot sets below the model's own window. */
  maxInputTokens?: number
}

export interface HostModelRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
}

export interface HostLanguageModels {
  /** Where the requests go, for messages: "VS Code", or "VS Code (relayed)". */
  readonly label: string
  listModels(signal?: AbortSignal): Promise<HostModelInfo[]>
  /** Yields `text` and `toolCall` chunks; throws with a sentence a person can act on. */
  chat(request: HostModelRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>
}

/**
 * The base URL a Copilot profile stores. Not an endpoint - nothing is ever fetched from it - but the
 * profile schema requires a URL, and this one says plainly where the model is.
 */
export const HOST_MODELS_BASE_URL = 'vscode://language-models'

/** Said wherever a Copilot profile is used with no way to reach VS Code. */
export const NO_HOST_MODELS =
  'GitHub Copilot is reached through VS Code, and it cannot be reached from here. In VS Code, use the Light Code extension; ' +
  'in Fire Code or the Light Code host on Windows, keep a VS Code window open with the Light Code extension and Copilot signed in.'

export class HostModelProvider implements ChatProvider {
  constructor(
    private readonly models: HostLanguageModels | undefined,
    private readonly model: string,
  ) {}

  async *streamChat(messages: ChatMessage[], options: ChatStreamOptions = {}): AsyncGenerator<StreamChunk> {
    if (this.models === undefined) {
      yield { type: 'error', error: NO_HOST_MODELS }
      return
    }
    try {
      for await (const chunk of this.models.chat(
        { model: this.model, messages, ...(options.tools !== undefined && options.tools.length > 0 ? { tools: options.tools } : {}) },
        options.signal,
      )) {
        if (chunk.type === 'done') break
        yield chunk
        if (chunk.type === 'error') return
      }
      yield { type: 'done' }
    } catch (error) {
      // A cancelled turn is not a failure; the loop already knows it stopped.
      if (options.signal?.aborted === true) return
      yield { type: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** The model picker's answer for a Copilot profile: ids, and each model's input limit as its window. */
export async function listHostModels(models: HostLanguageModels | undefined, signal?: AbortSignal): Promise<ListModelsResult & { found?: HostModelInfo[] }> {
  if (models === undefined) return { ids: [], warning: NO_HOST_MODELS }
  try {
    const found = await models.listModels(signal)
    if (found.length === 0) {
      return {
        ids: [],
        warning: `${models.label} offered no language models. Sign in to GitHub Copilot in VS Code (the Copilot icon in the status bar), then refresh.`,
      }
    }
    // Copilot's first, then by name, so the list reads the way the Copilot picker does.
    const sorted = [...found].sort((a, b) => Number(b.vendor === 'copilot') - Number(a.vendor === 'copilot') || a.name.localeCompare(b.name))
    const windows: Record<string, number> = {}
    for (const model of sorted) if (model.maxInputTokens !== undefined && model.maxInputTokens > 0) windows[model.id] = model.maxInputTokens
    return { ids: [...new Set(sorted.map((model) => model.id))], found: sorted, ...(Object.keys(windows).length > 0 ? { windows } : {}) }
  } catch (error) {
    return { ids: [], warning: error instanceof Error ? error.message : String(error) }
  }
}

/** Test Connection for a Copilot profile: there are no certificates or token here, only "is the model there". */
export async function testHostModels(models: HostLanguageModels | undefined, model: string, signal?: AbortSignal): Promise<TestConnectionResult> {
  const steps: TestConnectionResult['steps'] = [
    { step: 'certificates', status: 'skipped', detail: 'GitHub Copilot is reached through VS Code; there are no certificates to load.' },
  ]
  if (models === undefined) {
    steps.push({ step: 'token', status: 'failed', detail: NO_HOST_MODELS })
    steps.push({ step: 'models', status: 'skipped', detail: 'Not attempted.' })
    return { ok: false, steps }
  }
  steps.push({ step: 'token', status: 'ok', detail: `Signed in through ${models.label}; Light Code never sees the token.` })
  const result = await listHostModels(models, signal)
  if (result.ids.length === 0) {
    steps.push({ step: 'models', status: 'failed', detail: result.warning ?? 'No models.' })
    return { ok: false, steps }
  }
  const named = model.trim().length === 0 || result.ids.includes(model)
  steps.push({
    step: 'models',
    status: named ? 'ok' : 'failed',
    detail: named
      ? `${models.label} offers ${String(result.ids.length)} model(s).`
      : `${models.label} offers ${String(result.ids.length)} model(s), but not "${model}". Pick one from the list.`,
  })
  return { ok: named, steps }
}
