/**
 * Consulting a *configured provider profile* as the expert, instead of the Claude CLI.
 *
 * ## Why this exists alongside `claudeCli.ts` rather than replacing it
 *
 * Asked for by the user, for the Node host, in these terms: the expert should be any model they
 * have already configured, and cost is no longer a consideration worth managing in the product.
 * On a server that is plainly right — there is no `claude` binary to detect, no npm prefix to
 * search, and the gateway that answers the chat already has a stronger model behind it.
 *
 * It is an addition because `packages/core` is shared with the extension, where the CLI expert is
 * in use and is not being changed. A host says which kind of expert it has; neither knows about
 * the other.
 *
 * ## What is deliberately absent
 *
 * No budget, no per-consultation cost, no savings figure, no session resume, no keep-alive, no
 * pricing measurement. Every one of those exists because the CLI charges per call and prices a
 * cold start an order of magnitude above a resumed one. A profile on a gateway has none of that
 * shape, and carrying the machinery across would mean reporting numbers nothing measures — which
 * is worse than reporting none, because a number on a screen gets believed.
 *
 * ## What is deliberately kept
 *
 * The answer is **advice, not instructions**. The primary model stays responsible for the work
 * and for checking it against the actual code. A weaker model handed a confident plan will
 * otherwise transcribe it without verifying it, which is the failure this whole feature is for.
 */
export interface ProviderExpertRequest {
  question: string
  /** Workspace-relative paths the asker thinks are relevant. Named, never read from here. */
  files?: string[] | undefined
  signal?: AbortSignal | undefined
}

export interface ProviderExpertResult {
  advice: string
  /** Which profile answered, so the transcript can say whose words these are. */
  producedBy: string
}

export type ProviderExpert = (request: ProviderExpertRequest) => Promise<ProviderExpertResult>

/**
 * What the expert profile is told.
 *
 * Two things it must know that the CLI expert learns by other means.
 *
 * **It cannot see the workspace.** The CLI is given `Read`, `Grep` and `Glob` and gathers its own
 * context; a provider profile is one request with no tools, so everything it needs has to be in
 * the question. Saying so plainly is what stops it answering "I would need to see the file" —
 * a reply that costs a round trip and tells the asker nothing they can act on.
 *
 * **It is advising, not deciding.** Stated as a role rather than a disclaimer appended
 * afterwards, because a model told its job at the start writes a different answer than one told
 * at the end that its answer will be reviewed.
 */
export function buildExpertPrompt(request: ProviderExpertRequest): string {
  const lines = [
    'You are a senior engineer being consulted by another AI assistant that is doing the work.',
    '',
    'It has hit something hard: a multi-file change to plan, a bug it has already failed to fix,',
    'or a design choice to make. Give it your judgement.',
    '',
    'Two things about your position here:',
    '',
    '- You cannot see the workspace and cannot read files, run commands or search. Everything you',
    '  have is below. If something essential is missing, say exactly what you need and why, then',
    '  give the best answer you can without it — do not refuse to answer.',
    '- Your reply is advice. The assistant will check it against the real code before acting, and',
    '  it is responsible for the result. Be concrete, say what you are unsure about, and say when',
    '  a thing must be verified rather than assumed.',
    '',
    'Answer in prose and short lists. No preamble about being happy to help.',
    '',
    '---',
    '',
    request.question,
  ]

  if (request.files !== undefined && request.files.length > 0) {
    lines.push(
      '',
      'The assistant named these files as relevant. You cannot open them — they are listed so you',
      'know what it is looking at:',
      ...request.files.map((file) => `- ${file}`),
    )
  }

  return lines.join('\n')
}
