import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  result: z.string().min(1).describe('The final result to present to the user.'),
})
export type AttemptCompletionParams = z.infer<typeof paramsSchema>

/**
 * A control tool (CLAUDE.md §6): calling it terminates the agent loop entirely — the
 * loop special-cases this tool by name.
 */
export const attemptCompletionTool: Tool<AttemptCompletionParams> = {
  name: 'attempt_completion',
  group: 'always',
  description: 'Signal that the task is complete and present the final result. Terminates the loop.',
  parametersSchema: paramsSchema,
  async execute(params): Promise<ToolResult> {
    return { content: params.result }
  },
}
