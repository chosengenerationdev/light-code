import type { ChatMessage } from '../providers/types.js'

/**
 * Drops superseded file reads — §12's "if a file was read three times, only the latest
 * matters".
 *
 * The saving is large and the risk is subtle, so two rules constrain it:
 *
 * 1. **Only `read_file` results are dropped.** A repeated `execute_command` is not
 *    redundant — running the tests twice produces two genuinely different answers, and the
 *    earlier one may be what the model is reasoning about. Reads are the one case where the
 *    later result strictly replaces the earlier.
 * 2. **The tool message is replaced, never removed.** Every wire format pairs a result to
 *    its call by id; deleting the message would leave an unanswered `tool_use` and the
 *    request would be rejected. The content becomes a short marker instead.
 */
const SUPERSEDED_MARKER =
  '[Superseded: this file was read again later in the conversation. See the most recent read for current contents.]'

/** Extracts the path a `read_file` call targeted, so repeats can be recognised. */
function readFilePath(argumentsJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsJson.length > 0 ? argumentsJson : '{}')
    const path = (parsed as { path?: unknown }).path
    return typeof path === 'string' && path.length > 0 ? path : undefined
  } catch {
    return undefined
  }
}

export interface SupersedeResult {
  messages: ChatMessage[]
  /** How many results were replaced — surfaced in the token breakdown. */
  supersededCount: number
  /** Characters reclaimed, an honest proxy for the tokens saved. */
  charactersSaved: number
}

/**
 * Replaces the content of every `read_file` result except the most recent one per path.
 *
 * Offsets matter: reading lines 1–100 and then 200–300 of the same file are not the same
 * read, and dropping the first would lose content the second never contained. Only calls
 * with identical arguments are treated as superseding each other.
 */
export function dropSupersededReads(messages: readonly ChatMessage[]): SupersedeResult {
  // Map each tool call id to a key identifying "the same read", for read_file calls only.
  const keyByCallId = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const toolCall of message.toolCalls ?? []) {
      if (toolCall.name !== 'read_file') continue
      const path = readFilePath(toolCall.arguments)
      if (path === undefined) continue
      // Keyed on the full arguments, so a ranged read never supersedes a different range.
      keyByCallId.set(toolCall.id, toolCall.arguments)
    }
  }

  // The last result for each key is the one that survives.
  const lastCallIdForKey = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const key = keyByCallId.get(message.toolCallId)
    if (key !== undefined) lastCallIdForKey.set(key, message.toolCallId)
  }

  const survivors = new Set(lastCallIdForKey.values())
  let supersededCount = 0
  let charactersSaved = 0

  const result = messages.map((message) => {
    if (message.role !== 'tool') return message
    const key = keyByCallId.get(message.toolCallId)
    if (key === undefined || survivors.has(message.toolCallId)) return message
    // Already short enough that replacing it would cost more than it saves.
    if (message.content.length <= SUPERSEDED_MARKER.length) return message

    supersededCount += 1
    charactersSaved += message.content.length - SUPERSEDED_MARKER.length
    return { role: 'tool' as const, toolCallId: message.toolCallId, content: SUPERSEDED_MARKER }
  })

  return { messages: result, supersededCount, charactersSaved }
}
