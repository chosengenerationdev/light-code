import path from 'node:path'
import { z } from 'zod'
import { normalizeForComparison } from '../fs/confine.js'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolPreview, ToolResult } from './types.js'

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
    'An existing file must have been read with read_file this session before it can be overwritten. ' +
    // Pushed back the other way too: a description that only describes itself does not help a
    // model choose between two tools that both write Python to disk.
    'If the user asked for a "tool" and create_python_tool exists, use that instead — a script written here is ' +
    'just a file, and nothing can call it.',
  parametersSchema: paramsSchema,
  async execute(params, context): Promise<ToolResult> {
    const resolved = await resolveToolPath(context, params.path, { write: true })
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
  async preview(params, context): Promise<ToolPreview> {
    const resolved = await resolveToolPath(context, params.path, { write: true })
    if (!resolved.ok) return { kind: 'text', text: resolved.message }

    // Read the file's *current* content so the diff is against reality, not assumption.
    const before = (await context.fs.exists(resolved.realPath))
      ? await context.fs.readFile(resolved.realPath).catch(() => '')
      : ''
    return { kind: 'diff', path: params.path, before, after: params.content }
  },
}
