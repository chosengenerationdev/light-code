import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { describeTimeout } from './bridge.js'

/*
 * Reported: Outlook "many times" not reading mail and "might be busy", worst searching for old
 * mail. Each cause below is a line of code that is easy to lose, and none of them can be seen by a
 * test of what a search returns, so they are pinned by reading the sources — the pattern
 * `officeTrace.test.ts` uses for the same reason. The message filter was verified compiling and
 * registering in a real Windows PowerShell 5.1 (STA, patience 30000).
 */
const worker = readFileSync(new URL('./worker.ps1', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('./bridge.ts', import.meta.url), 'utf8')

function functionBody(name: string): string {
  const start = worker.indexOf(`function ${name} {`)
  expect(start, name).toBeGreaterThan(-1)
  const next = worker.indexOf('\nfunction ', start + 10)
  return worker.slice(start, next === -1 ? undefined : next)
}

describe('Outlook when it is busy', () => {
  /* One hung call used to make every request behind it time out too — the repeated "busy". */
  it('restarts the helper when a request times out, rather than queueing behind the stuck call', () => {
    const timeout = bridge.slice(bridge.indexOf('const timer = setTimeout('), bridge.indexOf('}, timeoutMs)'))
    expect(timeout).toContain('this.restart()')
    expect(bridge).toContain("execFile('taskkill', ['/PID', String(pid), '/T', '/F']")
    // A replaced helper exiting late must not clear its successor.
    expect(bridge).toContain('if (this.child !== child) return')
  })

  it('waits a busy Office out inside each call, with a COM message filter on an STA thread', () => {
    expect(worker).toContain('CoRegisterMessageFilter')
    expect(worker).toContain('[LightCode.BusyFilter]::Register()')
    expect(worker).toContain('public static int Patience = 30000;')
    expect(bridge).toContain("'-Sta'")
  })

  it('keeps the connection while Outlook is busy, and reconnects once when it was restarted', () => {
    const attach = functionBody('Get-OfficeApp')
    expect(attach).toMatch(/transientComCodes -contains \(Get-ComErrorCode -ErrorRecord \$_\)\) \{ throw \}/)
    const retry = functionBody('Invoke-ComWithRetry')
    expect(retry).toContain('$script:disconnectedComCodes -contains $code')
    expect(retry).toContain('$script:apps.Clear()')
  })

  it('names Outlook, not Excel, when Outlook is the one that was busy', () => {
    const advice = functionBody('Get-ComErrorAdvice')
    expect(advice).toContain("if ($Operation -like 'outlook.*')")
    expect(advice).toContain('Outlook stayed busy')
    const outlook = describeTimeout('outlook.search', 60)
    expect(outlook).toContain('Outlook did not answer within 60s')
    expect(outlook).toContain('security prompt')
    expect(outlook).toContain('restarted')
    expect(describeTimeout('excel.readRange', 60)).toContain('Excel did not answer')
  })
})

describe('searching Outlook, old mail especially', () => {
  const search = functionBody('Invoke-OutlookSearch')

  it('narrows before sorting, and sorts only what matched', () => {
    expect(search.indexOf('$items.Restrict(')).toBeGreaterThan(-1)
    expect(search.indexOf('$items.Sort(')).toBeGreaterThan(search.indexOf('$items.Restrict('))
  })

  /* Reading every body until enough matched outran the timeout on a large folder. */
  it('asks Outlook to filter text, instead of reading every message body', () => {
    expect(search).toContain('urn:schemas:httpmail:textdescription LIKE')
  })

  it('filters a date range on both ends, inclusive of the last day, and can go oldest first', () => {
    expect(search).toContain('$Request.until')
    expect(search).toContain('.Date.AddDays(1)')
    expect(search).toContain("datereceived < '")
    expect(search).toContain('-not [bool]$Request.oldestFirst')
  })

  it('stops at a bound and says so, rather than running into the timeout', () => {
    expect(search).toContain('$scanLimit = 2000')
    expect(search).toContain('stoppedEarly = $stoppedEarly')
  })
})
