import { z } from 'zod'

import { checkVba } from '../office/vbaCheck.js'
import type { Tool, ToolResult } from './types.js'
import type { OfficeToolOptions } from './office.js'

/**
 * Debugging a macro: check it, try a formula, run it and see what moved.
 *
 * ## What COM can and cannot give you
 *
 * There is no breakpoint, no stepping and no reading of locals while stopped — the VBA debugger
 * is not reachable from outside the application. What is reachable is everything either side of
 * a run: the source, the workbook's state before and after, the value an expression evaluates to,
 * and the error VBA raised. In practice that is what a person is after; the stepping is a means
 * to it, not the end.
 *
 * ## The order these are meant to be used in
 *
 * `excel_check_macro` first, because it changes nothing and reports *every* fault it can see
 * rather than stopping at the first. `excel_evaluate` next, to test a formula without writing it
 * anywhere. `excel_run_macro` last, because it executes code and is the only one here that can
 * change anything — which is why it always asks, and why the prompt shows the source rather than
 * the name.
 */

const workbookField = z
  .string()
  .optional()
  .describe('Workbook name from excel_sessions. Omit for whichever workbook is active.')

const runMacroSchema = z.object({
  workbook: workbookField,
  macro: z.string().min(1).describe('Macro name, from excel_list_macros or the module source.'),
  arguments: z.array(z.string()).max(3).optional().describe('Up to three arguments, passed as strings.'),
  watchSheet: z.string().optional().describe('Sheet to snapshot before and after, to see what changed.'),
  watchRange: z.string().optional().describe('A1 range to snapshot, e.g. "A1:D20". Needs watchSheet.'),
})

export function createExcelRunMacroTool(options: OfficeToolOptions): Tool<z.infer<typeof runMacroSchema>> {
  return {
    name: 'excel_run_macro',
    group: 'command',
    description:
      'Run a macro in an open workbook and report its result, or the error VBA raised. Give ' +
      'watchSheet and watchRange to see exactly which cells it changed. This EXECUTES code and can ' +
      'modify the workbook, so it always asks first. Use excel_check_macro and excel_evaluate ' +
      'while investigating — neither changes anything.',
    parametersSchema: runMacroSchema,

    /**
     * The approval shows the code that will run, not the name of it.
     *
     * "Run DoTheThing" tells the user nothing about what they are agreeing to, and a macro can do
     * anything its author wrote. Fetching the source for the prompt is the whole point — this is
     * invariant 8 applied to somebody else's code rather than to a diff we computed.
     */
    async preview(params) {
      let source: string
      try {
        const found = await findMacroSource(options, params.workbook, params.macro)
        source =
          found ??
          `(the source of "${params.macro}" could not be found — it may live in a module this cannot read)`
      } catch (error) {
        // Shown as a failure rather than quietly downgraded to "trust me".
        source = `(the source could not be read: ${message(error)})`
      }

      return {
        kind: 'text',
        text: [
          `Run the macro "${params.macro}" in ${params.workbook ?? 'the active workbook'}.`,
          '',
          'This executes VBA on your machine, as you. It can change cells, delete sheets, write',
          'files or send mail — whatever its author wrote. Nothing is saved automatically, though',
          'a macro is perfectly able to save the workbook itself.',
          ...(params.arguments === undefined ? [] : ['', `Arguments: ${params.arguments.join(', ')}`]),
          '',
          '--- the code that will run ---',
          source,
        ].join('\n'),
      }
    },

    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          workbook: string
          macro: string
          failed: boolean
          error: string | null
          returned: string | null
          before: Record<string, unknown>[]
          after: Record<string, unknown>[]
        }>({ op: 'excel.runMacro', ...params })

        const lines = [
          result.failed
            ? `${result.macro} raised an error: ${result.error ?? '(no message)'}`
            : `${result.macro} completed${result.returned === null ? '' : `, returning: ${result.returned}`}`,
        ]

        if (params.watchRange !== undefined) {
          const changes = describeChanges(result.before, result.after)
          lines.push('')
          lines.push(
            changes.length > 0
              ? `Cells that changed in ${params.watchRange}:`
              : `Nothing changed in ${params.watchRange}.`,
          )
          lines.push(...changes)
        }

        if (result.failed) {
          lines.push(
            '',
            'VBA reports only the first failure and gives no line number over COM. excel_check_macro ' +
              'reads the source for the usual causes and reports all of them, without running anything.',
          )
        }
        return { content: lines.join('\n'), ...(result.failed ? { isError: true } : {}) }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const evaluateSchema = z.object({
  workbook: workbookField,
  sheet: z.string().optional().describe('Sheet whose context to evaluate in. Omit for the active sheet.'),
  expression: z.string().min(1).describe('A formula as you would type it in a cell, e.g. "=VLOOKUP(A1,Data!A:B,2,0)".'),
})

/**
 * Works out what a formula would give, without putting it anywhere.
 *
 * `Application.Evaluate` computes in the workbook's own context — its names, its sheets — and
 * returns the answer with no cell touched. During an investigation "what would this give" is
 * asked far more often than "change this", and answering it by writing into a spare cell is a
 * modification nobody asked for and might not notice.
 */
export function createExcelEvaluateTool(options: OfficeToolOptions): Tool<z.infer<typeof evaluateSchema>> {
  return {
    name: 'excel_evaluate',
    group: 'read',
    description:
      'Work out what a formula would return, in the context of an open workbook, without writing ' +
      'it into any cell. Use it to test a fix before proposing it, or to see what one part of a ' +
      'broken formula evaluates to on its own.',
    parametersSchema: evaluateSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const result = await options.bridge.request<{
          sheet: string
          expression: string
          failed: boolean
          error: string | null
          value: string | null
        }>({ op: 'excel.evaluate', ...params })

        if (result.failed) {
          return { content: `Could not evaluate on ${result.sheet}: ${result.error ?? '(no message)'}`, isError: true }
        }
        return { content: `${result.expression} on ${result.sheet} gives: ${result.value ?? '(empty)'}` }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const checkMacroSchema = z.object({
  workbook: workbookField,
  module: z.string().min(1).describe('Module name from excel_list_macros.'),
  /** When the user says which line fails, findings there are the ones worth reading first. */
  aroundLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('The line the user says fails. Findings near it are listed first and the line is quoted.'),
})

/**
 * Reads a module for the faults that are visible without running it.
 *
 * The first thing to reach for when a macro misbehaves: it changes nothing, and it reports
 * *every* problem it finds rather than stopping at the first, which is what running does.
 */
export function createExcelCheckMacroTool(options: OfficeToolOptions): Tool<z.infer<typeof checkMacroSchema>> {
  return {
    name: 'excel_check_macro',
    group: 'read',
    description:
      'Check a VBA module for the faults visible without running it: missing Option Explicit, ' +
      'swallowed errors, unclosed blocks, error handlers jumping nowhere, and references to sheets ' +
      'this workbook does not have. Changes nothing. Try this before excel_run_macro. When the user ' +
      'says which line fails, pass aroundLine — the line is quoted back and findings near it come first.',
    parametersSchema: checkMacroSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const module = await options.bridge.request<{ workbook: string; module: string; code: string }>({
          op: 'excel.readMacro',
          ...params,
        })
        // The sheet list makes the sharpest check possible: a renamed tab is the commonest way a
        // working macro starts failing, and VBA's own error for it names nothing at all.
        const sessions = await options.bridge.request<{ workbooks: { name: string; sheets: string[] }[] }>({
          op: 'excel.sessions',
        })
        const sheets = sessions.workbooks.find((entry) => entry.name === module.workbook)?.sheets ?? []

        const findings = checkVba({ code: module.code, sheets })
        const lines = module.code.split(/\r?\n/)
        const quoted =
          params.aroundLine === undefined
            ? []
            : [
                `Line ${String(params.aroundLine)} reads:`,
                `  ${lines[params.aroundLine - 1] ?? '(past the end of this module — is the failure in another one?)'}`,
                '',
              ]

        if (findings.length === 0) {
          return {
            content: [
              ...quoted,
              `No static faults found in ${module.module}. That does not mean it works — it means ` +
                'nothing is wrong in a way that is visible without running it.',
              ...(params.aroundLine === undefined
                ? []
                : [
                    '',
                    'Nothing here explains a failure on that line, so it is likely a runtime one: a value ' +
                      'that is not what the code assumes, an object that is Nothing, or a type mismatch. ' +
                      'excel_read_range on the cells it touches, or excel_evaluate on the expression, will ' +
                      'usually show it.',
                  ]),
            ].join('\n'),
          }
        }

        /*
         * Ordered by distance from the line the user named.
         *
         * They are telling us where the failure surfaced, so a finding on that line, or a few lines
         * above it, is the one they need to read first. Sorting rather than filtering: the cause is
         * often nowhere near the symptom - a swallowed error thirty lines earlier is exactly the
         * sort of thing that makes a later line fail - so nothing is hidden, only ranked.
         */
        if (params.aroundLine !== undefined) {
          const target = params.aroundLine
          findings.sort((a, b) => Math.abs(a.line - target) - Math.abs(b.line - target))
        }

        const errors = findings.filter((finding) => finding.severity === 'error').length
        return {
          content: [
            ...quoted,
            `${String(findings.length)} finding(s) in ${module.workbook} / ${module.module}` +
              `${errors > 0 ? ` — ${String(errors)} definitely wrong` : ''}:`,
            '',
            ...findings.map((finding) => `line ${String(finding.line)} [${finding.severity}] ${finding.message}`),
          ].join('\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

/**
 * The source of the module that declares a macro, for the approval prompt.
 *
 * Matched on a declaration rather than any mention, so a module that merely *calls* the macro is
 * not presented as the thing about to run.
 */
async function findMacroSource(
  options: OfficeToolOptions,
  workbook: string | undefined,
  macro: string,
): Promise<string | undefined> {
  const workbookArg = workbook === undefined ? {} : { workbook }
  const listed = await options.bridge.request<{ modules: { name: string }[] }>({
    op: 'excel.listMacros',
    ...workbookArg,
  })

  const declaration = new RegExp(String.raw`\b(?:sub|function)\s+${escapeForRegExp(macro)}\s*\(`, 'i')
  for (const module of listed.modules) {
    const read = await options.bridge.request<{ module: string; code: string }>({
      op: 'excel.readMacro',
      module: module.name,
      ...workbookArg,
    })
    if (declaration.test(read.code)) return `' ${read.module}\n\n${read.code}`
  }
  return undefined
}

/** A macro name is model-supplied text; it must not be able to act as a pattern. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/** Which watched cells differ, described in terms of what the user would see on screen. */
function describeChanges(
  before: readonly Record<string, unknown>[],
  after: readonly Record<string, unknown>[],
): string[] {
  const previous = new Map(before.map((cell) => [String(cell.address), cell]))
  const changes: string[] = []
  for (const cell of after) {
    const was = previous.get(String(cell.address))
    if (was === undefined) continue
    const sameText = String(was.text ?? '') === String(cell.text ?? '')
    const sameFormula = String(was.formula ?? '') === String(cell.formula ?? '')
    if (sameText && sameFormula) continue
    changes.push(`  ${String(cell.address)}: "${String(was.text ?? '')}" -> "${String(cell.text ?? '')}"`)
  }
  return changes
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
