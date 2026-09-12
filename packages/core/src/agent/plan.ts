/**
 * A plan the user sets for one chat, to keep the assistant on the job it was given.
 *
 * Requested after watching an agent wander: it would do the thing asked, then keep going —
 * refactoring something adjacent, fixing an unrelated lint, exploring a file nobody mentioned.
 *
 * ## Why a plan is more than a longer first message
 *
 * A first message is one turn old by the second step and twenty turns old by the tenth. It gets
 * compacted, superseded and buried under tool results, and the model's picture of "what am I
 * doing" degrades with it. A plan sits in the **system prompt**, which is re-sent whole on every
 * request — so it is exactly as present at step twenty as at step one. That is the only place in
 * this product where something stays equally loud for a whole task.
 *
 * ## The three places it bites
 *
 * Stating a plan is not the same as following one, so it is applied at the three moments drift
 * actually happens:
 *
 * 1. **Before acting** — the instruction to check each step against the plan, at the very end of
 *    the prompt where recency helps most.
 * 2. **When tempted** — an explicit rule for the thing agents do: noticing an unrelated
 *    improvement and taking it. Noticing is useful; acting on it unasked is the drift.
 * 3. **At the end** — `attempt_completion` has to reconcile against the plan. This is the
 *    strongest of the three, because it is the one moment the model must compare what it *did*
 *    against what it was *for*, and say plainly what it skipped.
 *
 * ## Why the prompt cache is not a reason to avoid this
 *
 * §12 is strict that the prompt prefix must stay byte-stable within a session, and this does
 * change it. But it changes it *when the user edits the plan* — a deliberate, occasional act, the
 * same carve-out mode switching already has. It is stable across every turn in between, which is
 * the property that matters.
 */

import { parseCheckpoints } from './checkpoints.js'

/** Long enough for a real plan, short enough that it cannot crowd out the rest of the prompt. */
export const PLAN_LIMIT = 4000

/**
 * The plan section, or nothing when there is no plan.
 *
 * Empty rather than a heading saying there is no plan: a chat without one should cost nothing and
 * read exactly as it did before.
 */
export function buildPlanGuidance(plan: string | undefined): string {
  const trimmed = plan?.trim() ?? ''
  if (trimmed.length === 0) return ''

  /*
   * The numbering is stated here because it is a contract.
   *
   * `plan_progress` takes a step *number*, and the panel renders the same numbers — both derived
   * from `parseCheckpoints`, which is the one place a plan is turned into steps. Letting the
   * model infer the numbering from the prose instead would put a second reading of the plan in
   * the prompt, and the two would disagree the first time somebody wrote a plan with a preamble
   * line above the list. Same rule as everywhere else here: one owner, and pass the result.
   */
  const checkpoints = parseCheckpoints(trimmed)
  const numbered =
    checkpoints.length > 0
      ? [
          '',
          'Its steps are numbered as follows. These numbers are what `plan_progress` takes, and',
          'they are what the user sees:',
          '',
          ...checkpoints.map((checkpoint) => `${String(checkpoint.index)}. ${checkpoint.text}`),
        ]
      : []

  return [
    '# The plan for this conversation',
    '',
    'The user set this. It is what you are here to do:',
    '',
    trimmed,
    ...numbered,
    '',
    '## Reporting where you are',
    '',
    '- **Call `plan_progress` with `active` when you start a step**, and with `done` when it is',
    '  actually finished. The user watches this rather than reading the whole transcript, so a',
    '  step marked done that is not done is worse than one never marked at all.',
    '- Work one step at a time. Marking three done at the end tells the user nothing while it',
    '  matters, which is the only time it is useful.',
    '',
    '## Changing the plan',
    '',
    '- **You may propose a different plan with `update_plan`, and the user must approve it.**',
    '  They are shown a diff of the plan they have against the one you are proposing. This is',
    '  the only way the plan changes on your side — never act on a plan the user has not agreed.',
    '- Use it when you have worked out a better plan, including one a specialist drafted for you.',
    '  Put the whole plan in it: it replaces what is there rather than adding to it.',
    '- If they decline, the existing plan still stands and you carry on with it.',
    '',
    '## Working to it',
    '',
    '- **Before each step, check it serves the plan.** If it does not, do not take it.',
    '- **Work the plan in order** where it has an order, and say which part you are on when you',
    '  start something substantial. A reader should never have to guess where you are.',
    '- **Noticing something else is useful; acting on it is not.** If you spot an unrelated bug,',
    '  a refactor worth doing, or a file that could be tidied, *say so and carry on with the*',
    '  *plan*. Do not fix it because you are there. The user will ask if they want it.',
    '- **If the plan turns out to be wrong**, say so and stop rather than quietly substituting a',
    '  better one. A plan the user set and a plan you preferred are different things, and only',
    '  one of them was agreed.',
    '- **If something the plan needs is missing or blocked**, say which part and why, finish what',
    '  can be finished, and report what you left.',
    '',
    'When you finish, `attempt_completion` must account for the plan: what is done, what is not,',
    'and anything you did that the plan did not ask for.',
  ].join('\n')
}

/*
 * There is deliberately no plan text in `attempt_completion`'s description.
 *
 * Putting it there was the first design, and it is the stronger position — a model reaching for
 * the tool reads its description, so the reminder arrives at the moment it applies. But a
 * description that changes when a plan is set makes the *tool block* a function of the plan, and
 * §12 is explicit that tool definitions sit at the front of the prompt and must stay byte-stable
 * within a session: varying them invalidates the cache prefix and every turn after it.
 *
 * The system prompt has the same carve-out for a deliberate user action, which is why the plan
 * lives there and ends by naming `attempt_completion` instead. Slightly weaker, and the right
 * trade: the alternative spends real money on every turn of every planned conversation.
 */
