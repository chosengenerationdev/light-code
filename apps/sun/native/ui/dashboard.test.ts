// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The monitoring dashboard, driven as WebView2 runs it: index.html, shell.js, then the `monitors` message
 * Rust sends (monitoring.rs `monitors_message`). Found by running the installed build: the dashboard would
 * not open - this is the check that sees that without a window.
 */
const ui = __dirname
const sent: { cmd: string; op?: string; args?: Record<string, unknown> }[] = []
type ShellWindow = Window & { __sun: { receive: (message: unknown) => void } }
const receive = (message: unknown): void => (window as unknown as ShellWindow).__sun.receive(message)

const monitor = (name: string, level: string, extra: Record<string, unknown> = {}) => ({
  name,
  title: name.replace(/-/g, ' '),
  summary: `What ${name} watches`,
  description: '',
  team: true,
  origin: 'shop',
  file: `C:/x/${name}.md`,
  level,
  status: 'ok',
  meaning: level,
  headline: `${name} headline`,
  lastRun: Math.floor(Date.now() / 1000) - 120,
  nextRun: null,
  every: 900,
  running: false,
  approved: true,
  block: null,
  paused: false,
  snoozeUntil: null,
  mode: null,
  notifyFrom: 'amber',
  openAlerts: 1,
  counts: null,
  rowCount: 3,
  source: 'C:/data/jobs.csv',
  sourceKind: 'files',
  history: [[1, 'green'], [2, level]],
  ...extra,
})

beforeEach(() => {
  sent.length = 0
  const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8')
  document.documentElement.innerHTML = html.replace(/<script src="shell.js"><\/script>/, '').replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '')
  const w = window as unknown as Record<string, unknown>
  w['ipc'] = { postMessage: (text: string) => sent.push(JSON.parse(text) as { cmd: string }) }
  w['matchMedia'] = () => ({ matches: false, addEventListener() {}, addListener() {} })
  ;(0, eval)(fs.readFileSync(path.join(ui, 'shell.js'), 'utf8'))
  receive({ type: 'init', version: 'x', projects: [], settings: { theme: 'dark', accent: '#f26b1d', sidebarWidth: 264 }, accent: '#f26b1d', hasSource: false, dataFolder: 'X' })
  receive({
    type: 'monitors',
    enabled: true,
    settings: { enabled: true, red: 'urgent', amber: 'toast', purple: 'silent', blue: 'dashboard', green: 'off', repeatMinutes: 60, recovery: true, quietHours: null, quietLetsRedThrough: true, extraFolders: [] },
    monitors: [monitor('overnight-batch', 'red'), monitor('disks', 'amber'), monitor('mine', 'green', { team: false }), monitor('theirs', 'grey', { status: 'review', approved: false, block: '{"every":"5m"}' })],
    codebases: [],
    executor: { running: false, starting: false, error: null },
    levels: [],
  })
})

describe('the monitoring dashboard', () => {
  it('shows a button with the alert count, and opens from it over the whole window', () => {
    const button = document.querySelector<HTMLButtonElement>('#monitoring-btn')
    expect(button?.hidden).toBe(false)
    expect(document.querySelector('#monitoring-count')?.textContent).toBe('2')
    button?.click()
    const dash = document.querySelector<HTMLElement>('#monitoring')
    expect(dash?.hidden).toBe(false)
    expect(dash?.textContent).not.toContain('null')
    expect(dash?.querySelectorAll('.tile').length).toBe(4)
    expect([...(dash?.querySelectorAll('.dash-section h3') ?? [])].map((h) => h.firstChild?.textContent)).toEqual(['Team alerts', 'Personal'])
  })

  it('opens a monitor\'s grid when its tile is clicked, and reviews one waiting for approval', () => {
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    document.querySelector<HTMLButtonElement>('.tile[data-name="overnight-batch"]')?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'open', args: { name: 'overnight-batch' } })
    document.querySelector<HTMLButtonElement>('.tile[data-name="theirs"]')?.click()
    expect(document.querySelector('.mon-spec')?.textContent).toBe('{"every":"5m"}')
  })

  it('does not turn the whole dashboard red for monitors that are snoozed', () => {
    receive({
      type: 'monitors',
      enabled: true,
      settings: {},
      monitors: [monitor('overnight-batch', 'red', { snoozeUntil: Math.floor(Date.now() / 1000) + 3600 }), monitor('disks', 'amber')],
      codebases: [],
      executor: {},
      levels: [],
    })
    expect(document.querySelector('#monitoring-orb')?.className).toBe('orb lv-amber')
    expect(document.querySelector('#monitoring-count')?.textContent).toBe('1')
  })

  it('says when a team monitor waits for the team history', () => {
    receive({ type: 'monitors', enabled: true, settings: {}, monitors: [monitor('shared', 'grey', { status: 'noTeam', headline: 'choose its connection' })], codebases: [], executor: {}, levels: [] })
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    expect(document.querySelector('.tile[data-name="shared"] .tile-flag')?.textContent).toBe('Needs team history')
  })

  it('edits a monitor\'s schedule in its window, and deletes it for good after a confirmation', () => {
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    const menuItem = (label: string): HTMLButtonElement | undefined => {
      document.querySelector('.tile[data-name="disks"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
      return [...document.querySelectorAll<HTMLButtonElement>('.menu button')].find((b) => b.textContent?.includes(label))
    }
    menuItem('Edit schedule')?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'open', args: { name: 'disks', sheet: 'schedule' } })
    menuItem('Delete this monitor')?.click()
    expect(sent.some((s) => s.op === 'delete')).toBe(false)
    ;[...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent === 'Delete for good')?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'delete', args: { name: 'disks' } })
  })

  it('deletes a copy from the team for everyone, and says so before and after', () => {
    receive({ type: 'monitors', enabled: true, settings: {}, monitors: [monitor('shared', 'amber', { teamCopy: "the team's bucket" })], codebases: [], executor: {}, levels: [] })
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    document.querySelector('.tile[data-name="shared"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    const del = [...document.querySelectorAll<HTMLButtonElement>('.menu button')].find((b) => b.textContent?.includes('Delete this monitor'))
    expect(del?.disabled).toBe(false)
    del?.click()
    expect(document.querySelector('.modal')?.textContent).toContain("from the team's bucket, for everyone")
    ;[...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent === 'Delete for good')?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'delete', args: { name: 'shared' } })
    receive({ type: 'monitorReply', op: 'delete', ok: true, data: { name: 'shared', message: 'Removed 1 object(s) from team-skills.' } })
    expect(document.querySelector('#notices')?.textContent).toContain('Removed 1 object(s)')
  })

  it('reviews several waiting monitors at once, approving only the ticked ones', () => {
    receive({
      type: 'monitors',
      enabled: true,
      settings: {},
      monitors: [
        monitor('a', 'grey', { status: 'review', approved: false, block: '{"every":"5m","source":{"tool":"py__a"}}' }),
        monitor('b', 'grey', { status: 'review', approved: false, block: '{"every":"10m","source":{"tool":"py__b"}}' }),
        monitor('c', 'grey', { status: 'review', approved: false, block: '{"at":"07:30","source":{"tool":"py__c"}}' }),
      ],
      codebases: [],
      executor: {},
      levels: [],
    })
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    const review = [...document.querySelectorAll<HTMLButtonElement>('.dash-banner button')].find((b) => b.textContent === 'Review all…')
    review?.click()
    const modal = document.querySelector('.modal')
    // Every definition is on screen before anything can be approved.
    expect([...(modal?.querySelectorAll('.mon-spec') ?? [])].map((p) => p.textContent)).toEqual([
      '{"every":"5m","source":{"tool":"py__a"}}',
      '{"every":"10m","source":{"tool":"py__b"}}',
      '{"at":"07:30","source":{"tool":"py__c"}}',
    ])
    const approve = [...(modal?.querySelectorAll<HTMLButtonElement>('footer button') ?? [])].find((b) => b.textContent?.startsWith('Approve'))
    expect(approve?.disabled).toBe(true)
    const boxes = [...(modal?.querySelectorAll<HTMLInputElement>('.review-pick input') ?? [])]
    boxes[0]?.click()
    boxes[2]?.click()
    expect(approve?.textContent).toBe('Approve 2 selected')
    approve?.click()
    expect(sent.filter((s) => s.op === 'approve').map((s) => s.args?.name)).toEqual(['a', 'c'])
  })

  it('snoozes a monitor until a chosen date and time', () => {
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    document.querySelector('.tile[data-name="disks"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    ;[...document.querySelectorAll<HTMLButtonElement>('.menu button')].find((b) => b.textContent?.includes('Snooze until…'))?.click()
    const input = document.querySelector<HTMLInputElement>('.modal input[type="datetime-local"]')
    if (!input) throw new Error('no date and time box')
    const when = new Date(Date.now() + 2 * 86_400_000)
    when.setHours(17, 30, 0, 0)
    const pad = (n: number) => String(n).padStart(2, '0')
    input.value = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T17:30`
    ;[...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent === 'Snooze')?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'snooze', args: { name: 'disks', until: Math.floor(when.getTime() / 1000) } })
  })

  it('opens the run history from the wide button on a tile, at the bar pressed', () => {
    receive({ type: 'monitors', enabled: true, settings: {}, monitors: [monitor('disks', 'amber', { history: [[1000, 'green'], [2000, 'red'], [3000, 'amber']] })], codebases: [], executor: {}, levels: [] })
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    const strip = document.querySelector('.tile[data-name="disks"] .spark-btn')
    expect(strip?.querySelectorAll('i').length).toBe(3)
    strip?.querySelector<HTMLElement>('i[data-at="2000"]')?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'open', args: { name: 'disks', sheet: 'history', at: 2000 } })
    expect(sent.filter((s) => s.op === 'open').length).toBe(1)
    ;(strip as HTMLElement | null)?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'open', args: { name: 'disks', sheet: 'history' } })
  })

  it('says when a team monitor runs on a colleague\'s computer instead, and when checks ran offline', () => {
    const reason = 'py__jobs is on this computer but not loaded: waiting for approval'
    receive({ type: 'monitors', enabled: true, settings: {}, monitors: [monitor('elsewhere', 'green', { notHere: reason, openAlerts: 0 }), monitor('cut-off', 'green', { offline: 3, openAlerts: 0 })], codebases: [], executor: {}, levels: [] })
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    const flag = document.querySelector<HTMLElement>('.tile[data-name="elsewhere"] .tile-flag')
    expect(flag?.textContent).toBe('Runs elsewhere')
    expect(flag?.title).toBe(reason)
    expect(document.querySelector('.tile[data-name="cut-off"] .tile-flag')?.textContent).toBe('Offline · 3 not shared')
  })

  it('deletes a monitor\'s history older than a chosen number of days, or all of it', () => {
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    const open = (): void => {
      document.querySelector('.tile[data-name="disks"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
      ;[...document.querySelectorAll<HTMLButtonElement>('.menu button')].find((b) => b.textContent?.includes('Delete its history'))?.click()
    }
    const press = (label: string): void => [...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent === label)?.click()
    open()
    press('Older than 30 days')
    press('Delete')
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'deleteHistory', args: { name: 'disks', olderThanDays: 30 } })
    open()
    const days = document.querySelector<HTMLInputElement>('.modal .days-box')
    if (!days) throw new Error('no days box')
    days.value = '45'
    days.dispatchEvent(new Event('input'))
    press('Delete')
    expect(sent.at(-1)).toMatchObject({ args: { name: 'disks', olderThanDays: 45 } })
    open()
    press('Delete')
    expect(sent.at(-1)?.args).toEqual({ name: 'disks' })
  })

  it('closes a tile menu on a press outside it, even after a press inside it', () => {
    // Reported: the menu stayed until Esc. A press inside used up a listener that fired only once.
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    document.querySelector('.tile[data-name="disks"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        const menu = document.querySelector('.menu')
        menu?.querySelector('hr')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        expect(document.querySelector('.menu')).not.toBeNull()
        document.querySelector('#monitoring')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        expect(document.querySelector('.menu')).toBeNull()
        resolve()
      }),
    )
  })

  it('closes for a chat started from an alert', () => {
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    receive({ type: 'prefillChat', id: 'p1~3', text: 'Help me investigate' })
    expect(document.querySelector<HTMLElement>('#monitoring')?.hidden).toBe(true)
  })

  it('filters by search, by tab and by colour', () => {
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    const search = document.querySelector<HTMLInputElement>('#dash-search')
    if (search === null) throw new Error('no search box')
    search.value = 'disk'
    search.dispatchEvent(new Event('input'))
    expect([...document.querySelectorAll('.tile')].map((t) => (t as HTMLElement).dataset.name)).toEqual(['disks'])
  })

  // Asked for: a refresh to see newly added monitoring checks, and deleted ones go.
  it('refreshes from a button, turning until Rust says what was new and what went', () => {
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    const refresh = () => document.querySelector<HTMLButtonElement>('.dash-tools button[aria-label="Refresh"]')
    refresh()?.click()
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'refresh' })
    expect(refresh()?.classList.contains('spinning')).toBe(true)
    receive({ type: 'monitorReply', op: 'refresh', ok: true, data: { syncing: true, refreshing: true } })
    expect(refresh()?.classList.contains('spinning')).toBe(true)
    receive({ type: 'monitorReply', op: 'refresh', ok: true, data: { message: 'New after syncing the bucket: disk space.', refreshed: true } })
    expect(refresh()?.classList.contains('spinning')).toBe(false)
    expect(document.body.textContent).toContain('New after syncing the bucket: disk space.')
  })

  it('says why a due check has not started, and who wrote and changed a monitor', () => {
    receive({
      type: 'monitors',
      enabled: true,
      settings: { enabled: true, extraFolders: [] },
      monitors: [monitor('disks', 'amber', { waitingFor: 'Making sure it can run on this computer first…', author: 'ana', updatedBy: 'bo', updatedAt: Math.floor(Date.now() / 1000) - 3600, version: 2 })],
      codebases: [],
      executor: { running: false, starting: false, error: null },
      levels: [],
    })
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    const when = document.querySelector<HTMLElement>('.tile[data-name="disks"] .tile-when')
    expect(when?.textContent).toBe('waiting…')
    expect(when?.title).toContain('Making sure')
    document.querySelector('.tile[data-name="disks"]')?.dispatchEvent(new MouseEvent('mouseenter'))
    const tip = document.querySelector('#dash-tip')?.textContent ?? ''
    expect(tip).toContain('ana')
    expect(tip).toContain('by bo')
  })

  // Asked for: a way to see whether the scheduler is working, start it when it is not, and stop it.
  it('shows whether the scheduler is working, and stops and starts it', () => {
    const show = (scheduler: Record<string, unknown>): void =>
      receive({ type: 'monitors', enabled: true, settings: { enabled: true, extraFolders: [] }, monitors: [monitor('disks', 'green')], codebases: [], executor: { running: false, starting: false, error: null }, levels: [], scheduler })
    const bar = () => document.querySelector<HTMLElement>('.dash-scheduler')
    const press = () => bar()?.querySelector<HTMLButtonElement>('button')?.click()
    show({ stopped: false, lastTick: Math.floor(Date.now() / 1000) - 2, running: 1, waiting: 0 })
    document.querySelector<HTMLButtonElement>('#monitoring-btn')?.click()
    expect(bar()?.textContent).toContain('Scheduler running')
    press()
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'schedulerStop' })
    show({ stopped: true, lastTick: Math.floor(Date.now() / 1000), running: 0, waiting: 0 })
    expect(bar()?.textContent).toContain('Scheduler stopped')
    press()
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'schedulerStart' })
    // Not heard from for minutes: not working, whatever it last said.
    show({ stopped: false, lastTick: Math.floor(Date.now() / 1000) - 600, running: 0, waiting: 0 })
    expect(bar()?.textContent).toContain('not responding')
    press()
    expect(sent.at(-1)).toMatchObject({ cmd: 'monitor', op: 'schedulerStart' })
  })
})
