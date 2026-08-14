import { z } from 'zod'
import { documentKindFor, extractDocument, DocumentError } from '../documents/extract.js'
import { normalizeForComparison } from '../fs/confine.js'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  path: z.string().min(1).describe('Path to the document, relative to the workspace root.'),
  sheet: z
    .string()
    .optional()
    .describe('For a spreadsheet: the worksheet name, or its 1-based number. Defaults to the first.'),
  offset: z.number().int().min(1).optional().describe('1-based line of the extracted text to start from.'),
  limit: z.number().int().min(1).optional().describe('How many lines of extracted text to return.'),
})
export type ReadDocumentParams = z.infer<typeof paramsSchema>

/**
 * Reads a Word document, spreadsheet or HTML page as text.
 *
 * `read_file` decodes UTF-8, which turns a `.docx` into pages of mojibake — the file is a ZIP
 * archive, not text. This extracts the actual content instead.
 *
 * **Ranged like `read_file`, and for the same reason.** A spreadsheet can extract to far more
 * text than a context window holds, so `offset`/`limit` page through it and a workbook yields
 * one sheet at a time. Oversized results still spill through the usual truncation path (§12),
 * so this can never be the thing that fills the window.
 *
 * PDF is deliberately absent. Word, Excel and HTML need no dependency at all; PDF needs a real
 * parser for compressed content streams and font-level character maps, and that is a bundle
 * decision rather than a parsing chore. Saying so plainly beats returning something garbled.
 */
export const readDocumentTool: Tool<ReadDocumentParams> = {
  name: 'read_document',
  group: 'read',
  description:
    'Read a Word document (.docx), spreadsheet (.xlsx) or HTML page as plain text. ' +
    'Use this instead of read_file for those formats — read_file returns unreadable binary for them. ' +
    'Supports offset/limit for long documents, and a sheet name for workbooks.',
  parametersSchema: paramsSchema,

  async execute(params, context): Promise<ToolResult> {
    const resolved = await resolveToolPath(context, params.path)
    if (!resolved.ok) return { content: resolved.message, isError: true, path: params.path }

    const kind = documentKindFor(params.path)
    if (params.path.toLowerCase().endsWith('.pdf')) {
      return {
        content:
          `PDF is not supported yet — ${params.path} cannot be read. ` +
          'Word, Excel and HTML documents work with read_document. If the same content exists in one of ' +
          'those formats, read that instead; otherwise tell the user PDF support is not available.',
        isError: true,
        path: params.path,
      }
    }

    let extracted
    try {
      const bytes = await context.fs.readBytes(resolved.realPath)
      extracted = extractDocument(params.path, bytes, ...(params.sheet !== undefined ? [{ sheet: params.sheet }] : []))
    } catch (error) {
      return {
        content:
          error instanceof DocumentError
            ? error.message
            : `Could not read "${params.path}": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        path: params.path,
      }
    }

    /*
     * Marked read, exactly as `read_file` does. A document the model has extracted counts as
     * one it has seen — otherwise the read-before-edit rule (§6) would refuse an edit to an
     * HTML file it had just read in full, which would be baffling.
     */
    context.readFiles.add(normalizeForComparison(resolved.realPath))

    if (extracted.text.trim().length === 0) {
      return {
        content: `${params.path} contains no extractable text. It may be empty, or hold only images.`,
        path: params.path,
      }
    }

    const lines = extracted.text.split('\n')
    const start = params.offset !== undefined ? params.offset - 1 : 0
    const end = params.limit !== undefined ? start + params.limit : lines.length
    const slice = lines.slice(start, end)

    const header = [
      `${params.path} (${kind}, ${String(lines.length)} lines of text)`,
      ...(extracted.sections !== undefined && extracted.sections.length > 1
        ? [`Sheets: ${extracted.sections.join(', ')}`]
        : []),
      ...(extracted.note !== undefined ? [extracted.note] : []),
      ...(end < lines.length || start > 0
        ? [`Showing lines ${String(start + 1)}–${String(Math.min(end, lines.length))}. Use offset/limit for more.`]
        : []),
    ]

    return { content: [...header, '', ...slice].join('\n'), path: params.path }
  },
}
