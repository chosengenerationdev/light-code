import { z } from 'zod'
import { normalizeForComparison } from '../fs/confine.js'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  path: z.string().min(1).describe('Path to the file, relative to the workspace root.'),
  offset: z.number().int().min(1).optional().describe('1-based line number to start from.'),
  limit: z.number().int().min(1).optional().describe('Maximum number of lines to return.'),
})
export type ReadFileParams = z.infer<typeof paramsSchema>

/**
 * The one place a file gets marked "read this session" — `write_to_file`/`apply_diff`
 * check `context.readFiles` before touching an existing file. See CLAUDE.md §6.
 */
export const readFileTool: Tool<ReadFileParams> = {
  name: 'read_file',
  group: 'read',
  description: 'Read a file with line numbers. Supports offset/limit for large files.',
  parametersSchema: paramsSchema,
  async execute(params, context): Promise<ToolResult> {
    const resolved = await resolveToolPath(context, params.path)
    if (!resolved.ok) return { content: resolved.message, isError: true, path: params.path }

    let raw: string
    try {
      raw = await context.fs.readFile(resolved.realPath)
    } catch (error) {
      return {
        content: `Could not read "${params.path}": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        path: params.path,
      }
    }

    context.readFiles.add(normalizeForComparison(resolved.realPath))

    const lines = raw.split(/\r\n|\r|\n/)
    const start = params.offset !== undefined ? params.offset - 1 : 0
    const end = params.limit !== undefined ? start + params.limit : lines.length
    const numbered = lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join('\n')

    return { content: numbered, path: params.path }
  },
}
