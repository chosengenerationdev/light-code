import { z } from 'zod'
import { normalizeForComparison } from '../fs/confine.js'
import { countLines, formatBytes, readLineWindow, readTail, SMALL_FILE_BYTES } from './largeFile.js'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  path: z.string().min(1).describe('Path to the file, relative to the workspace root.'),
  offset: z.number().int().min(1).optional().describe('1-based line number to start from.'),
  limit: z.number().int().min(1).optional().describe('Maximum number of lines to return.'),
  tail: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Read this many lines from the END of the file. The usual way into a log.'),
})
export type ReadFileParams = z.infer<typeof paramsSchema>

/** Above this, a window must be asked for — see the refusal message for why. */
const REQUIRE_WINDOW_BYTES = SMALL_FILE_BYTES

/** Default window when a large file is read with `offset` but no `limit`. */
const DEFAULT_LARGE_LIMIT = 500

/**
 * The one place a file gets marked "read this session" — `write_to_file`/`apply_diff`
 * check `context.readFiles` before touching an existing file. See CLAUDE.md §6.
 *
 * ## Large files are read in parts
 *
 * Reading the whole file and then slicing was fine until it met a real log. Beyond a few
 * hundred megabytes it is not merely wasteful: it exceeds V8's maximum string length and
 * throws, so `offset`/`limit` could not rescue it — the whole read happened first.
 *
 * Past `REQUIRE_WINDOW_BYTES` only the requested window is read, and a request with no window
 * at all is refused with the size and the three ways to proceed. Refusing is the useful
 * answer: silently returning the first 500 lines of a 2GB log looks like the whole file and
 * would be reasoned about as if it were.
 */
export const readFileTool: Tool<ReadFileParams> = {
  name: 'read_file',
  group: 'read',
  description:
    'Read a file with line numbers. Use offset/limit to read a window, or tail to read from the end — ' +
    'a large log must be read in parts rather than all at once.',
  parametersSchema: paramsSchema,
  async execute(params, context): Promise<ToolResult> {
    const resolved = await resolveToolPath(context, params.path)
    if (!resolved.ok) return { content: resolved.message, isError: true, path: params.path }

    let size: number
    try {
      size = (await context.fs.stat(resolved.realPath)).size
    } catch (error) {
      return {
        content: `Could not read "${params.path}": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        path: params.path,
      }
    }

    // Marked read before any windowing: the model has seen this file, whichever part of it.
    context.readFiles.add(normalizeForComparison(resolved.realPath))

    try {
      if (size <= REQUIRE_WINDOW_BYTES) {
        return { content: readSmall(await context.fs.readFile(resolved.realPath), params), path: params.path }
      }
      return { content: await readLarge(context.fs, resolved.realPath, params, size), path: params.path }
    } catch (error) {
      return {
        content: `Could not read "${params.path}": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        path: params.path,
      }
    }
  },
}

function number(lines: string[], firstLineNumber: number): string {
  return lines.map((line, index) => `${firstLineNumber + index}\t${line}`).join('\n')
}

/** Small enough to hold, so line numbers are exact and `tail` needs no scanning. */
function readSmall(raw: string, params: ReadFileParams): string {
  const lines = raw.split(/\r\n|\r|\n/)

  if (params.tail !== undefined) {
    const start = Math.max(0, lines.length - params.tail)
    return number(lines.slice(start), start + 1)
  }

  const start = params.offset !== undefined ? params.offset - 1 : 0
  const end = params.limit !== undefined ? start + params.limit : lines.length
  return number(lines.slice(start, end), start + 1)
}

async function readLarge(
  fs: Parameters<typeof readTail>[0],
  realPath: string,
  params: ReadFileParams,
  size: number,
): Promise<string> {
  const human = formatBytes(size)

  if (params.tail !== undefined) {
    const part = await readTail(fs, realPath, size, params.tail)
    return [
      `${human} file — last ${String(part.lines.length)} lines.`,
      /*
       * Said rather than fabricated. Numbering these would mean scanning the whole file from
       * the start to learn where they sit, which is exactly the cost reading backwards avoids.
       */
      'Line numbers are omitted: the file was read from the end, so their positions are unknown.',
      'Use search_files to find a specific string, or offset with limit to read from a known point.',
      '',
      ...part.lines,
    ].join('\n')
  }

  if (params.offset !== undefined) {
    const limit = params.limit ?? DEFAULT_LARGE_LIMIT
    const part = await readLineWindow(fs, realPath, size, params.offset, limit)
    const shown = part.lines.length
    return [
      `${human} file — lines ${String(params.offset)}–${String(params.offset + shown - 1)}${
        part.hasMoreAfter ? ', more follows' : ' (end of file)'
      }.`,
      '',
      number(part.lines, params.offset),
    ].join('\n')
  }

  /*
   * Refused rather than truncated. Returning the first 500 lines of a 2GB log would look
   * exactly like the whole file, and be reasoned about as if it were — the wrong answer
   * delivered confidently. The line count is worth the scan here because it is what makes
   * the next call possible.
   */
  const total = await countLines(fs, realPath, size)
  return [
    `${realPathName(realPath)} is ${human} (${total.toLocaleString()} lines) — too large to read at once.`,
    '',
    'Read part of it instead:',
    `- tail: 200               the end of the log, where recent events are`,
    `- offset: 1, limit: 200   from the start`,
    `- offset: ${Math.max(1, total - 500).toLocaleString()}, limit: 500   near the end, with line numbers`,
    '',
    'Or use search_files, which greps the whole file without loading it and is usually the',
    'faster route when you know what you are looking for.',
  ].join('\n')
}

/** Just the basename, so the refusal message does not carry an absolute path. */
function realPathName(realPath: string): string {
  const parts = realPath.split(/[\\/]/)
  return parts[parts.length - 1] ?? realPath
}
