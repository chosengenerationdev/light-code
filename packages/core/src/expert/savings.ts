import type { ExpertPricing } from './pricing.js'

/**
 * What Junior mode has cost, and what it has avoided.
 *
 * ## The number that would be easy and dishonest
 *
 * "Junior mode saved you $40" requires knowing what the task would have cost had the strong
 * model done all of it, and nothing here can know that. CLAUDE.md §12b already records that
 * the 40–70% figure once written down was order-of-magnitude guesswork, and the meter exists
 * precisely so that stops being a guess. Inventing a multiplier and presenting the product as
 * a measurement would be worse than showing nothing.
 *
 * ## What is actually derivable
 *
 * Two things, both from numbers measured on this machine:
 *
 * - **Turns the expert never saw.** Every turn the cheap model handled alone is a turn that
 *   would otherwise have been an expert turn. Priced at `resumedUsd` — the measured cost of a
 *   *minimal* consultation into a warm session — that is a hard **floor**: real work costs more
 *   than replying "OK", so the true saving is larger, never smaller.
 * - **Cold starts avoided.** A consultation that resumed a session instead of starting one
 *   saved exactly `coldUsd - resumedUsd`, which is measured rather than assumed.
 *
 * Both are lower bounds, so the total is presented as "at least". A floor that is honestly a
 * floor is worth more than an estimate nobody can check.
 *
 * ## Why events rather than running totals
 *
 * Three windows are wanted — today, thirty days, all time — and a running total cannot answer
 * the first two after the fact. Events also survive being wrong: a bug in the arithmetic is
 * fixable from the log, where a corrupted counter is gone.
 */

export type ExpertEvent =
  /** One consultation, whatever it cost and whether it reused a session. */
  | { at: number; kind: 'consultation'; usd?: number; resumed: boolean }
  /**
   * One turn in Junior mode that the cheap model handled without consulting.
   *
   * Recorded per turn, not per tool call: a turn is the unit an expert consultation would have
   * replaced, and counting tool calls would inflate the floor by however chatty the task was.
   */
  | { at: number; kind: 'juniorTurn' }

export interface SavingsWindow {
  /** Spent on the expert in this window. */
  spentUsd: number
  /** Consultations whose cost the plan did not report; excluded from `spentUsd`, never as zero. */
  unpriced: number
  consultations: number
  /** Turns the cheap model handled alone. */
  juniorTurns: number
  /**
   * A floor for what those turns and reused sessions avoided, or undefined when nothing has
   * been measured — in which case the honest answer is "unknown", not zero.
   */
  avoidedUsd: number | undefined
}

export interface ExpertSavings {
  today: SavingsWindow
  last30Days: SavingsWindow
  allTime: SavingsWindow
  /** False when `expert.pricing` is unmeasured, so the UI can say why the figure is missing. */
  measured: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Midnight *local*, because "today" means the user's day, not UTC's. */
export function startOfLocalDay(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function summariseSavings(
  events: readonly ExpertEvent[],
  pricing: ExpertPricing | undefined,
  now: number = Date.now(),
): ExpertSavings {
  const since = (from: number): SavingsWindow => windowFor(events.filter((event) => event.at >= from), pricing)

  return {
    today: since(startOfLocalDay(now)),
    last30Days: since(now - 30 * DAY_MS),
    allTime: windowFor(events, pricing),
    measured: pricing?.resumedUsd !== undefined,
  }
}

function windowFor(events: readonly ExpertEvent[], pricing: ExpertPricing | undefined): SavingsWindow {
  let spentUsd = 0
  let unpriced = 0
  let consultations = 0
  let juniorTurns = 0
  let resumedConsultations = 0

  for (const event of events) {
    if (event.kind === 'juniorTurn') {
      juniorTurns += 1
      continue
    }
    consultations += 1
    if (event.usd === undefined) unpriced += 1
    else spentUsd += event.usd
    if (event.resumed) resumedConsultations += 1
  }

  return {
    spentUsd,
    unpriced,
    consultations,
    juniorTurns,
    avoidedUsd: avoided(juniorTurns, resumedConsultations, pricing),
  }
}

/**
 * The floor, or undefined when there is nothing measured to build it from.
 *
 * The cold-start component is clamped at zero. A measurement where resuming came out *dearer*
 * than a cold start means the resume did not really happen (see `resumeWorked`), and reporting
 * a negative saving would read as the feature costing money rather than as a bad measurement.
 */
function avoided(
  juniorTurns: number,
  resumedConsultations: number,
  pricing: ExpertPricing | undefined,
): number | undefined {
  const resumedUsd = pricing?.resumedUsd
  if (pricing === undefined || resumedUsd === undefined) return undefined

  const perColdStart = Math.max((pricing.coldUsd ?? resumedUsd) - resumedUsd, 0)
  return juniorTurns * resumedUsd + resumedConsultations * perColdStart
}

/**
 * Keeps the log from growing without bound.
 *
 * Bounded by *age* rather than by count, because the windows are ages: anything older than the
 * widest one can never change an answer again. A year is kept rather than thirty-one days so
 * "all time" stays meaningful for a while — it is a few hundred kilobytes at worst.
 */
export function pruneEvents(events: readonly ExpertEvent[], now: number = Date.now()): ExpertEvent[] {
  const cutoff = now - 365 * DAY_MS
  return events.filter((event) => event.at >= cutoff)
}
