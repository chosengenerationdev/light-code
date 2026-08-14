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
