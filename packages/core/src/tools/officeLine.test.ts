import { describe, expect, it } from 'vitest'

import { createExcelReadMacroTool } from './office.js'
import { createExcelCheckMacroTool } from './officeVba.js'
import type { OfficeBridge } from '../office/bridge.js'
import type { ToolExecutionContext } from './types.js'

/**
 * "If I tell the agent at what line the VBA fails, can it investigate based on it?"
 *
 * It can only if the numbering it sees is the numbering the user is reading — the VBA editor's,
 * counting from the first line of the module with blanks and comments included. Before this, the
 * source came back as an unnumbered blob and the model had to count, which it does badly; being
 * confidently wrong about *which* line failed is worse than not knowing.
 */
const code = [
  'Sub Report()',
  '    Dim n',
  '    On Error Resume Next',
  '    n = Sheets("Gone").Range("A1").Value',
  '    Debug.Print n',
  'End Sub',
].join('\n')

const bridge = {
  request: async (request: { op: string }) => {
    if (request.op === 'excel.readMacro') return { workbook: 'Book1', module: 'Reports', code }
    if (request.op === 'excel.sessions') return { workbooks: [{ name: 'Book1', sheets: ['Data'] }] }
    throw new Error(`unexpected ${request.op}`)
  },
} as unknown as OfficeBridge

const context = {} as unknown as ToolExecutionContext
const read = (params: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> =>
  createExcelReadMacroTool({ bridge }).execute(params as never, context)
const check = (params: Record<string, unknown>): Promise<{ content: string }> =>
  createExcelCheckMacroTool({ bridge }).execute(params as never, context)

describe('reading a module the user has named a line in', () => {
  it('numbers every line, so a line number means the same thing to both sides', async () => {
    const result = await read({ module: 'Reports' })
    expect(result.content).toContain('   1 | Sub Report()')
    expect(result.content).toContain('   6 | End Sub')
  })

  it('marks the line asked about and shows its surroundings', async () => {
    const result = await read({ module: 'Reports', aroundLine: 4, context: 1 })
    expect(result.content).toContain('>>   4 |')
    expect(result.content).toContain('   3 |')
    expect(result.content).toContain('   5 |')
    expect(result.content).not.toContain('   1 |')
  })

  /**
   * A line past the end almost always means the failure is in a different module. An empty window
   * would send the investigation the wrong way with no hint that anything was odd.
   */
  it('says so when the line is not in this module at all', async () => {
    const result = await read({ module: 'Reports', aroundLine: 90 })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('only 6 lines')
    expect(result.content).toContain('different module')
  })

  it('clamps to the start of the module rather than asking for line zero', async () => {
    const result = await read({ module: 'Reports', aroundLine: 1, context: 5 })
    expect(result.content).toContain('>>   1 | Sub Report()')
  })
})

describe('checking a module against a named line', () => {
  it('quotes the line back, so a mismatch in numbering is visible immediately', async () => {
    const result = await check({ module: 'Reports', aroundLine: 4 })
    expect(result.content).toContain('Line 4 reads:')
    expect(result.content).toContain('Sheets("Gone")')
  })

  it('puts the finding on that line first', async () => {
    const result = await check({ module: 'Reports', aroundLine: 4 })
    const findings = result.content.split('\n').filter((line) => line.startsWith('line '))
    expect(findings[0]).toContain('line 4')
  })

  /**
   * Ranked, never filtered. The cause is often nowhere near the symptom — the swallowed error on
   * line 3 is exactly why line 4 fails quietly — so everything is still reported.
   */
  it('still reports findings elsewhere in the module', async () => {
    const result = await check({ module: 'Reports', aroundLine: 4 })
    expect(result.content).toContain('line 3')
    expect(result.content).toContain('line 1')
  })

  it('leaves the order alone when no line was named', async () => {
    const result = await check({ module: 'Reports' })
    const findings = result.content.split('\n').filter((line) => line.startsWith('line '))
    expect(findings[0]).toContain('line 1')
  })
})
