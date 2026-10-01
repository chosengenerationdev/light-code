import { describe, expect, it } from 'vitest'

import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import type { ToolExecutionContext } from '../tools/types.js'
import {
  AutosysClient,
  conditionMet,
  createAutosysApplyJilTool,
  createAutosysDependenciesTool,
  createAutosysJobTool,
  createAutosysLogTool,
  createAutosysSendEventTool,
  createAutosysStatusTool,
  parseConditions,
} from './autosys.js'

/** AutoSys web services, faked: routes keyed by "METHOD path?query", anything else a 404. */
function fakeAutosys(routes: Record<string, { status?: number; json?: unknown; text?: string }>) {
  const calls: { method: string; target: string; options: HttpRequestOptions }[] = []
  const http: HttpClient = {
    async request(url, options = {}) {
      const parsed = new URL(url)
      const target = decodeURIComponent(parsed.pathname + parsed.search)
      const method = options.method ?? 'GET'
      calls.push({ method, target, options })
      const route = routes[`${method} ${target}`] ?? { status: 404, text: 'not found' }
      const bytes = new TextEncoder().encode(route.text ?? JSON.stringify(route.json ?? {}))
      const response: HttpResponse = {
        status: route.status ?? 200,
        headers: {},
        text: async () => new TextDecoder().decode(bytes),
        json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
        body: null,
      }
      return response
    },
  }
  const client = async (): Promise<AutosysClient> =>
    new AutosysClient(http, { baseUrl: 'https://wla.test:9443', token: 'secret', username: 'jsmith' })
  return { calls, client }
}

const NONE = {} as ToolExecutionContext
const run = (name: string, status: string) => ({ json: [{ name, status, lastStart: '10/01/2026 02:00:00', exitCode: status === 'FAILURE' ? 1 : 0 }] })

describe('reading conditions', () => {
  it('finds every job a condition names, in short and long forms, across instances', () => {
    expect(parseConditions('s(PAY_LOAD) & f(PAY_CHECK, 24.00) | done(PAY_X^PRD) & e(PAY_Y) = 0 & v(GLOBAL_FLAG) = "Y"')).toEqual([
      { kind: 's', job: 'PAY_LOAD' },
      { kind: 'f', job: 'PAY_CHECK' },
      { kind: 'd', job: 'PAY_X', instance: 'PRD' },
      { kind: 'e', job: 'PAY_Y', comparison: '= 0' },
    ])
    expect(conditionMet('s', 'SUCCESS')).toBe(true)
    expect(conditionMet('d', 'TERMINATED')).toBe(true)
    expect(conditionMet('s', 'FAILURE')).toBe(false)
  })
})

describe('AutoSys tools', () => {
  it('signs in with the username and password as HTTP Basic', async () => {
    const { calls, client } = fakeAutosys({ 'GET /AEWS/job-run-info?filter=name==LIGHTCODE_PROBE_NO_SUCH_JOB*': { json: [] } })
    await (await client()).probe('jsmith')
    expect(calls[0]?.options.headers?.['Authorization']).toBe(`Basic ${Buffer.from('jsmith:secret').toString('base64')}`)
  })

  it('shows a definition in JIL terms, with its status and box members', async () => {
    const { client } = fakeAutosys({
      'GET /AEWS/job/PAY_EOD': { json: { name: 'PAY_EOD', jobType: 'BOX', owner: 'payops', condition: 's(PAY_LOAD)' } },
      'GET /AEWS/job-run-info/PAY_EOD': run('PAY_EOD', 'RUNNING'),
      'GET /AEWS/job?filter=boxName==PAY_EOD': { json: { jobs: [{ name: 'PAY_EXTRACT' }, { name: 'PAY_REPORT' }] } },
    })
    const result = await createAutosysJobTool({ client }).execute({ job: 'PAY_EOD' }, NONE)
    expect(result.content).toContain('condition: s(PAY_LOAD)')
    expect(result.content).toContain('Status: PAY_EOD: RUNNING')
    expect(result.content).toContain('- PAY_EXTRACT')
  })

  it('lists only failed jobs when asked', async () => {
    const { client } = fakeAutosys({
      'GET /AEWS/job-run-info?filter=name==PAY_*': { json: [{ name: 'PAY_A', status: 'SUCCESS' }, { name: 'PAY_B', status: 'FAILURE', exitCode: 2 }] },
    })
    const result = await createAutosysStatusTool({ client, defaultPattern: 'PAY_*' }).execute({ only: 'FAILURE' }, NONE)
    expect(result.content).toContain('PAY_B: FAILURE')
    expect(result.content).not.toContain('PAY_A')
  })

  it('reads a log, and says where the output goes when the server has no log endpoint', async () => {
    const withLog = fakeAutosys({ 'GET /AEWS/job-log/PAY_B?runNum=&type=stderr': { text: 'line 1\nORA-01017: invalid username/password\nline 3' } })
    const found = await createAutosysLogTool({ client: withLog.client }).execute({ job: 'PAY_B', search: 'ORA-' }, NONE)
    expect(found.content).toContain('2: ORA-01017: invalid username/password')

    const without = fakeAutosys({ 'GET /AEWS/job/PAY_B': { json: { name: 'PAY_B', machine: 'payhost01', std_err_file: '/logs/PAY_B.err' } } })
    const missing = await createAutosysLogTool({ client: without.client }).execute({ job: 'PAY_B' }, NONE)
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('/logs/PAY_B.err on payhost01')
  })

  it('explains why a job has not started, following the unmet condition up', async () => {
    const { client } = fakeAutosys({
      'GET /AEWS/job/PAY_REPORT': { json: { name: 'PAY_REPORT', condition: 's(PAY_LOAD) & d(PAY_AUDIT)' } },
      'GET /AEWS/job-run-info/PAY_LOAD': run('PAY_LOAD', 'ON_HOLD'),
      'GET /AEWS/job-run-info/PAY_AUDIT': run('PAY_AUDIT', 'SUCCESS'),
      'GET /AEWS/job/PAY_LOAD': { json: { name: 'PAY_LOAD', condition: 's(PAY_FEED)' } },
      'GET /AEWS/job-run-info/PAY_FEED': run('PAY_FEED', 'FAILURE'),
      'GET /AEWS/job/PAY_FEED': { json: { name: 'PAY_FEED', start_times: '01:00' } },
    })
    const result = await createAutosysDependenciesTool({ client }).execute({ job: 'PAY_REPORT', direction: 'upstream' }, NONE)
    expect(result.content).toContain('success of PAY_LOAD: ON_HOLD — NOT met')
    expect(result.content).toContain('completion of PAY_AUDIT: SUCCESS — met')
    expect(result.content).toContain('success of PAY_FEED: FAILURE — NOT met')
  })

  it('finds the jobs that wait on this one', async () => {
    const { client } = fakeAutosys({
      'GET /AEWS/job/PAY_LOAD': { json: { name: 'PAY_LOAD', jobType: 'CMD' } },
      'GET /AEWS/job?filter=name==PAY_*': {
        json: [
          { name: 'PAY_REPORT', condition: 's(PAY_LOAD) & d(PAY_AUDIT)' },
          { name: 'PAY_OTHER', condition: 's(PAY_LOADER)' },
        ],
      },
    })
    const result = await createAutosysDependenciesTool({ client, defaultPattern: 'PAY_*' }).execute({ job: 'PAY_LOAD', direction: 'downstream' }, NONE)
    expect(result.content).toContain('1 job(s) wait on it')
    expect(result.content).toContain('PAY_REPORT')
    expect(result.content).not.toContain('PAY_OTHER')
  })

  it('shows an event as the sendevent it is, with what it will do, and sends it', async () => {
    const { calls, client } = fakeAutosys({
      'GET /AEWS/job-run-info/PAY_B': run('PAY_B', 'FAILURE'),
      'POST /AEWS/event': { text: 'Event sent' },
    })
    const tool = createAutosysSendEventTool({ client })
    const preview = JSON.stringify(await tool.preview?.({ job: 'PAY_B', event: 'FORCE_STARTJOB', comment: 'rerun after fix' }, NONE))
    expect(preview).toContain('sendevent -E FORCE_STARTJOB -J PAY_B -C \\"rerun after fix\\"')
    expect(preview).toContain('ignoring its starting conditions')
    await tool.execute({ job: 'PAY_B', event: 'FORCE_STARTJOB' }, NONE)
    expect(JSON.parse(String(calls.find((call) => call.method === 'POST')?.options.body))).toEqual({ eventType: 'FORCE_STARTJOB', jobName: 'PAY_B' })
  })

  it('refuses a status change with no status', async () => {
    const { client } = fakeAutosys({})
    expect((await createAutosysSendEventTool({ client }).execute({ job: 'PAY_B', event: 'CHANGE_STATUS' }, NONE)).isError).toBe(true)
  })

  it('shows the whole JIL, and says so plainly when it deletes', async () => {
    const { client } = fakeAutosys({})
    const preview = JSON.stringify(await createAutosysApplyJilTool({ client }).preview?.({ jil: 'delete_job: PAY_OLD' }, NONE))
    expect(preview).toContain('delete_job PAY_OLD')
    expect(preview).toContain('DELETES job definitions')
  })

  it('refuses names that could reach the URL as something else', async () => {
    const { client } = fakeAutosys({})
    await expect((await client()).job('../admin')).rejects.toThrow(/not a job name/)
  })

  /* Asked for: changing definitions, starting jobs and changing statuses always ask; reading can be always allowed. */
  it('always asks before changing anything, and never lets a schedule do it', () => {
    for (const name of ['autosys_send_event', 'autosys_apply_jil']) {
      expect(ALWAYS_ASK_TOOLS.has(name)).toBe(true)
      expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain(name)
    }
    for (const name of ['autosys_find_jobs', 'autosys_job', 'autosys_status', 'autosys_job_log', 'autosys_dependencies']) {
      expect(ALWAYS_ASK_TOOLS.has(name)).toBe(false)
    }
  })
})
