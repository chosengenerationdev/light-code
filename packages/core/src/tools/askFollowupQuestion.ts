import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  question: z.string().min(1).describe('The clarifying question to ask the user.'),
})
export type AskFollowupQuestionParams = z.infer<typeof paramsSchema>

/**
 * A control tool (CLAUDE.md §6): calling it ends the current turn rather than feeding a
 * result back for another model turn — the agent loop special-cases this tool by name.
 */
export const askFollowupQuestionTool: Tool<AskFollowupQuestionParams> = {
  name: 'ask_followup_question',
  group: 'always',
  description: "Ask the user a clarifying question. Ends this turn; the user's next message is the answer.",
  parametersSchema: paramsSchema,
  async execute(params): Promise<ToolResult> {
    return { content: params.question }
  },
}
