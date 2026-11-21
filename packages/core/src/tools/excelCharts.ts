import fs from 'node:fs/promises'
import { z } from 'zod'

import type { OfficeRequest } from '../office/bridge.js'
import type { OfficeToolOptions } from './office.js'
import type { Tool, ToolPreview, ToolResult } from './types.js'

/**
 * Charts and pivot tables over the data in an open workbook.
 *
 * ## Two tools, each with named actions
 *
 * The same reasoning as `excel_sheets` (CLAUDE.md section 17): list / create / update / delete
 * over one noun share almost every argument, and a model discriminates between tools by their
 * descriptions, which would differ by a word. Charts and pivot tables are different nouns with
 * different arguments, so they are two tools rather than one.
 *
 * ## What the approval shows
 *
 * Invariant 8: the preview reads the data block live - through the same worker function the create
 * uses - and names its columns, so "a column chart of A1:E40" says which columns become series, and
 * a pivot field that is not a column heading is flagged before anyone approves it.
 *
 * ## Nothing is saved
 *
 * Like every Excel write here the workbook is left dirty, so closing without saving is the undo;
 * `excel_save_workbook` keeps it. Both tools are `edit`, always ask, and never run unattended
 * (`ALWAYS_ASK_TOOLS`, `NEVER_AVAILABLE_TO_SCHEDULES`): they change somebody's open workbook.
 */

/** The chart types offered, by the names the worker maps to Excel's constants (`$script:ChartTypes`). */
export const CHART_TYPES = [
  'column',
  'stackedColumn',
  'stackedColumn100',
  'bar',
  'stackedBar',
  'stackedBar100',
  'line',
  'lineMarkers',
  'stackedLine',
  'pie',
  'doughnut',
  'area',
  'stackedArea',
  'scatter',
  'scatterLines',
  'scatterSmooth',
  'bubble',
  'radar',
  'radarFilled',
  'histogram',
  'pareto',
  'waterfall',
  'treemap',
  'sunburst',
  'boxWhisker',
  'funnel',
] as const

export const PIVOT_SUMMARIES = ['sum', 'count', 'average', 'max', 'min', 'product', 'countNumbers', 'stdDev', 'var'] as const
export const PIVOT_SHOW_AS = ['normal', 'percentOfTotal', 'percentOfRow', 'percentOfColumn'] as const

const workbookField = z.string().optional().describe('Workbook name from excel_sessions. Omit for whichever workbook is active.')

const chartTypeField = z
  .enum(CHART_TYPES)
  .describe(
    'Chart type. column/bar compare categories; line/area show change over time; pie/doughnut show shares of one total; ' +
      'scatter relates two numbers; bubble adds a third; histogram/boxWhisker show distribution; pareto, waterfall, treemap, ' +
      'sunburst and funnel need Excel 2016 or later. For a combo chart create a column chart and give some series their own type.',
  )

const chartSchema = z.object({
  action: z
    .enum(['list', 'create', 'update', 'delete', 'picture'])
    .describe('list: the charts and what each plots (changes nothing). create: a new chart. update: change one. delete: remove one. picture: see what a chart looks like.'),
  workbook: workbookField,
  sheet: z
    .string()
    .optional()
    .describe('For create (and update with range): the sheet holding the data. For list: only charts on this sheet. Omit for the active sheet.'),
  range: z
    .string()
    .optional()
    .describe(
      'The data to plot, e.g. "A1:D20", without the sheet name. The first row should be headings (they become series names) and the first column ' +
        'the categories. Pick columns with a union such as "A1:A20,C1:D20". Omit to use the block of data around the top-left of the sheet.',
    ),
  type: chartTypeField.optional(),
  name: z.string().optional().describe('For create: what to call the new chart (optional). For update, delete and picture: the chart, as list shows it.'),
  newName: z.string().optional().describe('For update: a new name for the chart.'),
  title: z.string().optional().describe('Chart title. An empty string removes it.'),
  xAxisTitle: z.string().optional().describe('Title of the category (horizontal) axis. Empty removes it.'),
  yAxisTitle: z.string().optional().describe('Title of the value (vertical) axis. Empty removes it.'),
  valueFormat: z.string().optional().describe('Excel number format for the value axis, e.g. "#,##0", "0%", "$#,##0.00".'),
  legend: z.enum(['right', 'bottom', 'top', 'left', 'none']).optional().describe('Where the legend goes, or none.'),
  dataLabels: z.boolean().optional().describe('Show each point\'s value on the chart.'),
  seriesIn: z
    .enum(['columns', 'rows'])
    .optional()
    .describe('Whether each column or each row of the data is a series. Omit to let Excel decide (usually columns).'),
  series: z
    .array(
      z.object({
        name: z.string().describe('The series, by its heading.'),
        type: chartTypeField.optional(),
        secondaryAxis: z.boolean().optional().describe('Plot this series against a second value axis on the right - for a measure on a very different scale.'),
      }),
    )
    .optional()
    .describe('Per-series changes, for combo charts: e.g. revenue as columns and units as a line on a secondary axis.'),
  placeOn: z
    .string()
    .optional()
    .describe('For create: the sheet to put the chart on. A name that does not exist yet becomes a new sheet. Omit to place it beside the data.'),
  at: z.string().optional().describe('Top-left cell to place the chart at, e.g. "H2". Omit to place it just right of the data.'),
  width: z.number().min(100).max(2000).optional().describe('Width in points (default 480).'),
  height: z.number().min(80).max(1500).optional().describe('Height in points (default 288).'),
  style: z.number().int().min(201).max(500).optional().describe('Excel chart style number (201 onwards). Rarely needed.'),
})

type ChartParams = z.infer<typeof chartSchema>

interface ChartSummary {
  name: string
  sheet: string
  at: string
  to: string
  type: string
  title?: string
  pivot?: boolean
  series: { name: string; formula?: string; type?: string; secondaryAxis?: boolean }[]
}

interface RangeShape {
  workbook: string
  sheet: string
  address: string
  rows: number
  columns: number
  areas: number
  headers: string[]
  sheets: string[]
}

/** The request the worker receives: only the fields that were given. */
function request(op: string, params: Record<string, unknown>): OfficeRequest {
  const out: OfficeRequest = { op }
  for (const [key, value] of Object.entries(params)) if (value !== undefined) out[key] = value
  return out
}

function renderChart(chart: ChartSummary): string {
  const lines = [`"${chart.name}" on ${chart.sheet} (${chart.at}:${chart.to}) - ${chart.type}${chart.pivot === true ? ' pivot chart' : ''}${chart.title !== undefined ? `, titled "${chart.title}"` : ''}`]
  for (const series of chart.series) {
    lines.push(
      `  series "${series.name}"${series.type !== undefined && series.type !== chart.type ? ` as ${series.type}` : ''}${series.secondaryAxis === true ? ' on the secondary axis' : ''}${series.formula !== undefined ? `: ${series.formula}` : ''}`,
    )
  }
  return lines.join('\n')
}

/** What the approval says about the data: where it is and which headings become what. */
async function describeData(options: OfficeToolOptions, params: { workbook?: string | undefined; sheet?: string | undefined; range?: string | undefined }): Promise<{ shape?: RangeShape; text: string }> {
  try {
    const shape = await options.bridge.request<RangeShape>(request('excel.rangeShape', { workbook: params.workbook, sheet: params.sheet, range: params.range }))
    const headers = shape.headers.map((header) => (header === '' ? '(blank)' : header))
    return {
      shape,
      text: [
        `Data: ${shape.sheet}!${shape.address} in ${shape.workbook} - ${String(shape.rows)} rows (heading row included), ${String(shape.columns)} columns.`,
        `Headings: ${headers.slice(0, 40).join(' | ')}${headers.length > 40 ? ` | ... (${String(headers.length - 40)} more)` : ''}`,
      ].join('\n'),
    }
  } catch (error) {
    return { text: `Could not read the data to show it here: ${message(error)}` }
  }
}

export function createExcelChartTool(options: OfficeToolOptions): Tool<ChartParams> {
  return {
    name: 'excel_chart',
    // `edit` as a whole, list and picture included - the same call excel_sheets makes: groups gate
    // a tool, not a call, and the preview says plainly when nothing changes.
    group: 'edit',
    description:
      'Create, change, list or delete charts in an open Excel workbook, from data already in a sheet. Pick the chart type for what the user ' +
      'wants to see (comparison: column/bar; trend: line; share: pie; relationship: scatter; distribution: histogram), choose the columns with ' +
      '"range", and set titles, axis titles, legend, data labels and number format. A combo chart is a column chart with some series given ' +
      'another type and optionally a secondary axis. After creating one, use action "picture" to look at it and check it shows what was asked. ' +
      'The workbook is left unsaved; call excel_save_workbook to keep the chart. For a chart of a pivot table, give excel_pivot_table a chartType.',
    parametersSchema: chartSchema,

    async preview(params): Promise<ToolPreview> {
      const which = params.workbook ?? 'the active workbook'
      if (params.action === 'list') return { kind: 'text', text: `List the charts in ${which}${params.sheet !== undefined ? ` on ${params.sheet}` : ''}. Changes nothing.` }
      if (params.action === 'picture') return { kind: 'text', text: `Take a picture of the chart "${params.name ?? ''}" in ${which} so the assistant can see it. Changes nothing.` }
      if (params.action === 'delete') {
        return {
          kind: 'text',
          text: [`DELETE the chart "${params.name ?? ''}" from ${which}.`, '', 'The data it plots is not touched. The workbook is left unsaved, so closing without saving brings the chart back.'].join('\n'),
        }
      }

      const lines: string[] = []
      if (params.action === 'create') {
        lines.push(`Create a ${params.type ?? 'column'} chart${params.name !== undefined ? ` called "${params.name}"` : ''} in ${which}.`)
        lines.push((await describeData(options, params)).text)
        lines.push(
          params.placeOn !== undefined
            ? `Placed on the sheet "${params.placeOn}" (created if it does not exist)${params.at !== undefined ? ` at ${params.at}` : ''}.`
            : `Placed ${params.at !== undefined ? `at ${params.at}` : 'just right of the data'} on the data's sheet.`,
        )
      } else {
        lines.push(`Change the chart "${params.name ?? ''}" in ${which}:`)
        if (params.type !== undefined) lines.push(`  type -> ${params.type}`)
        if (params.range !== undefined) lines.push(`  plot instead: ${(await describeData(options, params)).text}`)
        if (params.newName !== undefined) lines.push(`  rename -> "${params.newName}"`)
        if (params.at !== undefined) lines.push(`  move to ${params.at}`)
        if (params.width !== undefined || params.height !== undefined) lines.push(`  size -> ${String(params.width ?? '(same)')} x ${String(params.height ?? '(same)')} points`)
      }
      if (params.seriesIn !== undefined) lines.push(`Each ${params.seriesIn === 'rows' ? 'row' : 'column'} is a series.`)
      if (params.title !== undefined) lines.push(params.title === '' ? 'No title.' : `Title: "${params.title}"`)
      if (params.xAxisTitle !== undefined) lines.push(`Horizontal axis title: "${params.xAxisTitle}"`)
      if (params.yAxisTitle !== undefined) lines.push(`Vertical axis title: "${params.yAxisTitle}"`)
      if (params.valueFormat !== undefined) lines.push(`Value axis format: ${params.valueFormat}`)
      if (params.legend !== undefined) lines.push(`Legend: ${params.legend}`)
      if (params.dataLabels !== undefined) lines.push(`Data labels: ${params.dataLabels ? 'on' : 'off'}`)
      for (const series of params.series ?? []) {
        lines.push(`Series "${series.name}"${series.type !== undefined ? ` as ${series.type}` : ''}${series.secondaryAxis === true ? ' on a secondary axis' : series.secondaryAxis === false ? ' on the main axis' : ''}`)
      }
      lines.push('', 'The workbook is left unsaved, so nothing reaches disk until it is saved.')
      return { kind: 'text', text: lines.join('\n') }
    },

    async execute(params): Promise<ToolResult> {
      if ((params.action === 'update' || params.action === 'delete' || params.action === 'picture') && (params.name ?? '').trim() === '') {
        return { content: `Action "${params.action}" needs the chart's name. Use action "list" to see them.`, isError: true }
      }
      try {
        const reply = await options.bridge.request<{
          workbook: string
          charts?: ChartSummary[]
          chartSheets?: string[]
          chart?: ChartSummary
          deleted?: ChartSummary
          source?: string
          addedSheet?: string | null
          notes?: string[]
          saved?: boolean
          file?: string
        }>(request('excel.chart', { ...params, type: params.action === 'create' ? (params.type ?? 'column') : params.type }))

        if (params.action === 'list') {
          const charts = reply.charts ?? []
          const lines = charts.length === 0 ? [`${reply.workbook} has no charts${params.sheet !== undefined ? ` on ${params.sheet}` : ''}.`] : [`${reply.workbook} has ${String(charts.length)} chart(s):`, ...charts.map(renderChart)]
          if ((reply.chartSheets ?? []).length > 0) lines.push(`Chart sheets (not editable here): ${(reply.chartSheets ?? []).join(', ')}`)
          return { content: lines.join('\n') }
        }

        if (params.action === 'picture') {
          const file = reply.file ?? ''
          try {
            const bytes = await fs.readFile(file)
            return {
              content: `A picture of the chart is attached.\n${reply.chart !== undefined ? renderChart(reply.chart) : ''}`,
              images: [{ label: `Chart "${params.name ?? ''}"`, mediaType: 'image/png', data: bytes.toString('base64') }],
            }
          } finally {
            await fs.rm(file, { force: true }).catch(() => undefined)
          }
        }

        const unsaved = reply.saved === true ? 'The workbook reports no unsaved changes.' : 'The workbook is NOT saved; call excel_save_workbook to keep this.'
        if (params.action === 'delete') {
          return { content: [`Deleted ${reply.deleted !== undefined ? renderChart(reply.deleted) : `"${params.name ?? ''}"`}`, '', unsaved].join('\n') }
        }

        const lines = [params.action === 'create' ? `Created ${reply.chart !== undefined ? renderChart(reply.chart) : 'the chart'}` : `Updated ${reply.chart !== undefined ? renderChart(reply.chart) : 'the chart'}`]
        if (reply.source !== undefined) lines.push(`Data: ${reply.source}`)
        if (typeof reply.addedSheet === 'string') lines.push(`Added the sheet "${reply.addedSheet}" for it.`)
        for (const note of reply.notes ?? []) lines.push(`Note: ${note}`)
        lines.push('Check each series formula above plots the intended cells; use action "picture" to see the chart.', '', unsaved)
        return { content: lines.join('\n') }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const pivotSchema = z.object({
  action: z
    .enum(['list', 'create', 'read', 'refresh', 'delete'])
    .describe('list: the pivot tables and their fields (changes nothing). create: a new one. read: its current numbers. refresh: recompute from changed data (one, or all when name is omitted). delete: remove one.'),
  workbook: workbookField,
  sheet: z.string().optional().describe('For create: the sheet holding the data. Omit for the active sheet.'),
  range: z
    .string()
    .optional()
    .describe('For create: the data, e.g. "A1:F500", heading row included, without the sheet name. Omit to use the block of data around the top-left of the sheet.'),
  name: z.string().optional().describe('For create: what to call it (optional). For read, refresh and delete: the pivot table, as list shows it.'),
  rows: z.array(z.string()).optional().describe('Column headings to group by down the side, outermost first.'),
  columns: z.array(z.string()).optional().describe('Column headings to spread across the top.'),
  filters: z.array(z.string()).optional().describe('Column headings to offer as report filters above the table.'),
  values: z
    .array(
      z.object({
        field: z.string().describe('The column heading to summarise.'),
        summarize: z.enum(PIVOT_SUMMARIES).optional().describe('How to summarise it. Default sum; use count for text columns.'),
        showAs: z.enum(PIVOT_SHOW_AS).optional().describe('Show the value itself (normal) or as a percentage of the grand total, its row or its column.'),
        caption: z.string().optional().describe('Heading for this value, e.g. "Total revenue". Default like "Sum of Revenue".'),
        numberFormat: z.string().optional().describe('Excel number format, e.g. "#,##0", "0.0%".'),
      }),
    )
    .optional()
    .describe('What to calculate in the body of the table.'),
  placeOn: z.string().optional().describe('The sheet to put it on. A name that does not exist becomes a new sheet. Omit for a new sheet called "Pivot of <data sheet>".'),
  at: z.string().optional().describe('Top-left cell, e.g. "A3". Omit for A3 on a new sheet, or just right of what an existing sheet holds.'),
  layout: z.enum(['compact', 'tabular', 'outline']).optional().describe('compact (Excel default, row fields in one column), tabular (each row field in its own column, easiest to copy) or outline.'),
  grandTotalRow: z.boolean().optional().describe('Show the grand total row at the bottom (default on).'),
  grandTotalColumn: z.boolean().optional().describe('Show the grand total column on the right (default on).'),
  chartType: chartTypeField.optional().describe('Also draw a pivot chart of it, beside it, of this type.'),
})

type PivotParams = z.infer<typeof pivotSchema>

interface PivotSummary {
  name: string
  sheet: string
  location: string
  source: string
  rows: string[]
  columns: string[]
  values: string[]
  filters: string[]
}

function renderPivot(pivot: PivotSummary): string {
  const parts = [`"${pivot.name}" on ${pivot.sheet} at ${pivot.location}, from ${pivot.source}`]
  if (pivot.rows.length > 0) parts.push(`  rows: ${pivot.rows.join(', ')}`)
  const columns = pivot.columns.filter((column) => column !== 'Values' && column !== 'Data')
  if (columns.length > 0) parts.push(`  columns: ${columns.join(', ')}`)
  if (pivot.values.length > 0) parts.push(`  values: ${pivot.values.map((value) => value.trim()).join(', ')}`)
  if (pivot.filters.length > 0) parts.push(`  filters: ${pivot.filters.join(', ')}`)
  return parts.join('\n')
}

/** The table's displayed body as a Markdown table, saying when it was cut. */
export function renderGrid(preview: { rows: string[][]; totalRows: number; totalColumns: number }): string {
  if (preview.rows.length === 0) return '(empty)'
  const width = Math.max(...preview.rows.map((row) => row.length))
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|').trim()
  const lines = preview.rows.map((row) => `| ${Array.from({ length: width }, (_, i) => escape(row[i] ?? '')).join(' | ')} |`)
  lines.splice(1, 0, `|${' --- |'.repeat(width)}`)
  const cut: string[] = []
  if (preview.totalRows > preview.rows.length) cut.push(`${String(preview.totalRows - preview.rows.length)} more rows`)
  if (preview.totalColumns > width) cut.push(`${String(preview.totalColumns - width)} more columns`)
  if (cut.length > 0) lines.push(`(${cut.join(' and ')} not shown - use action "read" or excel_read_range for the rest)`)
  return lines.join('\n')
}

export function createExcelPivotTool(options: OfficeToolOptions): Tool<PivotParams> {
  return {
    name: 'excel_pivot_table',
    group: 'edit',
    description:
      'Create, read, refresh, list or delete pivot tables in an open Excel workbook. Summarise a block of data by naming its column headings: ' +
      'rows to group by, columns to spread across, values to calculate (sum, count, average, max, min...; optionally as a percentage of the total, ' +
      'row or column) and report filters. Optionally draws a pivot chart beside it. The created table\'s numbers come back in the result. ' +
      'Use excel_read_range first if the headings are not known. The workbook is left unsaved; call excel_save_workbook to keep it.',
    parametersSchema: pivotSchema,

    async preview(params): Promise<ToolPreview> {
      const which = params.workbook ?? 'the active workbook'
      if (params.action === 'list') return { kind: 'text', text: `List the pivot tables in ${which}. Changes nothing.` }
      if (params.action === 'read') return { kind: 'text', text: `Read the pivot table "${params.name ?? ''}" in ${which}. Changes nothing.` }
      if (params.action === 'refresh') {
        return { kind: 'text', text: `Refresh ${params.name !== undefined ? `the pivot table "${params.name}"` : 'every pivot table'} in ${which} from its data. The numbers it shows may change; the workbook is left unsaved.` }
      }
      if (params.action === 'delete') {
        return { kind: 'text', text: `DELETE the pivot table "${params.name ?? ''}" from ${which}. Its data is not touched. The workbook is left unsaved, so closing without saving brings it back.` }
      }

      const data = await describeData(options, params)
      const lines = [`Create a pivot table${params.name !== undefined ? ` called "${params.name}"` : ''} in ${which}.`, data.text]
      const known = data.shape?.headers
      const check = (field: string): string => (known === undefined || known.includes(field) ? field : `${field} (NOT A HEADING IN THE DATA - this will be refused)`)
      if ((params.rows ?? []).length > 0) lines.push(`Rows: ${(params.rows ?? []).map(check).join(', ')}`)
      if ((params.columns ?? []).length > 0) lines.push(`Columns: ${(params.columns ?? []).map(check).join(', ')}`)
      if ((params.filters ?? []).length > 0) lines.push(`Filters: ${(params.filters ?? []).map(check).join(', ')}`)
      for (const value of params.values ?? []) {
        const how = value.summarize ?? 'sum'
        const shown = value.showAs !== undefined && value.showAs !== 'normal' ? `, shown as ${value.showAs}` : ''
        lines.push(`Value: ${how} of ${check(value.field)}${shown}${value.caption !== undefined ? `, headed "${value.caption}"` : ''}${value.numberFormat !== undefined ? `, format ${value.numberFormat}` : ''}`)
      }
      lines.push(
        params.placeOn !== undefined
          ? `Placed on the sheet "${params.placeOn}" (created if it does not exist)${params.at !== undefined ? ` at ${params.at}` : ''}.`
          : `Placed on a new sheet "Pivot of ${data.shape?.sheet ?? params.sheet ?? 'the data sheet'}".`,
      )
      if (params.layout !== undefined) lines.push(`Layout: ${params.layout}`)
      if (params.chartType !== undefined) lines.push(`With a ${params.chartType} pivot chart beside it.`)
      lines.push('', 'The workbook is left unsaved, so nothing reaches disk until it is saved.')
      return { kind: 'text', text: lines.join('\n') }
    },

    async execute(params): Promise<ToolResult> {
      if ((params.action === 'read' || params.action === 'delete') && (params.name ?? '').trim() === '') {
        return { content: `Action "${params.action}" needs the pivot table's name. Use action "list" to see them.`, isError: true }
      }
      try {
        const reply = await options.bridge.request<{
          workbook: string
          pivots?: PivotSummary[]
          pivot?: PivotSummary
          deleted?: PivotSummary
          preview?: { rows: string[][]; totalRows: number; totalColumns: number }
          refreshed?: string[]
          source?: string
          addedSheet?: string | null
          chart?: string | null
          saved?: boolean
        }>(request('excel.pivot', params))

        const unsaved = reply.saved === true ? 'The workbook reports no unsaved changes.' : 'The workbook is NOT saved; call excel_save_workbook to keep this.'
        switch (params.action) {
          case 'list': {
            const pivots = reply.pivots ?? []
            return { content: pivots.length === 0 ? `${reply.workbook} has no pivot tables.` : [`${reply.workbook} has ${String(pivots.length)} pivot table(s):`, ...pivots.map(renderPivot)].join('\n') }
          }
          case 'read':
            return { content: [reply.pivot !== undefined ? renderPivot(reply.pivot) : '', '', reply.preview !== undefined ? renderGrid(reply.preview) : ''].join('\n') }
          case 'refresh':
            return { content: [(reply.refreshed ?? []).length === 0 ? `${reply.workbook} has no pivot tables to refresh.` : `Refreshed: ${(reply.refreshed ?? []).join(', ')}`, '', unsaved].join('\n') }
          case 'delete':
            return { content: [`Deleted ${reply.deleted !== undefined ? renderPivot(reply.deleted) : `"${params.name ?? ''}"`}`, '', unsaved].join('\n') }
          case 'create': {
            const lines = [`Created ${reply.pivot !== undefined ? renderPivot(reply.pivot) : 'the pivot table'}`]
            if (typeof reply.addedSheet === 'string') lines.push(`Added the sheet "${reply.addedSheet}" for it.`)
            if (typeof reply.chart === 'string') lines.push(`Drew the pivot chart "${reply.chart}" beside it (excel_chart can change it, or take a picture).`)
            if (reply.preview !== undefined) lines.push('', renderGrid(reply.preview))
            lines.push('', unsaved)
            return { content: lines.join('\n') }
          }
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
