import * as vscode from 'vscode'
import {
  toPortableParameters,
  type ChatMessage,
  type HostLanguageModels,
  type HostModelInfo,
  type HostModelRequest,
  type StreamChunk,
} from '@light-code/core'

/**
 * GitHub Copilot - and any other model an extension contributes - through VS Code's Language Model API.
 *
 * `@types/vscode` is pinned to the extension's 1.84 floor, which predates the API, so the few shapes used
 * are declared here and found at run time. The floor is deliberately not raised for one provider (§19):
 * an older VS Code simply does not offer the Copilot preset. Tool calling, which the agent cannot work
 * without, arrived after the API itself, so both are required.
 */

interface LmChatModel {
  readonly id: string
  readonly name: string
  readonly vendor: string
  readonly family: string
  readonly maxInputTokens: number
  sendRequest(
    messages: unknown[],
    options?: { justification?: string; tools?: { name: string; description: string; inputSchema?: object }[] },
    token?: vscode.CancellationToken,
  ): Thenable<{ stream: AsyncIterable<unknown> }>
}

interface LmApi {
  selectChatModels(selector?: { vendor?: string; id?: string }): Thenable<LmChatModel[]>
}

type PartConstructor = new (...args: never[]) => object

export interface LmTypes {
  lm: LmApi
  LanguageModelChatMessage: new (role: number, content: unknown[]) => object
  LanguageModelChatMessageRole: { User: number; Assistant: number }
  LanguageModelTextPart: new (value: string) => object
  LanguageModelToolCallPart: new (callId: string, name: string, input: object) => object
  LanguageModelToolResultPart: new (callId: string, content: unknown[]) => object
  /** Images, in newer releases only. */
  LanguageModelDataPart?: { image(data: Uint8Array, mimeType: string): object }
  LanguageModelError?: PartConstructor
}

/** What this VS Code offers, or undefined when it is too old for an agent to use Copilot. */
function lmTypes(): LmTypes | undefined {
  const api = vscode as unknown as Partial<LmTypes>
  if (
    api.lm === undefined ||
    api.LanguageModelChatMessage === undefined ||
    api.LanguageModelChatMessageRole === undefined ||
    api.LanguageModelTextPart === undefined ||
    api.LanguageModelToolCallPart === undefined ||
    api.LanguageModelToolResultPart === undefined
  ) {
    return undefined
  }
  return api as LmTypes
}

/**
 * Our messages as VS Code's. There is no system role, so the system prompt is the first user message,
 * byte-identical every turn (§12's cache rule still applies to whatever is behind Copilot). Neighbouring
 * messages of one role are merged: a tool result is a user message, and so is the text that follows it.
 */
export function toLmMessages(messages: readonly ChatMessage[], lm: LmTypes): object[] {
  const turns: { role: 'user' | 'assistant'; parts: object[] }[] = []
  const add = (role: 'user' | 'assistant', parts: object[]): void => {
    if (parts.length === 0) return
    const last = turns.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else turns.push({ role, parts })
  }
  for (const message of messages) {
    if (message.role === 'system') {
      add('user', [new lm.LanguageModelTextPart(message.content)])
    } else if (message.role === 'user') {
      const parts: object[] = []
      if (message.content.length > 0) parts.push(new lm.LanguageModelTextPart(message.content))
      for (const image of message.images ?? []) {
        parts.push(
          lm.LanguageModelDataPart !== undefined
            ? lm.LanguageModelDataPart.image(Buffer.from(image.data, 'base64'), image.mediaType)
            : new lm.LanguageModelTextPart('[An image was attached, but this VS Code cannot pass images to the model. Updating VS Code fixes that.]'),
        )
      }
      add('user', parts)
    } else if (message.role === 'assistant') {
      const parts: object[] = []
      if (message.content.length > 0) parts.push(new lm.LanguageModelTextPart(message.content))
      for (const call of message.toolCalls ?? []) {
        let input: object = {}
        try {
          const parsed: unknown = JSON.parse(call.arguments)
          if (parsed !== null && typeof parsed === 'object') input = parsed
        } catch {
          // A call whose arguments did not parse was already answered with an error; the call stays.
        }
        parts.push(new lm.LanguageModelToolCallPart(call.id, call.name, input))
      }
      add('assistant', parts)
    } else {
      add('user', [new lm.LanguageModelToolResultPart(message.toolCallId, [new lm.LanguageModelTextPart(message.content)])])
    }
  }
  return turns.map(
    (turn) =>
      new lm.LanguageModelChatMessage(
        turn.role === 'user' ? lm.LanguageModelChatMessageRole.User : lm.LanguageModelChatMessageRole.Assistant,
        turn.parts,
      ),
  )
}

/** VS Code's errors in words that say what to do. Its codes: NoPermissions, Blocked, NotFound. */
function describeLmError(error: unknown): Error {
  const code = (error as { code?: unknown }).code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'NoPermissions') {
    return new Error(
      'Light Code may not use GitHub Copilot: the permission was refused in VS Code. To allow it, run "Manage Language Model Access" from the Accounts menu in VS Code, or send again and choose Allow.',
    )
  }
  if (code === 'Blocked') return new Error(`GitHub Copilot refused the request (a quota or rate limit): ${message}`)
  if (code === 'NotFound') return new Error(`VS Code no longer offers that model: ${message}. Pick another in the provider's model list.`)
  return new Error(`GitHub Copilot through VS Code: ${message}`)
}

let shared: HostLanguageModels | undefined | null = null

/** One per window: the bridge and the relay share it. Undefined where VS Code is too old. */
export function vscodeLanguageModels(): HostLanguageModels | undefined {
  if (shared === null) shared = createVSCodeLanguageModels()
  return shared
}

export function createVSCodeLanguageModels(): HostLanguageModels | undefined {
  const lm = lmTypes()
  if (lm === undefined) return undefined

  async function find(id: string): Promise<LmChatModel> {
    const [model] = await lm!.lm.selectChatModels({ id })
    if (model === undefined) {
      throw new Error(`VS Code offers no model "${id}". Sign in to GitHub Copilot in VS Code, or pick another model in the provider's list.`)
    }
    return model
  }

  return {
    label: 'VS Code',
    async listModels() {
      const models = await lm.lm.selectChatModels()
      return models.map(
        (model): HostModelInfo => ({
          id: model.id,
          name: model.name,
          vendor: model.vendor,
          family: model.family,
          ...(model.maxInputTokens > 0 ? { maxInputTokens: model.maxInputTokens } : {}),
        }),
      )
    },
    async *chat(request: HostModelRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
      const model = await find(request.model)
      const cancel = new vscode.CancellationTokenSource()
      const onAbort = (): void => cancel.cancel()
      signal?.addEventListener('abort', onAbort)
      try {
        let response: { stream: AsyncIterable<unknown> }
        try {
          response = await model.sendRequest(
            toLmMessages(request.messages, lm),
            {
              justification: 'Light Code uses the model you chose for its chat and its agent.',
              ...(request.tools !== undefined
                ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: toPortableParameters(tool.parameters) })) }
                : {}),
            },
            cancel.token,
          )
        } catch (error) {
          throw describeLmError(error)
        }
        try {
          for await (const part of response.stream) {
            if (part instanceof lm.LanguageModelTextPart) {
              yield { type: 'text', text: (part as { value: string }).value }
            } else if (part instanceof lm.LanguageModelToolCallPart) {
              const call = part as { callId: string; name: string; input: object }
              yield { type: 'toolCall', toolCall: { id: call.callId, name: call.name, arguments: JSON.stringify(call.input ?? {}) } }
            }
            // Anything else (thinking parts, newer kinds) is not part of the answer.
          }
        } catch (error) {
          if (signal?.aborted === true) return
          throw describeLmError(error)
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        cancel.dispose()
      }
    },
  }
}
