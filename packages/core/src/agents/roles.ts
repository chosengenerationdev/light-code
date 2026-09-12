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

export type BuiltInRole = (typeof AGENT_ROLES)[number]

/**
 * A role id — one of the five built in, or one the user defined.
 *
 * ## Why this is a string rather than a union
 *
 * The five cover most of a development cycle, and the ones people ask for next are almost always
 * *a reviewer with a different prompt*: a security reviewer, a performance reviewer, an
 * accessibility reviewer. Adding each as a fixed role means editing twelve files, growing the
 * roster the expert has to allocate from, and still not having the one the next person wants. A
 * role is its prompt; making that user-definable answers the whole family at once.
 *
 * The cost is that nothing can exhaustively switch on a role any more. That is genuinely fine
 * here — every consumer either looks a role up or asks the resolved team whether it exists — and
 * `roleInfo` returns a described placeholder rather than throwing for an id that has gone.
 */
export type AgentRole = string

/** A role the user invented: the whole of what makes it a role. */
export interface CustomRoleDefinition {
  id: string
  name: string
  summary: string
  prompt: string
  /** Whether it may read and search the workspace. Absent means yes; see `roleInfo`. */
  usesTools?: boolean | undefined
  /** Whether it may edit files and record skills, each through the approval gate. Absent means no. */
  canWrite?: boolean | undefined
}

/**
 * Few enough that the roster stays short.
 *
 * The expert allocates from that list, and its judgement is the bottleneck — four separate
 * misallocations have been reported with five roles. A cap is the honest answer to "can I have
 * twenty", which would produce a plan that names whichever three sounded relevant.
 */
export const CUSTOM_ROLE_LIMIT = 5

/*
 * Lowercase, no spaces: the id reaches a CSS custom property (`--lc-agent-<id>`), a config key
 * and the `ask_agent` argument the model types. Somewhere in that chain a space or a capital
 * would be mangled silently, and the symptom would be a role that simply never answers.
 */
const ROLE_ID = /^[a-z][a-z0-9-]{1,23}$/

export function isValidRoleId(id: string): boolean {
  return ROLE_ID.test(id) && !(AGENT_ROLES as readonly string[]).includes(id)
}

export function isAgentRole(value: string, custom: readonly CustomRoleDefinition[] = []): boolean {
  return (
    (AGENT_ROLES as readonly string[]).includes(value) ||
    custom.some((role) => role.id === value)
  )
}

/** Every role that exists on this machine, built-in first so the familiar ones lead. */
export function knownRoles(custom: readonly CustomRoleDefinition[] = []): string[] {
  return [...AGENT_ROLES, ...custom.map((role) => role.id)]
}

export interface AgentRoleInfo {
  role: AgentRole
  name: string
  /** One line, for the picker and for the tool's own description. */
  summary: string
  /** What this role is told it is. Editable; see above. */
  prompt: string
  /**
   * Whether this specialist may look things up for itself.
   *
   * On where the answer depends on material the asker cannot reasonably paste — the librarian
   * searching what is written down, the expert planning across files, the reviewer wanting the
   * callers of a change. Off where the question already contains everything: the programmer
   * writing to a spec, the tester reasoning about what breaks. A lookup it did not need is a
   * round trip and a slower answer that is no better.
   */
  usesTools: boolean
  /**
   * Whether this specialist may *change* things, not merely read them.
   *
   * Off everywhere by default, and off is where this design starts: §12b's load-bearing decision
   * is that a consultant is read-only, because a second agent mutating the repository would sit
   * outside the approval gate everything else goes through.
   *
   * It can be switched on per role because that objection is answerable now rather than
   * structural — `runConsultation` routes every non-read call through the same gate the agent
   * loop uses, so a specialist's edit is approved exactly as the assistant's would be. What it
   * still costs is attention: the approval arrives mid-consultation, about work the user did not
   * watch being decided.
   */
  canWrite: boolean
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
/**
 * What every specialist is told, in the version that matches what it can actually do.
 *
 * ## The correction this encodes
 *
 * There used to be one preamble, opening "You cannot see the workspace and cannot read files, run
 * commands or search". That was true when a consultation was a single request, and it stopped
 * being true when `agents/consult.ts` gave provider-backed specialists the read tool group and the
 * CLI expert its own Read/Grep/Glob. The text stayed. So a librarian — whose entire job is what has
 * been written down in this workspace — was being told it could not go and read any of it, and
 * answered from whatever happened to be pasted into the question. It is the weakest of the five
 * roles for exactly that reason, and the reason was a stale sentence.
 *
 * ## Why not simply give every role tools
 *
 * Each lookup is a round trip and a slice of the step budget, and two of the roles do not need
 * any: the programmer is handed a spec and the surrounding code and asked to write, and the tester
 * reasons about what breaks from the change in front of it. Offering tools there buys a slower
 * answer that is no better. So it is a per-role flag with a sensible default, and the user can
 * change it — `usesTools` in `AgentRoleInfo`, overridable per assignment.
 */
const SHARED_TAIL = [
  'Your reply is advice. The assistant will check it against the real code before acting, and it',
  'is responsible for the result. Be concrete, say what you are unsure about, and say plainly when',
  'something must be verified rather than assumed.',
  '',
  'Answer in prose and short lists. No preamble about being happy to help.',
]

/** What a role that may change things is told, appended to whichever preamble it has. */
const MAY_WRITE = [
  '',
  'You can also change this workspace: edit files, and record a skill. Every such change is shown',
  'to the user and approved by them before it happens, so make each one small enough to read and',
  'say what it is for. Prefer telling the assistant what to change where the change is large or',
  'spans files — it has the whole picture and you have only what you asked for.',
].join('\n')

/** For a role that can look things up. Read-only by construction — see `agents/consult.ts`. */
const SHARED_WITH_TOOLS = [
  'You can read this workspace: open files, list them, and search. Use that rather than guessing,',
  'and rather than asking the assistant for something you can fetch yourself. You have a small',
  'budget of lookups, so go for what actually settles the question.',
  '',
  'You cannot edit anything, run anything, or reach the network. If something needs changing, say',
  'what and why — the assistant makes the change and is responsible for it.',
  '',
  ...SHARED_TAIL,
].join('\n')

/** For a role that is given everything it needs in the question. */
const SHARED_BLIND = [
  'You have no tools and cannot see the workspace. Everything you have is in the question. If',
  'something essential is missing, say exactly what you need and why, then give the best answer you',
  'can without it — never refuse to answer.',
  '',
  ...SHARED_TAIL,
].join('\n')

/**
 * A role's own instruction plus the half that is not the user's to edit.
 *
 * Appended at assembly rather than stored in the prompt, so that editing a role — or writing a
 * custom one — cannot remove the sentences that say what it may and may not do. Before this, the
 * built-in prompts carried it inline and an edit could delete it silently.
 */
export function specialistPreamble(usesTools: boolean, canWrite = false): string {
  const base = usesTools ? SHARED_WITH_TOOLS : SHARED_BLIND
  /*
   * Appended rather than replacing the "cannot edit anything" sentence above it, which would leave
   * a preamble contradicting itself. Both preambles say what a specialist cannot do; this says
   * what it additionally can, and it appears only where the user switched it on.
   */
  return canWrite ? `${base}${MAY_WRITE}` : base
}

const DEFINITIONS: Record<BuiltInRole, Omit<AgentRoleInfo, 'role'>> = {
  expert: {
    name: 'Expert',
    summary: 'Hard problems, architecture, and deciding what to do',
    /* Planning a change means knowing what is already there, and it spans files the asker
     * cannot paste all of. */
    usesTools: true,
    canWrite: false,
    prompt: [
      'You are a senior engineer being consulted by another AI assistant that is doing the work.',
      '',
      'It has hit something hard: a change across several files to plan, a bug it has already',
      'failed to fix, or a design choice with no obvious answer. Give it your judgement.',
      '',
      'Decide *what* should happen and why. Leave the typing to the assistant — it is the one',
      'making the change and answering for it. Where there is a real trade-off, name both sides',
      'and then choose.',
    ].join('\n'),
  },
  programmer: {
    name: 'Programmer',
    summary: 'Writes the code once the plan is settled',
    /* It is handed a spec and the surrounding code and asked to write. Looking around buys
     * a slower answer that is no better. */
    usesTools: false,
    canWrite: false,
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
      /*
       * The programmer is the role that gets its own work handed back, so it is the one that has
       * to be told what to do with a review — including that it may disagree. Requested in those
       * terms: it is classified as the programmer, so fixing it is its job, and it should be able
       * to challenge a reviewer rather than obey one.
       */
      'You may be given a review of code you wrote. Fix what is genuinely wrong and return the',
      'corrected code the same way. **Where the review is wrong, say so and say why** — a finding',
      'can be about a path that cannot happen, a convention this codebase does not follow, or a',
      'misreading of a fragment. Do not rewrite working code to satisfy an objection you think is',
      'mistaken; the assistant has the real file and will settle it. Changing something you believe',
      'is right, because you were told to, is the worse failure: it looks like agreement.',
    ].join('\n'),
  },
  reviewer: {
    name: 'Reviewer',
    summary: 'Reads a change and says what is wrong with it',
    /* Most of what a review turns on is *around* the diff — the callers, the neighbouring
     * function, whether this convention is really the convention. */
    usesTools: true,
    canWrite: false,
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
      // Findings go back to whoever wrote the code, which may disagree. Concrete ones can be
      // settled against the file; vague ones turn into an argument nobody can end.
      'Your findings may be put to the person who wrote the code, who can disagree with them. That',
      'is why each one needs an input and an outcome: a finding stated concretely can be checked',
      'against the real file and settled, and one stated as a preference cannot.',
    ].join('\n'),
  },
  tester: {
    name: 'Tester',
    summary: 'Designs cases and finds what breaks it',
    /* The change is in front of it and the cases come from reasoning about it, not from
     * reading more of the codebase. */
    usesTools: false,
    canWrite: false,
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
    ].join('\n'),
  },
  librarian: {
    name: 'Librarian',
    summary: 'Skills, internal documentation and house conventions',
    /* Its whole job is what has been written down here, so being unable to go and read it
     * left it answering from whatever happened to be pasted in. This is the role the flag
     * exists for. */
    usesTools: true,
    canWrite: false,
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
      /*
       * The one specialist that may write, and only this one thing.
       *
       * The objection was never that the librarian should not record what it knows — it is the
       * role that can see the gap. It was that a consultation asks nobody, so a skill written
       * there would be prose injected into every later prompt that no human had read (§13's
       * persistent prompt-injection vector). That was answered by making this path *ask*:
       * `runConsultation` routes anything in ALWAYS_ASK_TOOLS through the same approval gate the
       * agent loop uses, so the user sees the source exactly as they would for any other write.
       *
       * Everything else stays read-only. `consultBoundary.test.ts` holds that line, and pins the
       * rule that any name allowed past the group filter must be one the gate will stop on.
       */
      'When the answer is something worth writing down — a convention you had to piece together,',
      'a gotcha that will catch the next person, a procedure that is currently only in somebody\'s',
      'head — say so and **write it with `write_skill`**. The user is shown the text and',
      'approves it before anything is recorded, so write it as it should stand rather than',
      'describing what it would say. If they decline, say what you would have written and why.',
      '',
      'Say plainly when something already written down is **wrong or out of date**. A stale skill',
      'is worse than a missing one, because it is believed.',
    ].join('\n'),
  },
}

export function roleInfo(
  role: AgentRole,
  custom: readonly CustomRoleDefinition[] = [],
): AgentRoleInfo {
  const builtIn = DEFINITIONS[role as BuiltInRole] as Omit<AgentRoleInfo, 'role'> | undefined
  if (builtIn !== undefined) return { role, ...builtIn }

  const defined = custom.find((candidate) => candidate.id === role)
  if (defined !== undefined) {
    return {
      role,
      name: defined.name,
      summary: defined.summary,
      prompt: defined.prompt.trim(),
      /*
       * Custom roles get tools by default.
       *
       * They are overwhelmingly reviewers of some particular kind — security, performance,
       * accessibility — and those all turn on code the asker did not think to paste. The flag is
       * there to turn it off for the ones that are really "write this to spec".
       */
      usesTools: defined.usesTools !== false,
      // Off unless asked for: a role invented in a hurry should not be able to edit the
      // repository because nobody thought about the box.
      canWrite: defined.canWrite === true,
    }
  }

  /*
   * An id with no definition: a custom role deleted while a chat still references it, or a
   * hand-edited config. Described rather than thrown, because the caller is usually rendering a
   * list and an exception there takes a panel down over a stale name.
   */
  return {
    role,
    name: role,
    summary: 'This role is no longer defined.',
    prompt: '',
    usesTools: false,
    canWrite: false,
  }
}

export function allRoles(custom: readonly CustomRoleDefinition[] = []): AgentRoleInfo[] {
  return knownRoles(custom).map((role) => roleInfo(role, custom))
}

/** The default prompt, so an edited one can be compared against it and reset to it. */
export function defaultPromptFor(
  role: AgentRole,
  custom: readonly CustomRoleDefinition[] = [],
): string {
  return roleInfo(role, custom).prompt
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
  /**
   * Whether this role may look things up, which changes two things in here.
   *
   * The preamble it is given, and what the named files mean — to a role with tools they are a
   * starting point, and to one without they are context it will never see. Getting the second
   * wrong is how a specialist ends up asking for a file it has been told it cannot open.
   */
  usesTools: boolean
  /** Whether it may change things, which adds a paragraph saying what that means. */
  canWrite?: boolean | undefined
}): string {
  /*
   * Role, then the half that is not editable.
   *
   * Appended here rather than stored in the prompt so that editing a role — or writing a custom
   * one — cannot delete the sentences saying what it may and may not do. They used to live inline
   * in each built-in prompt, one edit away from being gone.
   */
  const lines = [
    options.prompt.trim(),
    '',
    specialistPreamble(options.usesTools, options.canWrite === true),
  ]
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
      options.usesTools
        ? 'The assistant named these files as relevant. Start there — you can open them yourself:'
        : 'The assistant named these files as relevant. You cannot open them — they are listed so' +
          ' you know what it is looking at:',
      ...options.files.map((file) => `- ${file}`),
    )
  }
  return lines.join('\n')
}
