/**
 * A ceiling on what the expert may cost within one task.
 *
 * Junior mode's whole design is "consult early, then keep asking cheap follow-ups", which is
 * correct and also removes the thing that used to limit spend — the friction of an expensive
 * cold start. Nothing else bounds it: the model decides when to consult, and a model that has
 * misdiagnosed a problem will happily consult about it eleven times.
 *
 * Two limits, because neither is sufficient alone:
 *
 * - **Spend** is what the user actually cares about, and is the one to set. But the CLI does
 *   not always report a cost, and an unpriced consultation cannot be added to a total without
 *   inventing a number.
 * - **Count** is always knowable, so it is the backstop that still holds when cost is missing.
 *
 * Whichever trips first stops the next consultation. Both are per *task*, matching the expert
 * session's own scope: a long day of unrelated work should not exhaust a budget set for one
 * piece of work, and `resetExpertSpend` already runs at the same boundary.
 */

export interface ExpertSpend {
  usd: number
  consultations: number
  /** Consultations the CLI reported no cost for. Counted, never guessed at. */
  unpriced: number
}

export interface ExpertLimits {
  /** Dollars per task. Undefined or 0 means no limit. */
  maxSpendUsd?: number | undefined
  /** Consultations per task. Undefined or 0 means no limit. */
  maxConsultations?: number | undefined
}

export interface BudgetVerdict {
  allowed: boolean
  /** Present when refused: what to tell the model, and through it the user. */
  message?: string
}

function money(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

/**
 * Whether another consultation may go ahead.
 *
 * Checked *before* spending rather than after, which is the only ordering that can prevent
 * anything — a limit enforced on the way out has already been exceeded by the time it fires.
 * The consequence is that the last permitted consultation can carry the total past the limit,
 * since its price is not known until it returns. That is stated in the message rather than
 * hidden, because a user who set $1.00 and sees $1.14 should know why.
 */
export function checkExpertBudget(spend: ExpertSpend, limits: ExpertLimits): BudgetVerdict {
  const maxConsultations = limits.maxConsultations ?? 0
  if (maxConsultations > 0 && spend.consultations >= maxConsultations) {
    return {
      allowed: false,
      message:
        `The expert consultation limit for this task has been reached ` +
        `(${String(spend.consultations)} of ${String(maxConsultations)}). ` +
        'Continue on your own: use what the expert has already told you, read the code directly, ' +
        'and say plainly if you are stuck rather than guessing. ' +
        'The user can raise the limit in Settings → Expert, or start a new task to reset it.',
    }
  }

  const maxSpend = limits.maxSpendUsd ?? 0
  if (maxSpend > 0 && spend.usd >= maxSpend) {
    return {
      allowed: false,
      message:
        `The expert spending limit for this task has been reached ` +
        `(${money(spend.usd)} of ${money(maxSpend)}). ` +
        'Continue on your own: use what the expert has already told you, read the code directly, ' +
        'and say plainly if you are stuck rather than guessing. ' +
        'The user can raise the limit in Settings → Expert, or start a new task to reset it.' +
        (spend.unpriced > 0
          ? ` Note ${String(spend.unpriced)} consultation${spend.unpriced === 1 ? '' : 's'} reported no cost, ` +
            'so the real total is higher than the figure above.'
          : ''),
    }
  }

  return { allowed: true }
}

/**
 * How close the task is to its limits, for the meter in the chat.
 *
 * Returns undefined when nothing is capped, so the UI can tell "no limit" from "0% used"
 * rather than drawing an empty bar that looks like a limit of zero.
 */
export function expertBudgetUsage(spend: ExpertSpend, limits: ExpertLimits): number | undefined {
  const fractions: number[] = []
  const maxSpend = limits.maxSpendUsd ?? 0
  const maxConsultations = limits.maxConsultations ?? 0
  if (maxSpend > 0) fractions.push(spend.usd / maxSpend)
  if (maxConsultations > 0) fractions.push(spend.consultations / maxConsultations)
  if (fractions.length === 0) return undefined
  // The nearer limit is the one that will actually stop the next call, so it is the one shown.
  return Math.min(1, Math.max(...fractions))
}

/**
 * A one-line statement of what is left, for the expert itself.
 *
 * The expert is the one deciding how many checkpoints the plan has, and therefore how many
 * reviews it implies. Told nothing, it plans as though reviews were free and proposes eight
 * checkpoints on a budget of three — the junior then runs out mid-plan, which is the worst
 * moment to lose it. Told the number, it can size the plan to fit.
 *
 * Undefined when nothing is capped, so no tokens are spent saying "unlimited".
 */
export function describeExpertBudget(
  spend: ExpertSpend,
  limits: ExpertLimits,
  /** Measured cost per consultation, so the expert plans in this deployment's units. */
  pricing?: string,
): string | undefined {
  const parts: string[] = []

  const maxConsultations = limits.maxConsultations ?? 0
  if (maxConsultations > 0) {
    const left = Math.max(0, maxConsultations - spend.consultations)
    parts.push(
      `${String(left)} of ${String(maxConsultations)} consultation${maxConsultations === 1 ? '' : 's'} left`,
    )
  }

  const maxSpend = limits.maxSpendUsd ?? 0
  if (maxSpend > 0) {
    parts.push(`${money(Math.max(0, maxSpend - spend.usd))} of ${money(maxSpend)} left`)
  }

  /*
   * The measured cost is worth sending even with no cap set. It is what turns "be economical" into
   * a number the expert can plan against, and without it the expert prices a task from whatever it
   * believes consultations cost in general — a guess about somebody else's contract.
   */
  if (parts.length === 0) return pricing
  return [
    `Budget for this task: ${parts.join(', ')}. ` +
      'Plan the number of checkpoints to fit — when it runs out the junior finishes alone.',
    pricing,
  ]
    .filter((line): line is string => line !== undefined)
    .join(' ')
}
