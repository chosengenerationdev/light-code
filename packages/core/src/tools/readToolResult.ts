import { z } from 'zod'
import type { TruncationStore } from '../agent/truncate.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  handle: z.string().min(1).describe('The handle from a truncated tool result.'),
  offset: z.number().int().min(0).default(0).describe('0-based line to start from.'),
  limit: z.number().int().min(1).default(200).describe('Maximum number of lines to return.'),
})
export type ReadToolResultParams = z.infer<typeof paramsSchema>

/** The re-read half of result truncation — see agent/truncate.ts and CLAUDE.md §12. */
export function createReadToolResultTool(store: TruncationStore): Tool<ReadToolResultParams> {
  return {
    name: 'read_tool_result',
    group: 'read',
    description: 'Read more of a previously truncated tool result, by handle, with an offset.',
    parametersSchema: paramsSchema,
    async execute(params): Promise<ToolResult> {
      const content = await store.read(params.handle, params.offset, params.limit)
      if (content === undefined) {
        return { content: `No stored result found for handle "${params.handle}".`, isError: true }
      }
      return { content }
    },
  }
}
