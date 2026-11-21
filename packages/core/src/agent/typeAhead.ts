import type { ChatMessage } from '../providers/types.js'

/**
 * Suggestions while typing in the chat box, from the chat's own model - asked for: "as the user types suggestions can
 * appear in grey, when user hits tab, suggestion can be used". Off unless `composerCompletion` is on: every pause in
 * typing is a request to the gateway.
 *
 * The model is asked for the rest of what the user is writing, never an answer to it. What comes back is cut to one
 * line and a short length here, so a model that answers instead of continuing offers a little text, not a reply.
 */

/** No suggestion for less typed than this: three letters predict nothing worth a request. */
export const TYPE_AHEAD_MIN_CHARS = 6
/** The longest suggestion offered; a long one is mostly wrong and hard to read in grey. */
export const TYPE_AHEAD_MAX_CHARS = 120
/** How much of the recent conversation goes with the request, so "fix the" can become "fix the failing test". */
const CONTEXT_MESSAGES = 4
const CONTEXT_CHARS_EACH = 600

export function typeAheadMessages(typed: string, recent: readonly ChatMessage[]): ChatMessage[] {
  const context = recent
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, text: typeof message.content === 'string' ? message.content.trim() : '' }))
    .filter((message) => message.text.length > 0)
    .slice(-CONTEXT_MESSAGES)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.length > CONTEXT_CHARS_EACH ? `${message.text.slice(0, CONTEXT_CHARS_EACH)}…` : message.text}`)
  return [
    {
      role: 'system',
      content:
        'You complete the message a user is typing to a coding assistant. Reply with ONLY the words that come next - ' +
        'a few words up to the end of the sentence - continuing exactly where the text stops (start with a space when a ' +
        'new word starts). Never answer the message, never repeat what is already typed, no quotes, no explanation. ' +
        'If nothing likely comes next, reply with nothing.',
    },
    {
      role: 'user',
      content: `${context.length > 0 ? `The conversation so far:\n${context.join('\n')}\n\n` : ''}The user has typed:\n<<<${typed}>>>\nWhat comes next?`,
    },
  ]
}

/**
 * The model's reply made fit to show after `typed`: the typed text taken off if it was repeated, wrappers removed, one
 * line, at most `TYPE_AHEAD_MAX_CHARS`, ending on a whole word. Empty when nothing usable is left.
 */
export function cleanSuggestion(typed: string, reply: string): string {
  let text = reply.replace(/\r/g, '')
  text = text.replace(/^\s*(<<<|>>>)/, '').replace(/(<<<|>>>)\s*$/, '')
  // Some models echo the whole message, or its last words, before continuing.
  if (typed.length > 0 && text.startsWith(typed)) text = text.slice(typed.length)
  else {
    const tail = typed.slice(-40)
    for (let size = Math.min(tail.length, text.length); size >= 8; size--) {
      if (text.startsWith(tail.slice(-size))) {
        text = text.slice(size)
        break
      }
    }
  }
  const wrapped = /^\s*["'`](.*)["'`]\s*$/s.exec(text)
  if (wrapped !== null && !/["'`]/.test(typed.slice(-1))) text = wrapped[1] ?? ''
  const line = text.split('\n')[0] ?? ''
  if (line.trim().length === 0) return ''
  // A space between the typed word and the next is the model's to give; never two.
  let out = /\s$/.test(typed) ? line.replace(/^\s+/, '') : line
  if (/^\s+$/.test(out)) return ''
  if (out.length > TYPE_AHEAD_MAX_CHARS) {
    const cut = out.slice(0, TYPE_AHEAD_MAX_CHARS)
    const space = cut.lastIndexOf(' ')
    out = space > 20 ? cut.slice(0, space) : cut
  }
  return out.trimEnd()
}

/**
 * How much of a suggestion Tab takes - asked for: "tab for accepting one word from suggestion, ctrl + space to accept
 * full sentence suggestion". The leading space (if any), the next word, and the punctuation stuck to it.
 */
export function nextWord(suggestion: string): string {
  const match = /^\s*\S+/.exec(suggestion)
  return match === null ? suggestion : match[0]
}
