import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { OfficeBridge } from '../office/bridge.js'
import { createExcelTraceTool } from './office.js'

/**
 * Tracing a cell back to its cause, on a workbook of a realistic size.
 *
 * ## What went wrong, and why a behaviour test could not see it
 *
 * The first version enumerated `Precedents` cell by cell and recursed into every one. `=SUM(A1:A2000)`
 * is 2000 precedent cells — measured at 9.3 seconds merely to list them, before four property reads
 * each and a `Precedents` call each. It timed out in real use, and raising the timeout did not help,
 * because the cost was a fan-out rather than a slow step.
 *
 * No test of the *result* can catch that: the trace was correct, just unusably slow, and against a
 * five-cell fixture it was fast. So the shape is asserted against the worker source directly — the
 * same reasoning as `config/retrieval.test.ts` reading `bridge.ts`, where the defect is a property
 * of the code rather than of any value it returns.
 */
const workerPath = fileURLToPath(new URL('../office/worker.ps1', import.meta.url))

describe('the trace walks blocks, not cells', () => {
  it('asks Precedents for its Areas rather than enumerating it', async () => {
    const source = await fs.readFile(workerPath, 'utf8')
    expect(source).toContain('$cell.Precedents.Areas')

    /*
     * `foreach ($x in $cell.Precedents)` iterates one cell at a time. That single line is the whole
     * defect, so it is the thing pinned — a reviewer restoring it would restore the timeout.
     */
    expect(source).not.toMatch(/foreach\s*\(\s*\$\w+\s+in\s+\$cell\.Precedents\s*\)/)
  })

  it('bounds the walk, so a pathological sheet ends rather than hangs', async () => {
    const source = await fs.readFile(workerPath, 'utf8')
    expect(source).toContain('traceNodeLimit')
    expect(source).toContain('traceTruncated')
  })

  /**
   * `Precedents` covers the current sheet only, so a cross-sheet reference is read out of the
   * formula text. The original pattern matched a single cell and nothing else, which meant
   * `=SUM(Data!A1:A500)` — the commonest cross-sheet formula there is — traced back to nothing.
   */
  it('matches a cross-sheet range, not only a cross-sheet cell', async () => {
    const source = await fs.readFile(workerPath, 'utf8')
    const line = source.split('\n').find((entry) => entry.includes('$pattern ='))
    expect(line).toBeDefined()
    expect(line).toContain('(?:')
    // The `:` alternation is the range half; without it only `Data!A1` matched.
    expect(line).toMatch(/\(\?:.*\)\?/)
  })
})

/** A bridge that answers one canned trace, so the renderer can be exercised on its own. */
function bridgeReturning(result: unknown): OfficeBridge {
  return { request: async () => result } as unknown as OfficeBridge
}

describe('rendering a traced range', () => {
  const rangeNode = {
    address: 'A1:A2000',
    sheet: 'Data',
    depth: 1,
    kind: 'range',
    cells: 2000,
    numbers: 1999,
    errors: 1,
    blanks: 0,
    texts: 0,
    errorCells: ['A57 is #DIV/0!'],
    feeds: [],
  }

  /**
   * The cause, named. A summary that said only "1 error" would send someone scrolling through two
   * thousand rows, which is the same dead end as the timeout it replaced.
   */
  it('names the cell in error, which is the answer being looked for', async () => {
    const tool = createExcelTraceTool({
      bridge: bridgeReturning({ workbook: 'Book1.xlsx', start: 'Data!C1', nodes: [rangeNode] }),
    })
    const result = await tool.execute({ cell: 'C1' }, {} as never)
    expect(result.content).toContain('A57 is #DIV/0!')
    expect(result.content).toContain('2000 cells feeding this')
  })

  /**
   * A range node carries no `text`, so the old renderer printed `displays ""` — which reads as an
   * empty cell and would have the model report the block as blank. Rendering it in its own shape
   * is what stops a summary being mistaken for a value.
   */
  it('does not read as an empty cell', async () => {
    const tool = createExcelTraceTool({
      bridge: bridgeReturning({ workbook: 'Book1.xlsx', start: 'Data!C1', nodes: [rangeNode] }),
    })
    const result = await tool.execute({ cell: 'C1' }, {} as never)
    expect(result.content).not.toContain('displays ""')
    expect(result.content).toContain('1999 numeric')
  })

  it('says when more cells are in error than it listed', async () => {
    const tool = createExcelTraceTool({
      bridge: bridgeReturning({
        workbook: 'Book1.xlsx',
        start: 'Data!C1',
        nodes: [{ ...rangeNode, errors: 40, errorCells: ['A57 is #DIV/0!'] }],
      }),
    })
    const result = await tool.execute({ cell: 'C1' }, {} as never)
    expect(result.content).toContain('including')
  })

  /** A partial answer presented as a whole one is the failure worth avoiding here. */
  it('says so when the walk stopped at its limit', async () => {
    const tool = createExcelTraceTool({
      bridge: bridgeReturning({
        workbook: 'Book1.xlsx',
        start: 'Data!C1',
        nodes: [rangeNode],
        truncated: true,
      }),
    })
    const result = await tool.execute({ cell: 'C1' }, {} as never)
    expect(result.content).toContain('partial picture')
  })

  it('still renders an ordinary cell as a cell', async () => {
    const tool = createExcelTraceTool({
      bridge: bridgeReturning({
        workbook: 'Book1.xlsx',
        start: 'Calc!B2',
        nodes: [{ address: 'B2', sheet: 'Calc', depth: 0, text: '#DIV/0!', formula: '=B1*2', feeds: ['Calc!B1'] }],
      }),
    })
    const result = await tool.execute({ cell: 'B2' }, {} as never)
    expect(result.content).toContain('Calc!B2, displays "#DIV/0!", formula =B1*2 <- Calc!B1')
  })
})
