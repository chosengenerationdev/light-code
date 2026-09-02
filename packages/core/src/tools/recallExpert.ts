import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'

/** One consultation, kept so it can be re-read without paying for it again. */
export interface ExpertConsultationRecord {
  at: number
  question: string
  advice: string
}

export interface RecallExpertOptions {
  /** Consultations in the current task, oldest first. */
  history: () => readonly ExpertConsultationRecord[]
}

const paramsSchema = z.object({
  /** Optional, because "what did it say" is usually the whole request. */
  contains: z
    .string()
    .optional()
    .describe('Only return consultations mentioning this word or phrase. Omit to get them all.'),
})
export type RecallExpertParams = z.infer<typeof paramsSchema>

/**
 * Returns what the expert has already said in this task, free.
 *
 * ## Why this exists
 *
 * Advice is expensive and easy to lose. A turn that fails partway, a tool error, a cancelled
 * run, history compacted after a long session — any of them can leave the model without the plan
 * it already paid for, and the obvious recovery is to ask again. That is the one recovery that
 * costs money, and it buys an answer the user has already bought.
 *
 * The record is kept host-side for the life of the task, so recalling it is a lookup rather than
 * a consultation. **Free by construction**: this tool has no path to the CLI at all, which is
 * what makes it safe to tell the model to reach for it first.
 *
 * ## What it is not
 *
 * Not a cache that answers *new* questions. It returns what was said, verbatim, with the
 * question it answered — judging whether that still applies is the model's job, and pretending
 * an old answer covers a new question is how a cache becomes a source of confident errors.
 */
export function createRecallExpertTool(options: RecallExpertOptions): Tool<RecallExpertParams> {
  return {
    name: 'recall_expert_advice',
    group: 'read',
    description:
      'Re-read advice the expert already gave in this task, at no cost. Check here before ' +
      'calling ask_expert — if a plan was lost to an error or a long conversation, it can be ' +
      'recovered instead of bought again. Returns previous answers verbatim; it never asks ' +
      'anything new.',
    parametersSchema: paramsSchema,
    async execute(params): Promise<ToolResult> {
      const all = options.history()
      if (all.length === 0) {
        return {
          content:
            'The expert has not been consulted in this task yet, so there is nothing to recall. ' +
            'Use ask_expert if you need advice.',
        }
      }

      const needle = params.contains?.trim().toLowerCase()
      const matches =
        needle === undefined || needle.length === 0
          ? all
          : all.filter(
              (entry) =>
                entry.question.toLowerCase().includes(needle) || entry.advice.toLowerCase().includes(needle),
            )

      if (matches.length === 0) {
        // Says how many exist, so "nothing matched" is not mistaken for "nothing was ever said"
        // — which would send the model straight back to paying for a fresh consultation.
        return {
          content: `No consultation in this task mentions "${params.contains ?? ''}". There ${
            all.length === 1 ? 'is 1 consultation' : `are ${String(all.length)} consultations`
          } recorded; call this again without a filter to see them.`,
        }
      }

      return {
        content: [
          `${String(matches.length)} previous consultation(s) in this task:`,
          '',
          ...matches.map((entry, index) =>
            [
              `### ${String(index + 1)}. asked at ${new Date(entry.at).toLocaleTimeString()}`,
              `**You asked:** ${entry.question}`,
              '',
              entry.advice,
            ].join('\n'),
          ),
        ].join('\n\n'),
      }
    },
  }
}
