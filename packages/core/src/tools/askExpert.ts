import { z } from 'zod'
import { consultExpert, type ClaudeCliInfo } from '../expert/claudeCli.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe(
      'The question, with the code and context needed to answer it. The expert cannot see this conversation.',
    ),
  files: z
    .array(z.string())
    .optional()
    .describe('Workspace-relative paths worth reading. The expert can open these itself.'),
})
export type AskExpertParams = z.infer<typeof paramsSchema>

export interface AskExpertOptions {
  cli: ClaudeCliInfo
  /** Overrides the model the CLI would pick — e.g. a cheaper one for routine consultations. */
  model?: string
  /**
   * Called once per completed consultation so the host can total the spend.
   *
   * A callback rather than a field on `ToolResult`: cost is specific to this one tool, and
   * widening the shared result type would invite every future tool to add its own. The
   * alternative — parsing the dollar figure back out of the result text — would break
   * silently the moment that wording changed.
   *
   * `costUsd` is absent when the CLI reports none, which is not the same as zero and must
   * not be totalled as such.
   */
  onConsultation?: (info: { costUsd?: number; isError: boolean }) => void
  /**
   * Continues one conversation with the expert across consultations, instead of starting
   * cold each time.
   *
   * Measured (CLI 2.1.227): cold costs $0.187 and creates an 18,643-token cache; resumed
   * costs $0.0099 and reads it. That is the difference between the expert being an
   * occasional luxury and something a junior can lean on.
   *
   * A getter/setter pair rather than internal state because the *task* owns the session —
   * it has to reset when the user starts a new one, and the tool is rebuilt every turn.
   */
  session?: {
    get: () => string | undefined
    set: (sessionId: string) => void
  }
  /**
   * A compact inventory of what the junior can do, sent **once per session**.
   *
   * The expert runs in its own CLI process with only `Read`/`Grep`/`Glob`. It cannot call an
   * MCP tool, a Python tool, or `search_docs`, and has no way to discover that any of them
   * exist. Without this it plans as though the junior were a bare shell, and recommends doing
   * by hand what a configured tool already does.
   *
   * **Names and one-line descriptions only — never JSON schemas.** Forty MCP tools cost a few
   * hundred tokens as a list and several thousand as schemas, and the expert does not need a
   * schema to *choose* a tool. When it needs the exact parameters it asks the junior to fetch
   * them with `search_docs`, which is the same name-first, body-on-demand split §13 already
   * makes for skills.
   *
   * Sent only when a session is being started, because a resumed expert already has it.
   */
  briefing?: () => string
}

/**
 * Consults a stronger model through the Claude CLI.
 *
 * Deliberately in the `read` group. It changes nothing in the workspace — the expert is
 * read-only — so gating it behind edit approval would be misleading about what it does.
 * It is still approval-gated like every other tool, which matters here because each call
 * costs real money.
 *
 * The answer comes back as advice, not instructions. The primary model stays responsible
 * for the work and for checking it against the actual code; that is stated in the result
 * as well as the system prompt, because a weak model will otherwise transcribe a plan it
 * has not verified.
 */
export function createAskExpertTool(options: AskExpertOptions): Tool<AskExpertParams> {
  return {
    name: 'ask_expert',
    group: 'read',
    description:
      'Consult a stronger expert model about a hard problem: planning a multi-file change, ' +
      'diagnosing a bug you have already failed to fix, or choosing between designs. ' +
      'Each call costs the user money, so use it for genuinely difficult questions only. ' +
      'The expert can read the workspace but cannot edit or run anything. ' +
      'Consultations within one task continue the same conversation, so after the first one it ' +
      'remembers what you already told it — a follow-up is far cheaper than a fresh explanation.',
    parametersSchema: paramsSchema,
    async preview(params) {
      return {
        kind: 'text' as const,
        // Ground truth (invariant 8): the user sees the question that will actually be
        // sent, not a summary of it, because they are paying for it.
        text: `Consult the expert (${options.cli.executable}):\n\n${params.question}${
          params.files !== undefined && params.files.length > 0 ? `\n\nSuggested files: ${params.files.join(', ')}` : ''
        }`,
      }
    },
    async execute(params, context): Promise<ToolResult> {
      const question =
        params.files !== undefined && params.files.length > 0
          ? `${params.question}\n\nRelevant files in this workspace:\n${params.files.map((file) => `- ${file}`).join('\n')}`
          : params.question

      const previousSession = options.session?.get()

      /*
       * Prepended only on a cold session. On a resume the expert still has it, and re-sending
       * would pay for the inventory again on every consultation — the exact waste the session
       * exists to avoid.
       */
      const briefing = previousSession === undefined ? options.briefing?.() : undefined
      const withBriefing =
        briefing !== undefined && briefing.length > 0 ? `${briefing}\n\n---\n\n${question}` : question

      const answer = await consultExpert(options.cli, {
        question: withBriefing,
        cwd: context.workspaceRoot,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(previousSession !== undefined ? { resumeSessionId: previousSession } : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      })

      // Stored before the error check: a failed answer still leaves a usable session, and
      // discarding it would make the retry pay the cold-start price.
      if (answer.sessionId !== undefined) options.session?.set(answer.sessionId)

      // Reported even when the consultation failed: one that errored partway can still have
      // cost money, and a total quietly omitting those would understate the spend.
      options.onConsultation?.({
        isError: answer.isError,
        ...(answer.costUsd !== undefined ? { costUsd: answer.costUsd } : {}),
      })

      if (answer.isError) {
        return { content: `The expert could not answer: ${answer.text}`, isError: true }
      }

      const notes: string[] = []
      /*
       * Told explicitly, because the model cannot observe it and the default assumption is
       * the opposite — the tool description says the expert cannot see this conversation,
       * which remains true of the *chat* but not of earlier consultations. Without this the
       * junior re-pastes context every time and throws away the saving the session exists for.
       */
      if (previousSession !== undefined && answer.resumeFailed !== true) {
        notes.push(
          'This continued your earlier consultation — the expert still remembers what you asked ' +
            'before in this task, so do not repeat context you have already given it.',
        )
      } else if (answer.resumeFailed === true) {
        notes.push('The earlier consultation could not be resumed, so this one started fresh with no memory of it.')
      }
      if (answer.deniedTools.length > 0) {
        // Surfaced rather than swallowed: if the expert wanted to edit or run something,
        // the primary model should know its answer was formed without that, and the user
        // should see what it reached for.
        notes.push(
          `The expert requested tools it is not permitted to use (${answer.deniedTools.join(', ')}) and worked without them.`,
        )
      }
      if (answer.costUsd !== undefined) notes.push(`Cost: $${answer.costUsd.toFixed(4)}.`)

      return {
        content: [
          answer.text,
          '',
          '---',
          'This is advice from a consulting model that cannot see your conversation and did not',
          'run anything. Verify it against the real code before acting, and say so if you disagree.',
          ...(notes.length > 0 ? ['', ...notes] : []),
        ].join('\n'),
      }
    },
  }
}
