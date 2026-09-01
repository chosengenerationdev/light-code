/**
 * The pure half of `@` file mentions, shared by the composer and the schedule editor.
 *
 * Extracted rather than duplicated: the caret arithmetic is small but exacting, and a second
 * copy would drift the first time one of them was fixed. The *rendering* of the candidate list
 * stays with each component, because the composer's sits above a growing textarea and the
 * schedule editor's sits inside a scrolling form.
 *
 * Nothing here touches the DOM, so it is straightforwardly testable — which matters, because
 * "the caret ended up in the wrong place" is invisible until someone types into it.
 */

/**
 * The mention being typed at the caret, or undefined when none is.
 *
 * A space closes a mention, and so does a second `@` — otherwise typing an email address or a
 * decorator would open a file picker and stay open for the rest of the line.
 */
export function activeMentionQuery(text: string, caret: number): string | undefined {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return undefined
  const token = before.slice(at + 1)
  if (/[\s@]/.test(token)) return undefined
  return token
}

/** Paths containing spaces are quoted, so the resolver reads them as a single target. */
export function renderMention(candidatePath: string): string {
  return candidatePath.includes(' ') ? `@"${candidatePath}"` : `@${candidatePath}`
}

export interface MentionInsertion {
  text: string
  /** Where the caret belongs afterwards — past the mention and the space following it. */
  caret: number
}

/**
 * Replaces the partial mention at the caret with a full one.
 *
 * Returns the new caret rather than leaving the component to guess: putting it at the end of
 * the text is the obvious shortcut and is wrong the moment someone inserts a mention into the
 * middle of a sentence they have already written.
 */
export function insertMention(text: string, caret: number, candidatePath: string): MentionInsertion | undefined {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return undefined

  const rendered = renderMention(candidatePath)
  return {
    text: `${text.slice(0, at)}${rendered} ${text.slice(caret)}`,
    caret: at + rendered.length + 1,
  }
}

/**
 * Splits composer text into plain runs and `@` mentions, for highlighting.
 *
 * ## Why the composer needs this at all
 *
 * A long prompt with five attached files gives no sign of which files they were: the mentions
 * are the same colour as the sentence around them, so the one thing in the message that is not
 * prose reads as prose. Colouring them makes the attachments countable at a glance, which is
 * what someone about to press send actually wants to check.
 *
 * ## Matching the same shapes the composer writes
 *
 * `renderMention` quotes a path containing spaces, so both `@src/api.ts` and `@"my docs/a.md"`
 * are single tokens and both are matched here. An `@` followed by nothing — mid-typing, before
 * any path — is deliberately *not* a mention: highlighting a bare `@` the moment it is typed
 * flickers on every message that merely contains one.
 */
export interface MentionSegment {
  text: string
  isMention: boolean
}

const MENTION_PATTERN = /@(?:"[^"\n]+"|[^\s@"]+)/g

export function splitMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = []
  let index = 0

  // `matchAll` rather than a manual scan: the pattern is the single description of what a
  // mention looks like, and a second hand-written scanner would be a second one to keep true.
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const start = match.index
    if (start > index) segments.push({ text: text.slice(index, start), isMention: false })
    segments.push({ text: match[0], isMention: true })
    index = start + match[0].length
  }
  if (index < text.length) segments.push({ text: text.slice(index), isMention: false })
  return segments
}
