import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpResponse } from '../platform/http.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { AutosysClient, createAutosysDependenciesTool, createAutosysPredecessorsTool, createAutosysRunStatsTool, createAutosysUsualStartTool, definitionBox, definitionCondition } from './autosys.js'
import { clockOfMinute, durationStats, etaFor, formatDuration, runDurations, timeOfDayStats } from './autosysInsight.js'

/**
 * Asked for: a job's average run time, an ETA in local time for one running now, the normal start time of a job started
 * by a dependency, and every predecessor back to the topmost job with statuses - "it needs to use the job definitions".
 */

const NONE = {} as ToolExecutionContext

function fakeAutosys(routes: Record<string, unknown>) {
  const http: HttpClient = {
    async request(url, options = {}) {
      const parsed = new URL(url)
      const target = `${options.method ?? 'GET'} ${decodeURIComponent(parsed.pathname + parsed.search)}`
      const found = routes[target]
      const text = found === undefined ? 'not found' : JSON.stringify(found)
      const response: HttpResponse = { status: found === undefined ? 404 : 200, headers: {}, text: async () => text, json: async <T>() => JSON.parse(text) as T, body: null }
      return response
    },
  }
  return async (): Promise<AutosysClient> => new AutosysClient(http, { baseUrl: 'https://wla.test:9443/AEWS', token: 'secret', username: 'jsmith' })
}

/** An AutoSys time `MM/DD/YYYY HH:MM:SS`, `daysAgo` days back at local `time`. */
function at(daysAgo: number, time: string): string {
  const day = new Date()
  day.setDate(day.getDate() - daysAgo)
  return `${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}/${String(day.getFullYear())} ${time}`
}

describe('the numbers', () => {
  it('takes successful runs, and gives the typical, average and nine-in-ten run times', () => {
    const minute = 60_000
    const runs = [10, 12, 11, 14, 30].map((minutes, i) => ({ start: i * 86_400_000, end: i * 86_400_000 + minutes * minute, status: 'SUCCESS' }))
    runs.push({ start: 9 * 86_400_000, end: 9 * 86_400_000 + minute, status: 'FAILURE' })
    const { durations, onlySuccess } = runDurations(runs)
    expect(onlySuccess).toBe(true)
    const stats = durationStats(durations)!
    expect(stats.count).toBe(5)
    expect(stats.medianMs).toBe(12 * minute)
    expect(stats.meanMs).toBe(15.4 * minute)
    expect(formatDuration(stats.medianMs)).toBe('12 min 00 s')
    expect(formatDuration(3_900_000)).toBe('1 h 05 min')
  })

  it('gives an ETA from the typical run time, and says when a run is already longer than usual', () => {
    const stats = durationStats([600_000, 720_000, 660_000])!
    const start = 1_000_000_000
    expect(etaFor(start, stats, start + 300_000)).toMatchObject({ expected: start + 660_000, overrun: false })
    expect(etaFor(start, stats, start + 3_600_000).overrun).toBe(true)
  })

  it('finds the usual start around the clock, so a job either side of midnight usually starts at midnight', () => {
    const local = (hour: number, minute: number, day: number): number => new Date(2026, 9, day, hour, minute).getTime()
    const stats = timeOfDayStats([local(23, 50, 1), local(0, 5, 3), local(23, 58, 4), local(0, 2, 5), local(0, 0, 6)])!
    expect(clockOfMinute(stats.typical)).toBe('00:00')
    expect(stats.spreadMinutes).toBeLessThan(20)
    const morning = timeOfDayStats([local(2, 10, 1), local(2, 15, 2), local(2, 12, 3)])!
    expect(clockOfMinute(morning.typical)).toBe('02:12')
  })
})

// A chain: PAY_REPORT waits on s(PAY_LOAD); PAY_LOAD sits in box PAY_BOX and waits on s(GL_EXTRACT) and d(FX_RATES);
// GL_EXTRACT starts at 01:00 on its own; FX_RATES and PAY_BOX have no condition; PAY_BOX starts at 00:30.
const DEFINITIONS: Record<string, unknown> = {
  'GET /AEWS/job/PAY_REPORT': [{ name: 'PAY_REPORT', jobType: 'CMD', condition: 's(PAY_LOAD)' }],
  'GET /AEWS/job/PAY_LOAD': [{ name: 'PAY_LOAD', jobType: 'CMD', boxName: 'PAY_BOX', condition: 's(GL_EXTRACT) & d(FX_RATES)' }],
  'GET /AEWS/job/GL_EXTRACT': [{ name: 'GL_EXTRACT', jobType: 'CMD', startTimes: '01:00', daysOfWeek: 'all' }],
  'GET /AEWS/job/FX_RATES': [{ name: 'FX_RATES', jobType: 'CMD', startTimes: '00:45' }],
  'GET /AEWS/job/PAY_BOX': [{ name: 'PAY_BOX', jobType: 'BOX', startTimes: '00:30' }],
}
const STATUSES: Record<string, unknown> = {
  'GET /AEWS/job-run-info/PAY_REPORT': [{ name: 'PAY_REPORT', status: 'ACTIVATED' }],
  'GET /AEWS/job-run-info/PAY_LOAD': [{ name: 'PAY_LOAD', status: 'RUNNING', lastStart: at(0, '01:30:00') }],
  'GET /AEWS/job-run-info/GL_EXTRACT': [{ name: 'GL_EXTRACT', status: 'SUCCESS', lastStart: at(0, '01:00:00'), lastEnd: at(0, '01:30:00') }],
  'GET /AEWS/job-run-info/FX_RATES': [{ name: 'FX_RATES', status: 'FAILURE', lastStart: at(0, '00:45:00'), lastEnd: at(0, '00:46:00') }],
  'GET /AEWS/job-run-info/PAY_BOX': [{ name: 'PAY_BOX', status: 'RUNNING', lastStart: at(0, '00:30:00') }],
}
/** Daily runs on the five days before today, `minutes` long, starting at `start`. */
function history(start: string, minutes: number): unknown[] {
  return [1, 2, 3, 4, 5].map((daysAgo) => {
    const [h, m] = start.split(':').map(Number)
    const end = (h ?? 0) * 60 + (m ?? 0) + minutes
    return { runNum: 100 + daysAgo, ntry: 1, status: 'SUCCESS', startTime: at(daysAgo, `${start}:00`), endTime: at(daysAgo, `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}:00`) }
  })
}
const HISTORY: Record<string, unknown> = {
  'GET /AEWS/job-run-info/GL_EXTRACT/history': history('01:00', 30),
  'GET /AEWS/job-run-info/FX_RATES/history': history('00:45', 5),
  'GET /AEWS/job-run-info/PAY_LOAD/history': history('01:30', 40),
  'GET /AEWS/job-run-info/PAY_REPORT/history': history('02:10', 15),
  'GET /AEWS/event?filter=jobName==PAY_REPORT': [],
}

describe('autosys_run_stats', () => {
  it('reports the typical run time and an ETA in local time for a job running now', async () => {
    // Started five minutes ago: it should finish 35 minutes from now, at its typical 40.
    const started = new Date(Date.now() - 5 * 60_000)
    const two = (n: number): string => String(n).padStart(2, '0')
    const autosysTime = `${two(started.getMonth() + 1)}/${two(started.getDate())}/${String(started.getFullYear())} ${two(started.getHours())}:${two(started.getMinutes())}:${two(started.getSeconds())}`
    const expected = new Date(started.getTime() + 40 * 60_000)
    const client = fakeAutosys({ ...STATUSES, ...HISTORY, 'GET /AEWS/job-run-info/PAY_LOAD': [{ name: 'PAY_LOAD', status: 'RUNNING', lastStart: autosysTime }] })
    const text = (await createAutosysRunStatsTool({ client }).execute({ jobs: ['PAY_LOAD'] }, NONE)).content
    expect(text).toContain('over 5 successful run(s) in 30 days: typically 40 min 00 s')
    expect(text).toContain(`ETA ${two(expected.getHours())}:${two(expected.getMinutes())}`)
    expect(text).not.toContain('running long')
    expect(text).toContain('Times are local')
  })

  it('says when there is no history to go by', async () => {
    const client = fakeAutosys({ 'GET /AEWS/job-run-info/PAY_LOAD': [{ name: 'PAY_LOAD', status: 'SUCCESS' }] })
    const text = (await createAutosysRunStatsTool({ client }).execute({ jobs: ['PAY_LOAD'] }, NONE)).content
    expect(text).toContain('nothing to base a run time on')
    expect(text).toContain('paths.runHistory')
  })
})

describe('autosys_predecessors', () => {
  it('walks every predecessor and the box up to the topmost jobs, with statuses and what is not met', async () => {
    const client = fakeAutosys({ ...DEFINITIONS, ...STATUSES })
    const text = (await createAutosysPredecessorsTool({ client }).execute({ job: 'PAY_REPORT' }, NONE)).content
    expect(text).toMatch(/^PAY_REPORT \[ACTIVATED\]/)
    expect(text).toContain('success of (NOT met) PAY_LOAD [RUNNING]')
    expect(text).toContain('inside box (met) PAY_BOX [RUNNING]')
    expect(text).toContain('success of (met) GL_EXTRACT [SUCCESS]')
    expect(text).toContain('completion of (met) FX_RATES [FAILURE]')
    expect(text).toContain('TOP - starts at 01:00 every day')
    expect(text).toContain('4 predecessor job(s) over 2 level(s). Topmost: ')
    for (const top of ['GL_EXTRACT', 'FX_RATES', 'PAY_BOX']) expect(text).toMatch(new RegExp(`Topmost: .*${top}`))
    expect(text).toContain('Failed or terminated: FX_RATES [FAILURE]')
    expect(text).toContain('PAY_REPORT waits on success of PAY_LOAD')
  })

  it('stops at its limit and says so', async () => {
    const client = fakeAutosys({ ...DEFINITIONS, ...STATUSES })
    const text = (await createAutosysPredecessorsTool({ client }).execute({ job: 'PAY_REPORT', maxDepth: 1 }, NONE)).content
    expect(text).toContain('The walk stopped at its limit')
    expect(text).toContain('not traced (limit reached)')
  })
})

describe('autosys_usual_start', () => {
  it('gives the observed start and, from the definitions, the start its predecessors imply', async () => {
    const client = fakeAutosys({ ...DEFINITIONS, ...STATUSES, ...HISTORY })
    const text = (await createAutosysUsualStartTool({ client }).execute({ jobs: ['PAY_REPORT'] }, NONE)).content
    expect(text).toContain('no start time of its own - started when: s(PAY_LOAD)')
    expect(text).toContain('observed over 5 run(s): usually starts around 02:10')
    // GL_EXTRACT 01:00 + 30 min -> PAY_LOAD at 01:30 (FX_RATES 00:45 + 5 is earlier) + 40 min -> PAY_REPORT at 02:10.
    expect(text).toContain('from the definitions: about 02:10 - GL_EXTRACT starts at 01:00 -> PAY_LOAD after GL_EXTRACT (01:30) -> PAY_REPORT after PAY_LOAD (02:10)')
  })

  it('names what is missing when the chain cannot be worked out', async () => {
    const client = fakeAutosys({ ...DEFINITIONS, ...STATUSES, 'GET /AEWS/job-run-info/PAY_REPORT/history': [] })
    const text = (await createAutosysUsualStartTool({ client }).execute({ jobs: ['PAY_REPORT'] }, NONE)).content
    expect(text).toContain('from the definitions: cannot be worked out')
    expect(text).toContain('(no run history)')
  })
})

describe('reading a definition however the server shapes it', () => {
  // Reported: the dependency tools found nothing for a job that has dependencies - the office server spells and nests
  // its definition fields its own way.
  it('finds the condition and box under any spelling, one level down, or in JIL text', () => {
    expect(definitionCondition({ Condition: 's(A)' })).toBe('s(A)')
    expect(definitionCondition({ job_condition: 's(A)' })).toBe('s(A)')
    expect(definitionCondition({ job: { name: 'X', condition: 'd(B)' } })).toBe('d(B)')
    expect(definitionCondition({ jil: 'insert_job: X   job_type: CMD\r\ncondition: s(A) & s(B)\r\nbox_name: BOX1' })).toBe('s(A) & s(B)')
    expect(definitionBox({ jil: 'insert_job: X\nbox_name: BOX1' })).toBe('BOX1')
    expect(definitionBox({ BOX_NAME: 'BOX2' })).toBe('BOX2')
    expect(definitionCondition({ name: 'X' })).toBeUndefined()
  })

  it('traces predecessors from a definition that wraps and capitalises its fields', async () => {
    const client = fakeAutosys({
      ...STATUSES,
      'GET /AEWS/job/PAY_REPORT': [{ name: 'PAY_REPORT', attributes: { Condition: 's(PAY_LOAD)' } }],
      'GET /AEWS/job/PAY_LOAD': [{ name: 'PAY_LOAD', jil: 'insert_job: PAY_LOAD\nstart_times: "01:30"' }],
    })
    const text = (await createAutosysPredecessorsTool({ client }).execute({ job: 'PAY_REPORT' }, NONE)).content
    expect(text).toContain('success of (NOT met) PAY_LOAD [RUNNING]')
    expect(text).not.toContain('has no condition or box field')
  })

  it('says which fields came back when a job with no start time shows no condition', async () => {
    const client = fakeAutosys({ ...STATUSES, 'GET /AEWS/job/PAY_REPORT': [{ name: 'PAY_REPORT', jobType: 'CMD', owner: 'batch' }] })
    const trace = (await createAutosysPredecessorsTool({ client }).execute({ job: 'PAY_REPORT' }, NONE)).content
    expect(trace).toContain('has no condition or box field (it returned: name, jobType, owner)')
    const deps = (await createAutosysDependenciesTool({ client }).execute({ job: 'PAY_REPORT', direction: 'upstream' }, NONE)).content
    expect(deps).toContain('has no condition or box field')
  })
})
