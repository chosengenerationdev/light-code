import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import type { ToolExecutionContext } from '../tools/types.js'
import {
  AutosysClient,
  createAutosysCalendarTool,
  createAutosysFindJobsTool,
  createAutosysGlobalVariablesTool,
  createAutosysMachinesTool,
  createAutosysRunsTool,
  createAutosysScheduleTool,
  createAutosysStatusTool,
  createAutosysTools,
  runMatches,
} from './autosys.js'
import { toolsForAccess } from './readOnly.js'
import { classifyRuns } from './autosysRuns.js'
import { calendarDates, jobSchedule, parseAutosysTime, startsInWindow, weekdayOf, wildcardMatches } from './autosysSchedule.js'

/*
 * The read tools added for "what is running on this machine", "what runs between 2 and 4", long
 * runners, global variables and calendars - and the read-only switch that leaves the writers out.
 */

function fakeAutosys(routes: Record<string, { status?: number; json?: unknown; text?: string }>) {
  const calls: { method: string; target: string; options: HttpRequestOptions }[] = []
  const http: HttpClient = {
    async request(url, options = {}) {
      const parsed = new URL(url)
      const target = decodeURIComponent(parsed.pathname + parsed.search)
      const method = options.method ?? 'GET'
      calls.push({ method, target, options })
      const route = routes[`${method} ${target}`] ?? { status: 404, text: 'not found' }
      const text = route.text ?? JSON.stringify(route.json ?? {})
      const response: HttpResponse = { status: route.status ?? 200, headers: {}, text: async () => text, json: async <T>() => JSON.parse(text) as T, body: null }
      return response
    },
  }
  const client = async (): Promise<AutosysClient> => new AutosysClient(http, { baseUrl: 'https://wla.test:9443/AEWS', token: 'secret', username: 'jsmith' })
  return { calls, client }
}

const NONE = {} as ToolExecutionContext
const JOBS = [
  { name: 'PAY_LOAD', jobType: 'CMD', machine: 'hostA', owner: 'svc_pay', command: '/apps/pay/load_gl.sh', startTimes: '02:00', daysOfWeek: 'mo,tu,we,th,fr' },
  { name: 'PAY_REPORT', jobType: 'CMD', machine: 'hostB', owner: 'svc_pay', command: '/apps/pay/report.sh', start_times: '"03:30, 23:15"', days_of_week: 'all' },
  { name: 'PAY_POLL', jobType: 'FW', machine: 'hostA', owner: 'svc_ops', startMins: '0,30', runCalendar: 'BUSDAYS' },
  { name: 'PAY_EOD', jobType: 'BOX', owner: 'svc_pay', condition: 's(PAY_LOAD)' },
]
const RUNS = [
  { name: 'PAY_LOAD', status: 'RUNNING', lastStart: '10/22/2026 01:00:00', runMachine: 'hostA' },
  { name: 'PAY_REPORT', status: 'FAILURE', lastStart: '10/22/2026 03:30:00', lastEnd: '10/22/2026 03:31:00', runMachine: 'hostB' },
  { name: 'PAY_POLL', status: 'SUCCESS', lastStart: '10/20/2026 00:00:00', lastEnd: '10/20/2026 00:01:00', runMachine: 'hostA' },
]

describe('the schedule in a definition', () => {
  it('matches AutoSys wildcards, case-insensitively', () => {
    expect(wildcardMatches('host*', 'HostA')).toBe(true)
    expect(wildcardMatches('PAY_?OAD', 'PAY_LOAD')).toBe(true)
    expect(wildcardMatches('hostA', 'hostAB')).toBe(false)
    expect(wildcardMatches('a.b', 'axb')).toBe(false)
    expect(wildcardMatches('host*', undefined)).toBe(false)
  })

  it('reads the time shapes AEWS returns, and "never" as nothing', () => {
    expect(parseAutosysTime('10/22/2026 02:05:00')).toBe(new Date(2026, 9, 22, 2, 5, 0).getTime())
    expect(parseAutosysTime('1761098700')).toBe(1761098700000)
    expect(parseAutosysTime('2026-10-22T02:05:00Z')).toBe(Date.parse('2026-10-22T02:05:00Z'))
    expect(parseAutosysTime('-----')).toBeUndefined()
    expect(parseAutosysTime('0')).toBeUndefined()
  })

  it('reads start times, hourly minutes, days and calendars in either spelling', () => {
    expect(jobSchedule(JOBS[0] as never)).toMatchObject({ times: ['02:00'], days: ['mo', 'tu', 'we', 'th', 'fr'] })
    expect(jobSchedule(JOBS[1] as never)).toMatchObject({ times: ['03:30', '23:15'] })
    expect(jobSchedule(JOBS[1] as never)?.days).toBeUndefined()
    expect(jobSchedule(JOBS[2] as never)).toMatchObject({ minutesPastHour: [0, 30], runCalendar: 'BUSDAYS' })
    expect(jobSchedule(JOBS[3] as never)).toBeUndefined()
  })

  it('finds the starts in a window, wrapping past midnight, on a given weekday', () => {
    const report = jobSchedule(JOBS[1] as never)!
    expect(startsInWindow(report, '02:00', '04:00')).toEqual(['03:30'])
    expect(startsInWindow(report, '22:00', '04:00')).toEqual(['03:30', '23:15'])
    const load = jobSchedule(JOBS[0] as never)!
    expect(startsInWindow(load, '00:00', '23:59', 'sa')).toEqual([])
    expect(startsInWindow(load, '00:00', '23:59', 'mo')).toEqual(['02:00'])
    expect(startsInWindow(jobSchedule(JOBS[2] as never)!, '02:00', '03:00')).toEqual(['02:00', '02:30', '03:00'])
  })

  it('turns the days people say into weekdays, and pulls dates out of a calendar', () => {
    const wednesday = new Date(2026, 9, 21)
    expect(weekdayOf('today', wednesday)).toBe('we')
    expect(weekdayOf('tomorrow', wednesday)).toBe('th')
    expect(weekdayOf('Saturday')).toBe('sa')
    expect(weekdayOf('2026-10-24')).toBe('sa')
    expect(weekdayOf('someday')).toBeUndefined()
    expect(calendarDates([{ name: 'BUSDAYS', dates: ['10/23/2026', '2026-10-22T00:00:00', { date: '10/26/2026 00:00' }] }])).toEqual([
      '2026-10-22',
      '2026-10-23',
      '2026-10-26',
    ])
  })
})

describe('more AutoSys reading', () => {
  it('finds jobs by what their definitions say', async () => {
    const { client } = fakeAutosys({ 'GET /AEWS/job?filter=name=@PAY_*': { json: JOBS } })
    const tool = createAutosysFindJobsTool({ client, defaultPattern: 'PAY_*' })
    const onA = await tool.execute({ machine: 'hostA' }, NONE)
    expect(onA.content).toContain('PAY_LOAD')
    expect(onA.content).toContain('PAY_POLL')
    expect(onA.content).not.toContain('PAY_REPORT')
    expect((await tool.execute({ commandContains: 'load_gl' }, NONE)).content).toMatch(/1 job\(s\) of the 4 .*PAY_LOAD/s)
    expect((await tool.execute({ owner: 'svc_ops' }, NONE)).content).toContain('PAY_POLL')
    expect((await tool.execute({ type: 'BOX' }, NONE)).content).toContain('PAY_EOD')
    expect((await tool.execute({ calendar: 'BUS*' }, NONE)).content).toContain('PAY_POLL')
  })

  it('answers "what is running on host A", and long runners with how long', async () => {
    const { client } = fakeAutosys({ 'GET /AEWS/job-run-info?filter=name=@PAY_*': { json: RUNS } })
    const tool = createAutosysStatusTool({ client, defaultPattern: 'PAY_*' })
    const running = await tool.execute({ machine: 'hostA', only: 'RUNNING' }, NONE)
    expect(running.content).toContain('PAY_LOAD: RUNNING')
    expect(running.content).not.toContain('PAY_POLL')
    expect(running.content).toMatch(/running for \d+ h/)
    const now = new Date(2026, 9, 22, 4, 0, 0).getTime()
    const longRun = { name: 'PAY_LOAD', status: 'RUNNING', lastStart: '10/22/2026 01:00:00' }
    expect(runMatches(longRun, { runningLongerThanMinutes: 120 }, now)).toBe(true)
    expect(runMatches(longRun, { runningLongerThanMinutes: 240 }, now)).toBe(false)
    const failed = { name: 'PAY_REPORT', status: 'FAILURE', lastEnd: '10/22/2026 03:31:00' }
    expect(runMatches(failed, { withinHours: 6 }, now)).toBe(true)
    expect(runMatches({ ...failed, lastEnd: '10/20/2026 03:31:00' }, { withinHours: 6 }, now)).toBe(false)
  })

  it('says so when status answers carry no machine, rather than "nothing runs there"', async () => {
    const { client } = fakeAutosys({ 'GET /AEWS/job-run-info?filter=name=@PAY_*': { json: [{ name: 'PAY_LOAD', status: 'RUNNING' }] } })
    const result = await createAutosysStatusTool({ client, defaultPattern: 'PAY_*' }).execute({ machine: 'hostA' }, NONE)
    expect(result.content).toContain('do not say which machine')
  })

  it('shows a machine with the jobs defined on it and running on it now', async () => {
    const { client } = fakeAutosys({
      'GET /AEWS/machine/hostA': { json: { name: 'hostA', status: 'ONLINE', type: 'a', maxLoad: 100 } },
      'GET /AEWS/job?filter=name=@PAY_*': { json: JOBS },
      'GET /AEWS/job-run-info?filter=name=@PAY_*': { json: RUNS },
    })
    const result = await createAutosysMachinesTool({ client, defaultPattern: 'PAY_*' }).execute({ machine: 'hostA' }, NONE)
    expect(result.content).toContain('status: ONLINE')
    expect(result.content).toMatch(/Running on hostA now \(1\):\n- PAY_LOAD: RUNNING/)
    expect(result.content).toMatch(/Defined to run on hostA \(2\)/)
    expect(result.content).toContain('PAY_POLL: SUCCESS')
  })

  it('names the setting to change when a server has no machine endpoint, and still lists the jobs', async () => {
    const { client } = fakeAutosys({ 'GET /AEWS/job?filter=name=@PAY_*': { json: JOBS }, 'GET /AEWS/job-run-info?filter=name=@PAY_*': { json: RUNS } })
    const result = await createAutosysMachinesTool({ client, defaultPattern: 'PAY_*' }).execute({ machine: 'hostB' }, NONE)
    expect(result.content).toContain('paths.machine')
    expect(result.content).toContain('PAY_REPORT')
  })

  it('reads global variables and calendars', async () => {
    const { client } = fakeAutosys({
      'GET /AEWS/global-variable?filter=name=@RUN_*': { json: [{ name: 'RUN_DATE', value: '20261022', lastChanged: '10/22/2026 00:00:01' }] },
      'GET /AEWS/calendar/standard/BUSDAYS': { json: { name: 'BUSDAYS', dates: ['10/22/2026', '10/23/2026', '10/26/2026'] } },
    })
    expect((await createAutosysGlobalVariablesTool({ client }).execute({ name: 'RUN_*' }, NONE)).content).toContain('RUN_DATE = 20261022')
    const calendar = createAutosysCalendarTool({ client })
    expect((await calendar.execute({ calendar: 'BUSDAYS', date: '2026-10-24' }, NONE)).content).toContain('is not in calendar BUSDAYS')
    expect((await calendar.execute({ calendar: 'BUSDAYS', from: '2026-10-23' }, NONE)).content).toContain('2026-10-23, 2026-10-26')
  })

  it('lists what starts in a window, in order, and counts what only a condition starts', async () => {
    const { client } = fakeAutosys({ 'GET /AEWS/job?filter=name=@PAY_*': { json: JOBS }, 'GET /AEWS/job-run-info?filter=name=@PAY_*': { json: RUNS } })
    const result = await createAutosysScheduleTool({ client, defaultPattern: 'PAY_*' }).execute({ from: '01:00', to: '04:00', withStatus: true }, NONE)
    const text = result.content
    expect(text.indexOf('02:00  PAY_LOAD')).toBeGreaterThan(-1)
    expect(text.indexOf('02:00  PAY_LOAD')).toBeLessThan(text.indexOf('03:30  PAY_REPORT'))
    expect(text).toContain('now FAILURE')
    expect(text).toContain('1 job(s) have no start schedule')
    const saturday = await createAutosysScheduleTool({ client, defaultPattern: 'PAY_*' }).execute({ from: '01:00', to: '04:00', day: '2026-10-24' }, NONE)
    expect(saturday.content).not.toContain('PAY_LOAD')
  })
})

/*
 * Asked for: a list of jobs today or in the last N hours - each run, and whether it was rerun by hand
 * (who, when) or automatically.
 */
describe('runs and how they started', () => {
  const today = (time: string): string => {
    const now = new Date()
    return `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${String(now.getFullYear())} ${time}`
  }

  it('tells a scheduled run, an automatic retry and a manual rerun apart, and names who reran it', async () => {
    const { client } = fakeAutosys({
      'GET /AEWS/job-run-info/PAY_LOAD/history': {
        json: [
          { runNum: 501, ntry: 1, status: 'FAILURE', startTime: today('02:00:00'), endTime: today('02:05:00'), exitCode: 1 },
          { runNum: 501, ntry: 2, status: 'FAILURE', startTime: today('02:10:00'), endTime: today('02:12:00'), exitCode: 1 },
          { runNum: 502, ntry: 1, status: 'SUCCESS', startTime: today('09:14:22'), endTime: today('09:20:00'), exitCode: 0 },
        ],
      },
      'GET /AEWS/event?filter=jobName==PAY_LOAD': {
        json: [
          { eventType: 'FORCE_STARTJOB', eventTime: today('09:14:20'), user: 'jsmith', comment: 'rerun after fix' },
          { eventType: 'JOB_ON_HOLD', eventTime: today('08:00:00'), user: 'akumar' },
        ],
      },
      'GET /AEWS/job-run-info/PAY_LOAD': { json: [{ name: 'PAY_LOAD', status: 'SUCCESS' }] },
    })
    const text = (await createAutosysRunsTool({ client }).execute({ jobs: ['PAY_LOAD'] }, NONE)).content
    expect(text).toContain('PAY_LOAD: 3 run(s) today')
    expect(text).toContain('started by hand 1x (jsmith at 09:14:20)')
    expect(text).toMatch(/run 501:.*automatic - its schedule or condition/)
    expect(text).toMatch(/run 501 try 2:.*AUTOMATIC RETRY/)
    expect(text).toMatch(/run 502:.*MANUAL - FORCE_STARTJOB by jsmith at 09:14:20 \("rerun after fix"\)/)
    expect(text).toContain('JOB_ON_HOLD by akumar')
  })

  it('says which address to set when the server has no history, rather than guessing', async () => {
    const { client } = fakeAutosys({ 'GET /AEWS/job-run-info/PAY_LOAD': { json: [{ name: 'PAY_LOAD', status: 'RUNNING', lastStart: today('01:00:00') }] } })
    const text = (await createAutosysRunsTool({ client }).execute({ jobs: ['PAY_LOAD'] }, NONE)).content
    expect(text).toContain('PAY_LOAD: 1 run(s) today')
    expect(text).toContain('how it started is not known')
    expect(text).toContain('paths.runHistory')
    expect(text).toContain('paths.eventHistory')
  })

  it('classifies without a clock: a start event just before a run is manual, none at all is unknown', () => {
    const run = { start: 1_000_000, status: 'SUCCESS' }
    expect(classifyRuns([run], [{ type: 'FORCE_STARTJOB', at: 999_000, user: 'ops' }])[0]?.how).toBe('manual')
    expect(classifyRuns([run], [{ type: 'FORCE_STARTJOB', at: 1_000_000 - 60 * 60_000, user: 'ops' }])[0]?.how).toBe('scheduled')
    expect(classifyRuns([run], undefined)[0]?.how).toBe('unknown')
  })
})

/*
 * Reported: Test connection got HTTP 404. The defaults started with /AEWS, so a site address that already
 * ended in /AEWS asked for /AEWS/AEWS/job-run-info. The site address is used as typed; only the resource
 * and its query are added.
 */
describe('the site address', () => {
  it('is used as typed, with only the resource and query added', async () => {
    const { calls, client } = fakeAutosys({ 'GET /AEWS/job-run-info?filter=name=@LIGHTCODE_PROBE_NO_SUCH_JOB*': { json: [] } })
    await (await client()).probe('jsmith')
    expect(calls[0]?.target).toBe('/AEWS/job-run-info?filter=name=@LIGHTCODE_PROBE_NO_SUCH_JOB*')
    expect(calls[0]?.target).not.toContain('/AEWS/AEWS')
  })
})

describe('read-only access', () => {
  it('leaves out every tool that changes something, and tells the readers', () => {
    const all = createAutosysTools({ client: async () => ({}) as AutosysClient })
    const readers = toolsForAccess(all, true, 'AutoSys')
    const names = readers.map((tool) => tool.name)
    expect(names).not.toContain('autosys_send_event')
    expect(names).not.toContain('autosys_apply_jil')
    expect(names).toEqual(expect.arrayContaining(['autosys_status', 'autosys_job', 'autosys_machines', 'autosys_schedule', 'autosys_calendar']))
    expect(readers.every((tool) => tool.group === 'read' && tool.description.includes('read-only'))).toBe(true)
    expect(toolsForAccess(all, false, 'AutoSys')).toHaveLength(all.length)
  })
})
