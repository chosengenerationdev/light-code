import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createExcelWriteRangeTool, rangeFor } from './office.js'
import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

const toolWith = (
  respond: (request: { op: string }) => unknown,
): ReturnType<typeof createExcelWriteRangeTool> =>
  createExcelWriteRangeTool({
    bridge: { request: async (request: { op: string }) => respond(request) },
  } as never)

/**
 * Writing into the workbook somebody has open.
 *
 * The Office tools were read-and-diagnose only, so "put some dummy data in and show me a VLOOKUP"
 * had no answer but writing a VBA module and running it — two approvals, a macro left behind, and
 * a Trust Center setting most people do not have on.
 */
describe('the range a block will cover', () => {
  it('extends right and down from the starting cell', () => {
    expect(rangeFor('A1', 3, 2)).toBe('A1:B3')
    expect(rangeFor('B2', 1, 1)).toBe('B2:B2')
    expect(rangeFor('C5', 2, 4)).toBe('C5:F6')
  })

  /*
   * The arithmetic people get wrong. Z+1 is AA, not BA, and a block starting at Z must not report
   * a range that silently covers the wrong columns in the approval prompt.
   */
  it('carries past Z the way Excel does', () => {
    expect(rangeFor('Y1', 1, 3)).toBe('Y1:AA1')
    expect(rangeFor('AA1', 1, 2)).toBe('AA1:AB1')
    expect(rangeFor('AZ1', 1, 2)).toBe('AZ1:BA1')
  })

  it('accepts absolute references and normalises the case', () => {
    expect(rangeFor('$b$3', 2, 1)).toBe('B3:B4')
  })

  /*
   * Handed back untouched rather than guessed at. Excel rejects a shape this does not understand
   * by its own rules, which is a better error than one invented here.
   */
  it('leaves something that is not a plain cell reference alone', () => {
    expect(rangeFor('Sheet2!A1', 2, 2)).toBe('Sheet2!A1')
    expect(rangeFor('A1:B2', 2, 2)).toBe('A1:B2')
  })
})

describe('the approval prompt', () => {
  const values = [['Name', 'Total'], ['Widget', '=VLOOKUP(A2,Data!A:B,2,FALSE)']]

  /*
   * Invariant 8 for a spreadsheet. What people need protecting from here is not a wrong formula —
   * it is the row of data they had forgotten was underneath.
   */
  it('shows what is in those cells now, read live', async () => {
    const tool = toolWith(() => ({
      cells: [
        { address: 'A1', value: 'old header', text: 'old header' },
        { address: 'B1', value: '', text: '' },
      ],
    }))
    const preview = await tool.preview?.({ cell: 'A1', values } as never, {} as never)
    expect(preview?.kind).toBe('text')
    const text = (preview as { text: string }).text
    expect(text).toContain('what is there now')
    expect(text).toContain('A1: old header')
    // The empty one is not listed as replaced content, because it is not any.
    expect(text).not.toContain('B1:')
    expect(text).toContain('what will replace it')
    expect(text).toContain('VLOOKUP')
  })

  it('says plainly when the target is empty', async () => {
    const tool = toolWith(() => ({ cells: [{ address: 'A1', value: '', text: '' }] }))
    const preview = await tool.preview?.({ cell: 'A1', values } as never, {} as never)
    expect((preview as { text: string }).text).toContain('all empty')
  })

  /*
   * A preview that throws would become an edit nobody was asked about, so a failure to read the
   * current contents degrades to saying so — the same rule a failing `apply_diff` preview follows.
   */
  it('still asks when the current contents cannot be read', async () => {
    const tool = toolWith(() => {
      throw new Error('Excel is busy')
    })
    const preview = await tool.preview?.({ cell: 'A1', values } as never, {} as never)
    expect((preview as { text: string }).text).toContain('Could not read the current contents')
    expect((preview as { text: string }).text).toContain('what will replace it')
  })

  it('promises the workbook is left unsaved', async () => {
    const tool = toolWith(() => ({ cells: [] }))
    const preview = await tool.preview?.({ cell: 'A1', values } as never, {} as never)
    expect((preview as { text: string }).text).toContain('unsaved')
  })
})

describe('what it reports back', () => {
  /*
   * A formula that lands as #N/A looks like success from here. Reported, or the error sits in the
   * sheet unnoticed — the same reasoning as `excel_evaluate` returning the error value.
   */
  it('names cells that evaluated to an error', async () => {
    const tool = toolWith(() => ({
      workbook: 'Book1.xlsx',
      sheet: 'Sheet1',
      range: 'A1:B2',
      written: 4,
      overwritten: [{ address: 'A1', was: 'old' }],
      cells: [
        { address: 'A1', value: 'Name' },
        { address: 'B2', value: '#N/A' },
      ],
    }))
    const result = await tool.execute({ cell: 'A1', values: [['x']] } as never, {} as never)
    expect(result.content).toContain('#N/A')
    expect(result.content).toContain('B2')
    expect(result.content).toContain('Replaced 1 cell(s)')
    expect(result.content).toContain('NOT saved')
  })

  it('says so when nothing was overwritten', async () => {
    const tool = toolWith(() => ({
      workbook: 'Book1.xlsx',
      sheet: 'Sheet1',
      range: 'A1:A1',
      written: 1,
      overwritten: [],
      cells: [{ address: 'A1', value: 1 }],
    }))
    const result = await tool.execute({ cell: 'A1', values: [['x']] } as never, {} as never)
    expect(result.content).toContain('Every target cell was empty')
  })
})

describe('how it is gated', () => {
  it('is an edit, not a read', () => {
    expect(toolWith(() => ({})).group).toBe('edit')
  })

  /* No category toggle may wave through a change to somebody's unsaved work. */
  it('always asks, whatever is auto-approved', () => {
    expect(ALWAYS_ASK_TOOLS.has('excel_write_range')).toBe(true)
  })

  /* Nobody is at the screen to see the diff, and there is no undo this product owns. */
  it('is never available to a scheduled run', () => {
    expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain('excel_write_range')
  })
})

describe('the worker', () => {
  const worker = read('../office/worker.ps1')

  /*
   * Bulk, not cell by cell. Reading 400 cells one at a time measured 315x slower than the array
   * property and ran past the timeout; writing has the same shape, so a per-cell loop here would
   * be a correct tool that is unusably slow — invisible to any test of what it returns.
   */
  it('writes the whole block in one assignment', () => {
    expect(worker).toContain('$target.Formula = $block')
    expect(worker).toContain("New-Object 'object[,]'")
  })

  it('captures what was there before writing over it', () => {
    const body = worker.slice(worker.indexOf('function Invoke-ExcelWriteRange'))
    expect(body.indexOf('$existing = $target.Formula')).toBeLessThan(
      body.indexOf('$target.Formula = $block'),
    )
  })

  /* A ragged block would write nulls into the short rows and look like it had worked. */
  it('refuses a block whose rows are different widths', () => {
    expect(worker).toContain('every row must be the same width')
  })

  /* Windows PowerShell decodes a BOM-less .ps1 as ANSI: one stray character is a dead worker. */
  it('stays pure ASCII', () => {
    // Checked by code point rather than by a regex range, which would itself need control
    // characters written into the pattern and trips the lint rule that forbids them.
    const offending = worker
      .split('\n')
      .filter((line) => [...line].some((character) => character.charCodeAt(0) > 127))
    expect(offending).toEqual([])
  })
})
