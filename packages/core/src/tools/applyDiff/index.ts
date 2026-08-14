import { z } from 'zod'
import { normalizeForComparison } from '../../fs/confine.js'
import { resolveToolPath } from '../paths.js'
import type { Tool, ToolPreview, ToolResult } from '../types.js'
import { applyDiff } from './apply.js'

const paramsSchema = z.object({
  path: z.string().min(1).describe('Path to the file, relative to the workspace root.'),
  diff: z
    .string()
    .min(1)
    .describe('One or more SEARCH/REPLACE blocks in the standard marker format, targeting this one file.'),
})
export type ApplyDiffParams = z.infer<typeof paramsSchema>

export const applyDiffTool: Tool<ApplyDiffParams> = {
  name: 'apply_diff',
  group: 'edit',
  description:
    'Apply one or more SEARCH/REPLACE blocks to an existing file. The file must have been read with ' +
    'read_file this session. All blocks are validated before any are applied.',
  parametersSchema: paramsSchema,
  async execute(params, context): Promise<ToolResult> {
    const resolved = await resolveToolPath(context, params.path, { write: true })
    if (!resolved.ok) return { content: resolved.message, isError: true, path: params.path }

    if (!context.readFiles.has(normalizeForComparison(resolved.realPath))) {
      return {
        content: `"${params.path}" must be read with read_file before it can be edited.`,
        isError: true,
        path: params.path,
      }
    }

    let original: string
    try {
      original = await context.fs.readFile(resolved.realPath)
    } catch (error) {
      return {
        content: `Could not read "${params.path}": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        path: params.path,
      }
    }

    const result = applyDiff(original, params.diff)
    if (!result.ok) {
      return { content: result.message, isError: true, path: params.path }
    }

    await context.fs.writeFile(resolved.realPath, result.content)
    return { content: result.message, path: params.path }
  },
  async preview(params, context): Promise<ToolPreview> {
    const resolved = await resolveToolPath(context, params.path, { write: true })
    if (!resolved.ok) return { kind: 'text', text: resolved.message }

    let original: string
    try {
      original = await context.fs.readFile(resolved.realPath)
    } catch (error) {
      return { kind: 'text', text: `Could not read "${params.path}": ${error instanceof Error ? error.message : String(error)}` }
    }

    // Runs the real matching cascade without writing, so the approved diff is byte-for-byte
    // what `execute` will produce — not a re-derivation that could drift from it.
    const result = applyDiff(original, params.diff)
    if (!result.ok) {
      return { kind: 'text', text: `This edit would fail: ${result.message}` }
    }
    return { kind: 'diff', path: params.path, before: original, after: result.content }
  },
}
