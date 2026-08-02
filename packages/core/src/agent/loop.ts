import type { ChatProvider, ChatStreamOptions, ToolCall } from '../providers/types.js'
import type { ToolExecutionContext, ToolRegistry, ToolResult } from '../tools/index.js'
import type { Conversation } from './messages.js'
import { truncateToolResult, type TruncationStore } from './truncate.js'

export interface AgentTurnEvents {
  onTextChunk(text: string): void
  onToolCall(toolCall: ToolCall): void
  onToolResult(toolCall: ToolCall, result: ToolResult): void
  onDone(): void
  onError(message: string): void
}

export interface RunAgentTurnOptions {
  signal?: AbortSignal
  /** Default 25 — configurable per CLAUDE.md §5. */
  maxIterations?: number
  /** When provided, oversized tool results are capped and stored for re-reading (§12). */
  truncationStore?: TruncationStore
}

const DEFAULT_MAX_ITERATIONS = 25
const MAX_CONSECUTIVE_MISTAKES = 3

async function executeToolCall(
  toolCall: ToolCall,
  registry: ToolRegistry,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  const tool = registry.get(toolCall.name)
  if (tool === undefined) {
    return { content: `Unknown tool "${toolCall.name}".`, isError: true }
  }

  let params: unknown
  try {
    params = JSON.parse(toolCall.arguments.length > 0 ? toolCall.arguments : '{}')
  } catch (error) {
    return {
      content: `Tool "${toolCall.name}" received malformed JSON arguments: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    }
  }

  const parsed = tool.parametersSchema.safeParse(params)
  if (!parsed.success) {
    return {
      content: `Invalid arguments for "${toolCall.name}": ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      isError: true,
    }
  }

  return tool.execute(parsed.data, context)
}

/**
 * Multi-step: send the user message, stream the response, execute at most one tool
 * call per assistant message, feed the result back, and repeat until the model calls
 * `attempt_completion`/`ask_followup_question`, answers in plain text, hits the
 * iteration cap, or fails consecutively on the same file. See CLAUDE.md §5.
 */
export async function runAgentTurn(
  provider: ChatProvider,
  conversation: Conversation,
  userMessage: string,
  toolRegistry: ToolRegistry,
  toolContext: ToolExecutionContext,
  events: AgentTurnEvents,
  options: RunAgentTurnOptions = {},
): Promise<void> {
  conversation.addUserMessage(userMessage)

  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const mistakeCounts = new Map<string, number>()
  const tools = toolRegistry.toToolDefinitions()

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const streamOptions: ChatStreamOptions = { tools }
    if (options.signal !== undefined) streamOptions.signal = options.signal

    let assistantText = ''
    let toolCall: ToolCall | undefined
    let streamError: string | undefined

    for await (const chunk of provider.streamChat(conversation.toArray(), streamOptions)) {
      if (chunk.type === 'text') {
        assistantText += chunk.text
        events.onTextChunk(chunk.text)
      } else if (chunk.type === 'toolCall') {
        // "One tool call per assistant message" (CLAUDE.md §5) — ignore extras defensively.
        if (toolCall === undefined) toolCall = chunk.toolCall
      } else if (chunk.type === 'error') {
        streamError = chunk.error
      } else if (chunk.type === 'done') {
        break
      }
    }

    if (streamError !== undefined) {
      // A late error must not discard text the model already sent this turn.
      if (assistantText.length > 0) conversation.addAssistantMessage(assistantText)
      events.onError(streamError)
      return
    }

    if (toolCall === undefined) {
      if (assistantText.length > 0) {
        conversation.addAssistantMessage(assistantText)
        events.onDone()
      } else {
        events.onError(
          'The provider finished without returning any text. Check the base URL and model name, and that the endpoint supports streaming chat completions.',
        )
      }
      return
    }

    conversation.addAssistantMessage(assistantText, [toolCall])
    events.onToolCall(toolCall)

    const result = await executeToolCall(toolCall, toolRegistry, toolContext)
    // The conversation gets the capped text; the UI event carries the full result so the
    // user still sees everything that actually happened.
    const forModel =
      options.truncationStore !== undefined
        ? (await truncateToolResult(result.content, options.truncationStore)).content
        : result.content
    conversation.addToolResultMessage(toolCall.id, forModel)
    events.onToolResult(toolCall, result)

    if (toolCall.name === 'attempt_completion' || toolCall.name === 'ask_followup_question') {
      events.onDone()
      return
    }

    if (result.path !== undefined) {
      if (result.isError === true) {
        const count = (mistakeCounts.get(result.path) ?? 0) + 1
        mistakeCounts.set(result.path, count)
        if (count >= MAX_CONSECUTIVE_MISTAKES) {
          events.onError(`Stopped after ${count} consecutive failed attempts on "${result.path}".`)
          return
        }
      } else {
        mistakeCounts.set(result.path, 0)
      }
    }
  }

  events.onError(`Stopped after reaching the maximum of ${maxIterations} steps.`)
}
