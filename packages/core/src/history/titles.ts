import type { ChatMessage } from '../providers/types.js'

const MAX_TITLE_LENGTH = 60
const FALLBACK_TITLE = 'Untitled task'

/**
 * A title derived from the first user message. Deliberately not model-generated: that
 * would cost a request per task, and the first thing the user typed is both free and
 * usually a better description of what they wanted than a summary of what happened.
 */
export function deriveTitle(messages: readonly ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user')
  if (firstUserMessage === undefined) return FALLBACK_TITLE

  // Collapse whitespace so a pasted multi-line prompt still yields one readable line.
  const collapsed = firstUserMessage.content.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return FALLBACK_TITLE
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed

  // Prefer a word boundary, but only when one is close enough to the limit that cutting
  // there doesn't throw away most of the title.
  const clipped = collapsed.slice(0, MAX_TITLE_LENGTH)
  const lastSpace = clipped.lastIndexOf(' ')
  const cut = lastSpace > MAX_TITLE_LENGTH * 0.6 ? clipped.slice(0, lastSpace) : clipped
  return `${cut.trimEnd()}…`
}
