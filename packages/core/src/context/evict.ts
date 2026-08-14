import type { ChatMessage } from '../providers/types.js'

/**
 * Drops documentation the model has finished with.
 *
 * A `search_docs` result carries a full JSON Schema — the most verbose thing in the
 * conversation and the shortest-lived. Once the model has read the parameters and made the
 * call, the schema is dead weight that every subsequent request pays for. This is the release
 * valve: the model calls `forget_docs` and everything it looked up before that point collapses
 * to a one-line marker.
 *
 * ## Derived from the transcript, never from side state
 *
 * `forget_docs` does not *do* anything when it executes — it records an intent, and this
 * function reads that intent back out of the history. Exactly the approach
 * `context/supersede.ts` takes, and for the same reasons: there is no separate set to keep in
 * sync, the result is idempotent however many times it runs, and a resumed task evicts
 * identically because the marker is in the messages rather than in memory that died with the
 * session.
 *
 * ## Two rules, both load-bearing
 *
 * 1. **The tool message is replaced, never removed.** Every wire format pairs a result to its
 *    call by id, so deleting one leaves an unanswered `tool_use` and the request is rejected.
 * 2. **Only results *before* the `forget_docs` call are dropped.** Anything looked up
 *    afterwards is current, and evicting it would delete a schema the model is about to use —
 *    turning a saving into a failed tool call.
 *
 * This does invalidate the prompt cache from the first evicted message onward. That cost is
 * real but bounded and mid-conversation, which is the same trade `dropSupersededReads` already
 * makes; §12 rules out varying the *prefix*, not the body.
 */

export const EVICTED_MARKER =
  '[Dropped: you called forget_docs after reading this. Search again with search_docs if you need it.]'

/** Tools whose results `forget_docs` releases. Documentation only — never a file read or command output. */
const EVICTABLE_TOOLS = new Set(['search_docs'])

export const FORGET_DOCS_TOOL = 'forget_docs'

export interface EvictionResult {
  messages: ChatMessage[]
  /** How many results were released, for the token breakdown. */
  evictedCount: number
  /** Characters reclaimed — an honest proxy for tokens saved. */
  charactersSaved: number
}

export function dropEvictedDocs(messages: readonly ChatMessage[]): EvictionResult {
  /*
   * Index of the last `forget_docs` request. Everything evictable answered before it goes.
   *
   * The *last* one rather than the first: a second call means the model has finished with a
   * further batch, and honouring only the earliest would leave those in place forever.
   */
  let cutoff = -1
  const evictableCallIds = new Set<string>()

  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return
    for (const toolCall of message.toolCalls ?? []) {
      if (toolCall.name === FORGET_DOCS_TOOL) cutoff = index
      else if (EVICTABLE_TOOLS.has(toolCall.name)) evictableCallIds.add(toolCall.id)
    }
  })

  if (cutoff < 0 || evictableCallIds.size === 0) {
    return { messages: [...messages], evictedCount: 0, charactersSaved: 0 }
  }

  let evictedCount = 0
  let charactersSaved = 0

  const result = messages.map((message, index) => {
    if (message.role !== 'tool' || index > cutoff) return message
    if (!evictableCallIds.has(message.toolCallId)) return message
    // Already shorter than the marker, so replacing it would cost more than it saves.
    if (message.content.length <= EVICTED_MARKER.length) return message

    evictedCount += 1
    charactersSaved += message.content.length - EVICTED_MARKER.length
    return { role: 'tool' as const, toolCallId: message.toolCallId, content: EVICTED_MARKER }
  })

  return { messages: result, evictedCount, charactersSaved }
}
