import { z } from 'zod'

import type { HttpClient } from '../platform/http.js'
import { resolveToolPath } from '../tools/paths.js'
import type { Tool, ToolExecutionContext, ToolPreview, ToolResult } from '../tools/types.js'
import { AtlassianError, AtlassianRest, type AtlassianConnection } from './rest.js'

/**
 * Jenkins: jobs, builds, logs, starting and stopping builds, and trying a Jenkinsfile.
 *
 * ## Why it sits beside Confluence, Jira and Bitbucket
 *
 * Same shape exactly — a site, a personal token in secret storage, the shared TLS resolver, one
 * `HttpClient` (invariant 2) — so it reuses `AtlassianRest` rather than a fourth copy of "send,
 * check the status, turn the error into a sentence". The one difference is authentication: a
 * Jenkins API token is sent as HTTP Basic with the user's name, which `AtlassianConnection.username`
 * switches on.
 *
 * ## What it can do, and what always asks
 *
 * Reading — jobs, a job's recent builds and parameters, a build's result, causes, changes, pipeline
 * stages and failed tests, the console log (tail, search, or one stage's), the queue and offline
 * agents, and linting a Jenkinsfile — goes through the ordinary gate as `read`.
 *
 * **Starting a build, stopping one, and replaying a build with a local Jenkinsfile change shared CI
 * under the user's name**, and a replay runs whatever the file says with the job's credentials. All
 * three are `command`, in `ALWAYS_ASK_TOOLS` and never available to a schedule, and each preview
 * shows the literal job, build and parameters — or the whole Jenkinsfile — that will run
 * (invariant 8). There is deliberately no tool that changes a job's configuration.
 *
 * ## Logs are streamed
 *
 * A console log can be hundreds of megabytes. It is read as a stream and only a bounded tail, or the
 * matching lines, is kept — never the whole text in memory and never the whole text in the context.
 */

// -------------------------------------------------------------------------------------------------
// Paths and references

/**
 * A job's path on the site: `folder/sub/name` becomes `/job/folder/job/sub/job/name`.
 *
 * Accepts the slash form, the `/job/…/job/…` form, or a pasted URL of this site. Each segment is
 * encoded, and `..` or an empty segment is refused, because the result is interpolated into a URL
 * that carries the token.
 */
export function jobPath(job: string, base?: string): string {
  let text = job.trim()
  if (base !== undefined && text.startsWith(base)) text = text.slice(base.length)
  if (/^https?:\/\//i.test(text)) text = new URL(text).pathname
  const segments = text
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  // `/job/a/job/b` — drop the `job` markers; a plain path has none.
  const names = segments.length > 0 && segments[0] === 'job' ? segments.filter((_, index) => index % 2 === 1) : segments
  if (names.length === 0) throw new AtlassianError(`"${job}" is not a job name — give it as folder/name, e.g. platform/service-api.`)
  for (const name of names) {
    if (name === '..' || name === '.') throw new AtlassianError(`"${job}" is not a job name.`)
  }
  return names.map((name) => `/job/${encodeURIComponent(decodeURIComponent(name))}`).join('')
}

const BUILD_ALIASES: Record<string, string> = {
  last: 'lastBuild',
  latest: 'lastBuild',
  lastbuild: 'lastBuild',
  lastfailed: 'lastFailedBuild',
  lastfailedbuild: 'lastFailedBuild',
  failed: 'lastFailedBuild',
  lastsuccessful: 'lastSuccessfulBuild',
  lastsuccessfulbuild: 'lastSuccessfulBuild',
  lastcompleted: 'lastCompletedBuild',
  lastcompletedbuild: 'lastCompletedBuild',
  lastunstable: 'lastUnstableBuild',
  lastunstablebuild: 'lastUnstableBuild',
}

/** `42`, `"#42"`, `last`, `lastFailed`… as the path segment Jenkins understands. */
export function buildRef(build: string | number | undefined): string {
  if (build === undefined) return 'lastBuild'
  const text = String(build).trim().replace(/^#/, '')
  if (/^\d+$/.test(text)) return text
  const alias = BUILD_ALIASES[text.toLowerCase().replace(/[^a-z]/g, '')]
  if (alias !== undefined) return alias
  throw new AtlassianError(`"${String(build)}" is not a build: give a number, or last, lastFailed, lastSuccessful or lastCompleted.`)
}

function when(timestamp: number | undefined): string {
  return timestamp === undefined || timestamp <= 0 ? '?' : new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function duration(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 90 ? `${String(minutes)}m ${String(seconds % 60)}s` : `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`
}

/** Jenkins' ball colour, said in words. */
function status(color: string | undefined): string {
  if (color === undefined) return '?'
  const base = color.replace(/_anime$/, '')
  const word =
    ({ blue: 'success', green: 'success', red: 'failed', yellow: 'unstable', aborted: 'aborted', disabled: 'disabled', notbuilt: 'never built', grey: 'never built' } as Record<
      string,
      string
    >)[base] ?? base
  return color.endsWith('_anime') ? `${word}, building now` : word
}

// -------------------------------------------------------------------------------------------------
// Client

export interface JenkinsJobSummary {
  name: string
  fullName: string
  url: string
  status: string
  isFolder: boolean
}

interface RawJob {
  name?: string
  fullName?: string
  url?: string
  color?: string
  _class?: string
  jobs?: RawJob[]
}

export interface JenkinsParameter {
  name: string
  type: string
  description?: string | undefined
  defaultValue?: string | undefined
  choices?: string[] | undefined
}

export interface PipelineStage {
  id: string
  name: string
  status: string
  durationMillis?: number | undefined
}

export class JenkinsClient {
  private readonly rest: AtlassianRest
  private crumb: { field: string; value: string } | undefined

  constructor(http: HttpClient, connection: AtlassianConnection) {
    this.rest = new AtlassianRest(http, 'jenkins', connection)
  }

  get base(): string {
    return this.rest.base
  }

  async currentUser(signal?: AbortSignal): Promise<string> {
    const me = await this.rest.json<{ fullName?: string; id?: string }>('reading the current user', '/me/api/json', { method: 'GET' }, signal)
    return me.fullName ?? me.id ?? 'an unnamed user'
  }

  /** Every job under `folder` (or the root), folders opened three levels deep. */
  async listJobs(folder: string | undefined, signal?: AbortSignal): Promise<JenkinsJobSummary[]> {
    const tree = 'jobs[name,fullName,url,color,_class,jobs[name,fullName,url,color,_class,jobs[name,fullName,url,color,_class]]]'
    const root = folder === undefined || folder.trim().length === 0 ? '' : jobPath(folder, this.base)
    const result = await this.rest.json<{ jobs?: RawJob[] }>('listing jobs', `${root}/api/json?tree=${encodeURIComponent(tree)}`, { method: 'GET' }, signal)
    const found: JenkinsJobSummary[] = []
    const walk = (jobs: RawJob[] | undefined): void => {
      for (const job of jobs ?? []) {
        const isFolder = job.jobs !== undefined || /Folder|OrganizationFolder|WorkflowMultiBranchProject/.test(job._class ?? '')
        found.push({
          name: job.name ?? '',
          fullName: job.fullName ?? job.name ?? '',
          url: job.url ?? '',
          status: isFolder ? 'folder' : status(job.color),
          isFolder,
        })
        walk(job.jobs)
      }
    }
    walk(result.jobs)
    return found
  }

  async job(job: string, signal?: AbortSignal) {
    const tree = [
      'fullName,description,url,buildable,color,inQueue,nextBuildNumber',
      'healthReport[description,score]',
      'lastBuild[number,result,timestamp,duration,building]',
      'lastSuccessfulBuild[number,timestamp]',
      'lastFailedBuild[number,timestamp]',
      'builds[number,result,timestamp,duration,building]{0,10}',
      'property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]]',
    ].join(',')
    return this.rest.json<{
      fullName?: string
      description?: string | null
      url?: string
      buildable?: boolean
      color?: string
      inQueue?: boolean
      nextBuildNumber?: number
      healthReport?: { description?: string; score?: number }[]
      lastBuild?: { number?: number; result?: string | null; timestamp?: number; duration?: number; building?: boolean } | null
      lastSuccessfulBuild?: { number?: number; timestamp?: number } | null
      lastFailedBuild?: { number?: number; timestamp?: number } | null
      builds?: { number?: number; result?: string | null; timestamp?: number; duration?: number; building?: boolean }[]
      property?: { parameterDefinitions?: { name?: string; type?: string; description?: string; defaultParameterValue?: { value?: unknown } | null; choices?: string[] }[] }[]
    }>(`reading job ${job}`, `${jobPath(job, this.base)}/api/json?tree=${encodeURIComponent(tree)}`, { method: 'GET' }, signal)
  }

  async parameters(job: string, signal?: AbortSignal): Promise<JenkinsParameter[]> {
    const info = await this.job(job, signal)
    return (info.property ?? []).flatMap((property) =>
      (property.parameterDefinitions ?? []).map((definition) => ({
        name: definition.name ?? '',
        type: (definition.type ?? '').replace(/ParameterDefinition$/, ''),
        description: definition.description || undefined,
        defaultValue:
          definition.defaultParameterValue?.value === undefined || definition.defaultParameterValue.value === null
            ? undefined
            : String(definition.defaultParameterValue.value),
        choices: definition.choices,
      })),
    )
  }

  async build(job: string, build: string | number | undefined, signal?: AbortSignal) {
    const tree = [
      'number,result,building,duration,estimatedDuration,timestamp,url,displayName,description,builtOn',
      'actions[causes[shortDescription],parameters[name,value],failCount,skipCount,totalCount,lastBuiltRevision[SHA1,branch[name]]]',
      'changeSets[items[msg,commitId,author[fullName]]]',
      'artifacts[fileName,relativePath]',
    ].join(',')
    return this.rest.json<{
      number?: number
      result?: string | null
      building?: boolean
      duration?: number
      estimatedDuration?: number
      timestamp?: number
      url?: string
      displayName?: string
      description?: string | null
      builtOn?: string
      actions?: {
        causes?: { shortDescription?: string }[]
        parameters?: { name?: string; value?: unknown }[]
        failCount?: number
        skipCount?: number
        totalCount?: number
        lastBuiltRevision?: { SHA1?: string; branch?: { name?: string }[] }
      }[]
      changeSets?: { items?: { msg?: string; commitId?: string; author?: { fullName?: string } }[] }[]
      artifacts?: { fileName?: string; relativePath?: string }[]
    }>(
      `reading build ${String(build ?? 'last')} of ${job}`,
      `${jobPath(job, this.base)}/${buildRef(build)}/api/json?tree=${encodeURIComponent(tree)}`,
      { method: 'GET' },
      signal,
    )
  }

  /** Pipeline stages, when the Pipeline Stage View plugin answers. Undefined for a freestyle job. */
  async stages(job: string, build: string | number | undefined, signal?: AbortSignal): Promise<PipelineStage[] | undefined> {
    try {
      const described = await this.rest.json<{ stages?: { id?: string; name?: string; status?: string; durationMillis?: number }[] }>(
        'reading pipeline stages',
        `${jobPath(job, this.base)}/${buildRef(build)}/wfapi/describe`,
        { method: 'GET' },
        signal,
      )
      return (described.stages ?? []).map((stage) => ({
        id: stage.id ?? '',
        name: stage.name ?? '',
        status: stage.status ?? '?',
        durationMillis: stage.durationMillis,
      }))
    } catch {
      return undefined
    }
  }

  /** The log of one stage: each of its steps that did not succeed, or all of them when none failed. */
  async stageLog(job: string, build: string | number | undefined, stage: PipelineStage, signal?: AbortSignal): Promise<string> {
    const root = `${jobPath(job, this.base)}/${buildRef(build)}/execution/node`
    const described = await this.rest.json<{ stageFlowNodes?: { id?: string; name?: string; status?: string; parameterDescription?: string }[] }>(
      `reading stage ${stage.name}`,
      `${root}/${encodeURIComponent(stage.id)}/wfapi/describe`,
      { method: 'GET' },
      signal,
    )
    const nodes = described.stageFlowNodes ?? []
    const failing = nodes.filter((node) => node.status !== 'SUCCESS')
    const chosen = (failing.length > 0 ? failing : nodes).slice(0, 8)
    const parts: string[] = []
    for (const node of chosen) {
      const log = await this.rest
        .json<{ text?: string }>(`reading step ${node.name ?? ''}`, `${root}/${encodeURIComponent(node.id ?? '')}/wfapi/log`, { method: 'GET' }, signal)
        .catch(() => ({ text: '' }))
      const text = (log.text ?? '').replace(/<[^>]+>/g, '')
      parts.push(`--- step: ${node.name ?? '?'}${node.parameterDescription ? ` (${node.parameterDescription})` : ''} [${node.status ?? '?'}]\n${text.slice(-20_000)}`)
    }
    return parts.join('\n')
  }

  async testFailures(job: string, build: string | number | undefined, signal?: AbortSignal) {
    try {
      const report = await this.rest.json<{
        failCount?: number
        passCount?: number
        skipCount?: number
        suites?: { cases?: { className?: string; name?: string; status?: string; errorDetails?: string | null; errorStackTrace?: string | null }[] }[]
      }>(
        'reading test results',
        `${jobPath(job, this.base)}/${buildRef(build)}/testReport/api/json?tree=${encodeURIComponent('failCount,passCount,skipCount,suites[cases[className,name,status,errorDetails,errorStackTrace]]')}`,
        { method: 'GET' },
        signal,
      )
      const failed = (report.suites ?? [])
        .flatMap((suite) => suite.cases ?? [])
        .filter((testCase) => testCase.status === 'FAILED' || testCase.status === 'REGRESSION')
      return { failCount: report.failCount ?? failed.length, passCount: report.passCount ?? 0, skipCount: report.skipCount ?? 0, failed }
    } catch {
      return undefined
    }
  }

  /**
   * The console log, streamed: the last `tailBytes`, or — with `pattern` — only matching lines and
   * `context` lines either side. The whole log is never held.
   */
  async log(
    job: string,
    build: string | number | undefined,
    options: { tailBytes: number; pattern?: RegExp | undefined; context: number; maxMatches: number },
    signal?: AbortSignal,
  ): Promise<{ text: string; totalBytes: number; truncated: boolean; matches?: number }> {
    const response = await this.rest.send(
      `reading the log of ${job} #${String(build ?? 'last')}`,
      `${jobPath(job, this.base)}/${buildRef(build)}/consoleText`,
      { method: 'GET', headers: { Accept: 'text/plain' } },
      signal,
    )
    const reader = response.body?.getReader()
    if (reader === undefined) {
      const text = await response.text()
      return { text: text.slice(-options.tailBytes), totalBytes: text.length, truncated: text.length > options.tailBytes }
    }
    const decoder = new TextDecoder()
    let totalBytes = 0
    let tail = ''
    let partial = ''
    const recent: string[] = []
    const kept: string[] = []
    let matches = 0
    let after = 0
    let lineNumber = 0
    const consume = (line: string): void => {
      lineNumber += 1
      if (options.pattern === undefined) return
      if (options.pattern.test(line)) {
        matches += 1
        if (matches <= options.maxMatches) {
          if (kept.length > 0 && recent.length > 0 && after === 0) kept.push('--')
          for (const [index, before] of recent.entries()) kept.push(`${String(lineNumber - recent.length + index)}- ${before}`)
          kept.push(`${String(lineNumber)}: ${line}`)
          after = options.context
        }
        recent.length = 0
        return
      }
      if (after > 0 && matches <= options.maxMatches) {
        kept.push(`${String(lineNumber)}- ${line}`)
        after -= 1
        return
      }
      recent.push(line)
      if (recent.length > options.context) recent.shift()
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      const chunk = decoder.decode(value, { stream: true })
      if (options.pattern === undefined) {
        tail = (tail + chunk).slice(-options.tailBytes)
      } else {
        const lines = (partial + chunk).split('\n')
        partial = lines.pop() ?? ''
        for (const line of lines) consume(line.replace(/\r$/, ''))
      }
    }
    if (options.pattern !== undefined) {
      if (partial.length > 0) consume(partial)
      return { text: kept.join('\n'), totalBytes, truncated: matches > options.maxMatches, matches }
    }
    return { text: tail, totalBytes, truncated: totalBytes > options.tailBytes }
  }

  async queue(signal?: AbortSignal) {
    const result = await this.rest.json<{
      items?: { id?: number; why?: string; inQueueSince?: number; stuck?: boolean; blocked?: boolean; task?: { name?: string; url?: string } }[]
    }>('reading the queue', `/queue/api/json?tree=${encodeURIComponent('items[id,why,inQueueSince,stuck,blocked,task[name,url]]')}`, { method: 'GET' }, signal)
    return result.items ?? []
  }

  async agents(signal?: AbortSignal) {
    const result = await this.rest.json<{
      computer?: { displayName?: string; offline?: boolean; temporarilyOffline?: boolean; offlineCauseReason?: string; idle?: boolean; numExecutors?: number }[]
    }>(
      'reading agents',
      `/computer/api/json?tree=${encodeURIComponent('computer[displayName,offline,temporarilyOffline,offlineCauseReason,idle,numExecutors]')}`,
      { method: 'GET' },
      signal,
    )
    return result.computer ?? []
  }

  /**
   * A POST, with a CSRF crumb fetched only if Jenkins asks for one. An API-token request is exempt on
   * current Jenkins; an older or stricter one answers 403 mentioning the crumb, and gets one retry.
   */
  private async post(doing: string, pathAndQuery: string, form: Record<string, string>, signal?: AbortSignal) {
    const body = new URLSearchParams(form).toString()
    const send = () =>
      this.rest.send(
        doing,
        pathAndQuery,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...(this.crumb !== undefined ? { [this.crumb.field]: this.crumb.value } : {}),
          },
          body,
        },
        signal,
      )
    try {
      return await send()
    } catch (error) {
      if (!(error instanceof AtlassianError) || error.status !== 403 || this.crumb !== undefined || !/crumb/i.test(error.message)) throw error
      const issued = await this.rest.json<{ crumbRequestField?: string; crumb?: string }>('asking for a CSRF crumb', '/crumbIssuer/api/json', { method: 'GET' }, signal)
      if (issued.crumbRequestField === undefined || issued.crumb === undefined) throw error
      this.crumb = { field: issued.crumbRequestField, value: issued.crumb }
      return send()
    }
  }

  /** Queues a build, then follows the queue item briefly to learn its number. */
  async startBuild(
    job: string,
    parameters: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<{ queueUrl?: string; number?: number; why?: string }> {
    const path = jobPath(job, this.base)
    const response = await this.post(
      `starting ${job}`,
      parameters !== undefined && Object.keys(parameters).length > 0 ? `${path}/buildWithParameters` : `${path}/build`,
      parameters ?? {},
      signal,
    )
    const location = response.headers['location']
    const queueId = location === undefined ? undefined : /\/queue\/item\/(\d+)/.exec(location)?.[1]
    if (queueId === undefined) return {}
    let why: string | undefined
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const item = await this.rest
        .json<{ executable?: { number?: number } | null; why?: string | null; cancelled?: boolean }>(
          'following the queued build',
          `/queue/item/${queueId}/api/json`,
          { method: 'GET' },
          signal,
        )
        .catch(() => undefined)
      if (item?.executable?.number !== undefined) return { queueUrl: location ?? '', number: item.executable.number }
      if (item?.cancelled === true) return { queueUrl: location ?? '', why: 'The queued build was cancelled.' }
      why = item?.why ?? why
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return { ...(location !== undefined ? { queueUrl: location } : {}), ...(why !== undefined ? { why } : {}) }
  }

  async stopBuild(job: string, build: string | number, signal?: AbortSignal): Promise<void> {
    await this.post(`stopping ${job} #${String(build)}`, `${jobPath(job, this.base)}/${buildRef(build)}/stop`, {}, signal)
  }

  /** The declarative linter. Read-only on the server; answers in plain text. */
  async validateJenkinsfile(text: string, signal?: AbortSignal): Promise<string> {
    const response = await this.post('validating a Jenkinsfile', '/pipeline-model-converter/validate', { jenkinsfile: text }, signal)
    return (await response.text()).trim()
  }

  /**
   * Replays a pipeline build with a different main script — Jenkins' own way to try a change to a
   * Jenkinsfile with the job's real agents, parameters and credentials, without committing it.
   */
  async replay(job: string, build: string | number, script: string, signal?: AbortSignal): Promise<{ number?: number }> {
    const before = await this.job(job, signal).catch(() => undefined)
    const previous = before?.lastBuild?.number ?? 0
    await this.post(
      `replaying ${job} #${String(build)}`,
      `${jobPath(job, this.base)}/${buildRef(build)}/replay/run`,
      { mainScript: script, json: JSON.stringify({ mainScript: script }) },
      signal,
    )
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const now = await this.job(job, signal).catch(() => undefined)
      const latest = now?.lastBuild?.number
      if (latest !== undefined && latest > previous) return { number: latest }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return {}
  }
}

// -------------------------------------------------------------------------------------------------
// Tools

export interface JenkinsToolOptions {
  client: () => Promise<JenkinsClient>
  /** Used when a request names no job. */
  defaultJob?: string | undefined
}

function errorResult(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true }
}

const jobParam = (options: JenkinsToolOptions) =>
  z
    .string()
    .optional()
    .describe(
      'The job, as folder/name (e.g. platform/service-api) or its URL.' +
        (options.defaultJob !== undefined ? ` Defaults to ${options.defaultJob}.` : ''),
    )

function jobOf(options: JenkinsToolOptions, job: string | undefined): string {
  const chosen = job?.trim() || options.defaultJob
  if (chosen === undefined || chosen.length === 0) {
    throw new AtlassianError('Name a job — none was given and no default job is configured (Settings → DevOps → Jenkins).')
  }
  return chosen
}

const buildParam = z
  .union([z.number().int().positive(), z.string()])
  .optional()
  .describe('A build number, or last, lastFailed, lastSuccessful, lastCompleted. Default last.')

// --- find jobs

const findSchema = z.object({
  query: z.string().optional().describe('Words in the job name or folder. Omit to list everything.'),
  folder: z.string().optional().describe('Only inside this folder.'),
  limit: z.number().int().min(1).max(100).optional().describe('How many. Default 30.'),
})

export function createJenkinsFindJobsTool(options: JenkinsToolOptions): Tool<z.infer<typeof findSchema>> {
  return {
    name: 'jenkins_find_jobs',
    group: 'read',
    description: 'Find Jenkins jobs by name or folder, with each job’s last status. Folders are opened three levels deep.',
    parametersSchema: findSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const jobs = await (await options.client()).listJobs(params.folder)
        const words = (params.query ?? '').toLowerCase().split(/\s+/).filter((word) => word.length > 0)
        const matching = jobs.filter((job) => words.every((word) => job.fullName.toLowerCase().includes(word)))
        const shown = matching.slice(0, params.limit ?? 30)
        if (shown.length === 0) return { content: `No Jenkins jobs match${params.query !== undefined ? `: ${params.query}` : '.'}` }
        return {
          content: [
            `${String(matching.length)} job(s)${matching.length > shown.length ? `, showing ${String(shown.length)}` : ''}:`,
            ...shown.map((job) => `- ${job.fullName}  [${job.status}]  ${job.url}`),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

// --- job

export function createJenkinsJobTool(options: JenkinsToolOptions) {
  const schema = z.object({ job: jobParam(options) })
  const tool: Tool<z.infer<typeof schema>> = {
    name: 'jenkins_job',
    group: 'read',
    description:
      'Read a Jenkins job: health, whether it is building or queued, its last ten builds with results and durations, the last good and last failed build, and the parameters it takes with their defaults and choices.',
    parametersSchema: schema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const job = jobOf(options, params.job)
        const info = await client.job(job)
        const parameters = await client.parameters(job).catch(() => [])
        return {
          content: [
            `${info.fullName ?? job}  [${status(info.color)}]${info.inQueue === true ? '  (queued)' : ''}${info.buildable === false ? '  (disabled)' : ''}`,
            `Link: ${info.url ?? ''}`,
            ...(info.description ? [`Description: ${info.description}`] : []),
            ...(info.healthReport ?? []).map((report) => `Health: ${report.description ?? ''} (${String(report.score ?? '?')}%)`),
            `Last success: ${info.lastSuccessfulBuild?.number !== undefined ? `#${String(info.lastSuccessfulBuild.number)} at ${when(info.lastSuccessfulBuild.timestamp)}` : 'none'}`,
            `Last failure: ${info.lastFailedBuild?.number !== undefined ? `#${String(info.lastFailedBuild.number)} at ${when(info.lastFailedBuild.timestamp)}` : 'none'}`,
            '',
            'Recent builds:',
            ...(info.builds ?? []).map(
              (build) =>
                `- #${String(build.number ?? '?')}  ${build.building === true ? 'BUILDING' : (build.result ?? '?')}  ${when(build.timestamp)}  ${duration(build.duration)}`,
            ),
            ...(parameters.length > 0
              ? [
                  '',
                  'Parameters:',
                  ...parameters.map(
                    (parameter) =>
                      `- ${parameter.name} (${parameter.type})${parameter.defaultValue !== undefined ? ` default "${parameter.defaultValue}"` : ''}${
                        parameter.choices !== undefined && parameter.choices.length > 0 ? ` one of: ${parameter.choices.join(', ')}` : ''
                      }${parameter.description ? ` — ${parameter.description}` : ''}`,
                  ),
                ]
              : []),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
  return tool
}

// --- build

export function createJenkinsBuildTool(options: JenkinsToolOptions) {
  const schema = z.object({ job: jobParam(options), build: buildParam })
  const tool: Tool<z.infer<typeof schema>> = {
    name: 'jenkins_build',
    group: 'read',
    description:
      'Read one Jenkins build: result, what started it, its parameters, the commits in it, pipeline stages with their status, failed tests with their errors, and artifacts. Start here to find out why a build failed, then read the failing stage’s log with jenkins_build_log.',
    parametersSchema: schema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const job = jobOf(options, params.job)
        const build = await client.build(job, params.build)
        const stages = await client.stages(job, params.build)
        const tests = await client.testFailures(job, params.build)
        const actions = build.actions ?? []
        const causes = actions.flatMap((action) => action.causes ?? []).map((cause) => cause.shortDescription ?? '')
        const parameters = actions.flatMap((action) => action.parameters ?? [])
        const revision = actions.find((action) => action.lastBuiltRevision !== undefined)?.lastBuiltRevision
        const changes = (build.changeSets ?? []).flatMap((set) => set.items ?? [])
        return {
          content: [
            `${job} ${build.displayName ?? `#${String(build.number ?? '?')}`}: ${build.building === true ? 'BUILDING' : (build.result ?? '?')}`,
            `Started ${when(build.timestamp)}, took ${duration(build.duration)}${build.builtOn ? ` on ${build.builtOn}` : ''}`,
            `Link: ${build.url ?? ''}`,
            ...(causes.length > 0 ? [`Started by: ${causes.join('; ')}`] : []),
            ...(revision?.SHA1 !== undefined ? [`Revision: ${revision.SHA1}${revision.branch?.[0]?.name ? ` (${revision.branch[0].name})` : ''}`] : []),
            ...(parameters.length > 0 ? ['Parameters:', ...parameters.map((parameter) => `- ${parameter.name ?? '?'} = ${JSON.stringify(parameter.value)}`)] : []),
            ...(changes.length > 0
              ? ['Changes:', ...changes.slice(0, 20).map((change) => `- ${change.commitId?.slice(0, 10) ?? ''} ${change.author?.fullName ?? ''}: ${(change.msg ?? '').split('\n')[0]}`)]
              : []),
            ...(stages !== undefined && stages.length > 0
              ? ['Stages:', ...stages.map((stage) => `- ${stage.name}: ${stage.status} (${duration(stage.durationMillis)})`)]
              : []),
            ...(tests !== undefined
              ? [
                  `Tests: ${String(tests.failCount)} failed, ${String(tests.passCount)} passed, ${String(tests.skipCount)} skipped`,
                  ...tests.failed.slice(0, 15).map(
                    (testCase) =>
                      `- ${testCase.className ?? ''}.${testCase.name ?? ''}: ${(testCase.errorDetails ?? testCase.errorStackTrace ?? '').split('\n').slice(0, 4).join(' | ').slice(0, 400)}`,
                  ),
                ]
              : []),
            ...((build.artifacts ?? []).length > 0 ? [`Artifacts: ${(build.artifacts ?? []).map((artifact) => artifact.relativePath ?? artifact.fileName).join(', ')}`] : []),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
  return tool
}

// --- log

export function createJenkinsBuildLogTool(options: JenkinsToolOptions) {
  const schema = z.object({
    job: jobParam(options),
    build: buildParam,
    stage: z.string().optional().describe('A pipeline stage name: returns the log of that stage’s failed steps (or all its steps if none failed).'),
    search: z.string().optional().describe('A regular expression: returns only matching lines, with context. Try "ERROR|FAILED|Exception".'),
    tailKb: z.number().int().min(1).max(512).optional().describe('Without search or stage: how much of the end of the log, in KB. Default 32.'),
  })
  const tool: Tool<z.infer<typeof schema>> = {
    name: 'jenkins_build_log',
    group: 'read',
    description:
      'Read a Jenkins build’s console log without loading all of it: the end of it, only lines matching a pattern, or one pipeline stage’s steps. Use jenkins_build first to see which stage failed.',
    parametersSchema: schema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const job = jobOf(options, params.job)
        if (params.stage !== undefined) {
          const stages = await client.stages(job, params.build)
          if (stages === undefined) return { content: 'This build has no pipeline stages to read (it may be a freestyle job). Use search or the tail instead.', isError: true }
          const wanted = params.stage.trim().toLowerCase()
          const stage = stages.find((entry) => entry.name.toLowerCase() === wanted) ?? stages.find((entry) => entry.name.toLowerCase().includes(wanted))
          if (stage === undefined) return { content: `No stage "${params.stage}". Stages: ${stages.map((entry) => entry.name).join(', ')}`, isError: true }
          return { content: `Stage ${stage.name} [${stage.status}] of ${job} #${String(params.build ?? 'last')}:\n${await client.stageLog(job, params.build, stage)}` }
        }
        let pattern: RegExp | undefined
        if (params.search !== undefined) {
          try {
            pattern = new RegExp(params.search, 'i')
          } catch (error) {
            return { content: `Not a valid pattern: ${error instanceof Error ? error.message : String(error)}`, isError: true }
          }
        }
        const tailBytes = (params.tailKb ?? 32) * 1024
        const log = await client.log(job, params.build, { tailBytes, pattern, context: 3, maxMatches: 60 })
        const size = `${(log.totalBytes / 1024).toFixed(0)} KB`
        if (pattern !== undefined) {
          return {
            content:
              log.matches === 0
                ? `No lines match /${params.search ?? ''}/ in the log (${size}).`
                : `${String(log.matches ?? 0)} matching line(s) in the ${size} log${log.truncated ? ', first 60 shown' : ''}:\n${log.text}`,
          }
        }
        return { content: `${log.truncated ? `Last ${String(params.tailKb ?? 32)} KB of a ${size} log:` : `Log (${size}):`}\n${log.text}` }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
  return tool
}

// --- queue and agents

const queueSchema = z.object({})

export function createJenkinsQueueTool(options: JenkinsToolOptions): Tool<z.infer<typeof queueSchema>> {
  return {
    name: 'jenkins_queue',
    group: 'read',
    description: 'What Jenkins is waiting on: queued builds with the reason each is waiting, and agents that are offline or busy. Use it when a build will not start.',
    parametersSchema: queueSchema,
    async execute(): Promise<ToolResult> {
      try {
        const client = await options.client()
        const queue = await client.queue()
        const agents = await client.agents().catch(() => [])
        const offline = agents.filter((agent) => agent.offline === true)
        return {
          content: [
            queue.length === 0 ? 'Nothing is queued.' : `${String(queue.length)} queued:`,
            ...queue.map(
              (item) =>
                `- ${item.task?.name ?? '?'} since ${when(item.inQueueSince)}${item.stuck === true ? ' (stuck)' : ''}${item.blocked === true ? ' (blocked)' : ''}: ${item.why ?? ''}`,
            ),
            '',
            `Agents: ${String(agents.length)}, ${String(offline.length)} offline, ${String(agents.filter((agent) => agent.offline !== true && agent.idle === false).length)} busy.`,
            ...offline.map((agent) => `- ${agent.displayName ?? '?'} offline${agent.temporarilyOffline === true ? ' (taken offline)' : ''}${agent.offlineCauseReason ? `: ${agent.offlineCauseReason}` : ''}`),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

// --- start and stop

export function createJenkinsStartBuildTool(options: JenkinsToolOptions) {
  const schema = z.object({
    job: jobParam(options),
    parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Build parameters by name. Unset ones take the job’s defaults. See jenkins_job for what it takes.'),
  })
  type Params = z.infer<typeof schema>
  const asStrings = (parameters: Params['parameters']): Record<string, string> | undefined =>
    parameters === undefined ? undefined : Object.fromEntries(Object.entries(parameters).map(([name, value]) => [name, String(value)]))
  const tool: Tool<Params> = {
    name: 'jenkins_start_build',
    group: 'command',
    description:
      'Start a Jenkins build now, with parameters if the job takes them. It runs on shared CI under the user’s name, so it is always shown to the user first. Returns the build number when Jenkins starts it within a few seconds.',
    parametersSchema: schema,
    async preview(params): Promise<ToolPreview> {
      const client = await options.client()
      const job = jobOf(options, params.job)
      const known = await client.parameters(job).catch(() => [] as JenkinsParameter[])
      const given = asStrings(params.parameters) ?? {}
      const unknown = Object.keys(given).filter((name) => !known.some((parameter) => parameter.name === name))
      return {
        kind: 'text',
        text: [
          `Start a build of ${job}`,
          `${client.base}${jobPath(job, client.base)}/`,
          ...(Object.keys(given).length > 0 ? ['Parameters:', ...Object.entries(given).map(([name, value]) => `- ${name} = ${value}`)] : ['No parameters: the job’s defaults apply.']),
          ...known.filter((parameter) => !(parameter.name in given)).map((parameter) => `- ${parameter.name} = ${parameter.defaultValue ?? '(empty)'}  (default)`),
          ...(unknown.length > 0 ? [`Not parameters of this job, and Jenkins will ignore them: ${unknown.join(', ')}`] : []),
        ].join('\n'),
      }
    },
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const job = jobOf(options, params.job)
        const started = await client.startBuild(job, asStrings(params.parameters))
        if (started.number !== undefined) {
          return { content: `Started ${job} #${String(started.number)}.\nLink: ${client.base}${jobPath(job, client.base)}/${String(started.number)}/` }
        }
        return {
          content: `Queued ${job}; it has not started yet${started.why ? `: ${started.why}` : '.'} ${started.queueUrl ? `Queue item: ${started.queueUrl}` : ''} Use jenkins_queue or jenkins_job to follow it.`,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
  return tool
}

export function createJenkinsStopBuildTool(options: JenkinsToolOptions) {
  const schema = z.object({ job: jobParam(options), build: z.union([z.number().int().positive(), z.string()]).describe('The build number to stop.') })
  const tool: Tool<z.infer<typeof schema>> = {
    name: 'jenkins_stop_build',
    group: 'command',
    description: 'Abort a running Jenkins build. Always shown to the user first.',
    parametersSchema: schema,
    async preview(params): Promise<ToolPreview> {
      const client = await options.client()
      const job = jobOf(options, params.job)
      const build = await client.build(job, params.build).catch(() => undefined)
      return {
        kind: 'text',
        text: `Abort ${job} #${String(params.build)}${build !== undefined ? ` — currently ${build.building === true ? 'running' : (build.result ?? '?')}, started ${when(build.timestamp)}` : ''}\n${client.base}${jobPath(job, client.base)}/${buildRef(params.build)}/`,
      }
    },
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const job = jobOf(options, params.job)
        await client.stopBuild(job, params.build)
        return { content: `Asked Jenkins to abort ${job} #${String(params.build)}.` }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
  return tool
}

// --- Jenkinsfile

async function readJenkinsfile(path: string, context: ToolExecutionContext): Promise<{ ok: true; text: string; realPath: string } | { ok: false; message: string }> {
  const resolved = await resolveToolPath(context, path)
  if (!resolved.ok) return { ok: false, message: resolved.message }
  try {
    return { ok: true, text: await context.fs.readFile(resolved.realPath), realPath: resolved.realPath }
  } catch (error) {
    return { ok: false, message: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const checkSchema = z.object({
  path: z.string().optional().describe('The Jenkinsfile in the workspace. Default Jenkinsfile.'),
})

export function createJenkinsCheckJenkinsfileTool(options: JenkinsToolOptions): Tool<z.infer<typeof checkSchema>> {
  return {
    name: 'jenkins_check_jenkinsfile',
    group: 'read',
    description:
      'Validate a local declarative Jenkinsfile with the configured Jenkins’s own linter, which knows its plugins and syntax. Changes nothing on Jenkins. Run it before trying a Jenkinsfile with jenkins_try_jenkinsfile.',
    parametersSchema: checkSchema,
    async execute(params, context): Promise<ToolResult> {
      try {
        const file = await readJenkinsfile(params.path ?? 'Jenkinsfile', context)
        if (!file.ok) return { content: file.message, isError: true }
        const answer = await (await options.client()).validateJenkinsfile(file.text)
        const ok = /successfully validated/i.test(answer)
        return {
          content: `${file.realPath}: ${answer}${ok ? '' : '\n(The linter checks declarative pipelines; a scripted pipeline can only be tried with jenkins_try_jenkinsfile.)'}`,
          ...(ok ? {} : { isError: true }),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

export function createJenkinsTryJenkinsfileTool(options: JenkinsToolOptions) {
  const schema = z.object({
    job: jobParam(options),
    path: z.string().optional().describe('The local Jenkinsfile to run. Default Jenkinsfile.'),
    build: z
      .union([z.number().int().positive(), z.string()])
      .optional()
      .describe('The build to replay — its parameters and revision are reused. Default last.'),
    waitMinutes: z
      .number()
      .int()
      .min(0)
      .max(30)
      .optional()
      .describe(
        'Wait this long for the run to finish and report whether it worked, with the failing stage and the end of its log if not. 0 returns as soon as it starts. Default 10.',
      ),
  })
  type Params = z.infer<typeof schema>
  const tool: Tool<Params> = {
    name: 'jenkins_try_jenkinsfile',
    group: 'command',
    description:
      'Find out whether a locally edited Jenkinsfile actually runs on Jenkins, without committing it: Jenkins Replay re-runs a recent build of a pipeline job with the local file as its script, on the job’s own agents, parameters and credentials, and this waits for the result — success, or the failing stage and the end of its log. Check the file with jenkins_check_jenkinsfile first; this one really runs, so it is always shown to the user first, with the whole file. Needs an existing pipeline job that has run at least once, and the Replay permission.',
    parametersSchema: schema,
    async preview(params, context): Promise<ToolPreview> {
      const client = await options.client()
      const job = jobOf(options, params.job)
      const file = await readJenkinsfile(params.path ?? 'Jenkinsfile', context)
      if (!file.ok) return { kind: 'text', text: `${file.message} — this will be refused.` }
      return {
        kind: 'text',
        text: [
          `Replay ${job} #${String(params.build ?? 'last')} with ${file.realPath} as its pipeline script.`,
          'It runs on the job’s agents with its credentials and the replayed build’s parameters and revision.',
          `${client.base}${jobPath(job, client.base)}/${buildRef(params.build)}/replay`,
          '',
          file.text,
        ].join('\n'),
      }
    },
    async execute(params, context): Promise<ToolResult> {
      try {
        const client = await options.client()
        const job = jobOf(options, params.job)
        const file = await readJenkinsfile(params.path ?? 'Jenkinsfile', context)
        if (!file.ok) return { content: file.message, isError: true }
        const ref = buildRef(params.build)
        const started = await client.replay(job, ref, file.text)
        if (started.number !== undefined) {
          const link = `${client.base}${jobPath(job, client.base)}/${String(started.number)}/`
          const waitMs = (params.waitMinutes ?? 10) * 60_000
          if (waitMs === 0) return { content: `Replaying as ${job} #${String(started.number)} with ${file.realPath}.\nLink: ${link}` }
          const finished = await waitForBuild(client, job, started.number, waitMs, context.signal)
          if (finished === undefined) {
            return {
              content: `Replaying as ${job} #${String(started.number)} with ${file.realPath} — still running after ${String(params.waitMinutes ?? 10)} minute(s). Follow it with jenkins_build.\nLink: ${link}`,
            }
          }
          if (finished.result === 'SUCCESS') {
            return { content: `${file.realPath} ran successfully as ${job} #${String(started.number)} (${duration(finished.duration)}).\nLink: ${link}` }
          }
          return {
            content: [
              `${file.realPath} did not run cleanly: ${job} #${String(started.number)} ended ${finished.result ?? '?'} after ${duration(finished.duration)}.`,
              `Link: ${link}`,
              await explainFailure(client, job, started.number),
            ].join('\n'),
            isError: true,
          }
        }
        return { content: `Jenkins accepted the replay of ${job} #${ref}, but the new build has not appeared yet. Check jenkins_job in a moment.` }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
  return tool
}

/** Polls a build until it stops building. Undefined if it is still running when the time is up. */
async function waitForBuild(
  client: JenkinsClient,
  job: string,
  number: number,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<{ result?: string | null | undefined; duration?: number | undefined } | undefined> {
  const deadline = Date.now() + waitMs
  for (;;) {
    if (signal?.aborted === true) return undefined
    const build = await client.build(job, number, signal).catch(() => undefined)
    if (build !== undefined && build.building === false) return { result: build.result, duration: build.duration }
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}

/** Why a build failed, briefly: the failed stages with their failing steps' logs, else the log's end. */
async function explainFailure(client: JenkinsClient, job: string, number: number): Promise<string> {
  const stages = await client.stages(job, number)
  const failed = (stages ?? []).filter((stage) => stage.status !== 'SUCCESS' && stage.status !== 'NOT_EXECUTED')
  if (failed.length > 0) {
    const parts: string[] = []
    for (const stage of failed.slice(0, 2)) {
      const log = await client.stageLog(job, number, stage).catch(() => '')
      parts.push(`Stage ${stage.name} [${stage.status}]:\n${log.slice(-6000)}`)
    }
    return parts.join('\n')
  }
  const tail = await client.log(job, number, { tailBytes: 6000, context: 0, maxMatches: 0 }).catch(() => undefined)
  return tail === undefined ? '' : `End of the log:\n${tail.text}`
}

/** Every Jenkins tool, in the order they are registered. */
export function createJenkinsTools(options: JenkinsToolOptions): Tool<never>[] {
  return [
    createJenkinsFindJobsTool(options),
    createJenkinsJobTool(options),
    createJenkinsBuildTool(options),
    createJenkinsBuildLogTool(options),
    createJenkinsQueueTool(options),
    createJenkinsStartBuildTool(options),
    createJenkinsStopBuildTool(options),
    createJenkinsCheckJenkinsfileTool(options),
    createJenkinsTryJenkinsfileTool(options),
  ] as unknown as Tool<never>[]
}
