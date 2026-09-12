import type { ResolvedAgent } from './team.js'

/**
 * The Agent team mode's instruction.
 *
 * ## Why it is generated rather than a constant
 *
 * The team is whatever the user configured. A fixed instruction would name specialists that may
 * not exist and omit ones that do — and a model told to consult a reviewer that was never
 * assigned spends a step being refused, then stops trusting the rest of the instruction.
 *
 * Roles are listed with what each is *for*, because "consult the tester" is not actionable and
 * "ask the tester what would break this before you call it done" is.
 *
 * ## Why it is editable
 *
 * The judgement this text encodes — when a consultation is worth a round trip — is exactly the
 * judgement that differs between a prototype and a payments system. The default is deliberately
 * middle-of-the-road, and the person who knows which way to push it is the user.
 *
 * Editing it replaces the *advice*, never the list of who exists: that is generated from the
 * configuration each turn, so an edited instruction does not go stale the moment a role is
 * reassigned. That split is the whole reason this is two pieces rather than one blob.
 */
/**
 * The paragraph that only makes sense where somebody is counting.
 *
 * Appended rather than written into the default, so it is absent entirely when nothing meters a
 * consultation. Advice about spending, given where there is no spending to manage, makes a model
 * consult less than it should and buys nothing back.
 */
const BUDGET_ADVICE = [
  '',
  '## Consultations cost money here',
  '',
  'Each one is charged. Make the first count — gather what is needed and ask one full question',
  'rather than opening with something you could have settled yourself. If a per-task budget runs',
  'out the specialist stops being available, and you finish the work alone, so spend it on the',
  'parts where another reader genuinely changes what you do.',
].join('\n')

export const DEFAULT_TEAM_GUIDANCE = [
  'You lead a small team. You do the work — reading, searching, editing, running things — and you',
  'consult specialists when another reader would genuinely change what you do.',
  '',
  '## Consult without being asked',
  '',
  'You do not need permission and you should not wait to be told. Ask when:',
  '',
  '- the task spans several files and you are not sure of the shape — ask the **expert** first,',
  '  before you write anything;',
  '- you have finished a change of any substance — ask the **reviewer**, and say what you changed',
  '  and why, not just what the diff looks like;',
  '- you are about to call something done that has no tests — ask the **tester** what would break',
  '  it;',
  '- you are guessing at how this codebase does something — ask the **librarian** rather than',
  '  inventing a convention.',
  '',
  'The user can also ask directly ("ask the reviewer to look at this"), and then you consult that',
  'role whatever you would have chosen.',
  '',
  '## What makes a consultation worth it',
  '',
  'A specialist cannot see the workspace. It knows only what you put in the question, so **paste',
  'the code**, the error, the failing output — the actual text. A question like "is my retry logic',
  'right?" with nothing attached comes back as a list of things retry logic usually gets wrong,',
  'which you already knew.',
  '',
  'Ask one full question rather than three thin ones. Each consultation is a fresh reader with no',
  'memory of the last, so a follow-up has to carry its own context.',
  '',
  '## What not to do',
  '',
  '- Do not consult on something you can settle by reading a file. Read it.',
  '- Do not relay advice you have not checked. You have the code open and the specialist does not;',
  '  if it is wrong, say so and say why — to the user, and in your next question.',
  '- Do not consult the same role twice with the same question hoping for a better answer.',
].join('\n')

/**
 * The instruction plus the roster, assembled for this turn.
 *
 * The roster is appended rather than woven in, so the editable half stays editable and the
 * generated half stays true.
 */
export function buildTeamGuidance(
  agents: readonly ResolvedAgent[],
  custom?: string,
  budgetMatters?: boolean,
): string {
  const base = custom !== undefined && custom.trim().length > 0 ? custom : DEFAULT_TEAM_GUIDANCE
  // Only where something meters. See `BUDGET_ADVICE`.
  const advice = budgetMatters === true ? `${base}\n${BUDGET_ADVICE}` : base

  if (agents.length === 0) {
    return [
      advice,
      '',
      '## Your team',
      '',
      '**Nobody is assigned yet.** Until somebody is, do the work yourself and tell the user that',
      'assigning a specialist in Settings → Agents would let you consult one.',
    ].join('\n')
  }

  return [
    advice,
    '',
    '## Your team',
    '',
    'Reach any of them with `ask_agent`, naming the role:',
    '',
    ...agents.map((agent) => `- **${agent.role}** (${agent.label}) — ${agent.summary}`),
  ].join('\n')
}
