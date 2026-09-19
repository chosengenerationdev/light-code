import { describe, expect, it } from 'vitest'

import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import type { OfficeBridge } from '../office/bridge.js'
import { OFFICE_WORKER_SOURCE } from '../office/workerSource.js'
import { PathDenylist } from '../fs/denylist.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import { createExcelCreateTool, createExcelSaveTool, createExcelSheetsTool } from './office.js'
import type { ToolExecutionContext } from './types.js'

/** Records what the worker was asked to do, and answers with whatever the test needs. */
function fakeBridge(reply: unknown): OfficeBridge & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = []
  return {
    requests,
    async request(payload: Record<string, unknown>) {
      requests.push(payload)
      return reply
    },
  } as unknown as OfficeBridge & { requests: Record<string, unknown>[] }
}

const context = (root: string): ToolExecutionContext =>
  ({ workspaceRoot: root, denylist: new PathDenylist() }) as unknown as ToolExecutionContext

/*
 * A root that exists on disk, deliberately.
 *
 * `resolveToolPath` realpaths the root before comparing, so an invented path fails
 * containment for the wrong reason - and every "it refused" assertion below would then
 * pass whatever the code did.
 */
const ROOT = process.cwd()

describe('excel_create_workbook', () => {
  const reply = {
    workbook: 'March.xlsx',
    fullName: `${ROOT}/March.xlsx`,
    sheets: ['Summary', 'Data'],
    started: false,
    replaced: false,
  }

  it('refuses an extension Excel cannot write, before anything is spawned', async () => {
    // Checked here as well as in the worker so the *approval prompt* can say it, rather than the
    // user approving a create that was never going to work.
    const bridge = fakeBridge(reply)
    const result = await createExcelCreateTool({ bridge }).execute(
      { path: 'report.pages' },
      context(ROOT),
    )
    expect(result.isError).toBe(true)
    expect(bridge.requests).toEqual([])
  })

  it('refuses a path with no extension at all', async () => {
    const bridge = fakeBridge(reply)
    const result = await createExcelCreateTool({ bridge }).execute({ path: 'report' }, context(ROOT))
    expect(result.isError).toBe(true)
    expect(bridge.requests).toEqual([])
  })

  it('will not write outside the workspace', async () => {
    // `write: true` on `resolveToolPath`: a file created outside the workspace has no checkpoint
    // behind it, which is the one place this differs from `excel_open_workbook`.
    const bridge = fakeBridge(reply)
    const result = await createExcelCreateTool({ bridge }).execute(
      { path: '../escaped.xlsx' },
      context(ROOT),
    )
    expect(result.isError).toBe(true)
    expect(bridge.requests).toEqual([])
  })

  it('says in the preview whether an existing file would be replaced', async () => {
    const tool = createExcelCreateTool({ bridge: fakeBridge(reply) })
    const guarded = await tool.preview?.({ path: 'a.xlsx' }, context(ROOT))
    const replacing = await tool.preview?.({ path: 'a.xlsx', overwrite: true }, context(ROOT))
    expect(guarded?.kind === 'text' ? guarded.text : '').toContain('Refuses if a file is already there')
    expect(replacing?.kind === 'text' ? replacing.text : '').toContain('REPLACES')
  })

  it('tells the model that filling it in afterwards needs a separate save', async () => {
    // Every other Excel write leaves the workbook dirty on purpose. A model that does not know
    // that reports "created and filled in" for a file holding an empty sheet.
    const result = await createExcelCreateTool({ bridge: fakeBridge(reply) }).execute(
      { path: 'March.xlsx', sheets: ['Summary', 'Data'] },
      context(ROOT),
    )
    if (result.isError === true) throw new Error(result.content)
    expect(result.content).toContain('excel_save_workbook')
  })
})

describe('excel_save_workbook', () => {
  it('saves in place without resolving a path at all', async () => {
    /*
     * Saving in place writes back to a file the user opened themselves, wherever it lives.
     * Confining it would make the tool useless for the workbook somebody is actually looking at,
     * which is on a share more often than not — and it creates nothing new.
     */
    const bridge = fakeBridge({
      workbook: 'March.xlsx',
      fullName: '\\\\finance\\reports\\March.xlsx',
      savedAs: false,
      wasDirty: true,
      replaced: false,
    })
    const result = await createExcelSaveTool({ bridge }).execute({}, context(ROOT))
    expect(result.isError).not.toBe(true)
    expect(bridge.requests[0]).toMatchObject({ op: 'excel.save' })
    expect(bridge.requests[0]?.path).toBeUndefined()
  })

  it('confines a save-a-copy path, because that names somewhere new', async () => {
    const bridge = fakeBridge({})
    const result = await createExcelSaveTool({ bridge }).execute(
      { path: '../elsewhere.xlsx' },
      context(ROOT),
    )
    expect(result.isError).toBe(true)
    expect(bridge.requests).toEqual([])
  })

  it('says so when there was nothing to save', async () => {
    // Otherwise somebody is left believing an edit they expected was written to disk.
    const bridge = fakeBridge({
      workbook: 'March.xlsx',
      fullName: `${ROOT}/March.xlsx`,
      savedAs: false,
      wasDirty: false,
      replaced: false,
    })
    const result = await createExcelSaveTool({ bridge }).execute({}, context(ROOT))
    expect(result.content).toContain('no unsaved changes')
  })

  it('calls an in-place save the point of no return in its preview', async () => {
    const preview = await createExcelSaveTool({ bridge: fakeBridge({}) }).preview?.(
      {},
      context(ROOT),
    )
    expect(preview?.kind === 'text' ? preview.text : '').toContain('point of no return')
  })
})

describe('excel_sheets', () => {
  const reply = {
    workbook: 'March.xlsx',
    action: 'add',
    before: ['Sheet1'],
    sheets: ['Sheet1', 'Data'],
    saved: false,
  }

  it('is one tool with named actions rather than six near-identical tools', () => {
    const tool = createExcelSheetsTool({ bridge: fakeBridge(reply) })
    const parsed = tool.parametersSchema.safeParse({ action: 'nonsense' })
    expect(parsed.success).toBe(false)
    expect(tool.parametersSchema.safeParse({ action: 'delete', sheet: 'Data' }).success).toBe(true)
  })

  it('says a list changes nothing, and does not read the sheet to ask', async () => {
    const bridge = fakeBridge(reply)
    const preview = await createExcelSheetsTool({ bridge }).preview?.({ action: 'list' }, context(ROOT))
    expect(preview?.kind === 'text' ? preview.text : '').toContain('Changes nothing')
    expect(bridge.requests).toEqual([])
  })

  it('shows what is on a sheet before deleting it', async () => {
    /*
     * Invariant 8 applied to the thing being destroyed: "delete Sheet3" says nothing about whether
     * Sheet3 is empty or holds the source data for every formula in the file.
     */
    const bridge = fakeBridge({
      cells: [
        { address: 'A1', value: 'Trade id', text: 'Trade id' },
        { address: 'A2', value: 10, text: '10' },
      ],
    })
    const preview = await createExcelSheetsTool({ bridge }).preview?.(
      { action: 'delete', sheet: 'Data' },
      context(ROOT),
    )
    const text = preview?.kind === 'text' ? preview.text : ''
    expect(text).toContain('DELETE')
    expect(text).toContain('Trade id')
    expect(text).toContain('#REF!')
    expect(bridge.requests[0]).toMatchObject({ op: 'excel.readRange', sheet: 'Data' })
  })

  it('still asks when the sheet could not be read', async () => {
    // A preview that throws would become a delete nobody was asked about.
    const bridge = {
      async request() {
        throw new Error('Excel is busy')
      },
    } as unknown as OfficeBridge
    const preview = await createExcelSheetsTool({ bridge }).preview?.(
      { action: 'delete', sheet: 'Data' },
      context(ROOT),
    )
    expect(preview?.kind === 'text' ? preview.text : '').toContain('Could not read')
  })

  it('reports the change as unsaved', async () => {
    const result = await createExcelSheetsTool({ bridge: fakeBridge(reply) }).execute(
      { action: 'add', sheet: 'Data' },
      context(ROOT),
    )
    expect(result.content).toContain('NOT saved')
  })
})

describe('how the three are gated', () => {
  const added = ['excel_create_workbook', 'excel_save_workbook', 'excel_sheets']

  it('always asks, whatever is auto-approved', () => {
    // One writes a file, one spends the only undo the feature has, one can delete a sheet.
    for (const name of added) expect(ALWAYS_ASK_TOOLS.has(name)).toBe(true)
  })

  it('is never available to a scheduled run', () => {
    // A scheduled run replaces the approval gate rather than wrapping it, so `ALWAYS_ASK_TOOLS`
    // never runs for it — which is why the list has to be repeated there.
    for (const name of added) expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain(name)
  })

  it('is an edit, so it sits behind the task checkpoint', () => {
    const bridge = fakeBridge({})
    expect(createExcelCreateTool({ bridge }).group).toBe('edit')
    expect(createExcelSaveTool({ bridge }).group).toBe('edit')
    expect(createExcelSheetsTool({ bridge }).group).toBe('edit')
  })
})

describe('the worker half', () => {
  it('handles the three new operations', () => {
    // The tools are useless against a worker that does not know the op, and the dispatch table is
    // the one place that can be forgotten without a type error.
    for (const op of ['excel.create', 'excel.save', 'excel.sheets']) {
      expect(OFFICE_WORKER_SOURCE).toContain(`'${op}'`)
    }
  })

  it('suppresses Excel dialogs around every call that raises one, and restores them', () => {
    /*
     * "Replace the existing file?", "data may be lost in this format", "are you sure you want to
     * delete this sheet?" — with nobody to answer, the call does not fail, it *hangs* until the
     * tool times out, and is reported as Excel being slow. Restoring them matters just as much:
     * leaving alerts off would disarm the confirmations the user gets working in Excel afterwards.
     */
    expect(OFFICE_WORKER_SOURCE).toContain('function Invoke-WithoutAlerts')
    expect(OFFICE_WORKER_SOURCE).toContain('$App.DisplayAlerts = $previous')
  })

  it('names the file format rather than letting SaveAs infer it', () => {
    // SaveAs with no format writes whatever the workbook currently is, so saving as `report.csv`
    // produces an xlsx called `report.csv` — silent at the point it is made, and read as data
    // corruption wherever it is opened next.
    expect(OFFICE_WORKER_SOURCE).toContain('function Get-ExcelFormat')
    expect(OFFICE_WORKER_SOURCE).toContain('$wb.SaveAs($path, $format)')
  })

  it('only excel.create may start Excel, as before', () => {
    // §12c's attach-only rule: `excel_open_workbook` was the single exception, and creating a file
    // the user named is the same case. Nothing else may guess.
    const starts = OFFICE_WORKER_SOURCE.split('New-Object -ComObject Excel.Application').length - 1
    expect(starts).toBe(2)
  })
})
