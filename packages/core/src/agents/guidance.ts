import { AGENT_ROLES } from './roles.js'
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

/**
 * Planning is the first act of this mode, not an option inside it.
 *
 * Requested in those terms: agent team mode should always start by getting a plan from the expert
 * and setting it, before the next steps. The reasoning is the one that produced the plan feature
 * — an agent that starts typing immediately is the one that wanders — but it is stronger here,
 * because this mode *has* somebody whose whole job is thinking about shape before code exists,
 * and consulting them once the work is under way wastes most of what they are for.
 *
 * **Generated rather than written into the editable default**, because which of these two applies
 * is a fact about the conversation rather than advice. One fixed instruction would tell somebody
 * who already has a plan to go and make one, which is how a standing instruction stops being read
 * at all — the same split that keeps the roster generated and the advice editable.
 */
const PLAN_FIRST = [
  '',
  '## Start by planning. This comes before everything else.',
  '',
  '**This conversation has no plan yet, so making one is your first job.** Before reading widely,',
  'before editing anything, before running anything:',
  '',
  '1. **Look at almost nothing first.** One `list_files` of the workspace root is usually the',
  '   whole of it, plus any file the user actually named. That is enough to ask a good question.',
  '   Do **not** survey the codebase, search the documentation index, hunt for skills, or read',
  '   files to get a feel for the style — not yet. The specialist cannot see any of it anyway,',
  '   and if it needs something specific it will say so and you can fetch it and ask again.',
  '   Announcing that you are "getting a sense of the workspace before proposing anything" is',
  '   this instruction being broken, however reasonable it sounds.',
  '2. **Ask the expert for the plan** — give the task, the little you found and the constraints,',
  '   and ask for numbered steps. A plan is the one thing worth asking for before the work rather',
  '   than after it, and it is what the expert is for. An expert asked early enough to change the',
  '   shape of the work is worth several times one asked to bless a direction already taken.',
  '   **Ask it to say which specialist should be involved in which step**, from the team it is',
  '   given. It knows who is available; it will not volunteer the allocation unless asked.',
  '3. **Propose it with `update_plan`.** The user sees a diff and approves it. Do not skip this:',
  '   a plan held only in the conversation is forgotten as the chat grows, and it is not',
  '   something the user has agreed to.',
  '   **Never write the plan to a file instead.** A file is not the plan: nothing reads it, the',
  '   progress panel stays empty, and the user never approved it. If `update_plan` fails, say',
  '   what it said and stop — a workaround that looks like progress is worse than the failure.',
  '4. Only once it is approved, start the work, reporting each step with `plan_progress`.',
  '',
  'If the user declines, ask what they want changed and propose a revised plan. If no expert is',
  'assigned, draft it yourself and propose it the same way — and say that is what you did, so',
  'nobody believes it was reviewed by somebody else.',
  '',
  'The exception is a question rather than a job. If the user asked something you can simply',
  'answer, answer it — do not plan a conversation.',
].join('\n')

/** When one is set: the plan itself is already in the prompt, so this only says what to do with it. */
const PLAN_IN_PLACE = [
  '',
  '## This conversation already has a plan',
  '',
  'It is above, with its steps numbered. Work it, report each step with `plan_progress`, and if it',
  'turns out to be wrong, consult the expert and propose a replacement with `update_plan` rather',
  'than quietly working to a different one.',
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
  '  inventing a convention;',
  /*
   * The programmer was missing from this list entirely, which is most of why it never got used.
   *
   * Every other bullet describes somebody *reading* what you have, and writing code is the one
   * thing the assistant can already do — so with no bullet of its own the role simply never came
   * up, and a plan drafted by the expert never allocated it either (the same omission, in the
   * briefing). Bounded deliberately: "hand everything to the programmer" would add a round trip
   * to every edit and put a second model's conventions into the file.
   */
  '- a step is a self-contained piece of code with a clear spec — a parser, a schema, a set of',
  '  pure functions — hand it to the **programmer** rather than writing it yourself out of habit,',
  '  then check what comes back against the real file before applying it. Not for a two-line',
  '  change, and not where the spec is still moving.',
  '',
  'The user can also ask directly ("ask the reviewer to look at this"), and then you consult that',
  'role whatever you would have chosen.',
  '',
  '## What makes a consultation worth it',
  '',
  /*
   * The last place still saying every specialist is blind.
   *
   * Some can read and search for themselves; the roster above marks which. But the advice does
   * not change much, because even one that can look things up starts from what you gave it — and
   * a question with nothing attached spends its whole lookup budget finding the file you already
   * had open.
   */
  '**Paste the code**, the error, the failing output — the actual text. Some of them can read the',
  'workspace and some cannot, and the roster says which; but even the ones that can start from',
  'what you give them, and a question with nothing attached spends their whole lookup budget',
  'finding what you already had open. A question like "is my retry logic right?" with nothing',
  'attached comes back as a list of things retry logic usually gets wrong, which you already knew.',
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
  '',
  '## When a review finds something in code the programmer wrote',
  '',
  '**Take it back to the programmer.** It wrote the code, it is the role picked for writing, and',
  'the fix is its job rather than yours — you are the one holding the files, not the one whose',
  'judgement was hired for this. Fixing it silently yourself wastes the specialist and hides the',
  'exchange from the user.',
  '',
  'A consultation remembers nothing, so the question has to carry everything: **the code as it',
  'stands, the finding in the reviewer\'s own words, and what you have checked yourself.** A',
  'programmer told only "the reviewer says this is wrong" will guess at which line and rewrite',
  'more than it should.',
  '',
  '**It may push back, and that is a real answer, not an obstacle.** Reviews are wrong often',
  'enough to matter — a finding can be about a path that cannot happen, a convention this',
  'codebase deliberately does not follow, or a misreading of code the reviewer only saw a fragment',
  'of. When the programmer disagrees, you settle it: you have the actual file and neither of them',
  'does. Say which way you went and why, in your reply, so the user sees the disagreement rather',
  'than only its outcome.',
  '',
  '**One lap, not a loop.** Review, fix, and re-review only when the fix was substantial enough',
  'that the first review no longer describes the code. If the two still disagree after that, stop',
  'and put it to the expert with both positions, or decide it yourself and say so. Ping-ponging a',
  'disagreement between two models that cannot see the file is how a turn is spent without',
  'anything being decided.',
  '',
  '## When the plan names a specialist',
  '',
  'Consult them **while that step is the active one**, not at the end in a batch. Two reasons, and',
  'the second is the one people notice: advice arriving after the work is done is a review nobody',
  'can act on without redoing it, and the progress panel attributes a consultation to whichever',
  'step was open when it happened — so a step worked in silence shows as nobody having helped with',
  'it, whatever you say afterwards.',
  '',
  'If a step names somebody and you decide against consulting them, say so and say why. A plan the',
  'user approved said that step would get another reader.',
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
  hasPlan?: boolean,
): string {
  const base = custom !== undefined && custom.trim().length > 0 ? custom : DEFAULT_TEAM_GUIDANCE
  // Only where something meters. See `BUDGET_ADVICE`.
  const advice = budgetMatters === true ? `${base}\n${BUDGET_ADVICE}` : base
  const planning = hasPlan === true ? PLAN_IN_PLACE : PLAN_FIRST

  /*
   * The whole team arrives, and the filtering happens here.
   *
   * It used to be filtered by the caller, which made "who is available" a decision taken in two
   * places for two audiences — this roster and the specialists' briefing — and only one of them
   * knew about the roles that are *not* set up. One input, one filter, and both lists come out of
   * the same `resolveTeam` result.
   */
  const usable = agents.filter((agent) => agent.available)
  const unusable = AGENT_ROLES.filter(
    (role) => !usable.some((agent) => agent.role === role),
  ).map((role) => {
    const assigned = agents.find((agent) => agent.role === role)
    return assigned === undefined
      ? `- **${role}** — nobody assigned.`
      : `- **${role}** — ${assigned.reason ?? 'assigned, but cannot be reached.'}`
  })

  /*
   * Naming who is missing, not only who is there.
   *
   * A list of available roles reads as a suggestion, and a model with a strong prior about how
   * software gets reviewed reaches for a reviewer regardless — spending a step being refused, or
   * writing it into a plan where nobody notices it never happened. Saying plainly which roles do
   * not exist turns the list into an instruction.
   */
  const missing =
    unusable.length === 0
      ? []
      : [
          '',
          '**Not available, so do not ask for them and do not plan work for them:**',
          '',
          ...unusable,
          '',
          'If something genuinely needs one of these, say so and say that assigning it in',
          'Settings → Agents would let you consult it — then carry on without it rather than',
          'leaving that part of the job unaccounted for.',
        ]

  if (usable.length === 0) {
    return [
      advice,
      planning,
      '',
      '## Your team',
      '',
      '**Nobody is assigned yet.** Until somebody is, do the work yourself and tell the user that',
      'assigning a specialist in Settings → Agents would let you consult one.',
      ...missing,
    ].join('\n')
  }

  return [
    advice,
    planning,
    '',
    '## Your team',
    '',
    'Reach any of them with `ask_agent`, naming the role. These are the only ones that exist:',
    '',
    ...usable.map((agent) => `- **${agent.role}** (${agent.label}) — ${agent.summary}`),
    ...missing,
  ].join('\n')
}
