import { z } from 'zod'

import type { HttpClient } from '../platform/http.js'
import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import { AtlassianError, AtlassianRest, type AtlassianConnection } from './rest.js'

/**
 * Bitbucket Data Center / Server: pull requests and files, with a personal access token.
 *
 * ## Four tools
 *
 * `bitbucket_pull_requests` lists, `bitbucket_read_pull_request` reads one (description, reviewers,
 * comments and the diff), `bitbucket_read_file` reads a file at any branch or commit — code the
 * workspace may not have checked out — and `bitbucket_write_pull_request` opens a pull request or
 * comments on one.
 *
 * ## What is deliberately absent
 *
 * No merge, no approve, no decline, no branch delete. Each is a decision a reviewer makes about
 * somebody's work, taken under the user's name, and an assistant that could approve a pull request
 * would turn the review it was asked to help with into a formality. Commenting is the assistant's
 * contribution to a review; approving is the person's.
 *
 * Writing is `edit` and in `ALWAYS_ASK_TOOLS`, and the preview is the literal comment or the literal
 * pull request with both branches (invariant 8).
 */

// -------------------------------------------------------------------------------------------------
// Client

export interface BitbucketRepo {
  project: string
  repo: string
}

export interface PullRequestSummary {
  id: number
  title: string
  state: string
  author: string
  from: string
  to: string
  updated: string | undefined
  url: string
}

export interface PullRequest extends PullRequestSummary {
  description: string
  reviewers: { name: string; status: string }[]
}

interface RawPullRequest {
  id?: number
  title?: string
  description?: string
  state?: string
  updatedDate?: number
  author?: { user?: { displayName?: string } }
  fromRef?: { displayId?: string }
  toRef?: { displayId?: string }
  reviewers?: { user?: { displayName?: string }; status?: string }[]
  links?: { self?: { href?: string }[] }
}

/** Project keys and repository slugs, checked so a model-supplied value cannot reshape a path. */
export function isSafeSegment(value: string): boolean {
  return /^~?[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..'
}

/** A file path, each segment encoded; `..` refused so it cannot climb out of the repository. */
export function encodeRepoPath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0 || segments.some((segment) => segment === '..' || segment === '.')) {
    throw new AtlassianError(`"${path}" is not a file path inside the repository.`)
  }
  return segments.map(encodeURIComponent).join('/')
}

export class BitbucketClient {
  private readonly rest: AtlassianRest

  constructor(http: HttpClient, connection: AtlassianConnection) {
    this.rest = new AtlassianRest(http, 'bitbucket', connection)
  }

  async currentUser(signal?: AbortSignal): Promise<string> {
    // The one endpoint every version has that names the token's owner, as plain text.
    const name = (await this.rest.text('reading the current user', '/plugins/servlet/applinks/whoami', signal)).trim()
    if (name.length === 0) throw new AtlassianError('Bitbucket accepted the request but did not recognise the token.')
    return name
  }

  async pullRequests(repo: BitbucketRepo, state: 'OPEN' | 'MERGED' | 'DECLINED' | 'ALL', limit: number, signal?: AbortSignal): Promise<PullRequestSummary[]> {
    const result = await this.rest.json<{ values?: RawPullRequest[] }>(
      `listing pull requests in ${repo.project}/${repo.repo}`,
      `${this.repoPath(repo)}/pull-requests?state=${state}&limit=${String(limit)}&order=NEWEST`,
      { method: 'GET' },
      signal,
    )
    return (result.values ?? []).map((raw) => this.summary(raw))
  }

  async pullRequest(repo: BitbucketRepo, id: number, signal?: AbortSignal): Promise<PullRequest> {
    const raw = await this.rest.json<RawPullRequest>(`reading pull request #${String(id)}`, `${this.repoPath(repo)}/pull-requests/${String(id)}`, { method: 'GET' }, signal)
    return {
      ...this.summary(raw),
      description: raw.description ?? '',
      reviewers: (raw.reviewers ?? []).map((reviewer) => ({
        name: reviewer.user?.displayName ?? 'someone',
        status: reviewer.status ?? 'UNAPPROVED',
      })),
    }
  }

  async comments(repo: BitbucketRepo, id: number, signal?: AbortSignal): Promise<{ author: string; text: string; file: string | undefined }[]> {
    const result = await this.rest.json<{
      values?: { action?: string; comment?: { text?: string; author?: { displayName?: string } }; commentAnchor?: { path?: string; line?: number } }[]
    }>(`reading the comments on #${String(id)}`, `${this.repoPath(repo)}/pull-requests/${String(id)}/activities?limit=100`, { method: 'GET' }, signal)
    return (result.values ?? [])
      .filter((activity) => activity.action === 'COMMENTED' && activity.comment !== undefined)
      .map((activity) => ({
        author: activity.comment?.author?.displayName ?? 'someone',
        text: activity.comment?.text ?? '',
        file:
          activity.commentAnchor?.path !== undefined
            ? `${activity.commentAnchor.path}${activity.commentAnchor.line !== undefined ? `:${String(activity.commentAnchor.line)}` : ''}`
            : undefined,
      }))
      .reverse()
  }

  /** The unified diff, as text — the same thing `git diff` would print. */
  async diff(repo: BitbucketRepo, id: number, signal?: AbortSignal): Promise<string> {
    return this.rest.text(`reading the diff of #${String(id)}`, `${this.repoPath(repo)}/pull-requests/${String(id)}.diff?contextLines=3`, signal)
  }

  async file(repo: BitbucketRepo, path: string, ref: string | undefined, signal?: AbortSignal): Promise<string> {
    const at = ref !== undefined && ref.length > 0 ? `?at=${encodeURIComponent(ref)}` : ''
    // `/raw` sits outside the REST API, beside the repository's browse URL.
    const browse = this.repoPath(repo).replace('/rest/api/1.0', '')
    return this.rest.text(`reading ${path}`, `${browse}/raw/${encodeRepoPath(path)}${at}`, signal)
  }

  async createPullRequest(
    repo: BitbucketRepo,
    pr: { title: string; description: string; from: string; to: string },
    signal?: AbortSignal,
  ): Promise<PullRequestSummary> {
    const ref = (branch: string) => ({
      id: branch.startsWith('refs/') ? branch : `refs/heads/${branch}`,
      repository: { slug: repo.repo, project: { key: repo.project } },
    })
    const raw = await this.rest.json<RawPullRequest>(
      `opening "${pr.title}"`,
      `${this.repoPath(repo)}/pull-requests`,
      { method: 'POST', body: JSON.stringify({ title: pr.title, description: pr.description, fromRef: ref(pr.from), toRef: ref(pr.to) }) },
      signal,
    )
    return this.summary(raw)
  }

  async comment(repo: BitbucketRepo, id: number, text: string, signal?: AbortSignal): Promise<void> {
    await this.rest.json(`commenting on #${String(id)}`, `${this.repoPath(repo)}/pull-requests/${String(id)}/comments`, { method: 'POST', body: JSON.stringify({ text }) }, signal)
  }

  private repoPath(repo: BitbucketRepo): string {
    if (!isSafeSegment(repo.project) || !isSafeSegment(repo.repo)) {
      throw new AtlassianError(`"${repo.project}/${repo.repo}" is not a project key and repository slug.`)
    }
    return `/rest/api/1.0/projects/${repo.project}/repos/${repo.repo}`
  }

  private summary(raw: RawPullRequest): PullRequestSummary {
    return {
      id: raw.id ?? 0,
      title: raw.title ?? '',
      state: raw.state ?? '?',
      author: raw.author?.user?.displayName ?? 'someone',
      from: raw.fromRef?.displayId ?? '?',
      to: raw.toRef?.displayId ?? '?',
      updated: raw.updatedDate !== undefined ? new Date(raw.updatedDate).toISOString() : undefined,
      url: raw.links?.self?.[0]?.href ?? this.rest.url(undefined),
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Tools

export interface BitbucketToolOptions {
  client: () => Promise<BitbucketClient>
  defaultProject?: string | undefined
  defaultRepo?: string | undefined
}

function errorResult(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true }
}

const repoFields = {
  project: z.string().optional().describe('Project key. Defaults to the configured project.'),
  repo: z.string().optional().describe('Repository slug. Defaults to the configured repository.'),
}

function resolveRepo(options: BitbucketToolOptions, params: { project?: string | undefined; repo?: string | undefined }): BitbucketRepo {
  const project = params.project ?? options.defaultProject
  const repo = params.repo ?? options.defaultRepo
  if (project === undefined || repo === undefined) {
    throw new AtlassianError(
      'Which repository? Give project and repo — no default is configured in Settings → Atlassian → Bitbucket.',
    )
  }
  return { project, repo }
}

function defaultsNote(options: BitbucketToolOptions): string {
  return options.defaultProject !== undefined && options.defaultRepo !== undefined
    ? ` Without project and repo it uses ${options.defaultProject}/${options.defaultRepo}.`
    : ''
}

const listSchema = z.object({
  ...repoFields,
  state: z.enum(['OPEN', 'MERGED', 'DECLINED', 'ALL']).optional().describe('Default OPEN.'),
  limit: z.number().int().min(1).max(50).optional().describe('Default 20.'),
})

export function createBitbucketPullRequestsTool(options: BitbucketToolOptions): Tool<z.infer<typeof listSchema>> {
  return {
    name: 'bitbucket_pull_requests',
    group: 'read',
    description: `List pull requests in a Bitbucket repository, newest first.${defaultsNote(options)}`,
    parametersSchema: listSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const repo = resolveRepo(options, params)
        const list = await (await options.client()).pullRequests(repo, params.state ?? 'OPEN', params.limit ?? 20)
        if (list.length === 0) return { content: `No ${(params.state ?? 'OPEN').toLowerCase()} pull requests in ${repo.project}/${repo.repo}.` }
        return {
          content: [
            `${String(list.length)} pull request(s) in ${repo.project}/${repo.repo}:`,
            ...list.map((pr) => `- #${String(pr.id)} [${pr.state}] ${pr.title} — ${pr.author}, ${pr.from} → ${pr.to}  ${pr.url}`),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

/** A diff past this is cut, and says so; the whole of it is rarely what a review needs first. */
const DIFF_LIMIT = 60_000

const readSchema = z.object({
  ...repoFields,
  id: z.number().int().positive().describe('The pull request number.'),
  diff: z.boolean().optional().describe('Include the diff. Default true.'),
})

export function createBitbucketReadPullRequestTool(options: BitbucketToolOptions): Tool<z.infer<typeof readSchema>> {
  return {
    name: 'bitbucket_read_pull_request',
    group: 'read',
    description:
      'Read a Bitbucket pull request: title, description, branches, reviewers and their verdicts, ' +
      `every comment (with the file and line it is on), and the diff.${defaultsNote(options)}`,
    parametersSchema: readSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const repo = resolveRepo(options, params)
        const client = await options.client()
        const pr = await client.pullRequest(repo, params.id)
        const comments = await client.comments(repo, params.id).catch(() => [])
        let diff = ''
        if (params.diff !== false) {
          const full = await client.diff(repo, params.id)
          diff =
            full.length > DIFF_LIMIT
              ? `${full.slice(0, DIFF_LIMIT)}\n… diff cut at ${String(DIFF_LIMIT)} characters of ${String(full.length)}; read individual files with bitbucket_read_file.`
              : full
        }
        return {
          content: [
            `#${String(pr.id)} ${pr.title}  [${pr.state}]`,
            `${pr.author}: ${pr.from} → ${pr.to}`,
            `Link: ${pr.url}`,
            `Reviewers: ${pr.reviewers.length === 0 ? 'none' : pr.reviewers.map((reviewer) => `${reviewer.name} (${reviewer.status.toLowerCase()})`).join(', ')}`,
            '',
            'Description:',
            pr.description.length > 0 ? pr.description : '(none)',
            '',
            comments.length === 0
              ? 'No comments.'
              : `Comments (${String(comments.length)}):\n${comments
                  .map((comment) => `--- ${comment.author}${comment.file !== undefined ? ` on ${comment.file}` : ''}\n${comment.text}`)
                  .join('\n')}`,
            ...(diff.length > 0 ? ['', 'Diff:', diff] : []),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const fileSchema = z.object({
  ...repoFields,
  path: z.string().min(1).describe('Path inside the repository, e.g. src/app.py.'),
  ref: z.string().optional().describe('Branch, tag or commit. Default: the repository\'s default branch.'),
})

export function createBitbucketReadFileTool(options: BitbucketToolOptions): Tool<z.infer<typeof fileSchema>> {
  return {
    name: 'bitbucket_read_file',
    group: 'read',
    description:
      'Read a file from a Bitbucket repository at a branch, tag or commit — for code that is not ' +
      `checked out here, or a version other than the one on disk.${defaultsNote(options)}`,
    parametersSchema: fileSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const repo = resolveRepo(options, params)
        const text = await (await options.client()).file(repo, params.path, params.ref)
        const numbered = text
          .split(/\r?\n/)
          .map((line, index) => `${String(index + 1).padStart(5)}  ${line}`)
          .join('\n')
        return { content: `${repo.project}/${repo.repo}:${params.path}${params.ref !== undefined ? ` @ ${params.ref}` : ''}\n${numbered}` }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const writeSchema = z.object({
  ...repoFields,
  id: z.number().int().positive().optional().describe('Comment on this pull request. Omit to open a new one.'),
  comment: z.string().optional().describe('The comment to add to pull request `id`. Markdown.'),
  title: z.string().min(1).optional().describe('New pull request: its title.'),
  description: z.string().optional().describe('New pull request: its description. Markdown.'),
  from: z.string().optional().describe('New pull request: the branch with the changes.'),
  to: z.string().optional().describe('New pull request: the branch to merge into.'),
})
type WriteParams = z.infer<typeof writeSchema>

export function createBitbucketWritePullRequestTool(options: BitbucketToolOptions): Tool<WriteParams> {
  return {
    name: 'bitbucket_write_pull_request',
    group: 'edit',
    description:
      'Open a Bitbucket pull request (title, from, to, optional description), or comment on one ' +
      '(id and comment). It cannot approve, merge or decline — tell the user to do that themselves. ' +
      `Always shown to the user before anything is posted.${defaultsNote(options)}`,
    parametersSchema: writeSchema,

    async preview(params): Promise<ToolPreview> {
      const repo = resolveRepo(options, params)
      if (params.id !== undefined) {
        const pr = await (await options.client()).pullRequest(repo, params.id)
        return {
          kind: 'text',
          text: [`Comment on ${repo.project}/${repo.repo} #${String(pr.id)} ${pr.title}`, `(${pr.url})`, '', params.comment ?? '(no comment given — this will be refused)'].join('\n'),
        }
      }
      return {
        kind: 'text',
        text: [
          `Open a pull request in ${repo.project}/${repo.repo}`,
          `${params.from ?? '(no source branch)'} → ${params.to ?? '(no target branch)'}`,
          `Title: ${params.title ?? '(missing — this will be refused)'}`,
          '',
          params.description ?? '(no description)',
        ].join('\n'),
      }
    },

    async execute(params): Promise<ToolResult> {
      try {
        const repo = resolveRepo(options, params)
        const client = await options.client()
        if (params.id !== undefined) {
          if (params.comment === undefined || params.comment.trim().length === 0) return { content: 'A comment needs text.', isError: true }
          await client.comment(repo, params.id, params.comment)
          return { content: `Commented on #${String(params.id)} in ${repo.project}/${repo.repo}.` }
        }
        if (params.title === undefined || params.from === undefined || params.to === undefined) {
          return { content: 'A new pull request needs title, from and to.', isError: true }
        }
        const pr = await client.createPullRequest(repo, {
          title: params.title,
          description: params.description ?? '',
          from: params.from,
          to: params.to,
        })
        return { content: `Opened #${String(pr.id)} ${pr.title} (${pr.from} → ${pr.to}).\nLink: ${pr.url}` }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}
