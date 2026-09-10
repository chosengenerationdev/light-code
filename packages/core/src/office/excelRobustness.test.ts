import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createExcelDiagnoseTool } from '../tools/office.js'
import type { OfficeBridge } from './bridge.js'

/**
 * The two things that made Excel unreliable in a real office, and the report that will identify
 * the next one.
 *
 * Both were measured rather than guessed at, and both are invisible to any test of what a tool
 * returns — so the shapes are asserted against `worker.ps1` directly, the same reasoning as
 * `officeTrace.test.ts` reading it for the precedent enumeration.
 */
const workerPath = fileURLToPath(new URL('./worker.ps1', import.meta.url))

async function worker(): Promise<string> {
  return fs.readFile(workerPath, 'utf8')
}

describe('finding every running Excel, not just one', () => {
  /**
   * Measured with two Excel windows open, each holding a workbook:
   *
   *   GetActiveObject      -> reached ONE instance, saw Book1 only
   *   Running Object Table -> zero Excel documents (unsaved workbooks register nothing)
   *
   * So the second workbook was invisible, and asking about a spreadsheet plainly on screen was
   * answered with "not open". In an office that is the ordinary case: mail attachments and
   * Protected View each get their own instance.
   */
  it('enumerates Excel windows rather than relying on the active object', async () => {
    const source = await worker()
    expect(source).toContain('XLMAIN')
    expect(source).toContain('XLDESK')
    expect(source).toContain('EXCEL7')
    expect(source).toContain('AccessibleObjectFromWindow')
  })

  /**
   * `out object` without this fails with "Specified OLE variant is invalid", which is what the
   * first attempt did. The attribute is the whole fix.
   */
  it('marshals the accessibility hand-back as IUnknown', async () => {
    expect(await worker()).toContain('[MarshalAs(UnmanagedType.IUnknown)] out object')
  })

  /** Both remain as fallbacks: either reaches one instance, which beats reaching none. */
  it('keeps the older routes as fallbacks', async () => {
    const source = await worker()
    expect(source).toContain('GetActiveObject')
    expect(source).toContain('Get-ExcelViaRot')
  })

  /** A workbook is found wherever it is open, which is what the single-instance search broke. */
  it('searches for a workbook across every instance', async () => {
    const source = await worker()
    expect(source).toContain('function Find-ExcelWorkbook')
    // `Get-Workbook` must delegate rather than keep its own single-instance loop.
    expect(source).toMatch(/function Get-Workbook \{[\s\S]{0,400}?Find-ExcelWorkbook/)
  })
})

describe('surviving an Excel that is momentarily busy', () => {
  /**
   * Measured: with a cell open for editing — the state a person is in whenever they are typing —
   * every COM call fails with 0x80010001 RPC_E_CALL_REJECTED. It is not an error in any useful
   * sense; the same call a moment later succeeds.
   */
  it('retries the three transient COM codes', async () => {
    const source = await worker()
    expect(source).toContain('0x80010001')
    expect(source).toContain('0x8001010A')
    expect(source).toContain('0x800AC472')
    expect(source).toContain('function Invoke-ComWithRetry')
  })

  /**
   * Only those three. A blanket retry would turn a genuine "no such sheet" into four seconds of
   * silence followed by the same error.
   */
  it('rethrows anything that is not transient, immediately', async () => {
    expect(await worker()).toContain('$script:transientComCodes -notcontains $code')
  })

  /** Backed off: someone typing a sentence holds Excel for seconds, not milliseconds. */
  it('backs off between attempts rather than hammering', async () => {
    expect(await worker()).toMatch(/delayMs \* 2/)
  })

  /**
   * Wrapped once around the whole request rather than sprinkled through each function. A
   * rejected call leaves nothing half-done, so repeating the operation is safe — and this way a
   * tool added later is covered without knowing the mechanism exists.
   */
  it('wraps every request, including ones added later', async () => {
    expect(await worker()).toMatch(/Invoke-ComWithRetry -Action \{ Invoke-Request/)
  })

  /** "Call was rejected by callee" tells nobody anything about their spreadsheet. */
  it('replaces the raw COM message with something actionable', async () => {
    const source = await worker()
    expect(source).toContain('function Get-ComErrorAdvice')
    expect(source).toContain('a cell is open for editing')
  })
})

function bridgeReturning(result: unknown): OfficeBridge {
  return { request: async () => result } as unknown as OfficeBridge
}

describe('the diagnosis', () => {
  const healthy = {
    excelProcesses: 1,
    getActiveObject: 'reached one instance',
    rotExcelDocuments: 1,
    instancesReached: 1,
    instances: [{ instance: 1, version: '16.0', acceptingCalls: true, workbooks: ['Book1.xlsx'], vbaAccessible: true }],
    advice: ['Excel is reachable and answering.'],
  }

  it('reports what is running and what can be reached', async () => {
    const tool = createExcelDiagnoseTool({ bridge: bridgeReturning(healthy) })
    const result = await tool.execute({}, {} as never)

    expect(result.content).toContain('Excel processes running: 1')
    expect(result.content).toContain('Instances this can reach: 1')
    expect(result.content).toContain('Book1.xlsx')
  })

  it('names a busy instance and its rejection code', async () => {
    const tool = createExcelDiagnoseTool({
      bridge: bridgeReturning({
        ...healthy,
        instances: [{ instance: 1, acceptingCalls: false, rejectionCode: '0x80010001', workbooks: [] }],
        advice: ['Instance 1 is refusing calls right now (0x80010001).'],
      }),
    })
    const result = await tool.execute({}, {} as never)

    expect(result.content).toContain('accepting calls: no (0x80010001)')
    expect(result.content).toContain('refusing calls right now')
  })

  /** Fewer reachable than running is the Protected View signature, and worth naming as such. */
  it('distinguishes an unreadable instance from an absent one', async () => {
    const tool = createExcelDiagnoseTool({
      bridge: bridgeReturning({
        ...healthy,
        excelProcesses: 2,
        instancesReached: 1,
        instances: [{ instance: 1, workbooksUnreadable: true }],
        advice: ['Some Excel processes could not be reached.'],
      }),
    })
    const result = await tool.execute({}, {} as never)

    expect(result.content).toContain('likely Protected View')
  })

  /**
   * A diagnosis that cannot run is itself the most informative result available: it points at
   * the PowerShell worker rather than at Excel, which is a different problem.
   */
  it('says so when it cannot run at all', async () => {
    const tool = createExcelDiagnoseTool({
      bridge: { request: async () => { throw new Error('worker did not start') } } as unknown as OfficeBridge,
    })
    const result = await tool.execute({}, {} as never)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('points at the PowerShell worker')
  })
})
