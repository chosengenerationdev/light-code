import { z } from 'zod'

import type { HttpClient } from '../platform/http.js'
import type { Tool, ToolExecutionContext, ToolPreview, ToolResult } from '../tools/types.js'
import { AtlassianError, AtlassianRest, type AtlassianConnection } from './rest.js'
import {
  attachmentsSchema,
  describeUploads,
  diagramsSchema,
  formatSize,
  isSafeAttachmentName,
  multipartBody,
  prepareUploads,
  type PreparedFile,
} from './uploads.js'

/**
 * Jira Data Center / Server: searching, reading and writing issues with a personal access token.
 *
 * ## Four tools
 *
 * `jira_search`, `jira_read_issue`, `jira_project` (what a project accepts: issue types,
 * components, versions, and every field a new issue takes, custom ones included), and
 * `jira_write_issue` — which creates an issue or updates one given its key, and in the same call can
 * set any field, attach files and drawn diagrams, link issues, add a comment and move its status.
 * Those are one act to a person ("log this bug with the screenshot, component Payments, assign it
 * to me"), and §17 prefers fewer, more general tools.
 *
 * ## Nothing is held back from the write
 *
 * Reported from real use: an issue could not be created with an image, an attachment or a
 * component, because the tool knew five fields and nothing else. So the common fields are named
 * parameters, and `fields` passes anything else through to Jira as written — a custom field, an
 * epic link, a field this code has never heard of. `jira_project` is how the model learns the ids
 * and allowed values for those, rather than guessing.
 *
 * ## What the approval shows (invariant 8)
 *
 * `jira_write_issue` is `edit` and in `ALWAYS_ASK_TOOLS`: it changes a shared tracker under the
 * user's name. The preview is computed — an update fetches the issue *now* and diffs the
 * description, lists every other field that changes from what to what, the literal comment, every
 * file with its source and size, each link, and the status transition with where it goes. A
 * component or person Jira does not know, and a transition that does not exist from the current
 * status, is said to be refused in the preview rather than discovered after approval.
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

export interface JiraAttachment {
  id: string
  name: string
  mediaType: string
  size: number
  /** Absolute URL, as Jira reports it. Fetched only when it is on this site. */
  content: string
}

export interface JiraIssue extends JiraIssueSummary {
  description: string
  reporter: string | undefined
  labels: string[]
  components: string[]
  fixVersions: string[]
  affectsVersions: string[]
  dueDate: string | undefined
  parent: string | undefined
  subtasks: string[]
  links: string[]
  attachments: JiraAttachment[]
  /** Custom and other fields with a value, by display name. */
  otherFields: { name: string; value: string }[]
  created: string | undefined
  comments: { author: string; created: string; body: string }[]
}

type Named = { name?: string; value?: string; displayName?: string; key?: string } | null | undefined

interface RawIssue {
  key?: string
  names?: Record<string, string>
  fields?: Record<string, unknown> & {
    summary?: string
    description?: string | null
    status?: { name?: string }
    issuetype?: { name?: string }
    assignee?: { displayName?: string; name?: string } | null
    reporter?: { displayName?: string } | null
    priority?: { name?: string } | null
    labels?: string[]
    components?: { name?: string }[]
    fixVersions?: { name?: string }[]
    versions?: { name?: string }[]
    duedate?: string | null
    parent?: { key?: string; fields?: { summary?: string } } | null
    subtasks?: { key?: string; fields?: { summary?: string; status?: { name?: string } } }[]
    issuelinks?: {
      type?: { inward?: string; outward?: string }
      inwardIssue?: { key?: string; fields?: { summary?: string } }
      outwardIssue?: { key?: string; fields?: { summary?: string } }
    }[]
    attachment?: { id?: string; filename?: string; mimeType?: string; size?: number; content?: string }[]
    created?: string
    updated?: string
    comment?: { comments?: { author?: { displayName?: string }; created?: string; body?: string }[] }
  }
}

/** Fields rendered by name elsewhere in `jira_read_issue`, so they are not listed twice. */
const SHOWN_FIELDS = new Set([
  'summary', 'description', 'status', 'issuetype', 'assignee', 'reporter', 'priority', 'labels',
  'components', 'fixVersions', 'versions', 'duedate', 'parent', 'subtasks', 'issuelinks', 'attachment',
  'created', 'updated', 'comment', 'project', 'watches', 'votes', 'worklog', 'timetracking',
  'lastViewed', 'creator', 'aggregateprogress', 'progress', 'workratio', 'statuscategorychangedate',
  'resolutiondate', 'aggregatetimespent', 'aggregatetimeoriginalestimate', 'aggregatetimeestimate',
  'timespent', 'timeestimate', 'timeoriginalestimate', 'thumbnail',
])

/** Issue keys look like `ABC-123`. Checked so a model-supplied key never reaches a path unshaped. */
export function isIssueKey(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)
}

/** Project keys: letters, digits and underscores. Same reason as `isIssueKey`. */
export function isProjectKey(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(key)
}

/** A field value as one readable line: names for objects, lists joined, nothing for empty. */
function renderValue(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (Array.isArray(value)) {
    const parts = value.map(renderValue).filter((part): part is string => part !== undefined)
    return parts.length > 0 ? parts.join(', ') : undefined
  }
  if (typeof value === 'object') {
    const named = value as Named & Record<string, unknown>
    const label = named?.displayName ?? named?.name ?? named?.value ?? named?.key
    if (typeof label === 'string') return label
    const json = JSON.stringify(value)
    return json === '{}' ? undefined : json.slice(0, 300)
  }
  return String(value).slice(0, 500)
}

export class JiraClient {
  private readonly rest: AtlassianRest

  constructor(http: HttpClient, connection: AtlassianConnection) {
    this.rest = new AtlassianRest(http, 'jira', connection)
  }

  async currentUser(signal?: AbortSignal): Promise<string> {
    const me = await this.me(signal)
    return me.displayName ?? me.name ?? 'an unnamed user'
  }

  private async me(signal?: AbortSignal): Promise<{ displayName?: string; name?: string }> {
    return this.rest.json('reading the current user', '/rest/api/2/myself', { method: 'GET' }, signal)
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
    // Every field, with display names, so a custom field is readable rather than `customfield_10010`.
    const raw = await this.rest.json<RawIssue>(`reading ${key}`, `/rest/api/2/issue/${key}?fields=*all&expand=names`, { method: 'GET' }, signal)
    const fields = raw.fields ?? {}
    const names = raw.names ?? {}
    const otherFields: { name: string; value: string }[] = []
    for (const [id, value] of Object.entries(fields)) {
      if (SHOWN_FIELDS.has(id)) continue
      const rendered = renderValue(value)
      if (rendered === undefined) continue
      otherFields.push({ name: names[id] !== undefined ? `${names[id]} (${id})` : id, value: rendered })
    }
    return {
      ...this.summary(raw),
      description: fields.description ?? '',
      reporter: fields.reporter?.displayName,
      labels: fields.labels ?? [],
      components: (fields.components ?? []).map((entry) => entry.name ?? '').filter((name) => name.length > 0),
      fixVersions: (fields.fixVersions ?? []).map((entry) => entry.name ?? '').filter((name) => name.length > 0),
      affectsVersions: (fields.versions ?? []).map((entry) => entry.name ?? '').filter((name) => name.length > 0),
      dueDate: fields.duedate ?? undefined,
      parent: fields.parent?.key !== undefined ? `${fields.parent.key} ${fields.parent.fields?.summary ?? ''}`.trim() : undefined,
      subtasks: (fields.subtasks ?? []).map(
        (task) => `${task.key ?? '?'} [${task.fields?.status?.name ?? '?'}] ${task.fields?.summary ?? ''}`.trim(),
      ),
      links: (fields.issuelinks ?? []).map((link) =>
        link.outwardIssue !== undefined
          ? `${link.type?.outward ?? 'relates to'} ${link.outwardIssue.key ?? '?'} ${link.outwardIssue.fields?.summary ?? ''}`.trim()
          : `${link.type?.inward ?? 'relates to'} ${link.inwardIssue?.key ?? '?'} ${link.inwardIssue?.fields?.summary ?? ''}`.trim(),
      ),
      attachments: (fields.attachment ?? []).map((entry) => ({
        id: entry.id ?? '',
        name: entry.filename ?? '',
        mediaType: entry.mimeType ?? 'application/octet-stream',
        size: entry.size ?? 0,
        content: entry.content ?? '',
      })),
      otherFields,
      created: fields.created,
      comments: (fields.comment?.comments ?? []).map((comment) => ({
        author: comment.author?.displayName ?? 'someone',
        created: comment.created ?? '',
        body: comment.body ?? '',
      })),
    }
  }

  async createIssue(
    fields: Record<string, unknown>,
    update: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<{ key: string; url: string }> {
    const created = await this.rest.json<{ key?: string }>(
      `creating "${String(fields['summary'] ?? 'an issue')}"`,
      '/rest/api/2/issue',
      { method: 'POST', body: JSON.stringify({ fields, ...(update !== undefined ? { update } : {}) }) },
      signal,
    )
    const key = created.key ?? ''
    return { key, url: this.rest.url(`/browse/${key}`) }
  }

  async updateIssue(
    key: string,
    fields: Record<string, unknown>,
    update: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.rest.json(
      `updating ${key}`,
      `/rest/api/2/issue/${key}`,
      { method: 'PUT', body: JSON.stringify({ fields, ...(update !== undefined ? { update } : {}) }) },
      signal,
    )
  }

  /** Jira keeps every upload, so attaching a name twice gives two attachments rather than a replacement. */
  async attach(key: string, file: { name: string; bytes: Uint8Array; contentType?: string | undefined }, signal?: AbortSignal): Promise<void> {
    if (!isSafeAttachmentName(file.name)) {
      throw new AtlassianError(`"${file.name}" cannot be used as an attachment name: letters, digits, spaces, ".", "_", "-" and brackets only.`)
    }
    const body = multipartBody(file)
    await this.rest.send(
      `attaching ${file.name} to ${key}`,
      `/rest/api/2/issue/${key}/attachments`,
      {
        method: 'POST',
        // Required for any multipart write, or Jira refuses it as a possible CSRF.
        headers: { 'Content-Type': body.contentType, 'X-Atlassian-Token': 'no-check' },
        bodyBytes: body.bytes,
      },
      signal,
    )
  }

  /**
   * An attachment's bytes. Jira reports its link as an absolute URL, so it is fetched only when it
   * is on *this* site — a link elsewhere would carry the token with it.
   */
  async download(attachment: JiraAttachment, signal?: AbortSignal): Promise<Buffer> {
    const prefix = `${this.rest.base}/`
    if (!attachment.content.startsWith(prefix)) {
      throw new AtlassianError(`Refused to fetch ${attachment.name}: its link is not on ${this.rest.base}.`)
    }
    return this.rest.bytes(`downloading ${attachment.name}`, attachment.content.slice(this.rest.base.length), signal)
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

  /**
   * A person, as Jira's `name` (the username Data Center assigns by).
   *
   * Accepts `me`, a username, a display name or an email, because the model is given whichever of
   * those the user said. An ambiguous answer is refused with the candidates named, rather than
   * assigning the first — the wrong colleague is not a mistake anybody notices quickly.
   */
  async resolveUser(query: string, signal?: AbortSignal): Promise<{ name: string; displayName: string }> {
    const wanted = query.trim()
    if (wanted.toLowerCase() === 'me' || wanted.toLowerCase() === 'myself') {
      const me = await this.me(signal)
      return { name: me.name ?? '', displayName: me.displayName ?? me.name ?? 'you' }
    }
    const found = await this.rest.json<{ name?: string; displayName?: string; emailAddress?: string; active?: boolean }[]>(
      `looking up "${wanted}"`,
      `/rest/api/2/user/search?${new URLSearchParams({ username: wanted, maxResults: '20' }).toString()}`,
      { method: 'GET' },
      signal,
    )
    const people = found.filter((person) => person.active !== false && person.name !== undefined)
    const needle = wanted.toLowerCase()
    const exact = people.filter(
      (person) =>
        person.name?.toLowerCase() === needle ||
        person.displayName?.toLowerCase() === needle ||
        person.emailAddress?.toLowerCase() === needle,
    )
    const chosen = exact.length === 1 ? exact[0] : people.length === 1 ? people[0] : undefined
    if (chosen !== undefined) return { name: chosen.name ?? '', displayName: chosen.displayName ?? chosen.name ?? wanted }
    if (people.length === 0) throw new AtlassianError(`No Jira user matches "${wanted}".`)
    throw new AtlassianError(
      `"${wanted}" matches several Jira users: ${people
        .slice(0, 8)
        .map((person) => `${person.displayName ?? '?'} (${person.name ?? '?'})`)
        .join(', ')}. Give the username.`,
    )
  }

  async project(key: string, signal?: AbortSignal): Promise<{
    key: string
    name: string
    issueTypes: { id: string; name: string; subtask: boolean }[]
    components: string[]
    versions: { name: string; released: boolean }[]
  }> {
    if (!isProjectKey(key)) throw new AtlassianError(`"${key}" is not a project key.`)
    const project = await this.rest.json<{ key?: string; name?: string; issueTypes?: { id?: string; name?: string; subtask?: boolean }[] }>(
      `reading project ${key}`,
      `/rest/api/2/project/${key}`,
      { method: 'GET' },
      signal,
    )
    const components = await this.rest
      .json<{ name?: string }[]>(`reading the components of ${key}`, `/rest/api/2/project/${key}/components`, { method: 'GET' }, signal)
      .catch(() => [])
    const versions = await this.rest
      .json<{ name?: string; released?: boolean; archived?: boolean }[]>(`reading the versions of ${key}`, `/rest/api/2/project/${key}/versions`, { method: 'GET' }, signal)
      .catch(() => [])
    return {
      key: project.key ?? key,
      name: project.name ?? key,
      issueTypes: (project.issueTypes ?? []).map((type) => ({ id: type.id ?? '', name: type.name ?? '', subtask: type.subtask === true })),
      components: components.map((component) => component.name ?? '').filter((name) => name.length > 0),
      versions: versions
        .filter((version) => version.archived !== true)
        .map((version) => ({ name: version.name ?? '', released: version.released === true })),
    }
  }

  /**
   * The fields a new issue of one type takes. Tries the per-type endpoint Data Center 8.4+ has, and
   * falls back to the older `createmeta` expansion, which 9.x still answers.
   */
  async createFields(projectKey: string, issueType: { id: string; name: string }, signal?: AbortSignal): Promise<JiraFieldInfo[]> {
    try {
      const result = await this.rest.json<{
        values?: { fieldId?: string; name?: string; required?: boolean; schema?: { type?: string; items?: string; custom?: string }; allowedValues?: unknown[] }[]
      }>(`reading the fields of ${issueType.name}`, `/rest/api/2/issue/createmeta/${projectKey}/issuetypes/${issueType.id}?maxResults=200`, { method: 'GET' }, signal)
      if (result.values !== undefined) {
        return result.values.map((field) => fieldInfo(field.fieldId ?? '', field))
      }
    } catch {
      // Older server: the expansion below.
    }
    const query = new URLSearchParams({ projectKeys: projectKey, issuetypeIds: issueType.id, expand: 'projects.issuetypes.fields' })
    const legacy = await this.rest.json<{
      projects?: { issuetypes?: { fields?: Record<string, { name?: string; required?: boolean; schema?: { type?: string; items?: string; custom?: string }; allowedValues?: unknown[] }> }[] }[]
    }>(`reading the fields of ${issueType.name}`, `/rest/api/2/issue/createmeta?${query.toString()}`, { method: 'GET' }, signal)
    const fields = legacy.projects?.[0]?.issuetypes?.[0]?.fields ?? {}
    return Object.entries(fields).map(([id, field]) => fieldInfo(id, field))
  }

  /** The fields an existing issue can be edited in, with allowed values. */
  async editFields(key: string, signal?: AbortSignal): Promise<JiraFieldInfo[]> {
    const result = await this.rest.json<{
      fields?: Record<string, { name?: string; required?: boolean; schema?: { type?: string; items?: string; custom?: string }; allowedValues?: unknown[] }>
    }>(`reading what can be edited on ${key}`, `/rest/api/2/issue/${key}/editmeta`, { method: 'GET' }, signal)
    return Object.entries(result.fields ?? {}).map(([id, field]) => fieldInfo(id, field))
  }

  private summary(raw: RawIssue): JiraIssueSummary {
    const key = raw.key ?? ''
    const fields = raw.fields ?? {}
    return {
      key,
      summary: fields.summary ?? '',
      status: fields.status?.name ?? '?',
      type: fields.issuetype?.name ?? '?',
      assignee: fields.assignee?.displayName ?? undefined,
      priority: fields.priority?.name ?? undefined,
      updated: fields.updated,
      url: this.rest.url(`/browse/${key}`),
    }
  }
}

export interface JiraFieldInfo {
  id: string
  name: string
  required: boolean
  type: string
  allowed: string[]
}

function fieldInfo(
  id: string,
  field: { name?: string; required?: boolean; schema?: { type?: string; items?: string; custom?: string }; allowedValues?: unknown[] },
): JiraFieldInfo {
  const schema = field.schema ?? {}
  const type = schema.type === 'array' ? `array of ${schema.items ?? '?'}` : (schema.type ?? '?')
  return {
    id,
    name: field.name ?? id,
    required: field.required === true,
    type,
    allowed: (field.allowedValues ?? []).map(renderValue).filter((value): value is string => value !== undefined),
  }
}

/** How a model should set each shape of field in `fields`, so custom fields are not a guess. */
function fieldExample(field: JiraFieldInfo): string {
  if (field.type === 'array of option') return '[{"value": "…"}]'
  if (field.type === 'array of component' || field.type === 'array of version' || field.type === 'array of user') {
    return '[{"name": "…"}]'
  }
  if (field.type === 'option') return '{"value": "…"}'
  if (field.type === 'user') return '{"name": "username"}'
  if (field.type === 'number') return '42'
  if (field.type === 'date') return '"2026-12-31"'
  if (field.type === 'datetime') return '"2026-12-31T17:00:00.000+0000"'
  if (field.type === 'array of string') return '["…"]'
  return '"…"'
}

function describeFields(fields: readonly JiraFieldInfo[]): string[] {
  return [...fields]
    .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name))
    .map((field) => {
      const allowed =
        field.allowed.length > 0
          ? ` — one of: ${field.allowed.slice(0, 25).join(', ')}${field.allowed.length > 25 ? `, … (${String(field.allowed.length)} in all)` : ''}`
          : ''
      return `- ${field.name} [${field.id}]${field.required ? ' REQUIRED' : ''}: ${field.type}, set as ${fieldExample(field)}${allowed}`
    })
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

const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 3_500_000
/** Formats a model can look at, on every provider this product speaks. SVG is read as text. */
const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const WIKI_GUIDE =
  'Jira wiki markup: h2. headings, *bold*, _italic_, {{monospace}}, {code:java}…{code}, {noformat}…{noformat}, ' +
  'bullet lines "* ", numbered "# ", tables "||head||head||" then "|cell|cell|", links [text|https://…]. ' +
  'Show an attached image inline with !name.png! (or !name.png|thumbnail! / !name.png|width=600!), ' +
  'and link an attached file with [^name.pdf]. Attach the file in the same call and refer to it by its name.'

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
  images: z.boolean().optional().describe('Also fetch the images attached to the issue so you can look at them. Default false.'),
  imageNames: z.array(z.string()).max(MAX_IMAGES).optional().describe('Only these attachments, by name. Implies images.'),
})

export function createJiraReadIssueTool(options: JiraToolOptions): Tool<z.infer<typeof readSchema>> {
  return {
    name: 'jira_read_issue',
    group: 'read',
    description:
      'Read a Jira issue: every field with a value (custom fields included, with their ids), ' +
      'description, comments, attachments, links, sub-tasks, and the status moves available now. ' +
      'Set images to also look at the pictures attached to it.',
    parametersSchema: readSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const issue = await client.getIssue(params.issueKey.trim())
        const moves = await client.transitions(issue.key).catch(() => [])

        const wanted =
          params.imageNames !== undefined && params.imageNames.length > 0
            ? new Set(params.imageNames.map((name) => name.toLowerCase()))
            : params.images === true
              ? undefined
              : new Set<string>()
        const images: NonNullable<ToolResult['images']> = []
        const svgText: string[] = []
        const skipped: string[] = []
        for (const attachment of issue.attachments) {
          if (!attachment.mediaType.startsWith('image/')) continue
          if (wanted !== undefined && !wanted.has(attachment.name.toLowerCase())) continue
          if (images.length >= MAX_IMAGES) {
            skipped.push(`${attachment.name} (more than ${String(MAX_IMAGES)} images — ask for it by name)`)
            continue
          }
          if (attachment.size > MAX_IMAGE_BYTES) {
            skipped.push(`${attachment.name} (${formatSize(attachment.size)}, too large to show)`)
            continue
          }
          try {
            const bytes = await client.download(attachment)
            if (attachment.mediaType === 'image/svg+xml') {
              svgText.push(`--- ${attachment.name} (SVG source) ---`, bytes.toString('utf8').slice(0, 20_000))
            } else if (VIEWABLE.has(attachment.mediaType)) {
              images.push({ label: attachment.name, mediaType: attachment.mediaType, data: bytes.toString('base64') })
            } else {
              skipped.push(`${attachment.name} (${attachment.mediaType} cannot be shown to a model)`)
            }
          } catch (error) {
            skipped.push(`${attachment.name} (${error instanceof Error ? error.message : String(error)})`)
          }
        }

        const list = (label: string, values: readonly string[]): string[] => (values.length > 0 ? [`${label}: ${values.join(', ')}`] : [])
        return {
          content: [
            `${issue.key}: ${issue.summary}`,
            `Status: ${issue.status}   Type: ${issue.type}   Priority: ${issue.priority ?? '—'}`,
            `Assignee: ${issue.assignee ?? 'unassigned'}   Reporter: ${issue.reporter ?? '—'}`,
            ...list('Labels', issue.labels),
            ...list('Components', issue.components),
            ...list('Fix versions', issue.fixVersions),
            ...list('Affects versions', issue.affectsVersions),
            ...(issue.dueDate !== undefined ? [`Due: ${issue.dueDate}`] : []),
            ...(issue.parent !== undefined ? [`Parent: ${issue.parent}`] : []),
            `Link: ${issue.url}`,
            ...(moves.length > 0 ? [`Can move to: ${moves.map((move) => move.to).join(', ')}`] : []),
            ...(issue.otherFields.length > 0 ? ['', 'Other fields:', ...issue.otherFields.map((field) => `- ${field.name}: ${field.value}`)] : []),
            ...(issue.links.length > 0 ? ['', 'Linked issues:', ...issue.links.map((link) => `- ${link}`)] : []),
            ...(issue.subtasks.length > 0 ? ['', 'Sub-tasks:', ...issue.subtasks.map((task) => `- ${task}`)] : []),
            '',
            issue.attachments.length === 0
              ? 'No attachments.'
              : [
                  'Attachments:',
                  ...issue.attachments.map((attachment) => `- ${attachment.name}  (${attachment.mediaType}, ${formatSize(attachment.size)})`),
                ].join('\n'),
            ...(images.length > 0 ? [`Showing ${String(images.length)} image(s): ${images.map((image) => image.label).join(', ')}.`] : []),
            ...(skipped.length > 0 ? ['Not shown:', ...skipped.map((line) => `- ${line}`)] : []),
            ...svgText,
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
          ...(images.length > 0 ? { images } : {}),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const projectSchema = z.object({
  project: z.string().optional().describe('Project key. Defaults to the configured project.'),
  issueType: z
    .string()
    .optional()
    .describe('Also list every field a new issue of this type takes — ids, required ones, allowed values.'),
  issueKey: z.string().optional().describe('Instead: list the fields this existing issue can be edited in, with allowed values.'),
})

export function createJiraProjectTool(options: JiraToolOptions): Tool<z.infer<typeof projectSchema>> {
  return {
    name: 'jira_project',
    group: 'read',
    description:
      'What a Jira project accepts: its issue types, components and versions, and — given an ' +
      'issueType — every field a new issue of that type takes, custom fields included with their ids ' +
      'and allowed values. Given an issueKey, the fields that issue can be edited in. Use it before ' +
      'jira_write_issue whenever a component, version or custom field is involved, instead of guessing names.',
    parametersSchema: projectSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        if (params.issueKey !== undefined) {
          const key = params.issueKey.trim()
          if (!isIssueKey(key)) return { content: `"${key}" is not an issue key.`, isError: true }
          return { content: [`Fields ${key} can be edited in:`, ...describeFields(await client.editFields(key))].join('\n') }
        }
        const projectKey = (params.project ?? options.defaultProject)?.trim()
        if (projectKey === undefined || projectKey.length === 0) {
          return { content: 'Name a project: none was given and no default project is configured.', isError: true }
        }
        const project = await client.project(projectKey)
        const lines = [
          `${project.key}: ${project.name}`,
          `Issue types: ${project.issueTypes.map((type) => (type.subtask ? `${type.name} (sub-task)` : type.name)).join(', ') || 'none'}`,
          `Components: ${project.components.join(', ') || 'none'}`,
          `Versions: ${project.versions.map((version) => `${version.name}${version.released ? ' (released)' : ''}`).join(', ') || 'none'}`,
        ]
        if (params.issueType !== undefined) {
          const wanted = params.issueType.trim().toLowerCase()
          const type = project.issueTypes.find((entry) => entry.name.toLowerCase() === wanted || entry.id === params.issueType)
          if (type === undefined) {
            lines.push('', `There is no issue type "${params.issueType}" in ${project.key}.`)
          } else {
            lines.push('', `Fields for a new ${type.name}:`, ...describeFields(await client.createFields(project.key, type)))
            lines.push(
              '',
              'Named parameters of jira_write_issue cover summary, description, priority, labels, assignee, ' +
                'components, versions, due date and parent; pass anything else in `fields` by its id.',
            )
          }
        }
        return { content: lines.join('\n') }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const writeSchema = z.object({
  issueKey: z.string().optional().describe('Update this issue. Omit to create a new one.'),
  project: z.string().optional().describe('Project key for a new issue. Defaults to the configured project.'),
  issueType: z.string().optional().describe('For a new issue: Task, Bug, Story, Sub-task… Default Task.'),
  summary: z.string().min(1).max(255).optional().describe('Required for a new issue.'),
  description: z.string().optional().describe(WIKI_GUIDE),
  labels: z.array(z.string()).optional().describe('Replaces the labels.'),
  priority: z.string().optional().describe('A priority name, e.g. High.'),
  assignee: z
    .string()
    .optional()
    .describe('Who it is assigned to: "me", a username, a display name or an email. "unassigned" clears it.'),
  components: z.array(z.string()).optional().describe('Component names. Replaces the components. See jira_project for the names.'),
  fixVersions: z.array(z.string()).optional().describe('Fix version names. Replaces them.'),
  affectsVersions: z.array(z.string()).optional().describe('Affects version names. Replaces them.'),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('YYYY-MM-DD.'),
  parent: z.string().optional().describe('Parent issue key, for a sub-task.'),
  links: z
    .array(
      z.object({
        type: z.string().min(1).describe('The link type name, e.g. "Blocks", "Relates", "Duplicate", "Cloners".'),
        issueKey: z.string().min(1).describe('The other issue.'),
        direction: z
          .enum(['outward', 'inward'])
          .optional()
          .describe('outward (default): this issue → the other ("this blocks ABC-1"). inward: the other → this ("this is blocked by ABC-1").'),
      }),
    )
    .max(20)
    .optional()
    .describe('Issue links to add.'),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Any other fields, by id, exactly as Jira takes them — e.g. {"customfield_10010": "ABC-5"} for an epic link, ' +
        '{"customfield_10200": {"value": "Production"}} for a select list, {"environment": "…"}. Applied last, so it ' +
        'wins over a named parameter. Use jira_project to find the ids and allowed values.',
    ),
  attachments: attachmentsSchema('issue', 'Show an image in the description or comment with !name.png!.'),
  diagrams: diagramsSchema,
  comment: z.string().optional().describe('A comment to add, in the same wiki markup; it can show an attached image with !name.png!.'),
  transition: z.string().optional().describe('Move the issue: the target status or the move\'s name, e.g. "In Review".'),
})
type WriteParams = z.infer<typeof writeSchema>

const JIRA_KEEPS_BOTH = 'an attachment of this name already exists; Jira keeps both'

/** The fields and update block a write sends, resolving people along the way. */
async function buildChange(
  client: JiraClient,
  params: WriteParams,
): Promise<{ fields: Record<string, unknown>; update: Record<string, unknown> | undefined; assignee?: string }> {
  const names = (values: readonly string[]): { name: string }[] => values.map((name) => ({ name: name.trim() }))
  const fields: Record<string, unknown> = {
    ...(params.summary !== undefined ? { summary: params.summary } : {}),
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(params.labels !== undefined ? { labels: params.labels } : {}),
    ...(params.priority !== undefined ? { priority: { name: params.priority } } : {}),
    ...(params.components !== undefined ? { components: names(params.components) } : {}),
    ...(params.fixVersions !== undefined ? { fixVersions: names(params.fixVersions) } : {}),
    ...(params.affectsVersions !== undefined ? { versions: names(params.affectsVersions) } : {}),
    ...(params.dueDate !== undefined ? { duedate: params.dueDate } : {}),
    ...(params.parent !== undefined ? { parent: { key: params.parent.trim() } } : {}),
  }
  let assignee: string | undefined
  if (params.assignee !== undefined) {
    if (/^(unassigned|none|nobody)$/i.test(params.assignee.trim())) {
      fields['assignee'] = { name: null }
      assignee = 'unassigned'
    } else {
      const person = await client.resolveUser(params.assignee)
      fields['assignee'] = { name: person.name }
      assignee = `${person.displayName} (${person.name})`
    }
  }
  Object.assign(fields, params.fields ?? {})
  const update =
    params.links !== undefined && params.links.length > 0
      ? {
          issuelinks: params.links.map((link) => ({
            add: {
              type: { name: link.type },
              [link.direction === 'inward' ? 'inwardIssue' : 'outwardIssue']: { key: link.issueKey.trim() },
            },
          })),
        }
      : undefined
  return { fields, update, ...(assignee !== undefined ? { assignee } : {}) }
}

/** Components and versions Jira will refuse, named before approval rather than after. */
async function unknownNames(client: JiraClient, projectKey: string, params: WriteParams): Promise<string[]> {
  if (params.components === undefined && params.fixVersions === undefined && params.affectsVersions === undefined) return []
  const project = await client.project(projectKey).catch(() => undefined)
  if (project === undefined) return []
  const problems: string[] = []
  const check = (label: string, wanted: readonly string[] | undefined, known: readonly string[]): void => {
    const lower = new Set(known.map((name) => name.toLowerCase()))
    const missing = (wanted ?? []).filter((name) => !lower.has(name.trim().toLowerCase()))
    if (missing.length > 0) problems.push(`${label} ${missing.join(', ')} not in ${projectKey} (it has: ${known.join(', ') || 'none'}) — Jira will refuse this.`)
  }
  check('Component', params.components, project.components)
  check('Version', [...(params.fixVersions ?? []), ...(params.affectsVersions ?? [])], project.versions.map((version) => version.name))
  return problems
}

function describeLinks(key: string, params: WriteParams): string[] {
  return (params.links ?? []).map((link) =>
    link.direction === 'inward' ? `Link: ${link.issueKey} —[${link.type}]→ ${key}` : `Link: ${key} —[${link.type}]→ ${link.issueKey}`,
  )
}

function describeExtraFields(params: WriteParams): string[] {
  return Object.entries(params.fields ?? {}).map(([id, value]) => `${id}: ${JSON.stringify(value)}`)
}

export function createJiraWriteIssueTool(options: JiraToolOptions): Tool<WriteParams> {
  return {
    name: 'jira_write_issue',
    group: 'edit',
    description:
      'Create a Jira issue, or update one given its key. In one call it can set any field — summary, ' +
      'description, priority, labels, assignee, components, versions, due date, parent, and any custom ' +
      'field through `fields` — attach workspace files and drawn diagrams (show an image in the ' +
      'description with !name.png!), link other issues, add a comment and move its status. Use ' +
      'jira_project to find component names and custom field ids, and search first so nothing is ' +
      'logged twice. Always shown to the user before anything changes.' +
      (options.defaultProject !== undefined
        ? ` New issues go to project ${options.defaultProject} unless the user asks for another — leave project out for that.`
        : ' No default project is configured, so a new issue needs a project key; ask the user if they have not given one.'),
    parametersSchema: writeSchema,

    async preview(params, context): Promise<ToolPreview> {
      const client = await options.client()
      const prepared = await prepareUploads(params, context)
      const change = await buildChange(client, params).catch((error: unknown) => error)
      const assigneeLine =
        change instanceof Error
          ? [`Assignee: ${change.message} — this will be refused.`]
          : params.assignee !== undefined
            ? [`Assignee: → ${(change as { assignee?: string }).assignee ?? params.assignee}`]
            : []

      if (params.issueKey === undefined) {
        const project = params.project ?? options.defaultProject
        const files = prepared.ok ? describeUploads(prepared.files, [], JIRA_KEEPS_BOTH) : `Attachments cannot be prepared: ${prepared.message} — this will be refused.`
        return {
          kind: 'text',
          text: [
            `New ${params.issueType ?? 'Task'} in ${project ?? '(no project given)'}`,
            `Summary: ${params.summary ?? '(missing — this will be refused)'}`,
            ...(params.priority !== undefined ? [`Priority: ${params.priority}`] : []),
            ...(params.labels !== undefined ? [`Labels: ${params.labels.join(', ')}`] : []),
            ...(params.components !== undefined ? [`Components: ${params.components.join(', ')}`] : []),
            ...(params.fixVersions !== undefined ? [`Fix versions: ${params.fixVersions.join(', ')}`] : []),
            ...(params.affectsVersions !== undefined ? [`Affects versions: ${params.affectsVersions.join(', ')}`] : []),
            ...(params.dueDate !== undefined ? [`Due: ${params.dueDate}`] : []),
            ...(params.parent !== undefined ? [`Parent: ${params.parent}`] : []),
            ...assigneeLine,
            ...describeExtraFields(params),
            ...describeLinks('(new issue)', params),
            ...(project !== undefined ? await unknownNames(client, project, params) : []),
            files,
            '',
            params.description ?? '(no description)',
            ...(params.comment !== undefined ? ['', 'Comment:', params.comment] : []),
          ].join('\n'),
        }
      }

      // The issue as it is now, so what is approved is a change to what is actually there.
      const current = await client.getIssue(params.issueKey.trim())
      const notes: string[] = []
      const was = (values: readonly string[]): string => `[${values.join(', ')}]`
      if (params.summary !== undefined && params.summary !== current.summary) notes.push(`Summary: "${current.summary}" → "${params.summary}"`)
      if (params.labels !== undefined) notes.push(`Labels: ${was(current.labels)} → ${was(params.labels)}`)
      if (params.priority !== undefined) notes.push(`Priority: ${current.priority ?? '—'} → ${params.priority}`)
      if (params.components !== undefined) notes.push(`Components: ${was(current.components)} → ${was(params.components)}`)
      if (params.fixVersions !== undefined) notes.push(`Fix versions: ${was(current.fixVersions)} → ${was(params.fixVersions)}`)
      if (params.affectsVersions !== undefined) notes.push(`Affects versions: ${was(current.affectsVersions)} → ${was(params.affectsVersions)}`)
      if (params.dueDate !== undefined) notes.push(`Due: ${current.dueDate ?? '—'} → ${params.dueDate}`)
      if (params.parent !== undefined) notes.push(`Parent: ${current.parent ?? '—'} → ${params.parent}`)
      if (params.assignee !== undefined) {
        notes.push(
          change instanceof Error
            ? `Assignee: ${change.message} — this will be refused.`
            : `Assignee: ${current.assignee ?? 'unassigned'} → ${(change as { assignee?: string }).assignee ?? params.assignee}`,
        )
      }
      notes.push(...describeExtraFields(params), ...describeLinks(current.key, params))
      notes.push(...(await unknownNames(client, current.key.replace(/-\d+$/, ''), params)))
      if (params.transition !== undefined) {
        const move = findTransition(await client.transitions(current.key).catch(() => []), params.transition)
        notes.push(
          move !== undefined
            ? `Status: ${current.status} → ${move.to}`
            : `Status: no move to "${params.transition}" exists from ${current.status} — this part will be refused.`,
        )
      }
      if ((params.attachments?.length ?? 0) + (params.diagrams?.length ?? 0) > 0) {
        notes.push(
          prepared.ok
            ? describeUploads(prepared.files, current.attachments.map((attachment) => attachment.name), JIRA_KEEPS_BOTH)
            : `Attachments cannot be prepared: ${prepared.message} — this will be refused.`,
        )
      }
      if (params.comment !== undefined) notes.push(`Comment:\n${params.comment}`)
      const title = `Jira: ${current.key} ${current.summary} (${current.url})`
      if (params.description !== undefined) {
        return { kind: 'diff', path: title, before: current.description, after: params.description, note: notes.join('\n') }
      }
      return { kind: 'text', text: [title, '', ...(notes.length > 0 ? notes : ['Nothing would change.'])].join('\n') }
    },

    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      try {
        // Files first: a path that cannot be read should stop the write before anything changes.
        const prepared = await prepareUploads(params, context)
        if (!prepared.ok) return { content: prepared.message, isError: true }
        const client = await options.client()
        const { fields, update } = await buildChange(client, params)
        let key: string
        let url: string
        const done: string[] = []
        if (params.issueKey === undefined) {
          const project = params.project ?? options.defaultProject
          if (project === undefined) return { content: 'No project was given and no default project is configured.', isError: true }
          if (params.summary === undefined) return { content: 'A new issue needs a summary.', isError: true }
          const created = await client.createIssue(
            { project: { key: project }, issuetype: { name: params.issueType ?? 'Task' }, ...fields },
            update,
          )
          key = created.key
          url = created.url
          done.push(`Created ${key}.`)
        } else {
          const current = await client.getIssue(params.issueKey.trim())
          key = current.key
          url = current.url
          if (Object.keys(fields).length > 0 || update !== undefined) {
            await client.updateIssue(key, fields, update)
            const changed = [...Object.keys(fields), ...(update !== undefined ? ['links'] : [])]
            done.push(`Updated ${changed.join(', ')}.`)
          }
        }
        // After the fields, so a failed upload, comment or move is reported without undoing the edit.
        // Before the comment, so a comment showing !screenshot.png! has the image to show.
        const failed: string[] = []
        const attached: PreparedFile[] = []
        for (const file of prepared.files) {
          try {
            await client.attach(key, file)
            attached.push(file)
          } catch (error) {
            failed.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (attached.length > 0) done.push(`Attached ${attached.map((file) => file.name).join(', ')}.`)
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
