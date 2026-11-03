// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * A monitor's grid window, as WebView2 runs it: monitor.html, monitor.js, then the `grid` message Rust sends
 * (monitoring.rs `grid_message`) and what it sends back - an explanation, a history.
 */
const ui = __dirname
const sent: { cmd: string; row?: number; codebase?: string; days?: number; schedule?: unknown; ids?: string[]; minutes?: number; note?: string; from?: number; until?: number; at?: number; hash?: string }[] = []
type GridWindow = Window & { __sun: { receive: (message: unknown) => void } }
const receive = (message: unknown): void => (window as unknown as GridWindow).__sun.receive(message)

const grid = {
  type: 'grid',
  monitor: { name: 'batch', title: 'Overnight batch', level: 'red', headline: '1 failing', team: true, origin: 'shop', approved: true, every: 900, lastRun: 1, source: 'jobs.csv' },
  record: {
    at: 1,
    level: 'red',
    headline: '1 failing',
    by: 'ann',
    partial: true,
    evaluation: {
      level: 'red',
      columns: [{ key: 'job' }, { key: 'status' }],
      rows: [{ job: 'A', status: 'OK' }, { job: 'B', status: 'FAILURE' }],
      alerts: [{ id: '0|B|status', row: 1, key: 'B', level: 'red', column: 'status', wholeRow: false, message: 'B failed', acknowledged: false }],
      counts: { red: 1 },
      headline: '1 failing',
    },
  },
  rules: [{ level: 'red', advice: 'Rerun B once; if it fails again call **payments ops**.' }],
  runbook: 'Owned by payments.',
  hasDetails: false,
  codebases: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
  appearance: { theme: 'dark', accent: '#f26b1d' },
}

beforeEach(() => {
  sent.length = 0
  const html = fs.readFileSync(path.join(ui, 'monitor.html'), 'utf8')
  document.documentElement.innerHTML = html.replace(/<script src="monitor.js"><\/script>/, '').replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '')
  const w = window as unknown as Record<string, unknown>
  w['ipc'] = { postMessage: (text: string) => sent.push(JSON.parse(text) as { cmd: string }) }
  w['matchMedia'] = () => ({ matches: false, addEventListener() {}, addListener() {} })
  ;(0, eval)(fs.readFileSync(path.join(ui, 'monitor.js'), 'utf8'))
  receive(grid)
})

const doubleClick = (row: number): void => {
  document.querySelector(`tr[data-row="${row}"] td`)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
}

describe('a monitor\'s grid window', () => {
  it('colours the alerted cell, and says when the rows are a colleague\'s alerted ones only', () => {
    expect(document.querySelector('tr[data-row="1"] td.cell-alert')?.textContent).toBe('FAILURE')
    expect(document.querySelector('#g-meta')?.textContent).toContain('Checked by ann - rows with alerts only')
  })

  it('opens an alerted row with the author\'s advice, asks the agent to explain it, and shows the answer', () => {
    doubleClick(1)
    expect(sent.at(-1)).toMatchObject({ cmd: 'explain', row: 1 })
    const drawer = document.querySelector('#g-drawer')
    expect(drawer?.textContent).toContain('Rerun B once')
    expect(drawer?.querySelector('.advice b')?.textContent).toBe('payments ops')
    expect(drawer?.textContent).toContain('Owned by payments.')
    expect(drawer?.querySelector('.thinking')).not.toBeNull()
    receive({ type: 'explanation', row: 1, ok: true, text: '**B failed** - new today.\n- Rerun it\n- Then call ops' })
    expect(drawer?.querySelector('.explanation b')?.textContent).toBe('B failed')
    expect(drawer?.querySelectorAll('.explanation li').length).toBe(2)
  })

  it('starts a chat in the codebase chosen, the first unless another is picked', () => {
    doubleClick(1)
    const start = [...document.querySelectorAll<HTMLButtonElement>('.start-chat .btn')].find((b) => b.textContent === 'Start a chat')
    start?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'startChat', row: 1, codebase: 'p1' })
    ;[...document.querySelectorAll<HTMLButtonElement>('.start-chat .choice button')].find((b) => b.textContent === 'Two')?.click()
    ;[...document.querySelectorAll<HTMLButtonElement>('.start-chat .btn')].find((b) => b.textContent === 'Start a chat')?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'startChat', codebase: 'p2' })
  })

  it('edits the schedule: every 10 minutes between 08:00 and 18:00 on weekdays', () => {
    receive({ ...grid, monitor: { ...grid.monitor, every: 900, schedule: 'every 15 min', scheduleSpec: { every: '15m' } } })
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-actions .hbtn')].find((b) => b.title.startsWith('Schedule'))?.click()
    const sheet = document.querySelector('#g-sheet')
    expect(sheet?.hasAttribute('hidden')).toBe(false)
    const num = sheet?.querySelector<HTMLInputElement>('.sheet-num')
    if (!num) throw new Error('no interval box')
    expect(num.value).toBe('15')
    num.value = '10'
    num.dispatchEvent(new Event('input'))
    const [from, to] = [...(sheet?.querySelectorAll<HTMLInputElement>('.sheet-time') ?? [])]
    if (!from || !to) throw new Error('no hours')
    from.value = '08:00'
    from.dispatchEvent(new Event('input'))
    to.value = '18:00'
    to.dispatchEvent(new Event('input'))
    for (const day of ['Sat', 'Sun']) [...document.querySelectorAll<HTMLButtonElement>('#g-sheet .seg.day')].find((b) => b.textContent === day)?.click()
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-sheet .btn.primary')].find((b) => b.textContent === 'Save')?.click()
    expect(sent.at(-1)).toEqual({
      cmd: 'setSchedule',
      schedule: { every: '10m', activeHours: '08:00-18:00', at: null, days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
    })
    // A refusal stays on the sheet; a fresh grid closes it.
    receive({ type: 'notice', level: 'error', text: '"every" must be between one minute and a week.' })
    expect(document.querySelector('#g-sheet .sheet-error')?.textContent).toMatch(/one minute/)
  })

  it('changes a copy from the team where the team keeps it, and waits for that answer', () => {
    // Reported: the team's monitors could not be changed at all. A team copy is now saved through the host.
    receive({ ...grid, monitor: { ...grid.monitor, teamCopy: "the team's bucket", scheduleSpec: { every: '15m' }, every: 900 } })
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-actions .hbtn')].find((b) => b.title.startsWith('Schedule'))?.click()
    expect(document.querySelector('#g-sheet .sheet-note')?.textContent).toContain("the team's bucket")
    const save = [...document.querySelectorAll<HTMLButtonElement>('#g-sheet .btn.primary')].find((b) => b.textContent === 'Save')
    expect(save?.disabled).toBe(false)
    save?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'setSchedule' })
    receive({ type: 'sheetPending', text: "Saving the new schedule to the team's bucket…" })
    expect(document.querySelector('#g-sheet')?.textContent).toContain('Saving the new schedule')
    // A check finishing meanwhile is not the answer: the sheet stays.
    receive({ ...grid, monitor: { ...grid.monitor, teamCopy: "the team's bucket" } })
    expect(document.querySelector('#g-sheet')?.hasAttribute('hidden')).toBe(false)
    receive({ ...grid, monitor: { ...grid.monitor, teamCopy: "the team's bucket" }, sheetDone: 'schedule', doneText: "Saved and uploaded to the bucket team-skills" })
    expect(document.querySelector('#g-sheet')?.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('#g-notice')?.textContent).toContain('uploaded to the bucket')
  })

  it('deletes the monitor for good only after the confirmation', () => {
    receive({ ...grid, monitor: { ...grid.monitor, file: 'C:/skills/batch.md' } })
    receive({ type: 'sheet', kind: 'delete' })
    expect(document.querySelector('#g-sheet')?.textContent).toContain('C:/skills/batch.md')
    expect(sent.some((s) => s.cmd === 'delete')).toBe(false)
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-sheet .btn')].find((b) => b.textContent === 'Delete for good')?.click()
    expect(sent.at(-1)).toEqual({ cmd: 'delete' })
    receive({ type: 'grid', missing: true, name: 'batch', sheetDone: 'delete' })
    expect(document.querySelector('#g-sheet')?.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('#g-name')?.textContent).toBe('This monitor is gone')
  })

  it('snoozes one row\'s alerts until a time, and says when the snooze ends', () => {
    document.querySelector('tr[data-row="1"] td')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }))
    ;[...document.querySelectorAll<HTMLButtonElement>('.menu button')].find((b) => b.textContent === 'Snooze this row 4 hours')?.click()
    expect(sent.at(-1)).toEqual({ cmd: 'ack', ids: ['0|B|status'], minutes: 240, note: 'snoozed' })
    receive({
      ...grid,
      acks: { '0|B|status': { until: 1_900_000_000, note: 'snoozed' } },
      record: { ...grid.record, evaluation: { ...grid.record.evaluation, alerts: [{ ...grid.record.evaluation.alerts[0], acknowledged: true }] } },
    })
    doubleClick(1)
    expect(document.querySelector('#g-drawer .drawer-alert')?.textContent).toMatch(/snoozed until/)
  })

  it('snoozes the monitor until a chosen time from its window', () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-actions .hbtn')].find((b) => b.title.startsWith('Snooze'))?.click()
    ;[...document.querySelectorAll<HTMLButtonElement>('.menu button')].find((b) => b.textContent === 'Snooze until…')?.click()
    const input = document.querySelector<HTMLInputElement>('#g-sheet input[type="datetime-local"]')
    if (!input) throw new Error('no date and time box')
    input.value = '2000-01-01T09:00'
    input.dispatchEvent(new Event('input'))
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-sheet .btn.primary')].find((b) => b.textContent === 'Snooze')?.click()
    expect(document.querySelector('#g-sheet .sheet-error')?.textContent).toMatch(/already passed/)
    expect(sent.some((s) => s.cmd === 'snooze')).toBe(false)
  })

  it('opens on History at the check a tile\'s bar named, from earlier days too', () => {
    const at = Math.floor(Date.now() / 1000) - 20 * 86_400
    receive({ type: 'sheet', kind: 'history', at })
    expect(sent.at(-1)).toMatchObject({ cmd: 'history', days: 30 })
    receive({
      type: 'history',
      ok: true,
      days: 30,
      checks: [
        { at: at + 3600, level: 'green', headline: 'All clear', alerts: 0, found: [] },
        { at, level: 'red', headline: '1 failing', alerts: 1, found: [{ id: 'x', level: 'red', key: 'B', column: 'status', message: 'B failed', row: { job: 'B', status: 'FAILURE' } }] },
      ],
      patterns: [],
    })
    expect(document.querySelector('#g-history .check-row.on')?.textContent).toContain('1 failing')
  })

  it('shows every check on one chosen day, and a clear check\'s facts where the click was', () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-views button')].find((b) => b.textContent === 'History')?.click()
    const day = document.querySelector<HTMLInputElement>('#g-views input[type="date"]')
    if (!day) throw new Error('no date box')
    day.value = '2026-10-20'
    day.dispatchEvent(new Event('change'))
    const from = Math.floor(new Date(2026, 9, 20).getTime() / 1000)
    expect(sent.at(-1)).toMatchObject({ cmd: 'history', from, until: Math.floor(new Date(2026, 9, 21).getTime() / 1000) })
    receive({ type: 'history', ok: true, days: 7, from, until: from + 86_400, checks: [{ at: from + 3600, level: 'green', headline: 'All clear', alerts: 0, rowCount: 42, durationMs: 1800, by: 'ann', found: [] }], patterns: [] })
    expect(document.querySelector('#g-history .hist-head')?.textContent).toMatch(/on .*October.*2026/)
    document.querySelector<HTMLButtonElement>('#g-history .check-row')?.click()
    const view = document.querySelector('#g-history .past-check')
    // Under the bars, before the alert patterns - not below them, out of sight.
    expect(view?.previousElementSibling?.classList.contains('timeline')).toBe(true)
    expect(view?.querySelector('.facts')?.textContent).toBe('OK · checked by ann · 42 rows read · took 1.8 s · 0 alerts')
    expect(view?.textContent).toContain('Nothing was alerting')
  })

  it('keeps only the rows in view in the page, every row reachable by scrolling - it used to build the whole table', async () => {
    const rows = Array.from({ length: 3450 }, (_, n) => ({ job: `J${n}`, status: n === 3400 ? 'FAILURE' : 'OK' }))
    receive({ ...grid, record: { ...grid.record, partial: false, evaluation: { ...grid.record.evaluation, rows, alerts: [{ id: 'far', row: 3400, key: 'J3400', level: 'red', column: 'status', wholeRow: false, message: 'J3400 failed', acknowledged: false }] } } })
    const drawn = () => document.querySelectorAll('#g-table tbody tr[data-row]').length
    expect(drawn()).toBeLessThan(120)
    expect(document.querySelector('#g-count')?.textContent).toBe('3450 rows')
    // Spacers stand in for the rest, so the scroll bar is the whole grid's.
    expect(document.querySelectorAll('#g-table tbody tr.g-spacer').length).toBe(1)
    // Scrolled far down: those rows, and still only a window of them.
    const wrap = document.querySelector<HTMLElement>('#g-table-wrap')!
    wrap.scrollTop = 62 + 2000 * 29
    wrap.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(document.querySelector('tr[data-row="2001"]')).not.toBeNull()
    expect(document.querySelector('tr[data-row="5"]')).toBeNull()
    expect(drawn()).toBeLessThan(120)
    // An alert far down: choosing it scrolls to it.
    document.querySelector<HTMLButtonElement>('#g-alerts .alert-chip')?.click()
    expect(document.querySelector('tr[data-row="3400"] td.cell-alert')?.textContent).toBe('FAILURE')
  })

  // Asked for: filters under the columns with values to tick or search, conditions such as > 50, a column chooser.
  const many = Array.from({ length: 300 }, (_, n) => ({ job: `J${n}`, status: n % 3 === 0 ? 'FAILURE' : n % 3 === 1 ? 'OK' : 'LATE', minutes: n }))
  const showMany = () =>
    receive({
      ...grid,
      record: { ...grid.record, partial: false, evaluation: { ...grid.record.evaluation, columns: [{ key: 'job' }, { key: 'status' }, { key: 'minutes', format: 'number' }], rows: many, alerts: [] } },
    })
  const typeFilter = async (col: string, text: string) => {
    const input = document.querySelector<HTMLInputElement>(`#g-table input[data-filter="${col}"]`)!
    input.value = text
    input.dispatchEvent(new Event('input'))
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  const count = () => document.querySelector('#g-count span')?.textContent

  it('filters a column by condition: more than, between, either, not, empty', async () => {
    showMany()
    await typeFilter('minutes', '>250')
    expect(count()).toBe('49 of 300 rows')
    await typeFilter('minutes', '10..19')
    expect(count()).toBe('10 of 300 rows')
    await typeFilter('minutes', '<5, >=298')
    expect(count()).toBe('7 of 300 rows')
    await typeFilter('minutes', '>10 & <20')
    expect(count()).toBe('9 of 300 rows')
    await typeFilter('minutes', '')
    await typeFilter('status', '!ok')
    expect(count()).toBe('200 of 300 rows')
    await typeFilter('status', '"late"')
    expect(count()).toBe('100 of 300 rows')
    await typeFilter('status', '=')
    expect(count()).toBe('0 of 300 rows')
    // Clearing every filter at once.
    await typeFilter('status', 'fail')
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-count button')].find((b) => b.textContent?.startsWith('Clear'))?.click()
    expect(count()).toBe('300 rows')
  })

  it("filters by ticking a column's values, searched, with each value's count", () => {
    showMany()
    document.querySelector<HTMLButtonElement>('th[data-col="status"] .funnel')?.click()
    const items = () => [...document.querySelectorAll<HTMLLabelElement>('.pop .pop-item')]
    expect(items().map((l) => l.textContent)).toEqual(['FAILURE100', 'LATE100', 'OK100'])
    // Untick OK: the other two stay.
    const ok = items().find((l) => l.textContent?.startsWith('OK'))!.querySelector('input')!
    ok.checked = false
    ok.dispatchEvent(new Event('change'))
    expect(count()).toBe('200 of 300 rows')
    expect(document.querySelector('th[data-col="status"]')?.classList.contains('filtered')).toBe(true)
    // Search the values, then keep only what the search found.
    const search = document.querySelectorAll<HTMLInputElement>('.pop .pop-search')[1]!
    search.value = 'lat'
    search.dispatchEvent(new Event('input'))
    expect(items().map((l) => l.textContent)).toEqual(['LATE100'])
    ;[...document.querySelectorAll<HTMLButtonElement>('.pop .link-btn')].find((b) => b.textContent === 'Only these')?.click()
    expect(count()).toBe('100 of 300 rows')
    // Another column's values are counted among the rows this filter leaves.
    document.querySelector<HTMLButtonElement>('th[data-col="job"] .funnel')?.click()
    expect(document.querySelectorAll('.pop .pop-item').length).toBe(100)
  })

  it('chooses the columns shown, remembered for this monitor, never none', () => {
    showMany()
    const heads = () => [...document.querySelectorAll('#g-table th[data-col]')].map((th) => (th as HTMLElement).dataset.col)
    expect(heads()).toEqual(['job', 'status', 'minutes'])
    document.querySelector<HTMLButtonElement>('.cols-btn')?.click()
    const box = (key: string) => [...document.querySelectorAll<HTMLLabelElement>('.pop .pop-item')].find((l) => l.textContent?.startsWith(key))!.querySelector('input')!
    box('minutes').checked = false
    box('minutes').dispatchEvent(new Event('change'))
    expect(heads()).toEqual(['job', 'status'])
    expect(localStorage.getItem('fire-code.grid.hidden.batch')).toBe('["minutes"]')
    box('status').checked = false
    box('status').dispatchEvent(new Event('change'))
    box('job').checked = false
    box('job').dispatchEvent(new Event('change'))
    // The last column cannot be hidden.
    expect(heads()).toEqual(['job'])
    ;[...document.querySelectorAll<HTMLButtonElement>('.pop .link-btn')].find((b) => b.textContent === 'Show all')?.click()
    expect(heads()).toEqual(['job', 'status', 'minutes'])
    localStorage.clear()
  })

  it('filters and sorts 100,000 rows quickly', async () => {
    const rows = Array.from({ length: 100_000 }, (_, n) => ({ job: `J${n}`, status: n % 7 === 0 ? 'FAILURE' : 'OK', minutes: n % 500 }))
    receive({ ...grid, record: { ...grid.record, partial: false, evaluation: { ...grid.record.evaluation, columns: [{ key: 'job' }, { key: 'status' }, { key: 'minutes' }], rows, alerts: [] } } })
    const started = performance.now()
    await typeFilter('minutes', '>450')
    document.querySelector<HTMLElement>('th[data-col="minutes"] .h-label')?.click()
    const took = performance.now() - started - 150
    expect(count()).toBe('9800 of 100000 rows')
    expect(document.querySelectorAll('#g-table tbody tr[data-row]').length).toBeLessThan(120)
    // Generous for a slow test machine; the point is that it is not seconds.
    expect(took).toBeLessThan(1500)
  })

  it('says plainly why an old check has no whole grid', () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-views button')].find((b) => b.textContent === 'History')?.click()
    receive({ type: 'history', ok: true, days: 14, checks: [{ at: 1_700_000_000, level: 'green', headline: 'All clear', alerts: 0, found: [] }], patterns: [] })
    document.querySelector<HTMLButtonElement>('#g-history .check-row')?.click()
    expect(sent.some((s) => s.cmd === 'pastGrid')).toBe(false)
    expect(document.querySelector('#g-history .past-check')?.textContent).toContain('recorded before Fire Code 0.64.0')
  })

  it('shows a past check\'s whole grid as it was, read-only, and deletes one check after a confirmation', () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-views button')].find((b) => b.textContent === 'History')?.click()
    receive({ type: 'history', ok: true, days: 14, checks: [{ at: 1_800_000_000, level: 'amber', headline: '1 low', alerts: 1, grid: 'abc123', found: [] }], patterns: [] })
    // Clicking the check asks for its whole grid at once - no button first.
    document.querySelector<HTMLButtonElement>('#g-history .check-row')?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'pastGrid', at: 1_800_000_000, hash: 'abc123' })
    receive({
      type: 'pastGrid',
      ok: true,
      at: 1_800_000_000,
      evaluation: { level: 'amber', headline: '1 low', columns: [{ key: 'job' }, { key: 'status' }], rows: [{ job: 'OLD', status: 'LATE' }], alerts: [{ id: 'x', row: 0, key: 'OLD', level: 'amber', column: 'status', wholeRow: false, message: 'OLD late', acknowledged: false }], counts: { amber: 1 } },
    })
    // Shown in History, every row, the alerted cell coloured; Open in grid view for filters and sorting.
    expect(document.querySelector('#g-history .past-check td.hl')?.textContent).toBe('LATE')
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-history .past-actions .btn')].find((b) => b.textContent === 'Open in grid view')?.click()
    expect(document.querySelector('#g-past')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('tr[data-row="0"] td.cell-alert')?.textContent).toBe('LATE')
    // Today's actions are off on the past: no acknowledging, explaining or snoozing it.
    doubleClick(0)
    expect(document.querySelector('#g-drawer .drawer-alert button')).toBeNull()
    expect(sent.some((s) => s.cmd === 'explain')).toBe(false)
    // A fresh check arriving meanwhile does not replace what is on screen; Back to now shows it.
    receive(grid)
    expect(document.querySelector('tr[data-row="0"] td')?.textContent).toBe('OLD')
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-past button')].find((b) => b.textContent === 'Back to now')?.click()
    expect(document.querySelector('tr[data-row="1"] td.cell-alert')?.textContent).toBe('FAILURE')
    // Delete one check: asks, then sends.
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-views button')].find((b) => b.textContent === 'History')?.click()
    receive({ type: 'history', ok: true, days: 14, checks: [{ at: 1_800_000_000, level: 'amber', headline: '1 low', alerts: 1, found: [] }], patterns: [] })
    document.querySelector<HTMLButtonElement>('#g-history .check-row')?.click()
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-history .btn')].find((b) => b.textContent === 'Delete this check')?.click()
    expect(sent.some((s) => s.cmd === 'deleteCheck')).toBe(false)
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-history .confirm .btn')].find((b) => b.textContent === 'Delete')?.click()
    expect(sent.at(-1)).toEqual({ cmd: 'deleteCheck', at: 1_800_000_000 })
  })

  it('shows the history: each alert\'s pattern, the checks, and one past check\'s rows', () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-views button')].find((b) => b.textContent === 'History')?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'history', days: 14 })
    receive({
      type: 'history',
      ok: true,
      days: 14,
      total: 2,
      checks: [
        { at: 200, level: 'red', headline: '1 failing', alerts: 1, by: 'ann', found: [{ id: '0|B|status', level: 'red', key: 'B', column: 'status', message: 'B failed', row: { job: 'B', status: 'FAILURE' } }] },
        { at: 100, level: 'green', headline: 'All clear', alerts: 0, found: [] },
      ],
      patterns: [{ id: '0|B|status', key: 'B', level: 'red', verdict: 'recurring', summary: 'came back 4 times, usually starting around 02:00', occurrences: 4, active: true }],
    })
    const history = document.querySelector('#g-history')
    expect(history?.querySelector('.verdict')?.textContent).toBe('Recurring')
    expect(history?.textContent).toContain('usually starting around 02:00')
    expect(history?.querySelectorAll('.timeline .tick').length).toBe(2)
    history?.querySelector<HTMLButtonElement>('.check-row')?.click()
    expect(document.querySelector('.past-check td.hl')?.textContent).toBe('FAILURE')
  })

  // Asked for: the top-right buttons were cropped in a narrow window, and should be icon buttons with tooltips.
  it('puts its actions in icon buttons, each saying what it does', () => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#g-actions button')]
    expect(buttons.length).toBeGreaterThanOrEqual(5)
    for (const b of buttons) {
      expect(b.classList.contains('hbtn')).toBe(true)
      expect(b.title.length).toBeGreaterThan(4)
      expect(b.getAttribute('aria-label')).toBe(b.title)
      expect(b.textContent?.replace(/\d/g, '').trim()).toBe('')
    }
    // The open alerts' count rides on the Acknowledge button.
    expect(buttons.find((b) => b.title.startsWith('Acknowledge'))?.querySelector('.hbtn-badge')?.textContent).toBe('1')
  })

  it("says who wrote it and who changed it last, and lists every change, the team's and this computer's as one", () => {
    receive({ ...grid, monitor: { ...grid.monitor, author: 'ana', updatedBy: 'bo', updatedAt: 1_800_000_000, version: 3 } })
    expect(document.querySelector('#g-meta')?.textContent).toContain('By ana')
    expect(document.querySelector('#g-meta')?.textContent).toContain('by bo')
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-actions .hbtn')].find((b) => b.title.startsWith('Changes'))?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'revisions' })
    const sheet = document.querySelector('#g-sheet')
    expect(sheet?.textContent).toContain('Reading')
    receive({ type: 'revisions', revisions: [{ at: 1_700_000_000, by: 'ana', version: 1, hash: 'a', change: 'First seen on this computer' }, { at: 1_800_000_000, by: 'bo', version: 3, hash: 'c', change: 'Schedule changed (every)', block: '{"every":"10m"}' }], teamPending: true })
    receive({ type: 'revisions', team: [{ at: 1_800_000_000, by: 'bo', version: 3, hash: 'c', change: 'Schedule changed (every)' }, { at: 1_750_000_000, by: 'chen', version: 2, hash: 'b', change: 'Changed: rules' }], teamPending: false })
    const rows = [...(sheet?.querySelectorAll('.changes li') ?? [])].map((li) => li.querySelector('.change-what')?.textContent)
    // Newest first, one row per version however many members recorded it.
    expect(rows).toEqual(['Schedule changed (every)', 'Changed: rules', 'First seen on this computer'])
    expect(sheet?.textContent).toContain('chen')
  })

  // jsdom has no layout, so the rule is checked in the stylesheet: without it the page's one grid column grew to
  // the table's width and the window cut off the header's buttons (reported twice).
  it('keeps its column the width of the window, so the header buttons are never cut off', () => {
    const css = fs.readFileSync(path.join(ui, 'monitor.css'), 'utf8')
    expect(css).toMatch(/\.grid-app \{[^}]*grid-template-columns: minmax\(0, 1fr\)/)
    expect(css).toMatch(/\.grid-app > \* \{\s*min-width: 0;/)
    expect(css).toMatch(/\.g-head \{[^}]*flex-wrap: wrap/)
    expect(css).toMatch(/\.g-actions \{[^}]*flex-wrap: wrap/)
  })

  // Asked for: "data should be selectable and copyable from the datagrid, a cell or the full grid".
  it('copies a cell, a block of cells and the whole grid, as text Excel pastes into cells and as a table', () => {
    const copied: { text: string; html: string }[] = []
    // jsdom has no clipboard: a copy is the copy event the page fills, as WebView2 delivers it.
    ;(document as unknown as { execCommand: (c: string) => boolean }).execCommand = () => {
      const data: Record<string, string> = {}
      const event = new Event('copy', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
      event.clipboardData = { setData: (type: string, value: string) => (data[type] = value) }
      document.dispatchEvent(event)
      copied.push({ text: data['text/plain'] ?? '', html: data['text/html'] ?? '' })
      return true
    }
    const cell = (row: number, col: string) => document.querySelector<HTMLElement>(`tr[data-row="${row}"] td[data-col="${col}"]`)
    const rightClick = (target: HTMLElement | null) => target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    const pick = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.menu button')].find((b) => b.textContent === label)?.click()

    rightClick(cell(1, 'status'))
    pick('Copy cell')
    expect(copied.at(-1)?.text).toBe('FAILURE')

    // Click one cell, Shift+click another: the block between them; Ctrl+C copies it.
    cell(0, 'job')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    cell(1, 'status')?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    expect(document.querySelectorAll('td.cell-range').length).toBe(4)
    document.execCommand('copy')
    // In the order shown: alerting rows first.
    expect(copied.at(-1)?.text).toBe('B\tFAILURE\r\nA\tOK')

    // The header's button: every row, with the headers.
    ;[...document.querySelectorAll<HTMLButtonElement>('#g-actions .hbtn')].find((b) => b.title.startsWith('Copy the grid'))?.click()
    expect(copied.at(-1)?.text).toBe('job\tstatus\r\nB\tFAILURE\r\nA\tOK')
    expect(copied.at(-1)?.html).toContain('<th style')
    expect(copied.at(-1)?.html).toContain('>FAILURE</td>')
  })
})
