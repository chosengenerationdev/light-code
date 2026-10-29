import type { ChatMessage } from '../providers/types.js'

/**
 * An agent explaining one alerted row on a monitor's grid (asked for: "bring in agent there, which can
 * explain the alert to user and suggest workaround or solution ... solution or workaround can be asked to
 * the user who adds that check", and "agent should be able to check the history of alert to see if it is
 * a repeating one or a new issue").
 *
 * Fire Code gathers the facts - the monitor, the author's advice for each rule that fired, the row, and
 * each alert's history worked out from the stored checks (new, ongoing for days, recurring at a time) -
 * and the background executor asks the model of the codebase monitoring uses, once. The model is told to
 * put the author's advice first and not to invent a fix where the author gave one.
 */

export const EXPLAIN_SYSTEM = [
  'You explain a monitoring alert to the person responsible for it, in Fire Code.',
  'You get the monitor, the author\'s advice for the rules that fired, the row the alert fired on, and each',
  'alert\'s history worked out from past checks. Write Markdown, at most about 200 words:',
  '1. **What is wrong** - one or two sentences, in plain words, naming the thing (job, host, feed).',
  '2. **New or known** - from the history: new today, ongoing since when, or recurring (how often, at what',
  '   time). Say it exactly as the history shows; never guess a pattern it does not show.',
  '3. **What to do** - the author\'s advice first, as given. Then, only if it helps, up to three concrete next',
  '   steps of your own, marked as suggestions. If there is no advice, say so and suggest checks to start with.',
  'No preamble, no repeating the input back, no code fences unless quoting a command from the advice.',
].join('\n')

export function explainMessages(context: Record<string, unknown>): ChatMessage[] {
  return [
    { role: 'system', content: EXPLAIN_SYSTEM },
    { role: 'user', content: `The alert, as Fire Code recorded it:\n\n${JSON.stringify(context, null, 2).slice(0, 24_000)}` },
  ]
}

