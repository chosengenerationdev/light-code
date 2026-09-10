import { chartSpecSchema } from '../charts/types.js'
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

/*
 * `show_chart` is deliberately NOT in CONTROL_TOOLS.
 *
 * A control tool's *result* is the message to the user; a chart's result is a summary for the
 * model and the picture is built from the call's arguments instead. Adding it here would print
 * that summary as assistant prose and draw nothing.
 */

/** Pretty-prints tool arguments; falls back to the raw string if it isn't JSON. */
export function formatToolArguments(raw: string): string {
  try {
    const parsed = JSON.parse(raw.length > 0 ? raw : '{}') as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      // `why` is lifted out and shown beside the tool name, so leaving it here would print it
      // twice — once as prose and once as an argument the tool never receives.
      const rest = { ...(parsed as Record<string, unknown>) }
      delete rest.why
      return JSON.stringify(rest, null, 2)
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

/** The model's stated reason for a call, if it gave one. Never inferred, never invented. */
export function toolCallReason(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw.length > 0 ? raw : '{}') as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const why = (parsed as Record<string, unknown>).why
    return typeof why === 'string' && why.trim().length > 0 ? why.trim() : undefined
  } catch {
    return undefined
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

      /*
       * A chart is rendered from its own call, so it survives a reload for free.
       *
       * The arguments are the only copy of the data — parsed here rather than trusted, because a
       * restored transcript can contain anything a past model sent, and a chart that renders
       * misaligned data looks correct and is not.
       */
      if (toolCall.name === 'show_chart') {
        /*
         * The arguments arrive as the JSON string a provider sent, not as an object.
         *
         * Parsing them as an object "worked" in the sense that it produced a chartError every
         * time — a chart that never drew, with a message about the wrong thing. Caught by a test
         * built from a realistic message rather than from what the code expected.
         */
        const parsed = chartSpecSchema.safeParse(decodeArguments(toolCall.arguments))
        entries.push(
          parsed.success
            ? { kind: 'chart', chart: parsed.data, ...(expertInformed ? { expertInformed: true } : {}) }
            : {
                kind: 'chartError',
                message: parsed.error.issues.map((issue) => issue.message).join('; '),
              },
        )
        continue
      }

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
          ...(toolCallReason(toolCall.arguments) === undefined
            ? {}
            : { why: toolCallReason(toolCall.arguments) as string }),
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

/** A tool call's arguments as an object. Providers send them as a JSON string. */
function decodeArguments(raw: string): unknown {
  try {
    return JSON.parse(raw.length > 0 ? raw : '{}')
  } catch {
    // Returned as-is so the schema reports "expected object", which is the truth: what arrived
    // was not one, and inventing an empty object here would hide why.
    return raw
  }
}
