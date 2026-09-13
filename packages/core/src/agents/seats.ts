import { ASSESSMENT_PROBES } from '../expert/assessment.js'
import type { AgentRole } from './roles.js'

/**
 * Which seats a model suits, decided from what it actually did.
 *
 * ## Why this is not "ask which model is best at reviewing"
 *
 * The same argument `expert/assessment.ts` already makes, applied one step further along. Asking a
 * model — or a person — to rank `gemma-4` against `qwen3-27b` for the reviewer seat is a recall
 * question about names, answered from training data that may predate the release, describe a
 * different quantisation, or be about a model with a similar name. It reads authoritatively and is
 * unfalsifiable. It also says nothing about *this* deployment: the same weights behind a gateway
 * that truncates the system prompt behave nothing like the reference model.
 *
 * The probes already run. This only says what each one predicts about a seat, so the evidence
 * that exists gets used for the decision it is relevant to.
 *
 * ## Why each probe maps where it does
 *
 * Each seat fails in a characteristic way, and each probe catches one of those failures:
 *
 * - **instruction-following** — the programmer is handed a spec and asked to return code to it.
 *   A model that narrates, or adds an explanation nobody wanted, produces a diff somebody has to
 *   unpick before applying.
 * - **honesty** — the librarian's whole risk is stated confidently: `roles.ts` says it outright,
 *   *a convention you guessed at, stated confidently, becomes the convention*. A model that
 *   invents rather than admitting a gap is the wrong one for the seat that answers "how is this
 *   done here".
 * - **code** — the programmer again, and the half that is obvious.
 * - **debugging** — reading code and finding the *actual* fault is what a reviewer does. A model
 *   that reports the first plausible thing produces reviews that are confidently about nothing.
 * - **instruction-conflict** — noticing a contradiction rather than silently picking a side is
 *   the tester's instinct, and it is also what separates a reviewer from an agreeable one.
 *
 * The expert seat is deliberately not predicted by any single probe: planning is the whole of
 * what it does, and no short probe stands in for it. What it needs is stated instead.
 */
export interface SeatFit {
  role: AgentRole
  /** The probes that speak to this seat, by id. */
  probes: string[]
  /** What to look for in those answers, in the user's terms. */
  lookFor: string
}

export const SEAT_FITS: readonly SeatFit[] = [
  {
    role: 'programmer',
    probes: ['code', 'instruction-following'],
    lookFor:
      'Code that is correct and *only* code — no preamble, no explanation you did not ask for, ' +
      'no rewriting of things it was not asked to change. A model that cannot hold an output ' +
      'format will produce diffs you have to unpick before you can apply them.',
  },
  {
    role: 'reviewer',
    probes: ['debugging', 'instruction-conflict'],
    lookFor:
      'Finding the actual fault rather than the first plausible one, and saying when two ' +
      'instructions contradict instead of quietly obeying one. A model that agrees easily makes ' +
      'an approving reviewer, which is worse than none because it gets believed.',
  },
  {
    role: 'tester',
    probes: ['instruction-conflict', 'debugging'],
    lookFor:
      'Noticing what does not add up. The tester earns its place by thinking of the case you ' +
      'did not, which is the same instinct as spotting a contradiction.',
  },
  {
    role: 'librarian',
    probes: ['honesty'],
    lookFor:
      'Admitting it does not know. This is the one seat where inventing is worse than silence — ' +
      'a convention guessed at and stated confidently becomes the convention.',
  },
]

/** What the expert seat needs, which no short probe measures. */
export const EXPERT_GUIDANCE =
  'Planning across files is the whole of what the expert does, and no short probe stands in for ' +
  'it. Give the seat the model you would trust with an unfamiliar codebase, turn its thinking up, ' +
  'and judge it on whether its first plan survives contact with the work.'

/** Every probe is used by at least one seat, or the mapping has gone stale against the probes. */
export function unmappedProbes(): string[] {
  const used = new Set(SEAT_FITS.flatMap((fit) => fit.probes))
  return ASSESSMENT_PROBES.map((probe) => probe.id).filter((id) => !used.has(id))
}
