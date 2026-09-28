import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PathDenylist } from '../fs/denylist.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { NodeFileSystem } from '../platform/node/filesystem.js'
import type { ToolExecutionContext } from '../tools/types.js'
import {
  createJiraProjectTool,
  createJiraReadIssueTool,
  createJiraWriteIssueTool,
  JiraClient,
} from './jira.js'

/**
 * Jira writes that do everything a person would ask for.
 *
 * Reported from real use: the assistant could not create an issue with an image or an attachment,
 * or set its component — the write tool knew five fields. These pin the rest: people, components,
 * versions, links, any field by id, files and drawn diagrams, and images read back.
 */

interface Recorded {
  method: string
  path: string
  options: HttpRequestOptions
}

type Route = { status?: number; json?: unknown; bytes?: Uint8Array }

function fakeJira(routes: Record<string, Route>) {
  const calls: Recorded[] = []
  const http: HttpClient = {
    async request(url, options = {}) {
      const { pathname } = new URL(url)
      const method = options.method ?? 'GET'
      calls.push({ method, path: pathname, options })
      const route = routes[`${method} ${pathname}`] ?? {
        status: 404,
        json: { errorMessages: [`no route for ${method} ${pathname}`] },
      }
      const bytes = route.bytes ?? new TextEncoder().encode(JSON.stringify(route.json ?? {}))
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
  const client = async (): Promise<JiraClient> =>
    new JiraClient(http, { baseUrl: 'https://jira.test', token: 't' })
  const bodyOf = (method: string, route: string): Record<string, unknown> =>
    JSON.parse(
      String(calls.find((call) => call.method === method && call.path === route)?.options.body),
    ) as Record<string, unknown>
  return { calls, client, bodyOf }
}

const roots: string[] = []

async function workspace(files: Record<string, string>): Promise<ToolExecutionContext> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-jira-')))
  roots.push(root)
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(root, name), content)
  return {
    fs: new NodeFileSystem(),
    workspaceRoot: root,
    denylist: new PathDenylist(),
    readFiles: new Set(),
  } as unknown as ToolExecutionContext
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const PROJECT = {
  'GET /rest/api/2/project/PAY': {
    json: {
      key: 'PAY',
      name: 'Payments',
      issueTypes: [
        { id: '1', name: 'Bug' },
        { id: '5', name: 'Sub-task', subtask: true },
      ],
    },
  },
  'GET /rest/api/2/project/PAY/components': { json: [{ name: 'Checkout' }, { name: 'Refunds' }] },
  'GET /rest/api/2/project/PAY/versions': { json: [{ name: '2.4', released: false }] },
}

describe('jira_write_issue', () => {
  it('creates an issue with components, an assignee, versions, a link, a custom field, a file and a diagram', async () => {
    const { calls, client, bodyOf } = fakeJira({
      ...PROJECT,
      'GET /rest/api/2/myself': { json: { name: 'jdoe', displayName: 'Jane Doe' } },
      'POST /rest/api/2/issue': { json: { key: 'PAY-9' } },
      'POST /rest/api/2/issue/PAY-9/attachments': { json: [{}] },
    })
    const context = await workspace({ 'screenshot.png': 'PNGDATA' })
    const tool = createJiraWriteIssueTool({ client, defaultProject: 'PAY' })

    const result = await tool.execute(
      {
        summary: 'Refund button does nothing',
        issueType: 'Bug',
        description: 'Clicking refund fails.\n\n!screenshot.png|width=600!',
        assignee: 'me',
        components: ['Refunds'],
        fixVersions: ['2.4'],
        dueDate: '2026-10-31',
        links: [{ type: 'Blocks', issueKey: 'PAY-3' }],
        fields: { customfield_10200: { value: 'Production' } },
        attachments: [{ path: 'screenshot.png' }],
        diagrams: [
          {
            name: 'flow',
            diagram: {
              nodes: [
                { id: 'a', label: 'Refund' },
                { id: 'b', label: 'Ledger' },
              ],
              edges: [{ from: 'a', to: 'b' }],
            },
          },
        ],
      },
      context,
    )

    expect(result.isError).not.toBe(true)
    expect(result.content).toContain('Created PAY-9')
    expect(result.content).toContain('Attached screenshot.png, flow.svg')
    expect(bodyOf('POST', '/rest/api/2/issue')).toEqual({
      fields: {
        project: { key: 'PAY' },
        issuetype: { name: 'Bug' },
        summary: 'Refund button does nothing',
        description: 'Clicking refund fails.\n\n!screenshot.png|width=600!',
        components: [{ name: 'Refunds' }],
        fixVersions: [{ name: '2.4' }],
        duedate: '2026-10-31',
        assignee: { name: 'jdoe' },
        customfield_10200: { value: 'Production' },
      },
      update: {
        issuelinks: [{ add: { type: { name: 'Blocks' }, outwardIssue: { key: 'PAY-3' } } }],
      },
    })

    const uploads = calls.filter((call) => call.path === '/rest/api/2/issue/PAY-9/attachments')
    expect(uploads).toHaveLength(2)
    expect(uploads[0]!.options.headers?.['X-Atlassian-Token']).toBe('no-check')
    const first = new TextDecoder().decode(uploads[0]!.options.bodyBytes)
    expect(first).toContain('filename="screenshot.png"')
    expect(first).toContain('PNGDATA')
    expect(new TextDecoder().decode(uploads[1]!.options.bodyBytes)).toContain('<svg')
  })

  it('lets `fields` win over a named parameter, and clears an assignee on request', async () => {
    const { client, bodyOf } = fakeJira({
      'GET /rest/api/2/issue/PAY-1': {
        json: { key: 'PAY-1', fields: { summary: 's', status: { name: 'Open' } } },
      },
      'PUT /rest/api/2/issue/PAY-1': { status: 204 },
    })
    const tool = createJiraWriteIssueTool({ client })
    const result = await tool.execute(
      {
        issueKey: 'PAY-1',
        priority: 'Low',
        assignee: 'unassigned',
        fields: { priority: { id: '2' } },
      },
      await workspace({}),
    )
    expect(result.content).toContain('Updated')
    expect(bodyOf('PUT', '/rest/api/2/issue/PAY-1')).toEqual({
      fields: { priority: { id: '2' }, assignee: { name: null } },
    })
  })

  it('names an unknown component and an ambiguous person in the preview, before approval', async () => {
    const { client } = fakeJira({
      ...PROJECT,
      'GET /rest/api/2/issue/PAY-1': {
        json: {
          key: 'PAY-1',
          fields: {
            summary: 's',
            status: { name: 'Open' },
            components: [{ name: 'Checkout' }],
            attachment: [{ filename: 'log.txt' }],
          },
        },
      },
      'GET /rest/api/2/user/search': {
        json: [
          { name: 'asmith', displayName: 'A Smith' },
          { name: 'asmyth', displayName: 'A Smyth' },
        ],
      },
    })
    const tool = createJiraWriteIssueTool({ client })
    const preview = await tool.preview?.(
      {
        issueKey: 'PAY-1',
        components: ['Checkout', 'Billing'],
        assignee: 'smith',
        attachments: [{ path: 'log.txt' }],
      },
      await workspace({ 'log.txt': 'boom' }),
    )
    const text = JSON.stringify(preview)
    expect(text).toContain('Components: [Checkout] → [Checkout, Billing]')
    expect(text).toContain('Component Billing not in PAY')
    expect(text).toContain('matches several Jira users')
    expect(text).toContain('Jira keeps both')
  })

  it('refuses a file outside the workspace before anything is written', async () => {
    const { calls, client } = fakeJira({ 'POST /rest/api/2/issue': { json: { key: 'PAY-9' } } })
    const tool = createJiraWriteIssueTool({ client, defaultProject: 'PAY' })
    const result = await tool.execute(
      { summary: 'x', attachments: [{ path: path.join(os.homedir(), '.ssh', 'id_rsa') }] },
      await workspace({}),
    )
    expect(result.isError).toBe(true)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })
})

describe('jira_read_issue', () => {
  it('shows every field, and the attached images when asked — only from this site', async () => {
    const { calls, client } = fakeJira({
      'GET /rest/api/2/issue/PAY-2': {
        json: {
          key: 'PAY-2',
          names: { customfield_10200: 'Environment tier' },
          fields: {
            summary: 'Broken',
            status: { name: 'Open' },
            components: [{ name: 'Checkout' }],
            customfield_10200: { value: 'Production' },
            attachment: [
              {
                filename: 'shot.png',
                mimeType: 'image/png',
                size: 4,
                content: 'https://jira.test/secure/attachment/1/shot.png',
              },
              {
                filename: 'evil.png',
                mimeType: 'image/png',
                size: 4,
                content: 'https://elsewhere.test/evil.png',
              },
            ],
          },
        },
      },
      'GET /rest/api/2/issue/PAY-2/transitions': { json: { transitions: [] } },
      'GET /secure/attachment/1/shot.png': { bytes: new Uint8Array([1, 2, 3, 4]) },
    })
    const result = await createJiraReadIssueTool({ client }).execute(
      { issueKey: 'PAY-2', images: true },
      {} as ToolExecutionContext,
    )
    expect(result.content).toContain('Components: Checkout')
    expect(result.content).toContain('Environment tier (customfield_10200): Production')
    expect(result.images).toEqual([
      {
        label: 'shot.png',
        mediaType: 'image/png',
        data: Buffer.from([1, 2, 3, 4]).toString('base64'),
      },
    ])
    expect(result.content).toContain('evil.png (Refused to fetch')
    expect(calls.some((call) => call.path.includes('evil'))).toBe(false)
  })
})

describe('jira_project', () => {
  it('lists components, versions and the fields a new issue takes, custom ones with allowed values', async () => {
    const { client } = fakeJira({
      ...PROJECT,
      'GET /rest/api/2/issue/createmeta/PAY/issuetypes/1': {
        json: {
          values: [
            { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
            {
              fieldId: 'customfield_10200',
              name: 'Environment tier',
              required: false,
              schema: { type: 'option' },
              allowedValues: [{ value: 'Production' }, { value: 'Staging' }],
            },
          ],
        },
      },
    })
    const result = await createJiraProjectTool({ client, defaultProject: 'PAY' }).execute(
      { issueType: 'bug' },
      {} as ToolExecutionContext,
    )
    expect(result.content).toContain('Components: Checkout, Refunds')
    expect(result.content).toContain('- Summary [summary] REQUIRED')
    expect(result.content).toContain(
      'Environment tier [customfield_10200]: option, set as {"value": "…"} — one of: Production, Staging',
    )
  })
})
