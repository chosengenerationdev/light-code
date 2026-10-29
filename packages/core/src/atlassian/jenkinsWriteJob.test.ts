import { describe, expect, it } from 'vitest'

import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { createJenkinsTools, createJenkinsWriteJobTool, JenkinsClient } from './jenkins.js'
import { applyJobChanges, jobParameters } from './jenkinsConfig.js'
import { toolsForAccess } from './readOnly.js'

/*
 * Creating, copying and changing Jenkins jobs (asked for: "create jobs or modify jobs or clone from an
 * existing job and create a new job based on it, then ... give new parameters"), always asked about.
 */

const PIPELINE = `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job@1400.v7fd111b_ec82f">
  <description>Builds the service.</description>
  <keepDependencies>false</keepDependencies>
  <properties>
    <hudson.model.ParametersDefinitionProperty>
      <parameterDefinitions>
        <hudson.model.StringParameterDefinition>
          <name>BRANCH</name>
          <description>Branch to build</description>
          <defaultValue>main</defaultValue>
          <trim>false</trim>
        </hudson.model.StringParameterDefinition>
        <hudson.model.ChoiceParameterDefinition>
          <name>ENV</name>
          <description></description>
          <choices class="java.util.Arrays$ArrayList">
            <a class="string-array">
              <string>dev</string>
              <string>uat</string>
            </a>
          </choices>
        </hudson.model.ChoiceParameterDefinition>
      </parameterDefinitions>
    </hudson.model.ParametersDefinitionProperty>
  </properties>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps@3894">
    <scriptPath>Jenkinsfile</scriptPath>
  </definition>
  <disabled>false</disabled>
</flow-definition>
`

const FREESTYLE = `<?xml version='1.1' encoding='UTF-8'?>
<project>
  <description></description>
  <keepDependencies>false</keepDependencies>
  <properties/>
  <builders/>
</project>
`

describe('changing a job configuration', () => {
  it('adds, changes and removes parameters in Jenkins\' own elements, escaping values', () => {
    const { xml, notes } = applyJobChanges(PIPELINE, {
      parameters: {
        set: [
          { name: 'BRANCH', default: 'release/2.0' },
          { name: 'ENV', choices: ['dev', 'uat', 'prod'], default: 'uat' },
          { name: 'DRY_RUN', type: 'boolean', default: true, description: 'Do not deploy' },
          { name: 'NOTE', type: 'text', default: 'a < b & "c"' },
        ],
        remove: [],
      },
    })
    expect(notes).toEqual(['changed parameter BRANCH', 'changed parameter ENV', 'added parameter DRY_RUN', 'added parameter NOTE'])
    expect(jobParameters(xml)).toEqual([
      { name: 'BRANCH', type: 'string', default: 'release/2.0' },
      { name: 'ENV', type: 'choice', choices: ['uat', 'dev', 'prod'] },
      { name: 'DRY_RUN', type: 'boolean', default: 'true' },
      { name: 'NOTE', type: 'text', default: 'a < b & "c"' },
    ])
    expect(xml).toContain('<defaultValue>a &lt; b &amp; &quot;c&quot;</defaultValue>')
    // Only the parameter block changed; everything else is byte for byte as it was.
    expect(xml).toContain('<scriptPath>Jenkinsfile</scriptPath>')
    expect(xml.startsWith(PIPELINE.slice(0, PIPELINE.indexOf('<properties>')))).toBe(true)
    expect(xml.endsWith(PIPELINE.slice(PIPELINE.indexOf('  </properties>')))).toBe(true)
    // Keeps the description of a parameter that was only given a new default.
    expect(xml).toContain('<description>Branch to build</description>')

    const removed = applyJobChanges(xml, { parameters: { remove: ['NOTE'] } })
    expect(jobParameters(removed.xml).map((each) => each.name)).toEqual(['BRANCH', 'ENV', 'DRY_RUN'])
  })

  it('gives a job with no parameters its first one, from <properties/>', () => {
    const { xml } = applyJobChanges(FREESTYLE, { parameters: { set: [{ name: 'VERSION', default: '1.0' }] } })
    expect(jobParameters(xml)).toEqual([{ name: 'VERSION', type: 'string', default: '1.0' }])
    expect(xml).toContain('<builders/>')
  })

  it('makes exact text edits only when they match exactly once, and refuses rather than half-applying', () => {
    expect(applyJobChanges(PIPELINE, { edits: [{ find: '<scriptPath>Jenkinsfile</scriptPath>', replace: '<scriptPath>ci/Jenkinsfile.deploy</scriptPath>' }] }).xml).toContain(
      'ci/Jenkinsfile.deploy',
    )
    expect(() => applyJobChanges(PIPELINE, { edits: [{ find: '<nothing/>', replace: 'x' }] })).toThrow(/Not found/)
    expect(() => applyJobChanges(PIPELINE, { edits: [{ find: '<description>', replace: 'x' }] })).toThrow(/more than once/)
    expect(() => applyJobChanges(PIPELINE, { parameters: { remove: ['NOPE'] } })).toThrow(/no parameter "NOPE"/)
    expect(() => applyJobChanges(PIPELINE, { parameters: { set: [{ name: 'ENV', default: 'prod' }] } })).toThrow(/not one of the choices/)
  })
})

/** Jenkins, faked: job configs by path, createItem and config.xml POSTs recorded. */
function fakeJenkins(jobs: Record<string, string>) {
  const posts: { path: string; query: string; body: string }[] = []
  const http: HttpClient = {
    async request(url, options: HttpRequestOptions = {}) {
      const parsed = new URL(url)
      const method = options.method ?? 'GET'
      let status = 200
      let text = '{}'
      const configMatch = /^(.*)\/config\.xml$/.exec(parsed.pathname)
      const apiMatch = /^(.*)\/api\/json$/.exec(parsed.pathname)
      if (method === 'GET' && configMatch !== null) {
        const xml = jobs[configMatch[1] ?? '']
        if (xml === undefined) status = 404
        else text = xml
      } else if (method === 'GET' && apiMatch !== null) {
        if (jobs[apiMatch[1] ?? ''] === undefined) status = 404
      } else if (method === 'POST') {
        const body = String(options.body ?? '')
        posts.push({ path: parsed.pathname, query: parsed.search, body })
        if (configMatch !== null) jobs[configMatch[1] ?? ''] = body
        if (parsed.pathname.endsWith('/createItem')) jobs[`${parsed.pathname.slice(0, -'/createItem'.length)}/job/${encodeURIComponent(parsed.searchParams.get('name') ?? '')}`] = body
      } else status = 404
      const bytes = new TextEncoder().encode(text)
      const response: HttpResponse = {
        status,
        headers: {},
        text: async () => text,
        json: async <T>() => JSON.parse(text) as T,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        }),
      }
      return response
    },
  }
  return { posts, jobs, client: async () => new JenkinsClient(http, { baseUrl: 'https://ci.test', token: 'tok', username: 'jsmith' }) }
}

const context = {} as ToolExecutionContext

describe('jenkins_write_job', () => {
  it('copies a job into a new one with new parameters, showing the diff against the source first', async () => {
    const jenkins = fakeJenkins({ '/job/platform/job/api': PIPELINE, '/job/platform': '<folder/>' })
    const tool = createJenkinsWriteJobTool({ client: jenkins.client })
    const params = { action: 'copy' as const, job: 'platform/api-hotfix', from: 'platform/api', parameters: { set: [{ name: 'BRANCH', default: 'hotfix/1.2' }] } }
    const preview = await tool.preview!(params, context)
    expect(preview).toMatchObject({ kind: 'diff', path: 'https://ci.test/job/platform/job/api-hotfix/config.xml', before: PIPELINE })
    expect((preview as { note?: string }).note).toContain('copied from platform/api')
    expect((preview as { note?: string }).note).toContain('BRANCH (string = hotfix/1.2)')
    const result = await tool.execute(params, context)
    expect(result.isError).not.toBe(true)
    expect(jenkins.posts).toHaveLength(1)
    expect(jenkins.posts[0]).toMatchObject({ path: '/job/platform/createItem', query: '?name=api-hotfix' })
    expect(jenkins.posts[0]?.body).toBe((preview as { after: string }).after)
    // The source job is untouched.
    expect(jenkins.jobs['/job/platform/job/api']).toBe(PIPELINE)
  })

  it('never creates or copies over an existing job', async () => {
    const jenkins = fakeJenkins({ '/job/api': PIPELINE, '/job/api-copy': FREESTYLE })
    const tool = createJenkinsWriteJobTool({ client: jenkins.client })
    const result = await tool.execute({ action: 'copy', job: 'api-copy', from: 'api' }, context)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('already exists')
    expect(jenkins.posts).toEqual([])
  })

  it('refuses to save a change when the job was edited on Jenkins after the preview read it', async () => {
    const jenkins = fakeJenkins({ '/job/api': PIPELINE })
    const tool = createJenkinsWriteJobTool({ client: jenkins.client })
    const params = { action: 'update' as const, job: 'api', description: 'Builds and deploys the service.' }
    await tool.preview!(params, context)
    jenkins.jobs['/job/api'] = PIPELINE.replace('<disabled>false</disabled>', '<disabled>true</disabled>')
    const stale = await tool.execute(params, context)
    expect(stale.isError).toBe(true)
    expect(stale.content).toContain('changed on Jenkins after this was shown')
    expect(jenkins.posts).toEqual([])

    await tool.preview!(params, context)
    expect((await tool.execute(params, context)).isError).not.toBe(true)
    expect(jenkins.jobs['/job/api']).toContain('<description>Builds and deploys the service.</description>')
  })

  it('always asks - no "Always allow" - is never scheduled, and is hidden by "My access is read-only"', () => {
    expect(ALWAYS_ASK_TOOLS.has('jenkins_write_job')).toBe(true)
    expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain('jenkins_write_job')
    const all = createJenkinsTools({ client: async () => ({}) as JenkinsClient })
    expect(all.some((tool) => tool.name === 'jenkins_write_job')).toBe(true)
    expect(toolsForAccess(all, true, 'Jenkins').some((tool) => tool.name === 'jenkins_write_job')).toBe(false)
  })
})
