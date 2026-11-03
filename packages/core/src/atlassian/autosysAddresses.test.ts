import { describe, expect, it } from 'vitest'

import type { LightCodeConfig } from '../config/schema.js'
import { applyImport, buildExport, describeSections } from '../config/share.js'
import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import type { HttpClient, HttpResponse } from '../platform/http.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { AUTOSYS_PATH_KEYS, AutosysClient, autosysPathProblem, createAutosysStatusTool, DEFAULT_AUTOSYS_PATHS, pagingNote, type AutosysPaths } from './autosys.js'
import { createAutosysAddressTools, createAutosysCheckAddressesTool, createAutosysSetAddressesTool } from './autosysAddresses.js'

/*
 * Reported: Test connection 404, one job's status fine, JOB*UK not - the office AutoSys REST service
 * answers at addresses of its own. Asked for: let the agent learn them (from the wiki) and keep them,
 * and share what it learned with the team.
 */

function fakeServer(routes: Record<string, { status?: number; json?: unknown; text?: string }>, base = 'https://wla.test:9443') {
  const calls: string[] = []
  const http: HttpClient = {
    async request(url, options = {}) {
      const parsed = new URL(url)
      const target = decodeURIComponent(parsed.pathname + parsed.search)
      calls.push(`${options.method ?? 'GET'} ${target}`)
      const route = routes[`${options.method ?? 'GET'} ${target}`] ?? { status: 404, text: 'Not Found' }
      const text = route.text ?? JSON.stringify(route.json ?? {})
      const response: HttpResponse = { status: route.status ?? 200, headers: {}, text: async () => text, json: async <T>() => JSON.parse(text) as T, body: null }
      return response
    },
  }
  const connection = { baseUrl: base, token: 'secret', username: 'jsmith' }
  const make = (paths?: Partial<AutosysPaths>): AutosysClient => new AutosysClient(http, connection, paths)
  return { calls, make }
}

const NONE = {} as ToolExecutionContext

describe('an address template', () => {
  it('accepts every default', () => {
    for (const key of AUTOSYS_PATH_KEYS) expect(autosysPathProblem(key, DEFAULT_AUTOSYS_PATHS[key])).toBeUndefined()
    expect(autosysPathProblem('runInfo', '/v1/job-run-info?jobName={pattern}')).toBeUndefined()
    expect(autosysPathProblem('job', '/AEWS/v1/job?filter={filter:name}')).toBeUndefined()
  })

  it('is a path on the configured site and nothing else - the credential goes with it', () => {
    expect(autosysPathProblem('job', '.evil.example/{job}')).toBeDefined()
    expect(autosysPathProblem('job', '//evil.example/{job}')).toBeDefined()
    expect(autosysPathProblem('job', '/x?u=https://evil.example/{job}')).toBeDefined()
    expect(autosysPathProblem('job', '/../admin/{job}')).toBeDefined()
    expect(autosysPathProblem('job', '/%2e%2e/admin/{job}')).toBeDefined()
    expect(autosysPathProblem('job', '/job/{job} ')).toBeDefined()
  })

  it('names what it is about, with placeholders that exist', () => {
    expect(autosysPathProblem('job', '/v1/job')).toMatch(/\{job\}/)
    expect(autosysPathProblem('runInfo', '/v1/job-run-info?name={nope}')).toMatch(/not a placeholder/)
    expect(autosysPathProblem('jobs', '/v1/job?name={pattern')).toMatch(/stray brace/)
  })

  it('is refused when a saved one is unusable, naming the setting', () => {
    const { make } = fakeServer({})
    expect(() => make({ job: 'evil.example/{job}' })).toThrow(/paths\.job/)
  })
})

describe('a pattern on a server with no pattern status address', () => {
  const routes = {
    'GET /job?filter=name=@JOB*UK': { json: [{ name: 'JOB_A_UK' }, { name: 'JOB_B_UK' }] },
    'GET /job-run-info/JOB_A_UK': { json: { name: 'JOB_A_UK', status: 'SUCCESS' } },
    'GET /job-run-info/JOB_B_UK': { json: { name: 'JOB_B_UK', status: 'FAILURE' } },
  }

  it('lists the jobs and reads each one, so JOB*UK works', async () => {
    const { make, calls } = fakeServer(routes)
    const result = await createAutosysStatusTool({ client: async () => make() }).execute({ jobs: ['JOB*UK'] }, NONE)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('JOB_A_UK: SUCCESS')
    expect(result.content).toContain('JOB_B_UK: FAILURE')
    expect(calls[0]).toBe('GET /job-run-info?filter=name=@JOB*UK')
  })

  it('reads a status carried by the definition when there is no one-job status address either', async () => {
    const { make } = fakeServer({ 'GET /job/JOB_A_UK': { json: { name: 'JOB_A_UK', status: 'RUNNING' } } })
    expect((await make().runInfo('JOB_A_UK'))[0]?.status).toBe('RUNNING')
  })

  it('lets Test connection pass on the job list, and says what to do when neither answers', async () => {
    await expect(fakeServer({ 'GET /job?filter=name=@LIGHTCODE_PROBE_NO_SUCH_JOB*': { json: [] } }).make().probe('jsmith')).resolves.toBe('jsmith')
    await expect(fakeServer({}).make().probe('jsmith')).rejects.toThrow(/autosys_check_addresses/)
  })
})

describe('a server that pages its answers', () => {
  it('is noticed, and the status says some jobs are missing and what to change', async () => {
    const { make } = fakeServer({ 'GET /job-run-info?filter=name=@JOB*USD': { json: { totalCount: 230, jobRunInfo: [{ name: 'JOB_1_USD', status: 'SUCCESS' }, { name: 'JOB_2_USD', status: 'FAILURE' }] } } })
    const result = await createAutosysStatusTool({ client: async () => make() }).execute({ jobs: ['JOB*USD'] }, NONE)
    expect(result.content).toContain('JOB_2_USD: FAILURE')
    expect(result.content).toMatch(/answered 2 statuses for JOB\*USD of 230 - it pages/)
  })

  it('says nothing when the answer is whole', () => {
    expect(pagingNote({ total: 2, items: [1, 2] }, 2, 'jobs')).toBeUndefined()
    expect(pagingNote([{ a: 1 }], 1, 'jobs')).toBeUndefined()
    expect(pagingNote({ items: [1], next: '/job?page=2' }, 1, 'jobs')).toMatch(/pages/)
  })
})

describe('autosys_check_addresses', () => {
  // The office server: everything under /v1, nothing at the documented addresses.
  const office = {
    'GET /v1/job?filter=name=@PAY_LOAD*': { json: [{ name: 'PAY_LOAD' }] },
    'GET /v1/job/PAY_LOAD': { json: { name: 'PAY_LOAD', jobType: 'CMD' } },
    'GET /v1/job-run-info?filter=name=@PAY_LOAD*': { json: [{ name: 'PAY_LOAD', status: 'SUCCESS' }] },
    'GET /v1/job-run-info/PAY_LOAD': { json: { name: 'PAY_LOAD', status: 'SUCCESS' } },
  }

  it('finds the layout this server uses and proposes exactly what answered', async () => {
    const { make } = fakeServer(office)
    const result = await createAutosysCheckAddressesTool({ client: async () => make(), currentPaths: async () => ({}) }).execute(
      { job: 'PAY_LOAD', keys: ['jobs', 'job', 'runInfo', 'jobRunInfo'] },
      NONE,
    )
    expect(result.content).toContain('✓ job: /v1/job/{job}')
    expect(result.content).toContain('✓ runInfo: /v1/job-run-info?filter={filter:name}')
    expect(result.content).toContain('"jobRunInfo":"/v1/job-run-info/{job}"')
  })

  it('tries the candidates read on a wiki page first', async () => {
    const { make, calls } = fakeServer({ 'GET /wla/rest/jobs/PAY_LOAD': { json: { name: 'PAY_LOAD' } } })
    const result = await createAutosysCheckAddressesTool({ client: async () => make(), currentPaths: async () => ({}) }).execute(
      { job: 'PAY_LOAD', keys: ['job'], addresses: { job: '/wla/rest/jobs/{job}' }, common: false },
      NONE,
    )
    expect(calls[0]).toBe('GET /wla/rest/jobs/PAY_LOAD')
    expect(result.content).toContain('✓ job: /wla/rest/jobs/{job}')
  })

  it('stops at a refused sign-in rather than trying thirty addresses with it', async () => {
    const { make, calls } = fakeServer({ 'GET /job/PAY_LOAD': { status: 401, text: 'Unauthorized' } })
    const result = await createAutosysCheckAddressesTool({ client: async () => make(), currentPaths: async () => ({}) }).execute(
      { job: 'PAY_LOAD', keys: ['job'] },
      NONE,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/credential, not the address/)
    expect(calls).toHaveLength(1)
  })

  it('never tries an address that is sent to', async () => {
    const { make, calls } = fakeServer({})
    await createAutosysCheckAddressesTool({ client: async () => make(), currentPaths: async () => ({}) }).execute(
      { job: 'PAY_LOAD', keys: ['event', 'jil'], common: true },
      NONE,
    )
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([])
  })

  it('asks for a real job rather than judging addresses on a made-up one', async () => {
    const result = await createAutosysCheckAddressesTool({ client: async () => fakeServer({}).make(), currentPaths: async () => ({}) }).execute({}, NONE)
    expect(result.isError).toBe(true)
  })
})

describe('autosys_set_addresses', () => {
  it('always asks, never runs in a schedule, and is left out when access is read-only', () => {
    expect(ALWAYS_ASK_TOOLS.has('autosys_set_addresses')).toBe(true)
    expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain('autosys_set_addresses')
    const tools = createAutosysAddressTools({ client: async () => fakeServer({}).make(), currentPaths: async () => ({}), savePaths: async () => {} })
    expect(tools.find((tool) => tool.name === 'autosys_set_addresses')?.group).toBe('edit')
  })

  it('shows the change and each changed address tried live, then saves only that', async () => {
    let saved: Partial<AutosysPaths> | undefined
    const { make } = fakeServer({ 'GET /v1/job/PAY_LOAD': { json: { name: 'PAY_LOAD' } } })
    const tool = createAutosysSetAddressesTool({
      client: async () => make(),
      currentPaths: async () => ({ log: '/v1/log/{job}' }),
      savePaths: async (paths) => {
        saved = paths
      },
      testJob: 'PAY_LOAD',
    })
    const params = { addresses: { job: '/v1/job/{job}', log: null }, source: 'Wiki: AutoSys REST API' }
    const preview = await tool.preview!(params, NONE)
    expect(preview.kind).toBe('diff')
    if (preview.kind !== 'diff') return
    expect(preview.after).toContain('"job": "/v1/job/{job}"')
    expect(preview.after).not.toContain('log')
    expect(preview.note).toContain('Wiki: AutoSys REST API')
    expect(preview.note).toContain('✓ job')
    const result = await tool.execute(params, NONE)
    expect(saved).toEqual({ job: '/v1/job/{job}' })
    expect(result.content).toContain('AutoSys addresses')
  })

  it('saves nothing when an address would leave the site', async () => {
    let saved = false
    const tool = createAutosysSetAddressesTool({
      client: async () => fakeServer({}).make(),
      currentPaths: async () => ({}),
      savePaths: async () => {
        saved = true
      },
    })
    const result = await tool.execute({ addresses: { job: '.evil.example/{job}' } }, NONE)
    expect(result.isError).toBe(true)
    expect(saved).toBe(false)
  })
})

describe('sharing the addresses with the team', () => {
  const mine: LightCodeConfig = {
    autosys: { baseUrl: 'https://wla.test:9443', username: 'me', tokenRef: 'autosys:password', paths: { job: '/v1/job/{job}', runInfo: '/v1/job-run-info?filter={filter:name}' } },
    confluence: { baseUrl: 'https://wiki.test' },
  }

  it('exports the addresses alone', () => {
    expect(buildExport(mine, ['autosysAddresses'])).toEqual({ autosys: { paths: mine.autosys?.paths } })
  })

  it("imports only the addresses, keeping the importer's own sign-in and sites", () => {
    const file = buildExport(mine, ['autosysAddresses'])
    const theirs: LightCodeConfig = {
      autosys: { baseUrl: 'https://wla.test:9443', username: 'colleague', tokenRef: 'autosys:password', testJob: 'X' },
      jira: { baseUrl: 'https://jira.test' },
    }
    // Only the addresses are offered: the DevOps section would replace the whole block.
    const offered = describeSections(file).filter((section) => section.present).map((section) => section.id)
    expect(offered).toEqual(['autosysAddresses'])
    const merged = applyImport(theirs, file, offered)
    expect(merged.autosys).toEqual({ ...theirs.autosys, paths: mine.autosys?.paths })
    expect(merged.jira).toEqual(theirs.jira)
  })
})
