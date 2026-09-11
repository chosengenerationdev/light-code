import { z } from 'zod'

import type { ProviderExpert } from '../expert/providerExpert.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe(
      'The question, with the code and context needed to answer it. The expert cannot see this ' +
        'conversation and cannot read files — paste what matters.',
    ),
  files: z
    .array(z.string())
    .optional()
    .describe(
      'Workspace-relative paths you are working in, so the expert knows what you are looking at.',
    ),
})
export type AskProviderExpertParams = z.infer<typeof paramsSchema>

export interface AskProviderExpertOptions {
  consult: ProviderExpert
  /** The profile's label, for the approval preview — which says who is about to be asked. */
  label: string
  /**
   * Keeps the answer so it can be re-read for free — see `recall_expert_advice`.
   *
   * Called with the advice as the model receives it, before the framing note is added, so a
   * recall reads as the expert's words rather than as a copy of a tool result.
   */
  onAdvice?: (record: { at: number; question: string; advice: string }) => void
}

/**
 * `ask_expert`, answered by a configured provider profile.
 *
 * ## Why it is a separate tool from the CLI one rather than a branch inside it
 *
 * They differ in what they can truthfully say. The CLI expert reads the workspace, continues one
 * conversation across consultations, and costs a measurable amount per call — so its description
 * tells the model to spend carefully and that a follow-up is cheap. None of that is true here,
 * and a description carrying it would be actively misleading: the model would hoard consultations
 * that cost nothing to repeat, and expect a memory that does not exist.
 *
 * The *name* is the same on purpose. Everything downstream — the approval gate, the transcript,
 * `recall_expert_advice`, the guidance in Junior mode — refers to `ask_expert`, and a host
 * swapping which expert answers should not be a rename that reaches all of that.
 *
 * ## Same group, same gate
 *
 * `read`, and approval-gated like everything else. It sends the user's code to a model, which is
 * the thing worth showing them before it happens — and the preview is the literal question
 * (invariant 8), not a summary of it.
 */
export function createAskProviderExpertTool(
  options: AskProviderExpertOptions,
): Tool<AskProviderExpertParams> {
  return {
    name: 'ask_expert',
    group: 'read',
    description:
      'Consult a stronger expert model about a hard problem: planning a multi-file change, ' +
      'diagnosing a bug you have already failed to fix, or choosing between designs. ' +
      'The expert cannot see this conversation, cannot read files and does not remember earlier ' +
      'consultations — put everything it needs in the question, including the relevant code. ' +
      'What comes back is advice: check it against the real code before acting on it.',
    parametersSchema: paramsSchema,

    async preview(params) {
      return {
        kind: 'text' as const,
        // Ground truth (invariant 8): the question that will actually be sent, in full. This
        // puts the user's code in front of another model, which is the decision being approved.
        text: `Consult the expert (${options.label}):\n\n${params.question}${
          params.files !== undefined && params.files.length > 0
            ? `\n\nFiles named as relevant: ${params.files.join(', ')}`
            : ''
        }`,
      }
    },

    async execute(params, context): Promise<ToolResult> {
      let result
      try {
        result = await options.consult({
          question: params.question,
          ...(params.files !== undefined ? { files: params.files } : {}),
          ...(context.signal !== undefined ? { signal: context.signal } : {}),
        })
      } catch (error) {
        return {
          content: `The expert could not be reached: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        }
      }

      if (result.advice.trim().length === 0) {
        return {
          content:
            'The expert returned nothing. That usually means the profile configured as the ' +
            'expert answered with an empty response — check it in Settings → Expert.',
          isError: true,
        }
      }

      options.onAdvice?.({ at: Date.now(), question: params.question, advice: result.advice })

      return {
        content:
          `${result.advice}\n\n---\n\n` +
          `That is advice from ${result.producedBy}, which has not seen your workspace. Check it ` +
          'against the actual code before acting on it, and say so if it turns out to be wrong.',
      }
    },
  }
}
