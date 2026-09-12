import type { ChatMessage } from '../providers/types.js'

/**
 * Answering a tool call that never got an answer.
 *
 * ## The reported failure
 *
 * A chat that had worked began refusing every message with an HTTP 400 from the provider:
 * *"An assistant message with 'tool_calls' must be followed by tool messages responding to each
 * 'tool_call_id'."* Not intermittent — **permanent**. Every later message in that conversation
 * failed the same way, because the broken pair was in the stored history and went out with every
 * request from then on. Starting a new chat was the only escape, and nothing said so.
 *
 * ## How the pair gets broken
 *
 * `runAgentTurn` adds the assistant message *before* running the tool, which it must: the call has
 * to be in the record even if what follows goes wrong. The result is added after. Anything that
 * escapes between the two — a tool throwing rather than returning an error result, a cancellation,
 * a crash in the truncation store — leaves the call with nothing answering it. The turn ends with
 * a visible error, the task is saved in its `finally`, and the damage is now on disk.
 *
 * Every provider rejects this, and each says so differently, so the symptom arrives as a wall of
 * vendor JSON rather than as anything a user could act on.
 *
 * ## Why repair rather than only prevent
 *
 * The loop no longer leaves one behind — a throwing tool becomes an error result. But that does
 * nothing for the conversations already saved, and those are exactly the ones people are in the
 * middle of. This runs on the way out to the provider, so an old task heals the moment it is
 * reopened.
 *
 * It is deliberately a **repair, not a deletion**. Removing the assistant message would lose the
 * record of what was attempted, and the model would see a turn where it had asked for nothing. A
 * synthetic result says what actually happened, which is also the honest thing to tell it: the
 * tool did not report back.
 */
const UNANSWERED =
  'This tool call never reported a result — the turn ended before it did. ' +
  'Nothing can be assumed about whether it ran or what it changed. ' +
  'If it still matters, call it again; otherwise carry on.'

export function repairUnansweredToolCalls(messages: readonly ChatMessage[]): ChatMessage[] {
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId !== undefined) answered.add(message.toolCallId)
  }

  const repaired: ChatMessage[] = []
  for (const message of messages) {
    repaired.push(message)
    if (message.role !== 'assistant' || message.toolCalls === undefined) continue

    for (const call of message.toolCalls) {
      if (answered.has(call.id)) continue
      /*
       * Inserted immediately after the call, not appended at the end.
       *
       * Providers require the result to *follow* its call, and several require it to follow
       * immediately — a repair that put them all at the end of the conversation would satisfy the
       * counting rule and still be rejected for ordering.
       */
      repaired.push({ role: 'tool', toolCallId: call.id, content: UNANSWERED })
      // Marked so a duplicated id in a malformed history is answered once rather than twice,
      // which would be the same error over again from the other direction.
      answered.add(call.id)
    }
  }

  return repaired
}

/** Whether anything would change, so a caller can log a repair without diffing the arrays. */
export function countUnansweredToolCalls(messages: readonly ChatMessage[]): number {
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId !== undefined) answered.add(message.toolCallId)
  }

  let missing = 0
  for (const message of messages) {
    if (message.role !== 'assistant' || message.toolCalls === undefined) continue
    for (const call of message.toolCalls) if (!answered.has(call.id)) missing += 1
  }
  return missing
}
