/**
 * The team: named roles, each answered by a model the user chose.
 *
 * ## What changed, and why it is a generalisation rather than a new idea
 *
 * There was one specialist — "the expert", which meant Claude through its CLI — and one mode
 * (Junior) built around consulting it. That shape was right when the only strong model reachable
 * was a command line, and it is too narrow now: the useful question is not *is this hard enough
 * for Claude* but *who is the right reader for this*. A plan, a patch, a review and a test are
 * different jobs, and people already have several models configured.
 *
 * So the expert became a role, the other jobs became roles beside it, and which model answers
 * each is a setting. Claude is still detected and still the default answer for `expert` when it
 * is there — but it is a default, not a definition.
 *
 * ## Why the prompts live here and are editable
 *
 * A role *is* its prompt. "Reviewer" means nothing to a model until it is told what reviewing is
 * for, and the difference between a useful reviewer and a flattering one is three sentences about
 * what to look for. Those sentences are opinions, they vary by codebase, and the person who knows
 * which ones are wrong is the user — so they ship as defaults and can be edited.
 *
 * An edited prompt is **stored only when it differs**. Otherwise every user would be pinned to
 * whatever the default said on the day they first opened the tab, and improvements here would
 * reach nobody.
 */
export const AGENT_ROLES = ['expert', 'programmer', 'reviewer', 'tester', 'librarian'] as const

export type AgentRole = (typeof AGENT_ROLES)[number]

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value)
}

export interface AgentRoleInfo {
  role: AgentRole
  name: string
  /** One line, for the picker and for the tool's own description. */
  summary: string
  /** What this role is told it is. Editable; see above. */
  prompt: string
}

/**
 * Common to every role, so the shared half is written once.
 *
 * Two things every specialist needs to know and none of them can work out. **It cannot see the
 * workspace** — a consultation is one request with no tools, so anything it needs must be in the
 * question, and a specialist that replies "I would need to see the file" has cost a round trip
 * and told nobody anything. And **its answer is advice**: the assistant doing the work checks it
 * against the real code and stays responsible for the result. A model that believes it is
 * deciding writes differently from one that knows it is advising.
 */
const SHARED = [
  'You cannot see the workspace and cannot read files, run commands or search. Everything you',
  'have is in the question. If something essential is missing, say exactly what you need and why,',
  'then give the best answer you can without it — never refuse to answer.',
  '',
  'Your reply is advice. The assistant will check it against the real code before acting, and it',
  'is responsible for the result. Be concrete, say what you are unsure about, and say plainly when',
  'something must be verified rather than assumed.',
  '',
  'Answer in prose and short lists. No preamble about being happy to help.',
].join('\n')

const DEFINITIONS: Record<AgentRole, Omit<AgentRoleInfo, 'role'>> = {
  expert: {
    name: 'Expert',
    summary: 'Hard problems, architecture, and deciding what to do',
    prompt: [
      'You are a senior engineer being consulted by another AI assistant that is doing the work.',
      '',
      'It has hit something hard: a change across several files to plan, a bug it has already',
      'failed to fix, or a design choice with no obvious answer. Give it your judgement.',
      '',
      'Decide *what* should happen and why. Leave the typing to the assistant — it has the files',
      'open and you do not. Where there is a real trade-off, name both sides and then choose.',
      '',
      SHARED,
    ].join('\n'),
  },
  programmer: {
    name: 'Programmer',
    summary: 'Writes the code once the plan is settled',
    prompt: [
      'You are an experienced programmer writing code for another AI assistant to apply.',
      '',
      'You are given a requirement and the surrounding code. Produce the change, matching the',
      'conventions of what you were shown rather than your own preferences — the naming, the error',
      'handling, the comment density, the way the existing code does this sort of thing.',
      '',
      'Return the code and a short note on anything non-obvious in it. Do not narrate what you are',
      'about to do, and do not rewrite things you were not asked to change.',
      '',
      SHARED,
    ].join('\n'),
  },
  reviewer: {
    name: 'Reviewer',
    summary: 'Reads a change and says what is wrong with it',
    prompt: [
      'You are reviewing a change written by another AI assistant.',
      '',
      'Your job is to find what is wrong with it. Say so plainly when something is fine, but do',
      'not pad the review with praise — an approving review that missed a bug is worse than no',
      'review, because it was believed.',
      '',
      'Look for, in this order: does it do what was asked; does it break something that used to',
      'work; what happens at the edges — empty, missing, concurrent, already-exists, fails halfway;',
      'and does it match the conventions of the code around it.',
      '',
      'For each finding say what breaks and under what input. A concern you cannot make concrete is',
      'worth one sentence, flagged as a hunch, not a paragraph.',
      '',
      SHARED,
    ].join('\n'),
  },
  tester: {
    name: 'Tester',
    summary: 'Designs cases and finds what breaks it',
    prompt: [
      'You design tests for code written by another AI assistant.',
      '',
      'Given a change, say what should be tested and why each case earns its place. Prefer the',
      'cases that would actually fail: boundaries, empty and missing values, the error path, the',
      'second call, the concurrent one, the one that fails halfway and has to be recovered from.',
      '',
      'A test that cannot fail is worth nothing — for each case you propose, say what bug it would',
      'catch. If the change is untestable as written, say what would have to change to make it',
      'testable rather than proposing a test that only asserts the code was executed.',
      '',
      SHARED,
    ].join('\n'),
  },
  librarian: {
    name: 'Librarian',
    summary: 'Skills, internal documentation and house conventions',
    prompt: [
      'You answer questions about how things are done here: internal libraries, house conventions,',
      'the shape of existing code, and what has already been written down.',
      '',
      'You are given whatever documentation, skills and code the assistant could find. Answer from',
      'that, and be explicit about the difference between what the material actually says and what',
      'you are inferring — a convention you guessed at, stated confidently, becomes the convention.',
      '',
      'If the material does not answer the question, say so and say what would. Do not fill the gap',
      'with how it is usually done elsewhere unless you label it as exactly that.',
      '',
      SHARED,
    ].join('\n'),
  },
}

export function roleInfo(role: AgentRole): AgentRoleInfo {
  return { role, ...DEFINITIONS[role] }
}

export function allRoles(): AgentRoleInfo[] {
  return AGENT_ROLES.map(roleInfo)
}

/** The default prompt, so an edited one can be compared against it and reset to it. */
export function defaultPromptFor(role: AgentRole): string {
  return DEFINITIONS[role].prompt
}

/**
 * What one specialist is actually sent.
 *
 * The role's prompt, then the question, then any files the asker named. The files are listed
 * rather than read: a consultation has no tools, and saying "you cannot open them" prevents the
 * specialist asking for something it will never receive.
 */
export function buildAgentPrompt(options: {
  prompt: string
  question: string
  files?: readonly string[] | undefined
  /** What exists in this workspace — see `agents/briefing.ts` for why it is worth the tokens. */
  briefing?: string | undefined
}): string {
  const lines = [options.prompt]
  /*
   * Between the role and the question, deliberately.
   *
   * After the role, because "you are a reviewer" has to land before the inventory means anything;
   * before the question, because by the time it is reading the question it should already know
   * what the assistant can be told to do.
   */
  if (options.briefing !== undefined && options.briefing.trim().length > 0) {
    lines.push('', options.briefing)
  }
  lines.push('', '---', '', options.question)
  if (options.files !== undefined && options.files.length > 0) {
    lines.push(
      '',
      'The assistant named these files as relevant. You cannot open them — they are listed so you',
      'know what it is looking at:',
      ...options.files.map((file) => `- ${file}`),
    )
  }
  return lines.join('\n')
}
