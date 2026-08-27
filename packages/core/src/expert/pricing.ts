/**
 * What a consultation actually costs on *this* plan.
 *
 * The measured figures in the documentation — $0.187 cold, $0.0099 resumed — came from one plan on
 * one day. An enterprise agreement, a subscription, or a gateway in front can all report something
 * different, or nothing at all. Guessing wrong matters because those numbers are what the budget
 * is set from and what the expert is told when it plans to fit.
 *
 * ## Why measuring costs money, and why that is stated rather than hidden
 *
 * There is no way to learn the price of a consultation without having one. The measurement is two:
 * a cold consultation, which pays to establish the session, and a resumed one, which reads the
 * cache instead. That pair is the whole point — the *ratio* between them is what every rule about
 * using the expert cheaply depends on, and a single sample cannot show it.
 *
 * So the button says what it will spend before it spends it. A tool that quietly bills you to tell
 * you about billing would be an unusually poor joke.
 */
export interface ExpertPricing {
  /** A first consultation in a fresh session: pays to establish the prompt and tools. */
  coldUsd?: number | undefined
  /** A later consultation in the same session: reads that cache instead of rebuilding it. */
  resumedUsd?: number | undefined
  /** Epoch ms. Rates change, and a figure with no date invites more trust than it has earned. */
  measuredAt: number
  /** False when the plan reported no cost at all, which is a result rather than a failure. */
  reportsCost: boolean
}

/**
 * The question asked twice.
 *
 * Deliberately trivial and identical both times: the measurement is of the *session*, not of the
 * model's effort, and a question that takes real thinking would add its own tokens to both samples
 * and blur the thing being compared.
 */
export const PRICING_PROBE = 'Reply with the single word: OK'

export function describePricing(pricing: ExpertPricing | undefined): string | undefined {
  if (pricing === undefined) return undefined
  if (!pricing.reportsCost) {
    return 'This plan reports no cost per consultation, so only the consultation limit can apply.'
  }
  const cold = pricing.coldUsd
  const resumed = pricing.resumedUsd
  if (cold === undefined || resumed === undefined) return undefined

  const ratio = resumed > 0 ? cold / resumed : undefined
  return [
    `A first consultation costs about ${money(cold)} here and a follow-up about ${money(resumed)}`,
    ratio !== undefined && ratio >= 2 ? ` — roughly ${String(Math.round(ratio))} times cheaper.` : '.',
  ].join('')
}

/**
 * What the expert is told, so its own estimate is grounded in this deployment.
 *
 * Without it the expert prices a task from whatever it believes consultations cost in general,
 * which is a guess about someone else's contract. With it, the estimate and the budget are in the
 * same units.
 */
export function pricingForPrompt(pricing: ExpertPricing | undefined): string | undefined {
  if (pricing === undefined || !pricing.reportsCost) return undefined
  const cold = pricing.coldUsd
  const resumed = pricing.resumedUsd
  if (cold === undefined || resumed === undefined) return undefined

  return (
    `Measured on this deployment: the first consultation of a task costs about ${money(cold)}, ` +
    `and each one after it about ${money(resumed)} because it resumes the same session. ` +
    'Plan accordingly — make the first one carry the task, and do not repeat context afterwards.'
  )
}

function money(value: number): string {
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`
}
