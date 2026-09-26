import { describe, expect, it } from 'vitest'

import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import { USER_SCOPE_ONLY_KEYS } from '../config/scopes.js'
import { buildExport, describeSections, SHARE_SECTIONS } from '../config/share.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import type { ToolExecutionContext } from '../tools/types.js'
import {
  BitbucketClient,
  createBitbucketReadFileTool,
  createBitbucketWritePullRequestTool,
  encodeRepoPath,
} from './bitbucket.js'
import { createJiraSearchTool, createJiraWriteIssueTool, findTransition, JiraClient } from './jira.js'
import { ATLASSIAN_PRODUCTS } from './products.js'
import { describeAtlassianFailure } from './rest.js'

interface Recorded {
  url: string
  options: HttpRequestOptions
}

/** A site that answers from a table keyed by "METHOD path-without-query". */
function fakeSite(routes: Record<string, { status?: number; json?: unknown; text?: string }>) {
  const calls: Recorded[] = []
  const http: HttpClient = {
    async request(url, options = {}) {
      calls.push({ url, options })
      const path = new URL(url).pathname
      const route = routes[`${options.method ?? 'GET'} ${path}`] ?? { status: 404, json: { errorMessages: ['no route'] } }
      const bytes = new TextEncoder().encode(route.text ?? JSON.stringify(route.json ?? {}))
      const response: HttpResponse = {
        status: route.status ?? 200,
        headers: {},
        text: async () => new TextDecoder().decode(bytes),
        json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
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
  return { http, calls }
}

const NO_CONTEXT = {} as unknown as ToolExecutionContext

const ISSUE = {
  key: 'ABC-7',
  fields: {
    summary: 'Login fails',
    description: 'old text',
    status: { name: 'Open' },
    issuetype: { name: 'Bug' },
    labels: ['auth'],
    comment: { comments: [] },
  },
}

describe('Jira', () => {
  it('searches words as text and passes JQL through untouched', async () => {
    const { http, calls } = fakeSite({ 'GET /rest/api/2/search': { json: { issues: [ISSUE] } } })
    const tool = createJiraSearchTool({ client: async () => new JiraClient(http, { baseUrl: 'https://jira.test', token: 't' }) })

    await tool.execute({ query: 'login "broken"', project: 'ABC' }, NO_CONTEXT)
    expect(new URL(calls[0]!.url).searchParams.get('jql')).toBe('project = "ABC" and text ~ "login \\"broken\\""')

    await tool.execute({ query: 'project = ABC and status = Open' }, NO_CONTEXT)
    expect(new URL(calls[1]!.url).searchParams.get('jql')).toBe('project = ABC and status = Open')
    expect(calls[0]!.options.headers?.['Authorization']).toBe('Bearer t')
  })

  it('previews an update against the live issue, including where the status would move', async () => {
    const { http } = fakeSite({
      'GET /rest/api/2/issue/ABC-7': { json: ISSUE },
      'GET /rest/api/2/issue/ABC-7/transitions': { json: { transitions: [{ id: '31', name: 'Start', to: { name: 'In Progress' } }] } },
    })
    const tool = createJiraWriteIssueTool({ client: async () => new JiraClient(http, { baseUrl: 'https://jira.test', token: 't' }) })
    const preview = await tool.preview?.({ issueKey: 'ABC-7', description: 'new text', transition: 'in progress' }, NO_CONTEXT)
    expect(preview).toMatchObject({ kind: 'diff', before: 'old text', after: 'new text' })
    expect(JSON.stringify(preview)).toContain('Open → In Progress')

    const impossible = await tool.preview?.({ issueKey: 'ABC-7', transition: 'Done' }, NO_CONTEXT)
    expect(JSON.stringify(impossible)).toContain('will be refused')
  })

  it('keeps the field edit when the comment fails, and says which part did not happen', async () => {
    const { http, calls } = fakeSite({
      'GET /rest/api/2/issue/ABC-7': { json: ISSUE },
      'PUT /rest/api/2/issue/ABC-7': { status: 204 },
      'POST /rest/api/2/issue/ABC-7/comment': { status: 403, json: { errorMessages: ['No comment permission'] } },
    })
    const tool = createJiraWriteIssueTool({ client: async () => new JiraClient(http, { baseUrl: 'https://jira.test', token: 't' }) })
    const result = await tool.execute({ issueKey: 'ABC-7', summary: 'Login fails on Safari', comment: 'hi' }, NO_CONTEXT)
    expect(calls.some((call) => call.options.method === 'PUT')).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Updated summary')
    expect(result.content).toContain('No comment permission')
  })

  it('creates in the default project, and says so to the model', async () => {
    const { http, calls } = fakeSite({ 'POST /rest/api/2/issue': { json: { key: 'ABC-8' } } })
    const tool = createJiraWriteIssueTool({
      client: async () => new JiraClient(http, { baseUrl: 'https://jira.test', token: 't' }),
      defaultProject: 'ABC',
    })
    expect(tool.description).toContain('project ABC')
    const result = await tool.execute({ summary: 'New thing' }, NO_CONTEXT)
    expect(result.content).toContain('Created ABC-8')
    expect(JSON.parse(String(calls[0]!.options.body))).toMatchObject({ fields: { project: { key: 'ABC' }, issuetype: { name: 'Task' } } })
  })

  it('matches a transition by the move or by where it leads', () => {
    const moves = [{ id: '1', name: 'Start progress', to: 'In Progress' }]
    expect(findTransition(moves, 'in progress')?.id).toBe('1')
    expect(findTransition(moves, 'START PROGRESS')?.id).toBe('1')
    expect(findTransition(moves, 'Done')).toBeUndefined()
  })

  it('reads Jira’s per-field errors into the message', () => {
    expect(describeAtlassianFailure('jira', 'creating', 400, JSON.stringify({ errors: { summary: 'You must specify a summary' } }))).toContain(
      'summary: You must specify a summary',
    )
  })
})

describe('Bitbucket', () => {
  it('reads a file at a ref, and never lets a path climb out of the repository', async () => {
    const { http, calls } = fakeSite({ 'GET /projects/PLAT/repos/api/raw/src/app.py': { text: 'print(1)\nprint(2)' } })
    const tool = createBitbucketReadFileTool({
      client: async () => new BitbucketClient(http, { baseUrl: 'https://git.test', token: 't' }),
      defaultProject: 'PLAT',
      defaultRepo: 'api',
    })
    const result = await tool.execute({ path: 'src/app.py', ref: 'feature/x' }, NO_CONTEXT)
    expect(result.content).toContain('    2  print(2)')
    expect(new URL(calls[0]!.url).searchParams.get('at')).toBe('feature/x')

    expect(() => encodeRepoPath('../../admin')).toThrow(/not a file path/)
    const escaped = await tool.execute({ path: 'a/../../x' }, NO_CONTEXT)
    expect(escaped.isError).toBe(true)
  })

  it('refuses a project or repository that could reshape the request path', async () => {
    const { http, calls } = fakeSite({})
    const tool = createBitbucketReadFileTool({ client: async () => new BitbucketClient(http, { baseUrl: 'https://git.test', token: 't' }) })
    const result = await tool.execute({ project: 'PLAT/../../x', repo: 'api', path: 'a' }, NO_CONTEXT)
    expect(result.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('asks which repository when none is given and none is configured', async () => {
    const { http } = fakeSite({})
    const tool = createBitbucketReadFileTool({ client: async () => new BitbucketClient(http, { baseUrl: 'https://git.test', token: 't' }) })
    const result = await tool.execute({ path: 'a' }, NO_CONTEXT)
    expect(result.content).toMatch(/Which repository/)
  })

  it('previews a comment as the literal text, on the pull request it names', async () => {
    const { http } = fakeSite({
      'GET /rest/api/1.0/projects/PLAT/repos/api/pull-requests/12': { json: { id: 12, title: 'Add retry' } },
    })
    const tool = createBitbucketWritePullRequestTool({
      client: async () => new BitbucketClient(http, { baseUrl: 'https://git.test', token: 't' }),
      defaultProject: 'PLAT',
      defaultRepo: 'api',
    })
    const preview = await tool.preview?.({ id: 12, comment: 'Looks good, one nit.' }, NO_CONTEXT)
    expect(JSON.stringify(preview)).toContain('#12 Add retry')
    expect(JSON.stringify(preview)).toContain('Looks good, one nit.')
  })

  /** Approving is the person's decision about somebody's work; commenting is the assistant's contribution. */
  it('has no way to approve, merge or decline', () => {
    const tool = createBitbucketWritePullRequestTool({ client: async () => ({}) as BitbucketClient })
    const fields = Object.keys((tool.parametersSchema as unknown as { shape: Record<string, unknown> }).shape)
    expect(fields.some((field) => /approve|merge|decline/i.test(field))).toBe(false)
  })
})

describe('the rules around them', () => {
  it('always asks before writing to Jira or Bitbucket', () => {
    expect(ALWAYS_ASK_TOOLS.has('jira_write_issue')).toBe(true)
    expect(ALWAYS_ASK_TOOLS.has('bitbucket_write_pull_request')).toBe(true)
  })

  it('cannot be set by a workspace', () => {
    for (const product of ATLASSIAN_PRODUCTS) expect(USER_SCOPE_ONLY_KEYS).toContain(product.id)
  })

  /** Shared together as one section, and every token named as something the colleague must enter. */
  it('exports all three as one section, naming each token but never including one', () => {
    const section = SHARE_SECTIONS.find((entry) => entry.id === 'atlassian')
    expect(section?.keys).toEqual(['confluence', 'jira', 'bitbucket'])
    const config = {
      confluence: { enabled: true, baseUrl: 'https://wiki.example.com', tokenRef: 'confluence:token' },
      jira: { enabled: true, baseUrl: 'https://jira.example.com', tokenRef: 'jira:token', defaultProject: 'ABC' },
    } as never
    const exported = buildExport(config, ['atlassian'])
    expect(JSON.stringify(exported)).toContain('"defaultProject":"ABC"')
    const summary = describeSections(config).find((entry) => entry.id === 'atlassian')
    expect(summary?.secretRefs).toEqual(['Confluence: personal access token', 'Jira: personal access token'])
  })
})
