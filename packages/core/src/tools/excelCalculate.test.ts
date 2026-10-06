import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createExcelCalculateTool } from './officeVba.js'

/**
 * Reported: the agent could not "select the range of cells and do Shift+F9". The worker's
 * Calculate methods are the same act as the keys; these pin the wording and the wiring.
 */
const worker = readFileSync(fileURLToPath(new URL('../office/worker.ps1', import.meta.url)), 'utf8')

const toolWith = (respond: (request: Record<string, unknown>) => unknown) =>
  createExcelCalculateTool({ bridge: { request: async (request: Record<string, unknown>) => respond(request) } } as never)

describe('recalculating in Excel', () => {
  it('says in the approval which keys it stands for', async () => {
    const tool = toolWith(() => ({}))
    expect(await tool.preview?.({ sheet: 'Data', range: 'B2:D9', select: true }, {} as never)).toEqual({
      kind: 'text',
      text: 'Recalculate Data!B2:D9, and select it so it is visible.',
    })
    expect((await tool.preview?.({ sheet: 'Data' }, {} as never)) as { text: string }).toMatchObject({ text: 'Recalculate Data (Shift+F9).' })
    expect((await tool.preview?.({ scope: 'all', full: true }, {} as never)) as { text: string }).toMatchObject({
      text: 'Recalculate every formula in every open workbook (Ctrl+Alt+F9).',
    })
  })

  it('reports manual calculation and what the cells show now', async () => {
    let sent: Record<string, unknown> = {}
    const tool = toolWith((request) => {
      sent = request
      return { sheet: 'Data', scope: 'range', range: 'B2:B3', mode: 'manual', pending: false, cells: [{ address: 'B2', text: '42' }, { address: 'B3', text: '' }] }
    })
    const result = await tool.execute({ sheet: 'Data', range: 'B2:B3' }, {} as never)
    expect(sent).toMatchObject({ op: 'excel.calculate', sheet: 'Data', range: 'B2:B3' })
    expect(result.content).toContain('Calculation mode: manual')
    expect(result.content).toContain('B2: 42')
    expect(result.content).toContain('B3: (empty)')
  })

  it('is dispatched by the worker, with Calculate methods rather than keystrokes', () => {
    expect(worker).toContain("'excel.calculate'       { return Invoke-ExcelCalculate -Request $Request }")
    expect(worker).toMatch(/\$range\.Calculate\(\)/)
    expect(worker).toMatch(/\$sheet\.Calculate\(\)/)
    expect(worker).toMatch(/\$app\.CalculateFull\(\)/)
    expect(worker).not.toMatch(/SendKeys/)
  })
})
