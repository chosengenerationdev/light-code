import path from 'node:path'
import { z } from 'zod'
import { normalizeForComparison } from '../fs/confine.js'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  path: z.string().min(1).describe('Path to the file, relative to the workspace root.'),
  content: z.string().describe('Full file content to write.'),
})
export type WriteToFileParams = z.infer<typeof paramsSchema>

export const writeToFileTool: Tool<WriteToFileParams> = {
  name: 'write_to_file',
  group: 'edit',
  description:
    'Write full file content, creating the file (and any missing parent directories) if it does not exist. ' +
    'An existing file must have been read with read_file this session before it can be overwritten.',
  parametersSchema: paramsSchema,
  async execute(params, context): Promise<ToolResult> {
    const resolved = await resolveToolPath(context, params.path)
    if (!resolved.ok) return { content: resolved.message, isError: true, path: params.path }

    const exists = await context.fs.exists(resolved.realPath)
    if (exists && !context.readFiles.has(normalizeForComparison(resolved.realPath))) {
      return {
        content: `"${params.path}" must be read with read_file before it can be edited.`,
        isError: true,
        path: params.path,
      }
    }

    if (!exists) {
      await context.fs.mkdir(path.dirname(resolved.realPath))
    }
    await context.fs.writeFile(resolved.realPath, params.content)
    context.readFiles.add(normalizeForComparison(resolved.realPath))

    return { content: `Wrote ${params.content.length} characters to "${params.path}".`, path: params.path }
  },
}
