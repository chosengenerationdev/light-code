import type { JuniorAssessment } from './assessment.js'

/**
 * Several models assessed, kept side by side.
 *
 * ## Why a list and not one slot
 *
 * One slot answers "is the model I am using any good". It cannot answer "which of these four
 * should review and which should write", because assessing the second model destroyed the
 * evidence about the first — and comparing is the question somebody with four models on a
 * gateway actually has. The probes are cheap; the reason not to keep their answers was never a
 * good one.
 *
 * ## Why the old single assessment is folded in here rather than read alongside
 *
 * Because two places holding one fact is the defect this repository has paid for more times than
 * any other. `assessment` is what earlier versions wrote and what a hand-edited config may still
 * carry, so it is read *through* this module and nowhere else: one owner, and every caller sees
 * the same answer whichever shape it came from.
 */

/** Everything assessed, oldest configuration shape included, newest first. */
export function allAssessments(expert: {
  assessment?: JuniorAssessment | undefined
  assessments?: readonly JuniorAssessment[] | undefined
}): JuniorAssessment[] {
  const list = [...(expert.assessments ?? [])]
  const legacy = expert.assessment
  // Kept only when the list does not already describe that model — an upgrade writes the list and
  // leaves the old field alone, so without this the first model would appear twice.
  if (legacy !== undefined && !list.some((entry) => sameSubject(entry, legacy))) {
    list.push(legacy)
  }
  return list.sort((a, b) => b.assessedAt - a.assessedAt)
}

/**
 * The assessment that applies to a model, or nothing.
 *
 * Matched on the model *and* the profile it was reached through, because §12b's own argument
 * applies here: the same weights behind two gateways are not the same thing to plan against.
 * Falls back to the model alone, since a profile can be renamed and an assessment of the right
 * model through a renamed profile is still better evidence than none.
 */
export function assessmentFor(
  all: readonly JuniorAssessment[],
  model: string,
  profileLabel?: string,
): JuniorAssessment | undefined {
  if (model.length === 0) return undefined
  const exact =
    profileLabel === undefined
      ? undefined
      : all.find((entry) => entry.model === model && entry.profileLabel === profileLabel)
  return exact ?? all.find((entry) => entry.model === model)
}

/**
 * The list with this assessment in it, replacing any earlier one of the same subject.
 *
 * Re-assessing a model must not leave two verdicts about it — which is the right one would be
 * unanswerable from the outside, and a stale verdict is fed back to the expert on later tasks.
 */
export function recordAssessment(
  all: readonly JuniorAssessment[],
  entry: JuniorAssessment,
  limit = MAX_ASSESSMENTS,
): JuniorAssessment[] {
  const kept = all.filter((existing) => !sameSubject(existing, entry))
  return [entry, ...kept].sort((a, b) => b.assessedAt - a.assessedAt).slice(0, limit)
}

/** The list without the named subject. */
export function forgetAssessment(
  all: readonly JuniorAssessment[],
  model: string,
  profileLabel: string,
): JuniorAssessment[] {
  return all.filter((entry) => !(entry.model === model && entry.profileLabel === profileLabel))
}

/**
 * A ceiling, because this is config and config is read on every load.
 *
 * Generous rather than tight: somebody comparing the models on a gateway may have a dozen, and
 * the cost of keeping one more is a few hundred bytes of prose.
 */
export const MAX_ASSESSMENTS = 12

function sameSubject(a: JuniorAssessment, b: JuniorAssessment): boolean {
  return a.model === b.model && a.profileLabel === b.profileLabel
}
