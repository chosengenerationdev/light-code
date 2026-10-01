import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import { PathDenylist } from '../fs/denylist.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { NodeFileSystem } from '../platform/node/filesystem.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import type { ToolExecutionContext } from '../tools/types.js'
import {
  buildRef,
  createJenkinsBuildLogTool,
  createJenkinsBuildTool,
  createJenkinsFindJobsTool,
  createJenkinsStartBuildTool,
  createJenkinsTryJenkinsfileTool,
  JenkinsClient,
  jobPath,
} from './jenkins.js'

/** Jenkins, faked: routes keyed by "METHOD path", anything else a 404. */
type RouteData = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }
type Route = RouteData | ((options: HttpRequestOptions) => RouteData)

function fakeJenkins(routes: Record<string, Route>) {
  const calls: { method: string; path: string; options: HttpRequestOptions }[] = []
  const http: HttpClient = {
    async request(url, options = {}) {
      const { pathname } = new URL(url)
      const method = options.method ?? 'GET'
      calls.push({ method, path: pathname, options })
      const found = routes[`${method} ${pathname}`] ?? { status: 404, text: '<html><body><h2>Not Found</h2></body></html>' }
      const route: RouteData = typeof found === 'function' ? found(options) : found
      const bytes = new TextEncoder().encode(route.text ?? JSON.stringify(route.json ?? {}))
      const response: HttpResponse = {
        status: route.status ?? 200,
        headers: route.headers ?? {},
        text: async () => new TextDecoder().decode(bytes),
        json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
        body: new ReadableStream({
          start(controller) {
            // In two chunks, so a line split across them is exercised.
            const middle = Math.floor(bytes.length / 2)
            controller.enqueue(bytes.slice(0, middle))
            controller.enqueue(bytes.slice(middle))
            controller.close()
          },
        }),
      }
      return response
    },
  }
  const client = async (): Promise<JenkinsClient> =>
    new JenkinsClient(http, { baseUrl: 'https://ci.test', token: 'tok', username: 'jsmith' })
  return { calls, client, http }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('naming jobs and builds', () => {
  it('turns folder paths, /job/ paths and pasted URLs into one shape, refusing ..', () => {
    expect(jobPath('platform/service api')).toBe('/job/platform/job/service%20api')
    expect(jobPath('/job/platform/job/api/')).toBe('/job/platform/job/api')
    // A pasted build address names its job; the build number is not part of the job.
    expect(jobPath('https://ci.test/job/platform/job/api/42/', 'https://ci.test')).toBe('/job/platform/job/api')
    expect(() => jobPath('platform/../admin')).toThrow(/not a job name/)
  })

  it('reads build numbers and the names people use for builds', () => {
    expect(buildRef(42)).toBe('42')
    expect(buildRef('#42')).toBe('42')
    expect(buildRef('lastFailed')).toBe('lastFailedBuild')
    expect(buildRef(undefined)).toBe('lastBuild')
    expect(() => buildRef('yesterday')).toThrow(/not a build/)
  })
})

describe('authentication', () => {
  it('sends a Jenkins API token with the user id, as HTTP Basic', async () => {
    const { calls, client } = fakeJenkins({ 'GET /me/api/json': { json: { fullName: 'J Smith' } } })
    expect(await (await client()).currentUser()).toBe('J Smith')
    expect(calls[0]?.options.headers?.['Authorization']).toBe(`Basic ${Buffer.from('jsmith:tok').toString('base64')}`)
  })

  it('sends it as a Bearer token when no user id is set — for an SSO access token', async () => {
    const { http } = fakeJenkins({ 'GET /me/api/json': { json: { id: 'jsmith' } } })
    const calls: HttpRequestOptions[] = []
    const recording: HttpClient = { request: (url, options = {}) => (calls.push(options), http.request(url, options)) }
    await new JenkinsClient(recording, { baseUrl: 'https://ci.test', token: 'sso' }).currentUser()
    expect(calls[0]?.headers?.['Authorization']).toBe('Bearer sso')
  })

  it('turns an HTML error page into words', async () => {
    const { client } = fakeJenkins({ 'GET /me/api/json': { status: 401, text: '<html><head><style>x{}</style></head><body><h1>Unauthorized</h1></body></html>' } })
    await expect((await client()).currentUser()).rejects.toThrow(/did not accept.*Settings → DevOps → Jenkins/)
  })
})

describe('reading', () => {
  it('finds jobs inside folders, with their status in words', async () => {
    const { client } = fakeJenkins({
      'GET /api/json': {
        json: {
          jobs: [
            { name: 'platform', fullName: 'platform', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [{ name: 'api', fullName: 'platform/api', color: 'red', url: 'u' }] },
            { name: 'docs', fullName: 'docs', color: 'blue_anime', url: 'v' },
          ],
        },
      },
    })
    const result = await createJenkinsFindJobsTool({ client }).execute({ query: 'api' }, {} as ToolExecutionContext)
    expect(result.content).toContain('- platform/api  [failed]')
    expect(result.content).not.toContain('docs')
  })

  it('explains a failed build: stages, failed tests, causes and changes', async () => {
    const { client } = fakeJenkins({
      'GET /job/api/lastFailedBuild/api/json': {
        json: {
          number: 7,
          result: 'FAILURE',
          timestamp: 1,
          duration: 125000,
          actions: [{ causes: [{ shortDescription: 'Started by user J Smith' }] }, { parameters: [{ name: 'ENV', value: 'staging' }] }],
          changeSets: [{ items: [{ msg: 'fix login\nmore', commitId: 'abcdef1234567', author: { fullName: 'Ana' } }] }],
        },
      },
      'GET /job/api/lastFailedBuild/wfapi/describe': { json: { stages: [{ id: '6', name: 'Build', status: 'SUCCESS' }, { id: '9', name: 'Test', status: 'FAILED' }] } },
      'GET /job/api/lastFailedBuild/testReport/api/json': {
        json: { failCount: 1, passCount: 40, skipCount: 0, suites: [{ cases: [{ className: 'LoginTest', name: 'rejects', status: 'FAILED', errorDetails: 'expected 401 but was 500' }] }] },
      },
    })
    const result = await createJenkinsBuildTool({ client }).execute({ job: 'api', build: 'lastFailed' }, {} as ToolExecutionContext)
    expect(result.content).toContain('FAILURE')
    expect(result.content).toContain('Started by user J Smith')
    expect(result.content).toContain('ENV = "staging"')
    expect(result.content).toContain('abcdef1234 Ana: fix login')
    expect(result.content).toContain('- Test: FAILED')
    expect(result.content).toContain('LoginTest.rejects: expected 401 but was 500')
  })

  it('streams the log: the end of it, or only matching lines with context', async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${String(index + 1)}`)
    lines[149] = 'ERROR: database refused connection'
    const { client } = fakeJenkins({ 'GET /job/api/7/consoleText': { text: lines.join('\n') } })
    const tool = createJenkinsBuildLogTool({ client, defaultJob: 'api' })

    const found = await tool.execute({ build: 7, search: 'error' }, {} as ToolExecutionContext)
    expect(found.content).toContain('1 matching line(s)')
    expect(found.content).toContain('150: ERROR: database refused connection')
    expect(found.content).toContain('149- line 149')
    expect(found.content).toContain('153- line 153')

    const tail = await tool.execute({ build: 7, tailKb: 1 }, {} as ToolExecutionContext)
    expect(tail.content).toContain('line 200')
    expect(tail.content).not.toContain('line 1\n')
  })

  it('reads the steps of the stage that failed', async () => {
    const { client } = fakeJenkins({
      'GET /job/api/7/wfapi/describe': { json: { stages: [{ id: '9', name: 'Test', status: 'FAILED' }] } },
      'GET /job/api/7/execution/node/9/wfapi/describe': { json: { stageFlowNodes: [{ id: '10', name: 'Shell Script', status: 'FAILED', parameterDescription: 'npm test' }] } },
      'GET /job/api/7/execution/node/10/wfapi/log': { json: { text: '<span>npm ERR! test failed</span>' } },
    })
    const result = await createJenkinsBuildLogTool({ client }).execute({ job: 'api', build: 7, stage: 'test' }, {} as ToolExecutionContext)
    expect(result.content).toContain('step: Shell Script (npm test) [FAILED]')
    expect(result.content).toContain('npm ERR! test failed')
  })
})

describe('acting', () => {
  it('starts a build with parameters, follows the queue to its number, and names an unknown parameter first', async () => {
    const { calls, client } = fakeJenkins({
      'GET /job/api/api/json': { json: { property: [{ parameterDefinitions: [{ name: 'ENV', type: 'StringParameterDefinition', defaultParameterValue: { value: 'dev' } }] }] } },
      'POST /job/api/buildWithParameters': { status: 201, headers: { location: 'https://ci.test/queue/item/55/' } },
      'GET /queue/item/55/api/json': { json: { executable: { number: 8 } } },
    })
    const tool = createJenkinsStartBuildTool({ client })
    const preview = JSON.stringify(await tool.preview?.({ job: 'api', parameters: { ENV: 'staging', TYPO: 'x' } }, {} as ToolExecutionContext))
    expect(preview).toContain('ENV = staging')
    expect(preview).toContain('Jenkins will ignore them: TYPO')

    const result = await tool.execute({ job: 'api', parameters: { ENV: 'staging' } }, {} as ToolExecutionContext)
    expect(result.content).toContain('Started api #8')
    const post = calls.find((call) => call.method === 'POST')
    expect(post?.options.body).toBe('ENV=staging')
    expect(post?.options.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded')
  })

  it('fetches a CSRF crumb only when Jenkins asks for one, and retries once', async () => {
    let attempts = 0
    const { calls, client } = fakeJenkins({
      'POST /job/api/build': (options) => {
        attempts += 1
        return options.headers?.['Jenkins-Crumb'] === 'c1'
          ? { status: 201 }
          : { status: 403, text: '<html><body>No valid crumb was included in the request</body></html>' }
      },
      'GET /crumbIssuer/api/json': { json: { crumbRequestField: 'Jenkins-Crumb', crumb: 'c1' } },
    })
    await (await client()).startBuild('api', undefined)
    expect(attempts).toBe(2)
    expect(calls.some((call) => call.path === '/crumbIssuer/api/json')).toBe(true)
  })

  it('tries a local Jenkinsfile with Replay, showing the whole file first', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-jenkins-')))
    dirs.push(root)
    fs.writeFileSync(path.join(root, 'Jenkinsfile'), "pipeline { agent any; stages { stage('x') { steps { echo 'hi' } } } }")
    const context = { fs: new NodeFileSystem(), workspaceRoot: root, denylist: new PathDenylist(), readFiles: new Set() } as unknown as ToolExecutionContext
    let lastBuild = 7
    const { calls, client } = fakeJenkins({
      'GET /job/api/api/json': () => ({ json: { lastBuild: { number: lastBuild } } }),
      'POST /job/api/7/replay/run': () => {
        lastBuild = 9
        return { status: 200 }
      },
    })
    const tool = createJenkinsTryJenkinsfileTool({ client, defaultJob: 'api' })
    const preview = JSON.stringify(await tool.preview?.({ build: 7 }, context))
    expect(preview).toContain("echo 'hi'")
    expect(preview).toContain('Replay api #7')
    const result = await tool.execute({ build: 7, waitMinutes: 0 }, context)
    expect(result.content).toContain('Replaying as api #9')
    const body = new URLSearchParams(String(calls.find((call) => call.method === 'POST')?.options.body))
    expect(body.get('mainScript')).toContain("echo 'hi'")
  })

  /*
   * Asked for directly: "check if a locally created Jenkinsfile will run fine". With a wait, the
   * answer comes back in one call — success, or which stage failed and why.
   */
  it('waits for the replayed run and says why it failed', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-jenkins-')))
    dirs.push(root)
    fs.writeFileSync(path.join(root, 'Jenkinsfile'), 'pipeline { }')
    const context = { fs: new NodeFileSystem(), workspaceRoot: root, denylist: new PathDenylist(), readFiles: new Set() } as unknown as ToolExecutionContext
    let lastBuild = 7
    const { client } = fakeJenkins({
      'GET /job/api/api/json': () => ({ json: { lastBuild: { number: lastBuild } } }),
      'POST /job/api/lastBuild/replay/run': () => {
        lastBuild = 8
        return { status: 200 }
      },
      'GET /job/api/8/api/json': { json: { number: 8, building: false, result: 'FAILURE', duration: 30000 } },
      'GET /job/api/8/wfapi/describe': { json: { stages: [{ id: '5', name: 'Deploy', status: 'FAILED' }] } },
      'GET /job/api/8/execution/node/5/wfapi/describe': { json: { stageFlowNodes: [{ id: '6', name: 'sh', status: 'FAILED' }] } },
      'GET /job/api/8/execution/node/6/wfapi/log': { json: { text: 'kubectl: permission denied' } },
    })
    const result = await createJenkinsTryJenkinsfileTool({ client, defaultJob: 'api' }).execute({}, context)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('did not run cleanly: api #8 ended FAILURE')
    expect(result.content).toContain('Stage Deploy [FAILED]')
    expect(result.content).toContain('kubectl: permission denied')
  })

  it('always asks before starting, stopping or replaying, and never lets a schedule do it', () => {
    for (const name of ['jenkins_start_build', 'jenkins_stop_build', 'jenkins_try_jenkinsfile']) {
      expect(ALWAYS_ASK_TOOLS.has(name)).toBe(true)
      expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain(name)
    }
  })
})
