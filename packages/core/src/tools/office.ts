import { z } from 'zod'

import type { OfficeBridge } from '../office/bridge.js'
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
  const parts = [`${String(cell.sheet ?? '')}${cell.sheet === undefined ? '' : '!'}${String(cell.address)}`]
  parts.push(`displays "${String(cell.text ?? '')}"`)
  if (cell.formula !== undefined) parts.push(`formula ${String(cell.formula)}`)
  else if (cell.value !== null && cell.value !== undefined) parts.push(`value ${JSON.stringify(cell.value)}`)
  return parts.join(', ')
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
  depth: z.number().int().min(1).max(6).optional().describe('How many steps back to follow. Default 3.'),
})

export function createExcelTraceTool(options: OfficeToolOptions): Tool<z.infer<typeof traceSchema>> {
  return {
    name: 'excel_trace_cell',
    group: 'read',
    description:
      'Explain why a cell holds the value it does: its formula, the cells feeding it, their ' +
      'values and formulas, following the chain back. This is the tool for "where does this ' +
      'number come from" and for finding the source of an error like #REF! or #DIV/0!.',
    parametersSchema: traceSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          workbook: string
          start: string
          nodes: Record<string, unknown>[]
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

export function createExcelReadMacroTool(options: OfficeToolOptions): Tool<z.infer<typeof macroSchema>> {
  return {
    name: 'excel_read_macro',
    group: 'read',
    description: 'Read the VBA source of one module in an open workbook.',
    parametersSchema: macroSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{ workbook: string; module: string; code: string }>({
          op: 'excel.readMacro',
          ...params,
        })
        return { content: [`' ${result.workbook} / ${result.module}`, '', result.code].join('\n') }
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
  depth: z.number().int().min(1).max(8).optional().describe('How far to descend into sub-folders. Default 4.'),
})

export function createOutlookFoldersTool(options: OfficeToolOptions): Tool<z.infer<typeof foldersSchema>> {
  return {
    name: 'outlook_folders',
    group: 'read',
    description:
      'List the mail folders in the local Outlook, including sub-folders, with the full path to ' +
      'each. Pass a path from here to outlook_search to search one folder.',
    parametersSchema: foldersSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          folders: { name: string; path: string; depth: number; items: number; unread: number }[]
        }>({ op: 'outlook.folders', ...params })

        if (result.folders.length === 0) return { content: 'Outlook is running but reports no mail folders.' }
        return {
          content: [
            'Mail folders (the full path is what outlook_search wants):',
            ...result.folders.map(
              (folder) =>
                // Indented by depth so the shape of the tree is visible, but every line still
                // carries the whole path: a nested name on its own is not something you can pass
                // back, and that was the gap - a sub-folder was reachable but undiscoverable.
                `${'  '.repeat(Math.max(0, folder.depth - 1))}- ${folder.path} ` +
                `(${String(folder.items)} items, ${String(folder.unread)} unread)`,
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
          attachments: string[]
        }>({ op: 'outlook.read', ...params })

        return {
          content: [
            `Subject: ${result.subject}`,
            `From: ${result.from} <${result.fromAddress}>`,
            `To: ${result.to}`,
            ...(result.cc.length > 0 ? [`Cc: ${result.cc}`] : []),
            `Received: ${result.received}`,
            ...(result.attachments.length > 0 ? [`Attachments: ${result.attachments.join(', ')}`] : []),
            '',
            result.body,
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
