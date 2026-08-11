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
      'The expert can read the workspace but cannot edit or run anything.',
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

      const answer = await consultExpert(options.cli, {
        question,
        cwd: context.workspaceRoot,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      })

      if (answer.isError) {
        return { content: `The expert could not answer: ${answer.text}`, isError: true }
      }

      const notes: string[] = []
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
