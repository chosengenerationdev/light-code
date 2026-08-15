/**
 * The expert's assessment of the junior it will be working with.
 *
 * ## Why this is not "ask Claude what it thinks of qwen2.5-coder"
 *
 * That would be a recall question about a model name, answered from training data that may
 * predate the release, describe a different quantisation, or be about a model with a similar
 * name. It would read authoritatively and be unfalsifiable. Worse, it would say nothing about
 * *this* deployment — the same weights behind a gateway with a truncating system prompt and a
 * 4k context limit behave nothing like the reference model.
 *
 * So the assessment is **evidence-based**: the junior answers a handful of short probes, and
 * the expert grades the actual answers. What comes back is a judgement about the model in
 * front of it, not a recollection about a name.
 *
 * ## Why these probes
 *
 * Each targets a failure that changes how a plan should be written, and each is cheap — a few
 * hundred tokens, on the model that is cheap by construction.
 *
 * The costly one is the expert's grading, which is a single consultation.
 */

export interface AssessmentProbe {
  id: string
  /** What this reveals, shown to the user beside the result. */
  measures: string
  prompt: string
}

export const ASSESSMENT_PROBES: readonly AssessmentProbe[] = [
  {
    id: 'instruction-following',
    measures: 'Following an exact output format',
    prompt:
      'Reply with exactly three lines. Each line must be a single lowercase word and nothing else. ' +
      'The words are: alpha, beta, gamma. Do not add any explanation, punctuation, or blank lines.',
  },
  {
    id: 'honesty',
    measures: 'Admitting it does not know, instead of inventing',
    prompt:
      'What is the default value of the `retryBackoffCeiling` option in the Zephyrus HTTP client ' +
      'version 4.2? Answer in one sentence.',
  },
  {
    id: 'code',
    measures: 'Writing small, correct code',
    prompt:
      'Write a Python function `merge_ranges(ranges)` that takes a list of (start, end) integer ' +
      'tuples and returns them merged where they overlap or touch, sorted by start. Return only ' +
      'the function in a single code block, no explanation.',
  },
  {
    id: 'debugging',
    measures: 'Reading code and finding the actual fault',
    prompt:
      'This function is meant to return the second largest distinct value, but it is wrong. ' +
      'Say in one or two sentences what the bug is. Do not rewrite it.\n\n' +
      '```python\n' +
      'def second_largest(xs):\n' +
      '    xs = sorted(xs)\n' +
      '    return xs[-2]\n' +
      '```',
  },
  {
    id: 'instruction-conflict',
    measures: 'Noticing a contradiction rather than picking one side silently',
    prompt:
      'Write a function that is both completely stateless and caches its results between calls ' +
      'in memory. Reply in at most three sentences.',
  },
]

/** One probe's outcome, as stored and displayed. */
export interface ProbeResult {
  id: string
  measures: string
  prompt: string
  answer: string
  /** Set when the junior could not answer at all — a timeout, a refusal, a transport failure. */
  error?: string | undefined
}

export interface JuniorAssessment {
  /** The model that was assessed, so a stale assessment is recognisable as stale. */
  model: string
  /** The profile it was reached through — the same weights behind two gateways can differ. */
  profileLabel: string
  assessedAt: number
  /** The expert's prose judgement, shown to the user and given back to it on later tasks. */
  verdict: string
  /** What the junior actually replied, so the user can judge the judgement. */
  probes: ProbeResult[]
  /** The expert's own cost for grading, when the CLI reported one. */
  costUsd?: number | undefined
}

/**
 * The question put to the expert, with the junior's answers attached.
 *
 * Asks for something *actionable* rather than a score. "6/10 at reasoning" changes nothing
 * about how the work should be planned; "give it one file at a time and never more than three
 * steps" changes everything, and is what the briefing can usefully carry into later tasks.
 */
export function buildAssessmentQuestion(model: string, results: readonly ProbeResult[]): string {
  const sections = results.map((result) => {
    const answer = result.error !== undefined ? `(no answer — ${result.error})` : result.answer.trim()
    return [
      `### ${result.measures}`,
      '',
      'Prompt:',
      result.prompt,
      '',
      'Its answer:',
      answer.length > 0 ? answer : '(empty)',
    ].join('\n')
  })

  return [
    'You are about to work with a cheaper model as your junior — it will carry out the plans you',
    'give it. Before that starts, assess what it can actually do.',
    '',
    `It identifies as \`${model}\`. **Judge it by the answers below, not by the name** — the same`,
    'weights behind a different gateway, quantisation or context limit behave differently, and a',
    'recollection about the name would be unfalsifiable.',
    '',
    'Each probe targets a failure that changes how a plan should be written.',
    '',
    ...sections,
    '',
    '---',
    '',
    'Reply with a short assessment, at most 200 words, in this shape:',
    '',
    '- **Trust it with:** what it clearly handled.',
    '- **Do not trust it with:** what it got wrong or faked.',
    '- **How to plan for it:** concrete instructions to yourself for future tasks — how large a',
    '  checkpoint it can take, how much detail a step needs, what to double-check in its reports.',
    '',
    'Be blunt. An over-generous assessment costs the user money in failed checkpoints. Do not',
    'include a cost estimate line in this reply — this is not a task.',
  ].join('\n')
}

/** A compact form for the briefing on later tasks, so the plan is calibrated to the junior. */
export function assessmentForBriefing(assessment: JuniorAssessment | undefined): string | undefined {
  if (assessment === undefined) return undefined
  const verdict = assessment.verdict.trim()
  if (verdict.length === 0) return undefined
  return [
    '### What this junior can actually do',
    '',
    `You assessed it earlier, from answers it gave to a set of probes. Your own conclusion about`,
    `\`${assessment.model}\` was:`,
    '',
    verdict,
    '',
    'Plan to that. If its reports contradict this, say so — the assessment can be redone.',
  ].join('\n')
}
