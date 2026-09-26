import { z } from 'zod'

import type { HttpClient } from '../platform/http.js'
import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import { AtlassianError, AtlassianRest, type AtlassianConnection } from './rest.js'

/**
 * Jira Data Center / Server: searching, reading and writing issues with a personal access token.
 *
 * ## Three tools
 *
 * `jira_search`, `jira_read_issue`, and `jira_write_issue` — which creates an issue, or updates one
 * given its key, and can add a comment and move its status in the same call. Create, edit, comment
 * and transition are one act to a person ("log this", "move it to review with a note"), and §17
 * prefers fewer, more general tools.
 *
 * ## What the approval shows (invariant 8)
 *
 * `jira_write_issue` is `edit` and in `ALWAYS_ASK_TOOLS`: it changes a shared tracker under the
 * user's name. The preview is computed — an update fetches the issue *now* and diffs the
 * description, lists every other field that changes from what to what, the literal comment, and the
 * status transition with where it goes. A transition that does not exist from the current status is
 * said to be impossible in the preview rather than discovered after approval.
 */

// -------------------------------------------------------------------------------------------------
// Client

export interface JiraIssueSummary {
  key: string
  summary: string
  status: string
  type: string
  assignee: string | undefined
  priority: string | undefined
  updated: string | undefined
  url: string
}

export interface JiraIssue extends JiraIssueSummary {
  description: string
  reporter: string | undefined
  labels: string[]
  created: string | undefined
  comments: { author: string; created: string; body: string }[]
}

interface RawIssue {
  key?: string
  fields?: {
    summary?: string
    description?: string | null
    status?: { name?: string }
    issuetype?: { name?: string }
    assignee?: { displayName?: string } | null
    reporter?: { displayName?: string } | null
    priority?: { name?: string } | null
    labels?: string[]
    created?: string
    updated?: string
    comment?: { comments?: { author?: { displayName?: string }; created?: string; body?: string }[] }
  }
}

/** Issue keys look like `ABC-123`. Checked so a model-supplied key never reaches a path unshaped. */
export function isIssueKey(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)
}

export class JiraClient {
  private readonly rest: AtlassianRest

  constructor(http: HttpClient, connection: AtlassianConnection) {
    this.rest = new AtlassianRest(http, 'jira', connection)
  }

  async currentUser(signal?: AbortSignal): Promise<string> {
    const me = await this.rest.json<{ displayName?: string; name?: string }>('reading the current user', '/rest/api/2/myself', { method: 'GET' }, signal)
    return me.displayName ?? me.name ?? 'an unnamed user'
  }

  async search(jql: string, limit: number, signal?: AbortSignal): Promise<JiraIssueSummary[]> {
    const query = new URLSearchParams({
      jql,
      maxResults: String(limit),
      fields: 'summary,status,issuetype,assignee,priority,updated',
    })
    const result = await this.rest.json<{ issues?: RawIssue[] }>('searching', `/rest/api/2/search?${query.toString()}`, { method: 'GET' }, signal)
    return (result.issues ?? []).map((raw) => this.summary(raw))
  }

  async getIssue(key: string, signal?: AbortSignal): Promise<JiraIssue> {
    if (!isIssueKey(key)) throw new AtlassianError(`"${key}" is not an issue key — those look like ABC-123.`)
    const fields = 'summary,description,status,issuetype,assignee,reporter,priority,labels,created,updated,comment'
    const raw = await this.rest.json<RawIssue>(`reading ${key}`, `/rest/api/2/issue/${key}?fields=${fields}`, { method: 'GET' }, signal)
    return {
      ...this.summary(raw),
      description: raw.fields?.description ?? '',
      reporter: raw.fields?.reporter?.displayName,
      labels: raw.fields?.labels ?? [],
      created: raw.fields?.created,
      comments: (raw.fields?.comment?.comments ?? []).map((comment) => ({
        author: comment.author?.displayName ?? 'someone',
        created: comment.created ?? '',
        body: comment.body ?? '',
      })),
    }
  }

  async createIssue(
    issue: { project: string; type: string; summary: string; description?: string; labels?: string[]; priority?: string },
    signal?: AbortSignal,
  ): Promise<{ key: string; url: string }> {
    const created = await this.rest.json<{ key?: string }>(
      `creating "${issue.summary}"`,
      '/rest/api/2/issue',
      {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            project: { key: issue.project },
            issuetype: { name: issue.type },
            summary: issue.summary,
            ...(issue.description !== undefined ? { description: issue.description } : {}),
            ...(issue.labels !== undefined ? { labels: issue.labels } : {}),
            ...(issue.priority !== undefined ? { priority: { name: issue.priority } } : {}),
          },
        }),
      },
      signal,
    )
    const key = created.key ?? ''
    return { key, url: this.rest.url(`/browse/${key}`) }
  }

  async updateIssue(
    key: string,
    fields: { summary?: string; description?: string; labels?: string[]; priority?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.rest.json(
      `updating ${key}`,
      `/rest/api/2/issue/${key}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          fields: {
            ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
            ...(fields.description !== undefined ? { description: fields.description } : {}),
            ...(fields.labels !== undefined ? { labels: fields.labels } : {}),
            ...(fields.priority !== undefined ? { priority: { name: fields.priority } } : {}),
          },
        }),
      },
      signal,
    )
  }

  async addComment(key: string, body: string, signal?: AbortSignal): Promise<void> {
    await this.rest.json(`commenting on ${key}`, `/rest/api/2/issue/${key}/comment`, { method: 'POST', body: JSON.stringify({ body }) }, signal)
  }

  async transitions(key: string, signal?: AbortSignal): Promise<{ id: string; name: string; to: string }[]> {
    const result = await this.rest.json<{ transitions?: { id?: string; name?: string; to?: { name?: string } }[] }>(
      `reading the transitions of ${key}`,
      `/rest/api/2/issue/${key}/transitions`,
      { method: 'GET' },
      signal,
    )
    return (result.transitions ?? []).map((transition) => ({
      id: transition.id ?? '',
      name: transition.name ?? '',
      to: transition.to?.name ?? transition.name ?? '',
    }))
  }

  async transition(key: string, id: string, signal?: AbortSignal): Promise<void> {
    await this.rest.json(`moving ${key}`, `/rest/api/2/issue/${key}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id } }) }, signal)
  }

  private summary(raw: RawIssue): JiraIssueSummary {
    const key = raw.key ?? ''
    return {
      key,
      summary: raw.fields?.summary ?? '',
      status: raw.fields?.status?.name ?? '?',
      type: raw.fields?.issuetype?.name ?? '?',
      assignee: raw.fields?.assignee?.displayName ?? undefined,
      priority: raw.fields?.priority?.name ?? undefined,
      updated: raw.fields?.updated,
      url: this.rest.url(`/browse/${key}`),
    }
  }
}

/** A transition named by the model, matched against the move's name or the status it leads to. */
export function findTransition(
  available: readonly { id: string; name: string; to: string }[],
  wanted: string,
): { id: string; name: string; to: string } | undefined {
  const needle = wanted.trim().toLowerCase()
  return available.find((transition) => transition.name.toLowerCase() === needle || transition.to.toLowerCase() === needle)
}

// -------------------------------------------------------------------------------------------------
// Tools

export interface JiraToolOptions {
  client: () => Promise<JiraClient>
  defaultProject?: string | undefined
}

function errorResult(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true }
}

const searchSchema = z.object({
  query: z.string().min(1).describe('Words to look for, or a full JQL query (e.g. `project = ABC and status = "In Progress"`).'),
  project: z.string().optional().describe('Limit to one project key. Ignored when `query` is already JQL.'),
  limit: z.number().int().min(1).max(50).optional().describe('How many results. Default 15.'),
})

/** Treated as JQL when it uses JQL's operators; otherwise searched as text. */
function toJql(query: string, project: string | undefined): string {
  if (/[=~<>]|\b(order by|in|is)\b/i.test(query)) return query
  const text = `text ~ "${query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return project !== undefined && project.trim().length > 0 ? `project = "${project.trim()}" and ${text}` : text
}

export function createJiraSearchTool(options: JiraToolOptions): Tool<z.infer<typeof searchSchema>> {
  return {
    name: 'jira_search',
    group: 'read',
    description:
      'Search Jira issues by words or JQL. Returns keys, summaries, status, assignee and links. Use ' +
      'it before creating an issue, so a duplicate is not logged.',
    parametersSchema: searchSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const issues = await (await options.client()).search(toJql(params.query, params.project), params.limit ?? 15)
        if (issues.length === 0) return { content: `No Jira issues match: ${params.query}` }
        return {
          content: [
            `${String(issues.length)} issue(s):`,
            ...issues.map(
              (issue) =>
                `- ${issue.key} [${issue.status}] ${issue.summary}  (${issue.type}${issue.assignee !== undefined ? `, ${issue.assignee}` : ', unassigned'})  ${issue.url}`,
            ),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const readSchema = z.object({
  issueKey: z.string().min(1).describe('The issue key, e.g. ABC-123.'),
})

export function createJiraReadIssueTool(options: JiraToolOptions): Tool<z.infer<typeof readSchema>> {
  return {
    name: 'jira_read_issue',
    group: 'read',
    description: 'Read a Jira issue: summary, status, type, people, labels, description, comments, and the status moves available now.',
    parametersSchema: readSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const issue = await client.getIssue(params.issueKey.trim())
        const moves = await client.transitions(issue.key).catch(() => [])
        return {
          content: [
            `${issue.key}: ${issue.summary}`,
            `Status: ${issue.status}   Type: ${issue.type}   Priority: ${issue.priority ?? '—'}`,
            `Assignee: ${issue.assignee ?? 'unassigned'}   Reporter: ${issue.reporter ?? '—'}`,
            ...(issue.labels.length > 0 ? [`Labels: ${issue.labels.join(', ')}`] : []),
            `Link: ${issue.url}`,
            ...(moves.length > 0 ? [`Can move to: ${moves.map((move) => move.to).join(', ')}`] : []),
            '',
            'Description:',
            issue.description.length > 0 ? issue.description : '(none)',
            '',
            issue.comments.length === 0
              ? 'No comments.'
              : `Comments (${String(issue.comments.length)}):\n${issue.comments
                  .map((comment) => `--- ${comment.author}, ${comment.created}\n${comment.body}`)
                  .join('\n')}`,
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const writeSchema = z.object({
  issueKey: z.string().optional().describe('Update this issue. Omit to create a new one.'),
  project: z.string().optional().describe('Project key for a new issue. Defaults to the configured project.'),
  issueType: z.string().optional().describe('For a new issue: Task, Bug, Story… Default Task.'),
  summary: z.string().min(1).max(255).optional().describe('Required for a new issue.'),
  description: z.string().optional().describe('Jira wiki markup: h2. headings, *bold*, {code}…{code}, bullet lines starting "* ".'),
  labels: z.array(z.string()).optional().describe('Replaces the labels.'),
  priority: z.string().optional().describe('A priority name, e.g. High.'),
  comment: z.string().optional().describe('A comment to add.'),
  transition: z.string().optional().describe('Move the issue: the target status or the move\'s name, e.g. "In Review".'),
})
type WriteParams = z.infer<typeof writeSchema>

export function createJiraWriteIssueTool(options: JiraToolOptions): Tool<WriteParams> {
  return {
    name: 'jira_write_issue',
    group: 'edit',
    description:
      'Create a Jira issue, or update one given its key: change summary, description, labels or ' +
      'priority, add a comment, and move its status — any of these in one call. Search first so ' +
      'nothing is logged twice. Always shown to the user before anything changes.' +
      (options.defaultProject !== undefined
        ? ` New issues go to project ${options.defaultProject} unless the user asks for another — leave project out for that.`
        : ' No default project is configured, so a new issue needs a project key; ask the user if they have not given one.'),
    parametersSchema: writeSchema,

    async preview(params): Promise<ToolPreview> {
      const client = await options.client()
      if (params.issueKey === undefined) {
        return {
          kind: 'text',
          text: [
            `New ${params.issueType ?? 'Task'} in ${params.project ?? options.defaultProject ?? '(no project given)'}`,
            `Summary: ${params.summary ?? '(missing — this will be refused)'}`,
            ...(params.priority !== undefined ? [`Priority: ${params.priority}`] : []),
            ...(params.labels !== undefined ? [`Labels: ${params.labels.join(', ')}`] : []),
            '',
            params.description ?? '(no description)',
            ...(params.comment !== undefined ? ['', 'Comment:', params.comment] : []),
          ].join('\n'),
        }
      }
      // The issue as it is now, so what is approved is a change to what is actually there.
      const current = await client.getIssue(params.issueKey.trim())
      const notes: string[] = []
      if (params.summary !== undefined && params.summary !== current.summary) notes.push(`Summary: "${current.summary}" → "${params.summary}"`)
      if (params.labels !== undefined) notes.push(`Labels: [${current.labels.join(', ')}] → [${params.labels.join(', ')}]`)
      if (params.priority !== undefined) notes.push(`Priority: ${current.priority ?? '—'} → ${params.priority}`)
      if (params.transition !== undefined) {
        const move = findTransition(await client.transitions(current.key).catch(() => []), params.transition)
        notes.push(
          move !== undefined
            ? `Status: ${current.status} → ${move.to}`
            : `Status: no move to "${params.transition}" exists from ${current.status} — this part will be refused.`,
        )
      }
      if (params.comment !== undefined) notes.push(`Comment:\n${params.comment}`)
      const title = `Jira: ${current.key} ${current.summary} (${current.url})`
      if (params.description !== undefined) {
        return { kind: 'diff', path: title, before: current.description, after: params.description, note: notes.join('\n') }
      }
      return { kind: 'text', text: [title, '', ...(notes.length > 0 ? notes : ['Nothing would change.'])].join('\n') }
    },

    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        let key: string
        let url: string
        const done: string[] = []
        if (params.issueKey === undefined) {
          const project = params.project ?? options.defaultProject
          if (project === undefined) return { content: 'No project was given and no default project is configured.', isError: true }
          if (params.summary === undefined) return { content: 'A new issue needs a summary.', isError: true }
          const created = await client.createIssue({
            project,
            type: params.issueType ?? 'Task',
            summary: params.summary,
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.labels !== undefined ? { labels: params.labels } : {}),
            ...(params.priority !== undefined ? { priority: params.priority } : {}),
          })
          key = created.key
          url = created.url
          done.push(`Created ${key}.`)
        } else {
          const current = await client.getIssue(params.issueKey.trim())
          key = current.key
          url = current.url
          const fields = {
            ...(params.summary !== undefined ? { summary: params.summary } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.labels !== undefined ? { labels: params.labels } : {}),
            ...(params.priority !== undefined ? { priority: params.priority } : {}),
          }
          if (Object.keys(fields).length > 0) {
            await client.updateIssue(key, fields)
            done.push(`Updated ${Object.keys(fields).join(', ')}.`)
          }
        }
        // After the fields, so a failed comment or move is reported without undoing the edit.
        const failed: string[] = []
        if (params.comment !== undefined) {
          try {
            await client.addComment(key, params.comment)
            done.push('Comment added.')
          } catch (error) {
            failed.push(`Comment: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (params.transition !== undefined) {
          const available = await client.transitions(key).catch(() => [])
          const move = findTransition(available, params.transition)
          if (move === undefined) {
            failed.push(`No move to "${params.transition}" from here. Available: ${available.map((entry) => entry.to).join(', ') || 'none'}.`)
          } else {
            try {
              await client.transition(key, move.id)
              done.push(`Moved to ${move.to}.`)
            } catch (error) {
              failed.push(`Move: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        return {
          content: [`${key}: ${done.join(' ') || 'Nothing changed.'}`, `Link: ${url}`, ...(failed.length > 0 ? ['Not done:', ...failed.map((line) => `- ${line}`)] : [])].join('\n'),
          ...(failed.length > 0 ? { isError: true } : {}),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}
