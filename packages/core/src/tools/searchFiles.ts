import { execFile } from 'node:child_process'
import { z } from 'zod'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  path: z.string().min(1).default('.').describe('Directory to search, relative to the workspace root.'),
  pattern: z.string().min(1).describe('Regular expression to search for.'),
  filePattern: z.string().optional().describe('Glob to restrict which files are searched, e.g. "*.ts".'),
})
export type SearchFilesParams = z.infer<typeof paramsSchema>

function isRipgrepNoMatchError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 1
}

function runRipgrepSearch(
  rgPath: string,
  dir: string,
  pattern: string,
  filePattern: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const args = ['--line-number', '--context', '2', '--hidden', '-g', '!.git', '-g', '!node_modules']
  if (filePattern !== undefined) args.push('-g', filePattern)
  args.push('--regexp', pattern, '.')

  return new Promise((resolve, reject) => {
    execFile(rgPath, args, { cwd: dir, signal, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error && !isRipgrepNoMatchError(error)) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

export const searchFilesTool: Tool<SearchFilesParams> = {
  name: 'search_files',
  group: 'read',
  description: 'Search for a regular expression across files, with surrounding context lines.',
  parametersSchema: paramsSchema,
  async execute(params, context): Promise<ToolResult> {
    const resolved = await resolveToolPath(context, params.path)
    if (!resolved.ok) return { content: resolved.message, isError: true }

    if (context.ripgrepPath === undefined) {
      return { content: 'Search is unavailable: ripgrep was not found on this installation.', isError: true }
    }

    try {
      const output = await runRipgrepSearch(
        context.ripgrepPath,
        resolved.realPath,
        params.pattern,
        params.filePattern,
        context.signal,
      )
      return { content: output.trim().length > 0 ? output : '(no matches)' }
    } catch (error) {
      return { content: `Search failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
  },
}
