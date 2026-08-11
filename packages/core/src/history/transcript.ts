import type { TranscriptEntry } from '../agent/protocol.js'
import type { ChatMessage } from '../providers/types.js'

/**
 * Tools whose "result" is the model addressing the user rather than work performed. They
 * render as ordinary assistant text, not as collapsed tool blocks — burying the actual
 * answer behind a disclosure triangle was a real usability bug in Phase 3.
 *
 * Lives here rather than in the host so the live transcript and a restored one agree; two
 * copies of this set would eventually disagree about how a task looked.
 */
export const CONTROL_TOOLS: ReadonlySet<string> = new Set(['attempt_completion', 'ask_followup_question'])

/** Pretty-prints tool arguments; falls back to the raw string if it isn't JSON. */
export function formatToolArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw.length > 0 ? raw : '{}'), null, 2)
  } catch {
    return raw
  }
}

/**
 * Rebuilds what the UI shows from the stored model-facing messages.
 *
 * There is deliberately no second stored representation: the display is a pure function of
 * the conversation, so a reopened task cannot disagree with what the model actually saw.
 *
 * One honest difference from the live view: oversized tool results were capped before
 * entering the conversation, so a restored transcript shows the capped text plus its
 * re-read handle rather than the full output. That is the §12 design — history references
 * the spilled result instead of duplicating it.
 */
export function toTranscript(messages: readonly ChatMessage[]): TranscriptEntry[] {
  const resultsByCallId = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'tool') resultsByCallId.set(message.toolCallId, message.content)
  }

  const entries: TranscriptEntry[] = []
  // Sticky for the rest of the task: everything after a consultation was decided with its
  // advice in context, so the mark reflects influence rather than adjacency.
  let expertInformed = false
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'tool') continue

    if (message.role === 'user') {
      entries.push({ kind: 'text', role: 'user', content: message.content })
      continue
    }

    if (message.content.length > 0) {
      entries.push({ kind: 'text', role: 'assistant', content: message.content, ...(expertInformed ? { expertInformed } : {}) })
    }

    for (const toolCall of message.toolCalls ?? []) {
      const result = resultsByCallId.get(toolCall.id)

      if (CONTROL_TOOLS.has(toolCall.name)) {
        // The control tool's result *is* the message to the user.
        if (result !== undefined) entries.push({ kind: 'text', role: 'assistant', content: result })
        continue
      }

      if (toolCall.name === 'ask_expert') expertInformed = true
      entries.push({
        kind: 'tool',
        ...(expertInformed ? { expertInformed: true } : {}),
        toolCall: {
          id: toolCall.id,
          name: toolCall.name,
          arguments: formatToolArguments(toolCall.arguments),
          // A call with no matching result means the task ended mid-flight — a cancel, a
          // crash, or a window closed. Leaving `result` unset renders it as unfinished,
          // which is what actually happened.
          ...(result !== undefined ? { result } : {}),
        },
      })
    }
  }
  return entries
}
