/**
 * Did the model announce an action and then not take it?
 *
 * The loop ends a turn on a plain-text reply, which is right for an answer and wrong for a
 * preamble. Models — smaller ones especially — quite often emit "I'll create the skill. Let me
 * write something realistic." and stop, having called nothing. Nothing errors: the text is
 * recorded, the turn completes, and the user is left looking at an announcement of work that
 * never happened, with no way to tell whether it failed or was never attempted.
 *
 * So this recognises the announcement and the loop asks the model to go ahead. It is deliberately
 * conservative in both directions:
 *
 * - **A false negative costs nothing** — the turn ends exactly as it does today, which is the
 *   behaviour every release so far has had.
 * - **A false positive costs one request**, and almost always produces `attempt_completion`
 *   immediately, so the user sees the same answer a moment later.
 *
 * That asymmetry is why this is allowed to be a heuristic at all, when §7 refuses fuzzy matching
 * for edits: there, a wrong guess corrupts a file. Here it buys a retry.
 */

/** A preamble is short. A considered answer that happens to begin with "I'll" is not. */
const MAX_PREAMBLE_LENGTH = 400

/**
 * Openings that promise something still to come. Matched against the *last* sentence only —
 * "I'll read the file. Here is what it does: …" opens this way and is finished.
 */
const FORWARD_LOOKING =
  /^(let me\b|let's\b|i'?ll\b|i will\b|i'?m going to\b|going to\b|now i\b|next,? i\b|first,? i\b|starting\b|beginning\b)/i

/**
 * Phrases that open the same way and mean the opposite — the model handing the turn back.
 *
 * Without these, "Let me know if you want anything else." reads as an announcement and earns a
 * pointless extra request on the most common closing line there is.
 */
const HANDING_BACK =
  /^(let me know\b|let us know\b|i'?ll be happy\b|i'?ll wait\b|i'?ll stand by\b|let me know if\b|i'?ll leave\b)/i

/** The last sentence, or the whole thing when there is no terminator. */
function lastSentence(text: string): string {
  const trimmed = text.trim()
  // Split on sentence enders followed by whitespace, so "e.g. foo" does not split awkwardly
  // more often than it has to. Getting this wrong only mis-scores the heuristic.
  const parts = trimmed.split(/(?<=[.!?])\s+/)
  return (parts[parts.length - 1] ?? trimmed).trim()
}

export function looksUnfinished(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_PREAMBLE_LENGTH) return false

  /*
   * A question is the model asking *the user* something. Answering it is their job, not the
   * loop's — and `ask_followup_question` exists precisely so a real question is a tool call.
   */
  if (trimmed.endsWith('?')) return false

  // "Here is the plan:" — a colon promises what follows, and nothing followed.
  if (trimmed.endsWith(':')) return true

  const last = lastSentence(trimmed)
  if (HANDING_BACK.test(last)) return false
  return FORWARD_LOOKING.test(last)
}

/**
 * What the model is told. Phrased as the user speaking, because that is the role it arrives in,
 * and it offers both exits explicitly — act, or declare yourself done — so a model that really
 * had finished is not pushed into inventing work.
 */
export const CONTINUE_PROMPT =
  'You described what you were about to do but did not call a tool, so nothing happened. ' +
  'If you meant to act, call the tool now. If you were already finished, call attempt_completion ' +
  'with a summary instead.'

/**
 * One nudge per turn.
 *
 * A model that ignores the nudge and narrates again is not going to be talked round by a second
 * one; it would just spend another request to reach the same place. One recovers the common
 * case — a dropped tool call — without turning a chatty model into a loop.
 */
export const MAX_CONTINUE_NUDGES = 1
