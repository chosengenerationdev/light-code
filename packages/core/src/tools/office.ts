import { z } from 'zod'

import type { OfficeBridge } from '../office/bridge.js'
import { annotateHtmlBody } from '../office/mailFormat.js'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolResult } from './types.js'

/**
 * Tools for the Excel and Outlook already running on this machine.
 *
 * ## The shape of the feature
 *
 * These attach to a **live application**, not to a file. That is the request — "connect with a
 * running or open excel session", "list open excel connections for user to select" — and it is
 * also the only way to answer the question people actually have, which is about a workbook they
 * are looking at, with unsaved edits, mid-investigation.
 *
 * Choosing *which* session needs no bespoke UI: `excel_sessions` lists what is open and the
 * model asks with `ask_user_form`, which already renders a themed dropdown.
 *
 * ## What is read and what is written
 *
 * Everything here is `read` except `excel_write_macro`, which is `edit` **and** always asks
 * (see `ALWAYS_ASK_TOOLS`). Writing VBA into a workbook is writing code that runs on the user's
 * machine with their identity — the same class of act as creating a Python tool, and section 13
 * requires a human to see the source. It is also never granted to a scheduled run.
 *
 * ## Nothing is saved
 *
 * A macro write changes the in-memory project and leaves the workbook dirty. Saving someone's
 * open file from underneath them is a larger act than editing a module, and they may well want
 * to run it before keeping it. The tool result says so explicitly.
 */

/** Shared by `officeVba.ts`, which holds the debugging half of the same feature. */
export interface OfficeToolOptions {
  bridge: OfficeBridge
}

const workbookField = z
  .string()
  .optional()
  .describe('Workbook name from excel_sessions. Omit for whichever workbook is active.')

const sheetField = z.string().optional().describe('Sheet name. Omit for the active sheet.')

/** Formats a value for the model without lying about its type. */
function renderCell(cell: Record<string, unknown>): string {
  const where = `${String(cell.sheet ?? '')}${cell.sheet === undefined ? '' : '!'}${String(cell.address)}`
  if (cell.kind === 'range') return renderRange(where, cell)

  const parts = [where]
  parts.push(`displays "${String(cell.text ?? '')}"`)
  if (cell.formula !== undefined) parts.push(`formula ${String(cell.formula)}`)
  else if (cell.value !== null && cell.value !== undefined) parts.push(`value ${JSON.stringify(cell.value)}`)
  return parts.join(', ')
}

/**
 * A block of cells feeding a formula, described rather than listed.
 *
 * The worker summarises a multi-cell precedent instead of expanding it — the reasoning is in
 * `Invoke-ExcelTrace`, and it is about a `=SUM(A1:A2000)` costing 2000 nodes. What matters here is
 * that the summary must not read like a cell whose text happens to be blank, or the model will
 * report the range as empty. So it is rendered in its own shape, leading with the count.
 *
 * The error addresses come first among the details because they are almost always the answer: a
 * total showing #DIV/0! is explained by naming the one cell in two thousand that is broken.
 */
function renderRange(where: string, node: Record<string, unknown>): string {
  const cells = Number(node.cells ?? 0)
  const parts = [`${where} (${String(cells)} cells feeding this)`]

  const errors = Number(node.errors ?? 0)
  if (errors > 0) {
    const listed = Array.isArray(node.errorCells) ? (node.errorCells as string[]) : []
    const shown = listed.join('; ')
    parts.push(
      listed.length < errors
        ? `${String(errors)} in error, including ${shown}`
        : `${String(errors)} in error: ${shown}`,
    )
  }

  const counts: string[] = []
  if (Number(node.numbers ?? 0) > 0) counts.push(`${String(node.numbers)} numeric`)
  if (Number(node.texts ?? 0) > 0) counts.push(`${String(node.texts)} text`)
  if (Number(node.blanks ?? 0) > 0) counts.push(`${String(node.blanks)} blank`)
  if (counts.length > 0) parts.push(counts.join(', '))

  if (node.min !== undefined && node.min !== null) {
    parts.push(`range ${JSON.stringify(node.min)} to ${JSON.stringify(node.max)}`)
  }
  return parts.join('; ')
}

const openSchema = z.object({
  path: z.string().min(1).describe('Full path to the workbook, e.g. "C:\\\\reports\\\\March.xlsx".'),
  readOnly: z
    .boolean()
    .optional()
    .describe('Open without taking a write lock. Default true, which is right for investigating.'),
})

/**
 * Opens a named workbook, starting Excel if it is not already running.
 *
 * ## Why this one is allowed to launch Excel when nothing else is
 *
 * Every other tool here refuses to start Excel, because answering "the spreadsheet I have open"
 * with a second invisible copy holding a file lock is worse than saying "open it first". That rule
 * is about a *guess*. Here the user has named a file, so there is nothing to guess at — and
 * refusing would only mean they open it by hand and ask again.
 *
 * ## What it will not do
 *
 * Macros are disabled while the file opens, so investigating a workbook cannot execute anything it
 * carries; running a macro stays a separate, separately approved act. It opens read-only by
 * default, so the user's own copy is never locked out. And the path goes through the same
 * confinement, deny list and out-of-workspace prompt as `read_file` — a workbook is usually
 * outside the workspace, which is exactly the case that machinery exists for.
 */
export function createExcelOpenTool(options: OfficeToolOptions): Tool<z.infer<typeof openSchema>> {
  return {
    name: 'excel_open_workbook',
    group: 'read',
    description:
      'Open a workbook by full path so it can be investigated, starting Excel if it is not already ' +
      'running. Use this when the user names a file rather than talking about a spreadsheet they ' +
      'already have open — otherwise call excel_sessions. Opens read-only and with macros ' +
      'disabled, so it changes nothing and runs nothing. Once it is open, excel_read_range and ' +
      'excel_trace_cell work on it as normal.',
    parametersSchema: openSchema,
    async execute(params, context): Promise<ToolResult> {
      /*
       * Inside the try, because resolving a path can itself fail in ways that are not a
       * confinement decision - a share that refuses even to be resolved being the one that
       * prompted this. A raw errno thrown out of a tool is the shape that reached a user as
       * 'not permitted' with no prompt and no explanation.
       */
      let workbookPath: string
      try {
        const resolved = await resolveToolPath(context, params.path)
        if (!resolved.ok) return { content: resolved.message, isError: true }
        workbookPath = resolved.realPath
      } catch (error) {
        return { content: `Could not work out where "${params.path}" is: ${message(error)}`, isError: true }
      }

      try {
        const result = await options.bridge.request<{
          workbook: string
          fullName: string
          sheets: string[]
          opened: boolean
          started: boolean
          readOnly: boolean
        }>({ op: 'excel.open', path: workbookPath, ...(params.readOnly === undefined ? {} : { readOnly: params.readOnly }) })

        const how = result.opened
          ? result.started
            ? 'Started Excel and opened'
            : 'Opened'
          : 'Already open in Excel:'
        return {
          content: [
            `${how} ${result.workbook}${result.readOnly ? ' (read-only)' : ''}`,
            `  ${result.fullName}`,
            `  sheets: ${result.sheets.join(', ')}`,
            '',
            /*
             * Only claimed when this actually did the opening. A workbook the user already
             * had open was opened by them, under their own macro settings - saying otherwise
             * would be a confident false assurance about whether code has run.
             */
            ...(result.opened
              ? ['Macros were disabled while it opened, so nothing in the file has run.']
              : ['This was already open, so your own Excel settings applied rather than ours.']),
            'Use excel_read_range to see data and excel_trace_cell to find where a value comes from.',
          ].join('\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

export function createExcelSessionsTool(options: OfficeToolOptions): Tool<Record<string, never>> {
  return {
    name: 'excel_sessions',
    group: 'read',
    description:
      'List the workbooks currently open in Excel on this machine, with their sheets. Call this ' +
      'first when the user asks about "the spreadsheet I have open" — then confirm which one ' +
      'with ask_user_form if more than one is listed.',
    parametersSchema: z.object({}),
    async execute(): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          workbooks: { name: string; fullName: string; saved: boolean; sheets: string[]; active: boolean }[]
        }>({ op: 'excel.sessions' })

        if (result.workbooks.length === 0) {
          return { content: 'Excel is running but has no workbook open.' }
        }
        return {
          content: [
            `${String(result.workbooks.length)} workbook(s) open:`,
            ...result.workbooks.map((workbook) =>
              [
                `- ${workbook.name}${workbook.active ? ' (active)' : ''}`,
                `  path: ${workbook.fullName}`,
                // Stated because it changes what is safe to suggest: an unsaved workbook holds
                // edits that exist nowhere else.
                `  ${workbook.saved ? 'saved' : 'HAS UNSAVED CHANGES'}`,
                `  sheets: ${workbook.sheets.join(', ')}`,
              ].join('\n'),
            ),
          ].join('\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const readRangeSchema = z.object({
  workbook: workbookField,
  sheet: sheetField,
  range: z.string().min(1).describe('An A1 range, e.g. "B2:D20" or a single cell "C7".'),
})

export function createExcelReadRangeTool(options: OfficeToolOptions): Tool<z.infer<typeof readRangeSchema>> {
  return {
    name: 'excel_read_range',
    group: 'read',
    description:
      'Read cells from an open workbook: what each displays, its underlying value, and its ' +
      'formula if it has one. Use it to see data; use excel_trace_cell to find out why a cell ' +
      'holds what it does.',
    parametersSchema: readRangeSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          sheet: string
          workbook: string
          cells: Record<string, unknown>[]
        }>({ op: 'excel.readRange', ...params })

        return {
          content: [
            `${result.workbook} / ${result.sheet} / ${params.range}`,
            '',
            ...result.cells.map((cell) => renderCell(cell)),
          ].join('\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const traceSchema = z.object({
  workbook: workbookField,
  sheet: sheetField,
  cell: z.string().min(1).describe('The cell to explain, e.g. "D14".'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe('How many steps back to follow. Default 3, which reaches the cause of most errors.'),
})

export function createExcelTraceTool(options: OfficeToolOptions): Tool<z.infer<typeof traceSchema>> {
  return {
    name: 'excel_trace_cell',
    group: 'read',
    description:
      'Explain why a cell holds the value it does: its formula, the cells feeding it, their ' +
      'values and formulas, following the chain back. This is the tool for "where does this ' +
      'number come from" and for finding the source of an error like #REF! or #DIV/0!. ' +
      'A block of cells feeding a formula is summarised rather than listed, and any cells in ' +
      'error inside it are named — so tracing a bad total usually points straight at the one ' +
      'broken cell without needing to read the range.',
    parametersSchema: traceSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          workbook: string
          start: string
          nodes: Record<string, unknown>[]
          truncated?: boolean
        }>({ op: 'excel.trace', ...params })

        if (result.nodes.length === 0) {
          return { content: `Nothing found at ${result.start} — the cell may be empty.` }
        }

        const lines = result.nodes.map((node) => {
          const indent = '  '.repeat(Number(node.depth ?? 0))
          const feeds = Array.isArray(node.feeds) && node.feeds.length > 0 ? ` <- ${(node.feeds as string[]).join(', ')}` : ''
          return `${indent}${renderCell(node)}${feeds}`
        })

        return {
          content: [
            `Tracing ${result.start} in ${result.workbook}, from the cell back to its sources:`,
            '',
            ...lines,
            '',
            'Indentation is distance from the starting cell. A cell with no formula is raw input,',
            'so an unexpected value there is a data problem rather than a formula problem.',
            'A line giving a cell count is a block feeding a formula, summarised rather than listed;',
            'any cells in error within it are named, and those are usually the cause.',
            ...(result.truncated === true
              ? [
                  '',
                  'The trace stopped at its node limit, so this is a partial picture. Trace one of the',
                  'cells above directly, or use a smaller depth, to follow a particular branch further.',
                ]
              : []),
          ].join('\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

export function createExcelListMacrosTool(options: OfficeToolOptions): Tool<{ workbook?: string | undefined }> {
  return {
    name: 'excel_list_macros',
    group: 'read',
    description: 'List the VBA modules in an open workbook, with their sizes.',
    parametersSchema: z.object({ workbook: workbookField }),
    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          workbook: string
          modules: { name: string; type: string; lines: number }[]
        }>({ op: 'excel.listMacros', ...params })

        if (result.modules.length === 0) return { content: `${result.workbook} contains no VBA modules.` }
        return {
          content: [
            `VBA in ${result.workbook}:`,
            ...result.modules.map((module) => `- ${module.name} (${module.type}, ${String(module.lines)} lines)`),
          ].join('\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const macroSchema = z.object({
  workbook: workbookField,
  module: z.string().min(1).describe('Module name from excel_list_macros.'),
})

const readMacroSchema = macroSchema.extend({
  /**
   * The line the user is asking about.
   *
   * VBA reports a failure by highlighting a line in the editor, so "it fails on line 47" is how
   * people describe a problem. Answering that means the numbering has to be the *same* numbering
   * they are reading, which is the module's own — hence counting from the first line of the
   * module, blank lines and comments included, exactly as the VBA editor does.
   */
  aroundLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Show the module around this line — use it when the user names the line that fails.'),
  context: z.number().int().min(1).max(200).optional().describe('Lines either side of aroundLine. Default 25.'),
})

export function createExcelReadMacroTool(options: OfficeToolOptions): Tool<z.infer<typeof readMacroSchema>> {
  return {
    name: 'excel_read_macro',
    group: 'read',
    description:
      'Read the VBA source of one module in an open workbook, with line numbers matching what the ' +
      'VBA editor shows. Pass aroundLine when the user says which line fails, to see that part of ' +
      'the module with its surroundings.',
    parametersSchema: readMacroSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const { aroundLine, context, ...request } = params
        const result = await options.bridge.request<{ workbook: string; module: string; code: string }>({
          op: 'excel.readMacro',
          ...request,
        })

        const all = result.code.split(/\r?\n/)
        const span = context ?? 25
        const from = aroundLine === undefined ? 1 : Math.max(1, aroundLine - span)
        const to = aroundLine === undefined ? all.length : Math.min(all.length, aroundLine + span)

        if (aroundLine !== undefined && aroundLine > all.length) {
          // Said rather than shown as an empty window: a line past the end usually means the wrong
          // module, and silently returning nothing would send the investigation the wrong way.
          return {
            content:
              `${result.module} has only ${String(all.length)} lines, so line ${String(aroundLine)} is not in it. ` +
              'The failure may be in a different module — excel_list_macros shows them all.',
            isError: true,
          }
        }

        // Numbered, and marked at the line asked about. A model counting lines in a blob of text
        // gets it wrong, and being wrong about *which* line fails is worse than not knowing.
        const numbered = all
          .slice(from - 1, to)
          .map((line, index) => {
            const number = from + index
            const marker = number === aroundLine ? '>>' : '  '
            return `${marker}${String(number).padStart(4)} | ${line}`
          })
          .join('\n')

        return {
          content: [
            `' ${result.workbook} / ${result.module}` +
              (aroundLine === undefined
                ? ` (${String(all.length)} lines)`
                : ` — lines ${String(from)}-${String(to)} of ${String(all.length)}, around line ${String(aroundLine)}`),
            '',
            numbered,
          ].join('\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const writeMacroSchema = macroSchema.extend({
  code: z.string().describe('The complete new contents of the module. It replaces what is there.'),
})

export function createExcelWriteMacroTool(options: OfficeToolOptions): Tool<z.infer<typeof writeMacroSchema>> {
  return {
    name: 'excel_write_macro',
    group: 'edit',
    description:
      'Replace the VBA source of a module in an open workbook. The whole module is replaced, so ' +
      'read it first and send back the complete text. The workbook is left unsaved so the user ' +
      'can run it before keeping it.',
    parametersSchema: writeMacroSchema,
    /**
     * The approval shows the code that will be installed, in full.
     *
     * Ground truth (invariant 8): what is rendered is the exact string that will be written, not
     * the model's description of it. This is the sharpest surface in the feature — VBA runs on
     * the user's machine as them, and a macro is not something anybody reviews later.
     */
    async preview(params) {
      return {
        kind: 'text',
        text: [
          `Replace VBA module "${params.module}" in ${params.workbook ?? 'the active workbook'}.`,
          '',
          'The workbook stays open and unsaved, so nothing reaches disk until the user saves it.',
          'This code will run with their identity when the macro is invoked.',
          '',
          '--- new contents ---',
          params.code,
        ].join('\n'),
      }
    },
    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          workbook: string
          module: string
          linesBefore: number
          linesAfter: number
        }>({ op: 'excel.writeMacro', ...params })

        return {
          content:
            `Replaced ${result.module} in ${result.workbook} — ${String(result.linesBefore)} lines became ` +
            `${String(result.linesAfter)}. The workbook is NOT saved; tell the user to save it in Excel ` +
            'once they are happy, or the change is lost when they close it.',
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const foldersSchema = z.object({
  depth: z.number().int().min(1).max(8).optional().describe('How far to descend into sub-folders. Default 2.'),
  /**
   * Item counts, off by default because they are the expensive part.
   *
   * On Exchange in online mode counting a folder's items is a server round trip each, and doing
   * it for a few hundred folders is what made this time out in real use.
   */
  counts: z.boolean().optional().describe('Include how many items each folder holds. Slow on a large mailbox.'),
})

export function createOutlookFoldersTool(options: OfficeToolOptions): Tool<z.infer<typeof foldersSchema>> {
  return {
    name: 'outlook_folders',
    group: 'read',
    description:
      'List the mail folders in the local Outlook, including sub-folders, with the full path to ' +
      'each. Pass a path from here to outlook_search to search one folder. Goes two levels deep ' +
      'by default; raise depth for a deeply filed mailbox, but expect it to take longer.',
    parametersSchema: foldersSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          folders: { name: string; path: string; depth: number; items?: number; unread?: number }[]
          depth: number
          truncated: boolean
        }>({ op: 'outlook.folders', ...params })

        if (result.folders.length === 0) return { content: 'Outlook is running but reports no mail folders.' }
        return {
          content: [
            'Mail folders (the full path is what outlook_search wants):',
            ...(result.truncated
              ? ['(list truncated — this mailbox has more folders than are shown; narrow with depth)']
              : []),
            ...result.folders.map(
              (folder) =>
                // Indented by depth so the shape of the tree is visible, but every line still
                // carries the whole path: a nested name on its own is not something you can pass
                // back, and that was the gap - a sub-folder was reachable but undiscoverable.
                `${'  '.repeat(Math.max(0, folder.depth - 1))}- ${folder.path}` +
                (folder.items === undefined ? '' : ` (${String(folder.items)} items)`) +
                (folder.unread === undefined || folder.unread === 0 ? '' : ` (${String(folder.unread)} unread)`),
            ),
          ].join('\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const searchSchema = z.object({
  folder: z
    .string()
    .optional()
    .describe('Full folder path from outlook_folders, e.g. "you@example.com\\Inbox\\Projects". Omit for the inbox.'),
  from: z.string().optional().describe('Match part of the sender address.'),
  subject: z.string().optional().describe('Match part of the subject.'),
  contains: z.string().optional().describe('Match text in the subject or body.'),
  since: z.string().optional().describe('Only messages received on or after this date, e.g. "2026-08-01".'),
  /**
   * The one people actually reach for: "anything in the last two hours".
   *
   * Wins over `since` when both are given. A relative window is the more specific request, and
   * asking the model to convert one into the other invites an off-by-a-timezone.
   */
  withinMinutes: z
    .number()
    .int()
    .min(1)
    .max(20160)
    .optional()
    .describe('Only messages received in the last N minutes - 50 for the last 50 minutes, 120 for two hours.'),
  limit: z.number().int().min(1).max(100).optional().describe('How many of the newest to return. Default 25.'),
})

export function createOutlookSearchTool(options: OfficeToolOptions): Tool<z.infer<typeof searchSchema>> {
  return {
    name: 'outlook_search',
    group: 'read',
    description:
      'Search mail in the local Outlook, newest first. Give a folder path from outlook_folders to ' +
      'search one folder, withinMinutes for a recent window (two hours is 120), and limit for how ' +
      'many of the newest to return. Returns subject, sender, date and a short preview - use ' +
      'outlook_read_email with the returned id for the full message.',
    parametersSchema: searchSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          folder: string
          matches: { entryId: string; subject: string; from: string; received: string; unread: boolean; preview: string }[]
        }>({ op: 'outlook.search', ...params })

        if (result.matches.length === 0) return { content: `No messages in ${result.folder} matched.` }
        return {
          content: [
            `${String(result.matches.length)} message(s) in ${result.folder}:`,
            '',
            ...result.matches.map((match) =>
              [
                `### ${match.subject}`,
                `from ${match.from} on ${match.received}${match.unread ? ' (unread)' : ''}`,
                `id: ${match.entryId}`,
                match.preview.trim(),
              ].join('\n'),
            ),
          ].join('\n\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

export function createOutlookReadTool(options: OfficeToolOptions): Tool<{ entryId: string }> {
  return {
    name: 'outlook_read_email',
    group: 'read',
    description: 'Read one message in full, by the id returned from outlook_search.',
    parametersSchema: z.object({ entryId: z.string().min(1).describe('The id from outlook_search.') }),
    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          subject: string
          from: string
          fromAddress: string
          to: string
          cc: string
          received: string
          body: string
          html: string | null
          attachments: string[]
        }>({ op: 'outlook.read', ...params })

        /*
         * The formatted body wins when there is one.
         *
         * Plain text loses colour, and colour in a work email is often the point of it: the red
         * line is the failure, the highlighted cell is the one that changed. Flattened, they all
         * read the same. `annotateHtmlBody` keeps the text readable and marks only what departs
         * from the default, so an ordinary message reads exactly as it did before.
         */
        const annotated =
          result.html === null || result.html.length === 0 ? undefined : annotateHtmlBody(result.html)

        return {
          content: [
            `Subject: ${result.subject}`,
            `From: ${result.from} <${result.fromAddress}>`,
            `To: ${result.to}`,
            ...(result.cc.length > 0 ? [`Cc: ${result.cc}`] : []),
            `Received: ${result.received}`,
            ...(result.attachments.length > 0 ? [`Attachments: ${result.attachments.join(', ')}`] : []),
            ...(annotated === undefined || annotated.colours.length === 0
              ? []
              : [
                  // Explained once at the top, rather than left to be inferred from the first
                  // bracket the reader meets halfway down a paragraph.
                  `Formatting: parts of this message are marked like [red: text]. Used here: ${annotated.colours.join(', ')}.`,
                ]),
            '',
            // Falls back to the plain body when there is no HTML, which is what a plain-text
            // sender produces — and losing the message to gain formatting would be absurd.
            annotated === undefined || annotated.text.length === 0 ? result.body : annotated.text,
          ].join('\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

/** Errors from COM are already phrased for a human by the worker; anything else is unexpected. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
