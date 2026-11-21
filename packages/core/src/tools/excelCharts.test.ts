import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import type { OfficeBridge } from '../office/bridge.js'
import { OFFICE_WORKER_SOURCE } from '../office/workerSource.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import { CHART_TYPES, createExcelChartTool, createExcelPivotTool, PIVOT_SUMMARIES, renderGrid } from './excelCharts.js'
import type { ToolExecutionContext } from './types.js'

/** Records what the worker was asked, and answers each op with the reply given for it. */
function fakeBridge(replies: Record<string, unknown>): OfficeBridge & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = []
  return {
    requests,
    async request(payload: Record<string, unknown>) {
      requests.push(payload)
      const reply = replies[String(payload['op'])]
      if (reply instanceof Error) throw reply
      return reply
    },
  } as unknown as OfficeBridge & { requests: Record<string, unknown>[] }
}

const context = {} as ToolExecutionContext
const shape = { workbook: 'Sales.xlsx', sheet: 'Data', address: 'A1:E40', rows: 40, columns: 5, areas: 1, headers: ['Region', 'Product', 'Month', 'Revenue', 'Units'], sheets: ['Data'] }

describe('excel_chart', () => {
  it('shows the data and its headings in the approval, read live', async () => {
    const bridge = fakeBridge({ 'excel.rangeShape': shape })
    const preview = await createExcelChartTool({ bridge }).preview!({ action: 'create', type: 'line', range: 'A1:E40', title: 'Trend' }, context)
    expect(preview.kind).toBe('text')
    const text = (preview as { text: string }).text
    expect(text).toContain('Create a line chart')
    expect(text).toContain('Data!A1:E40')
    expect(text).toContain('Region | Product | Month | Revenue | Units')
    expect(text).toContain('left unsaved')
  })

  it('sends column when no type is given, and only the fields that were given', async () => {
    const bridge = fakeBridge({ 'excel.chart': { workbook: 'Sales.xlsx', chart: { name: 'Chart 1', sheet: 'Data', at: 'G1', to: 'P21', type: 'column', series: [] }, notes: [], saved: false } })
    const result = await createExcelChartTool({ bridge }).execute({ action: 'create', sheet: 'Data' }, context)
    expect(result.isError).toBeUndefined()
    expect(bridge.requests[0]).toEqual({ op: 'excel.chart', action: 'create', sheet: 'Data', type: 'column' })
    expect(result.content).toContain('NOT saved')
  })

  it('reports each series formula, so a chart over the wrong column is visible', async () => {
    const formula = "=SERIES(Data!$D$1,Data!$C$2:$C$40,Data!$D$2:$D$40,1)"
    const bridge = fakeBridge({ 'excel.chart': { workbook: 'Sales.xlsx', chart: { name: 'Chart 1', sheet: 'Data', at: 'G1', to: 'P21', type: 'combo', series: [{ name: 'Revenue', formula, type: 'column' }, { name: 'Units', type: 'line', secondaryAxis: true }] }, notes: ['This kind of chart has no category (x) axis, so that title was not set.'], saved: false } })
    const result = await createExcelChartTool({ bridge }).execute({ action: 'create', type: 'column', series: [{ name: 'Units', type: 'line', secondaryAxis: true }] }, context)
    expect(result.content).toContain(formula)
    expect(result.content).toContain('on the secondary axis')
    expect(result.content).toContain('Note: This kind of chart has no category')
  })

  it('needs a name to update, delete or picture, before asking the worker', async () => {
    const bridge = fakeBridge({})
    for (const action of ['update', 'delete', 'picture'] as const) {
      const result = await createExcelChartTool({ bridge }).execute({ action }, context)
      expect(result.isError).toBe(true)
    }
    expect(bridge.requests).toEqual([])
  })

  it('attaches the picture and removes the temporary file', async () => {
    const file = path.join(os.tmpdir(), `light-code-chart-test-${String(Date.now())}.png`)
    await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const bridge = fakeBridge({ 'excel.chart': { workbook: 'Sales.xlsx', file, chart: { name: 'Sales', sheet: 'Data', at: 'G1', to: 'P21', type: 'column', series: [] } } })
    const result = await createExcelChartTool({ bridge }).execute({ action: 'picture', name: 'Sales' }, context)
    expect(result.images?.[0]?.mediaType).toBe('image/png')
    expect(result.images?.[0]?.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))
    await expect(fs.stat(file)).rejects.toThrow()
  })

  it('says when the data could not be read rather than failing the approval', async () => {
    const bridge = fakeBridge({ 'excel.rangeShape': new Error('Excel is not running on this machine. Open it and try again.') })
    const preview = await createExcelChartTool({ bridge }).preview!({ action: 'create', type: 'pie' }, context)
    expect((preview as { text: string }).text).toContain('Could not read the data')
  })
})

describe('excel_pivot_table', () => {
  it('flags a field that is not a heading before anyone approves it', async () => {
    const bridge = fakeBridge({ 'excel.rangeShape': shape })
    const preview = await createExcelPivotTool({ bridge }).preview!({ action: 'create', rows: ['Regoin'], values: [{ field: 'Revenue', showAs: 'percentOfTotal' }] }, context)
    const text = (preview as { text: string }).text
    expect(text).toContain('Regoin (NOT A HEADING IN THE DATA')
    expect(text).toContain('Value: sum of Revenue, shown as percentOfTotal')
    expect(text).toContain('new sheet "Pivot of Data"')
  })

  it('returns the numbers it made as a table', async () => {
    const bridge = fakeBridge({
      'excel.pivot': {
        workbook: 'Sales.xlsx',
        pivot: { name: 'PivotTable1', sheet: 'Pivot of Data', location: 'A3:C7', source: "'Data'!R1C1:R40C5", rows: ['Region'], columns: ['Values'], values: ['Sum of Revenue'], filters: [] },
        preview: { rows: [['Row Labels', 'Sum of Revenue'], ['North', '3,300'], ['Grand Total', '3,300']], totalRows: 3, totalColumns: 2 },
        addedSheet: 'Pivot of Data',
        chart: 'Chart 2',
        saved: false,
      },
    })
    const result = await createExcelPivotTool({ bridge }).execute({ action: 'create', rows: ['Region'], values: [{ field: 'Revenue' }], chartType: 'column' }, context)
    expect(result.content).toContain('| North | 3,300 |')
    expect(result.content).toContain('rows: Region')
    expect(result.content).not.toContain('columns: Values')
    expect(result.content).toContain('pivot chart "Chart 2"')
  })

  it('says how much of a large table was left out', () => {
    expect(renderGrid({ rows: [['a', 'b']], totalRows: 50, totalColumns: 20 })).toContain('49 more rows and 18 more columns')
  })
})

describe('chart and pivot safety', () => {
  it('always asks and never runs unattended, like every other Excel write', () => {
    for (const name of ['excel_chart', 'excel_pivot_table']) {
      expect(ALWAYS_ASK_TOOLS).toContain(name)
      expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain(name)
    }
  })

  it('offers only the names the worker maps to Excel constants', () => {
    for (const type of CHART_TYPES) expect(OFFICE_WORKER_SOURCE).toContain(`'${type}' = `)
    for (const fn of PIVOT_SUMMARIES) expect(OFFICE_WORKER_SOURCE).toContain(`'${fn}' = `)
  })

  it('removes a half-made chart or pivot table when a create fails, so a retry does not leave two', () => {
    expect(OFFICE_WORKER_SOURCE).toMatch(/\$chartObject\.Delete\(\) \| Out-Null/)
    expect(OFFICE_WORKER_SOURCE).toMatch(/\$table\.TableRange2\.Clear\(\) \| Out-Null/)
  })

  it('returns a Range wrapped, because PowerShell unrolls a bare one into its cells', () => {
    expect(OFFICE_WORKER_SOURCE).toContain('return ,$first.CurrentRegion')
  })
})
