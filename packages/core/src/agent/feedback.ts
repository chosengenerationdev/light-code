/**
 * Replies and reactions: how a person points at something the assistant said.
 *
 * Both become **text in the user's next turn**, and that is the whole design. A model has no
 * channel for "the user tapped thumbs-down on paragraph three" other than words in the
 * conversation, so anything subtler would be a UI that looks like feedback and reaches nothing.
 * Folding it into the user message also means the transcript records it: a restored task shows
 * what was pointed at, exactly as the model saw it.
 *
 * One function writes it, used by the host for the model and by the panel for the live bubble, so
 * the two cannot drift — the defect shape this project keeps paying for.
 *
 * **Reacting to a thought process steers; it does not edit.** Reasoning that already happened
 * cannot be changed, and most providers do not even show a model its previous reasoning on the
 * next turn. What works is quoting the line back as a user remark — "this part was wrong" — which
 * the model reads like any other instruction. Delivered mid-turn, it lands at the next step, which
 * is the earliest any input can.
 */

export type Reaction = 'up' | 'down' | 'focus'

export interface MessageQuote {
  /** What was pointed at: a selection inside the message, or the message itself. */
  excerpt: string
  /** A reply or a thought process. The model is told which, because they mean different things. */
  source: 'message' | 'reasoning'
}

export interface MessageReaction {
  reaction: Reaction
  quote: MessageQuote
}

/** Long enough for a paragraph, short enough that a quoted essay cannot swamp the turn. */
export const MAX_QUOTE_CHARS = 1200
/** A reaction names its target; it does not repeat it. */
const MAX_REACTION_QUOTE_CHARS = 280

const REACTION_LABELS: Record<Reaction, string> = {
  up: '👍 Right direction, keep this',
  down: '👎 Wrong, do not pursue this',
  focus: '🎯 Focus on this',
}

export function reactionLabel(reaction: Reaction): string {
  return REACTION_LABELS[reaction]
}

/**
 * Trims to a limit on a word boundary where one is near, and says it was cut.
 *
 * Idempotent — the result, ellipsis included, never exceeds `limit` — because the panel clips
 * what it sends and the host clips again; two different cuts would make the live bubble and the
 * saved transcript disagree.
 */
export function clipQuote(text: string, limit = MAX_QUOTE_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  const cut = trimmed.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function sourceNote(quote: MessageQuote): string {
  return quote.source === 'reasoning' ? ' (from your thought process)' : ''
}

/** A block quote, so a multi-line excerpt stays visibly one thing. */
function blockQuote(text: string): string {
  return clipQuote(text)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n')
}

function describeReply(quote: MessageQuote): string {
  const where = quote.source === 'reasoning' ? 'this part of your thought process' : 'this part of your earlier reply'
  return `[Replying to ${where}]\n${blockQuote(quote.excerpt)}`
}

function describeReactions(reactions: readonly MessageReaction[]): string {
  const lines = reactions.map((item) => {
    const excerpt = clipQuote(item.quote.excerpt, MAX_REACTION_QUOTE_CHARS).replace(/\s+/g, ' ')
    return `- ${REACTION_LABELS[item.reaction]}: "${excerpt}"${sourceNote(item.quote)}`
  })
  return `[My reactions to what you wrote — weigh them in what you do next]\n${lines.join('\n')}`
}

/**
 * The user's turn as the model receives it: reactions first (context), then the reply quote,
 * then what they typed. Any part may be absent; with neither a quote nor reactions the text is
 * returned unchanged, so an ordinary message is byte-for-byte what it always was.
 */
export function composeUserText(
  text: string,
  extras: { replyTo?: MessageQuote | undefined; reactions?: readonly MessageReaction[] | undefined } = {},
): string {
  const parts: string[] = []
  if (extras.reactions !== undefined && extras.reactions.length > 0) parts.push(describeReactions(extras.reactions))
  if (extras.replyTo !== undefined && extras.replyTo.excerpt.trim().length > 0) parts.push(describeReply(extras.replyTo))
  if (parts.length === 0) return text
  if (text.trim().length > 0) parts.push(text)
  return parts.join('\n\n')
}
