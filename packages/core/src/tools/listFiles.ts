import { execFile } from 'node:child_process'
import { z } from 'zod'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  path: z.string().min(1).default('.').describe('Directory to list, relative to the workspace root.'),
  recursive: z.boolean().optional().describe('List the full subtree instead of just this directory.'),
  /**
   * Ignored files are skipped by default, and that surprises people.
   *
   * A recursive listing goes through ripgrep, which honours `.gitignore` — so `.venv`, `dist`
   * and anything else the repository ignores comes back empty, with no error and no hint that a
   * rule was applied. Someone asking to list a virtualenv is not asking about version control,
   * and "there is nothing there" is a wrong answer to their question.
   */
  includeIgnored: z
    .boolean()
    .optional()
    .describe('Include files excluded by .gitignore — needed for .venv, dist, and similar folders.'),
})
export type ListFilesParams = z.infer<typeof paramsSchema>

function isRipgrepNoMatchError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 1
}

function runRipgrepFiles(
  rgPath: string,
  dir: string,
  signal: AbortSignal | undefined,
  includeIgnored: boolean,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      rgPath,
      [
        '--files',
        '--hidden',
        ...(includeIgnored ? ['--no-ignore-vcs'] : []),
        // Excluded even then: neither is ever what someone means by "show me the ignored
        // files", and one of them is enormous.
        '-g',
        '!.git',
        '-g',
        '!node_modules',
      ],
      { cwd: dir, signal, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        // ripgrep exits with code 1 when it simply finds nothing — not a real error.
        if (error && !isRipgrepNoMatchError(error)) {
          reject(error)
          return
        }
        resolve(stdout.split(/\r?\n/).filter((line) => line.length > 0))
      },
    )
  })
}

/**
 * Recursive listing goes through ripgrep (fast, respects `.gitignore`-style excludes).
 * Non-recursive listing uses the plain `FileSystem` interface instead — ripgrep has no
 * "immediate children only" mode, and a single `readdir` is simpler for that case.
 */
export const listFilesTool: Tool<ListFilesParams> = {
  name: 'list_files',
  group: 'read',
  description: 'List files in a directory. Set recursive to list the full subtree (ignores node_modules and .git).',
  parametersSchema: paramsSchema,
  async execute(params, context): Promise<ToolResult> {
    const resolved = await resolveToolPath(context, params.path)
    if (!resolved.ok) return { content: resolved.message, isError: true }

    if (params.recursive === true) {
      if (context.ripgrepPath === undefined) {
        return {
          content: 'Recursive listing is unavailable: ripgrep was not found. List one directory at a time instead.',
          isError: true,
        }
      }
      try {
        const files = await runRipgrepFiles(
          context.ripgrepPath,
          resolved.realPath,
          context.signal,
          params.includeIgnored === true,
        )
        if (files.length > 0) return { content: files.join('\n') }
        // Says which rule may have hidden them, rather than leaving "nothing here" to be read
        // as fact — an empty ignored folder and an ignored one look identical otherwise.
        return {
          content:
            params.includeIgnored === true
              ? '(no files found)'
              : '(no files found — .gitignore-excluded files are skipped; retry with includeIgnored: true)',
        }
      } catch (error) {
        return { content: `Could not list files: ${error instanceof Error ? error.message : String(error)}`, isError: true }
      }
    }

    const entries = await context.fs.readdir(resolved.realPath)
    const visible = entries.filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
    const lines = visible.map((entry) => (entry.isDirectory ? `${entry.name}/` : entry.name))
    return { content: lines.length > 0 ? lines.join('\n') : '(empty directory)' }
  },
}
