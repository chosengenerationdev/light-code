/**
 * The expert's own estimate of what a task will cost.
 *
 * ## Why the expert, and why in its answer
 *
 * The expert is the only participant that knows the shape of the work before it starts — it
 * has just read the code and decided how many checkpoints there are. Asking it separately
 * would be a second consultation to find out how much consulting will cost, which is absurd;
 * asking the *junior* would be asking the model that has not planned anything. So the estimate
 * rides along with the plan and costs nothing extra.
 *
 * ## Why a marker line rather than a second parse of the prose
 *
 * "About forty cents" is unparseable in the general case, and a model asked for a number in
 * prose will happily produce three of them. A single tagged line is unambiguous, and it is
 * stripped before the answer reaches the transcript so the machinery does not become something
 * the user has to read past.
 *
 * ## What it is not
 *
 * A guess by a language model about its own future behaviour. The UI must say "estimated",
 * never present it as a quote — the meter beside it shows what has *actually* been spent, and
 * that is the number that is true.
 */

export interface ExpertEstimate {
  /** Consultations the expert expects the whole task to take, including reviews. */
  consultations?: number
  /** Dollars, as the expert's own guess. */
  usd?: number
}

/**
 * The line the expert is asked to emit. Deliberately ugly: it should be obvious in a
 * transcript that it is machinery, on the occasions when stripping fails.
 */
const ESTIMATE_PATTERN = /^[ \t]*\[LIGHT-CODE-ESTIMATE\b([^\]]*)\][ \t]*$/gim

function readNumber(source: string, key: string): number | undefined {
  const match = new RegExp(`${key}\\s*=\\s*\\$?([0-9]+(?:\\.[0-9]+)?)`, 'i').exec(source)
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value < 0) return undefined
  return value
}

/**
 * Extracts the estimate and returns the answer without it.
 *
 * Always returns the text, estimate or not, so the caller has one thing to render rather than
 * a branch. The last marker wins: an expert revising its plan mid-answer means the later
 * number is the considered one.
 */
export function extractEstimate(answer: string): { text: string; estimate?: ExpertEstimate } {
  let found: ExpertEstimate | undefined

  for (const match of answer.matchAll(ESTIMATE_PATTERN)) {
    const body = match[1] ?? ''
    const consultations = readNumber(body, 'consultations')
    const usd = readNumber(body, 'usd')
    if (consultations === undefined && usd === undefined) continue
    found = {
      ...(consultations === undefined ? {} : { consultations: Math.round(consultations) }),
      ...(usd === undefined ? {} : { usd }),
    }
  }

  const text = answer
    .replace(ESTIMATE_PATTERN, '')
    // The marker sits on its own line, so removing it leaves a blank one behind.
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return found === undefined ? { text } : { text, estimate: found }
}

/** What the expert is told to emit, appended to its briefing. */
export const ESTIMATE_INSTRUCTION = [
  '### Estimate the cost of the task, once',
  '',
  'The user sets a budget for this conversation and can only judge it if someone who has seen',
  'the work says what it is likely to take. You are the only participant who has.',
  '',
  'So **on your first substantive answer** — the one where you give the plan — end with exactly',
  'this line, and nothing after it:',
  '',
  '    [LIGHT-CODE-ESTIMATE consultations=<n> usd=<amount>]',
  '',
  'where `<n>` is how many consultations you expect in total *including this one and every',
  'checkpoint review*, and `<amount>` is dollars. The first consultation costs roughly twenty',
  'times a follow-up, because it establishes the cached context that the rest read; a rough',
  'rule is $0.20 for the first and $0.01 for each one after it, plus more for a long answer.',
  '',
  'The line is removed before the user reads your reply, so do not explain it. Estimate once —',
  'repeating it on every answer would be noise, and the figure only matters before the work',
  'starts. If a review reveals the plan was badly wrong, you may emit a revised line then.',
].join('\n')
