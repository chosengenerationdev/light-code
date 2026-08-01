import type { ChatProvider, ChatStreamOptions } from '../providers/types.js'
import type { Conversation } from './messages.js'

export interface AgentTurnEvents {
  onTextChunk(text: string): void
  onDone(): void
  onError(message: string): void
}

/**
 * Minimal turn: send the user message, stream the response, render it. No tools yet —
 * see CLAUDE.md §5/§6 and IMPLEMENTATION_PLAN.md Phase 3 for where those land.
 */
export async function runAgentTurn(
  provider: ChatProvider,
  conversation: Conversation,
  userMessage: string,
  events: AgentTurnEvents,
  options: ChatStreamOptions = {},
): Promise<void> {
  conversation.addUserMessage(userMessage)

  let assistantText = ''
  for await (const chunk of provider.streamChat(conversation.toArray(), options)) {
    if (chunk.type === 'text') {
      assistantText += chunk.text
      events.onTextChunk(chunk.text)
    } else if (chunk.type === 'error') {
      // A late error (e.g. a connection drop right at the end of a long response)
      // must not discard text the model already sent — the next turn should still
      // see it, same as a clean completion would have recorded it.
      if (assistantText.length > 0) {
        conversation.addAssistantMessage(assistantText)
      }
      events.onError(chunk.error)
      return
    } else if (chunk.type === 'done') {
      break
    }
  }

  if (assistantText.length > 0) {
    conversation.addAssistantMessage(assistantText)
    events.onDone()
  } else {
    // A turn that ends with no text and no explicit error would otherwise look like
    // nothing happened at all — silence is never an acceptable outcome (CLAUDE.md
    // §17: "errors are for humans"). Surface it instead of a quiet no-op.
    events.onError(
      'The provider finished without returning any text. Check the base URL and model name, and that the endpoint supports streaming chat completions.',
    )
  }
}
