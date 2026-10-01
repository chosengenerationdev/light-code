import { z } from 'zod'

import type { HttpClient } from '../platform/http.js'
import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import { AtlassianError, AtlassianRest, type AtlassianConnection } from './rest.js'

/**
 * AutoSys Workload Automation, through its REST web services (AEWS).
 *
 * ## Same shape as the other DevOps sites
 *
 * A site, a credential in secret storage, the shared TLS resolver and the one `HttpClient`
 * (invariant 2) — so it rides `AtlassianRest` like Jenkins does. The credential is a username and
 * password, sent as HTTP Basic, which is how AEWS authenticates.
 *
 * ## The paths are configurable, and why
 *
 * AEWS has been reshaped across releases, and sites front it differently (a context path, a proxy
 * prefix). The defaults below follow the documented layout — `/AEWS/job`, `/AEWS/job-run-info`,
 * `/AEWS/event`, `/AEWS/jil` — but every request goes through a template that `autosys.paths` can
 * override, so a server that answers elsewhere is a config edit rather than a release. The job-log
 * endpoint varies most of all; when it is absent, the log tool says where the job writes its output
 * instead of failing with nothing to go on.
 *
 * ## What always asks
 *
 * Reading — finding jobs, a job's definition, run status, logs — is `read`. **Sending an event**
 * (force-start, kill, hold, ice, change status) **and applying JIL** change production schedules
 * under the user's name; both are `command`, in `ALWAYS_ASK_TOOLS`, never available to a schedule,
 * and each preview shows the literal event or the whole JIL (invariant 8).
 */

export interface AutosysPaths {
  /** Jobs whose name matches `{pattern}` (`*` wildcards). */
  jobs: string
  /** One job's definition. */
  job: string
  /** Run status of jobs matching `{pattern}`. */
  runInfo: string
  /** Run status of one job. */
  jobRunInfo: string
  /** A box's members. */
  boxMembers: string
  /** Where events are POSTed. */
  event: string
  /** Where JIL is POSTed. */
  jil: string
  /** A job's log: `{job}`, `{runNum}` (may be empty), `{type}` (stdout, stderr). */
  log: string
}

export const DEFAULT_AUTOSYS_PATHS: AutosysPaths = {
  jobs: '/AEWS/job?filter={filter:name}',
  job: '/AEWS/job/{job}',
  runInfo: '/AEWS/job-run-info?filter={filter:name}',
  jobRunInfo: '/AEWS/job-run-info/{job}',
  boxMembers: '/AEWS/job?filter={filter:boxName}',
  event: '/AEWS/event',
  jil: '/AEWS/jil',
  log: '/AEWS/job-log/{job}?runNum={runNum}&type={type}',
}

/** Job names are letters, digits and `._-#` in AutoSys; `*` is allowed only where a pattern is. */
export function isAutosysName(name: string, pattern = false): boolean {
  return (pattern ? /^[A-Za-z0-9._#*-]{1,64}$/ : /^[A-Za-z0-9._#-]{1,64}$/).test(name)
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(filter:)?(\w+)\}/g, (_, filter: string | undefined, key: string) => {
    if (filter !== undefined) {
      // FIQL: `name==PAY_*`. The value is checked before it gets here, so only encoding remains.
      return encodeURIComponent(`${key}==${values['pattern'] ?? values[key] ?? ''}`)
    }
    return encodeURIComponent(values[key] ?? '')
  })
}

/** Whatever a list endpoint returns — an array, or an object holding one — as an array. */
function asList(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[]
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(inner)) return inner as Record<string, unknown>[]
    }
    return [value as Record<string, unknown>]
  }
  return []
}

function field(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name]
    if (value !== undefined && value !== null && value !== '') return String(value)
  }
  return undefined
}

/** A definition as `attribute: value` lines, the way JIL reads, whatever shape the server used. */
export function renderDefinition(record: Record<string, unknown>, indent = ''): string[] {
  const lines: string[] = []
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || value === '') continue
    if (typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${indent}${key}:`, ...renderDefinition(value as Record<string, unknown>, `${indent}  `))
    } else {
      lines.push(`${indent}${key}: ${Array.isArray(value) ? value.map(String).join(', ') : String(value)}`)
    }
  }
  return lines
}

export interface AutosysRun {
  name: string
  status: string
  lastStart?: string | undefined
  lastEnd?: string | undefined
  exitCode?: string | undefined
  runNum?: string | undefined
  machine?: string | undefined
}

function toRun(record: Record<string, unknown>): AutosysRun {
  return {
    name: field(record, 'name', 'jobName', 'job_name') ?? '?',
    status: field(record, 'status', 'jobStatus') ?? '?',
    lastStart: field(record, 'lastStart', 'lastStartTime', 'last_start'),
    lastEnd: field(record, 'lastEnd', 'lastEndTime', 'last_end'),
    exitCode: field(record, 'exitCode', 'exit_code', 'lastExitCode'),
    runNum: field(record, 'runNum', 'run_num', 'runNumber'),
    machine: field(record, 'machine', 'runMachine', 'run_machine'),
  }
}

function describeRun(run: AutosysRun): string {
  return [
    `${run.name}: ${run.status}`,
    run.lastStart !== undefined ? `started ${run.lastStart}` : undefined,
    run.lastEnd !== undefined ? `ended ${run.lastEnd}` : undefined,
    run.exitCode !== undefined ? `exit ${run.exitCode}` : undefined,
    run.runNum !== undefined ? `run ${run.runNum}` : undefined,
    run.machine !== undefined ? `on ${run.machine}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ')
}

export const AUTOSYS_EVENTS = [
  'FORCE_STARTJOB',
  'STARTJOB',
  'KILLJOB',
  'JOB_ON_HOLD',
  'JOB_OFF_HOLD',
  'JOB_ON_ICE',
  'JOB_OFF_ICE',
  'JOB_ON_NOEXEC',
  'JOB_OFF_NOEXEC',
  'CHANGE_STATUS',
  'CHANGE_PRIORITY',
  'COMMENT',
] as const
export type AutosysEvent = (typeof AUTOSYS_EVENTS)[number]

export class AutosysClient {
  private readonly rest: AtlassianRest
  private readonly paths: AutosysPaths

  constructor(http: HttpClient, connection: AtlassianConnection, paths?: Partial<AutosysPaths>) {
    this.rest = new AtlassianRest(http, 'autosys', connection)
    this.paths = { ...DEFAULT_AUTOSYS_PATHS, ...(paths ?? {}) }
  }

  get base(): string {
    return this.rest.base
  }

  /** Signs in and lists nothing: proves the credential and the path without fetching every job. */
  async probe(username: string, signal?: AbortSignal): Promise<string> {
    await this.rest.json('signing in', fill(this.paths.runInfo, { pattern: 'LIGHTCODE_PROBE_NO_SUCH_JOB*' }), { method: 'GET' }, signal)
    return username
  }

  async findJobs(pattern: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    if (!isAutosysName(pattern, true)) throw new AtlassianError(`"${pattern}" is not a job name or pattern — letters, digits, . _ - # and * only.`)
    return asList(await this.rest.json('finding jobs', fill(this.paths.jobs, { pattern }), { method: 'GET' }, signal))
  }

  async job(name: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!isAutosysName(name)) throw new AtlassianError(`"${name}" is not a job name.`)
    const found = asList(await this.rest.json(`reading job ${name}`, fill(this.paths.job, { job: name }), { method: 'GET' }, signal))
    const first = found[0]
    if (first === undefined) throw new AtlassianError(`No AutoSys job called ${name}.`)
    return first
  }

  async boxMembers(box: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    return asList(await this.rest.json(`listing the jobs in box ${box}`, fill(this.paths.boxMembers, { pattern: box, boxName: box }), { method: 'GET' }, signal))
  }

  async runInfo(pattern: string, signal?: AbortSignal): Promise<AutosysRun[]> {
    if (!isAutosysName(pattern, true)) throw new AtlassianError(`"${pattern}" is not a job name or pattern.`)
    const path = pattern.includes('*') ? fill(this.paths.runInfo, { pattern }) : fill(this.paths.jobRunInfo, { job: pattern })
    return asList(await this.rest.json(`reading the status of ${pattern}`, path, { method: 'GET' }, signal)).map(toRun)
  }

  /** A job's log, or undefined when this server has no log endpoint (404). */
  async log(name: string, runNum: string | undefined, type: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!isAutosysName(name)) throw new AtlassianError(`"${name}" is not a job name.`)
    try {
      const response = await this.rest.send(
        `reading the ${type} log of ${name}`,
        fill(this.paths.log, { job: name, runNum: runNum ?? '', type }),
        { method: 'GET', headers: { Accept: 'text/plain, application/json' } },
        signal,
      )
      const text = await response.text()
      try {
        const parsed = JSON.parse(text) as unknown
        const content = asList(parsed)
          .map((entry) => field(entry, 'content', 'log', 'text', 'data'))
          .filter((entry): entry is string => entry !== undefined)
        return content.length > 0 ? content.join('\n') : text
      } catch {
        return text
      }
    } catch (error) {
      if (error instanceof AtlassianError && error.status === 404) return undefined
      throw error
    }
  }

  async sendEvent(
    event: AutosysEvent,
    name: string,
    extra: { status?: string | undefined; priority?: number | undefined; comment?: string | undefined },
    signal?: AbortSignal,
  ): Promise<string> {
    if (!isAutosysName(name)) throw new AtlassianError(`"${name}" is not a job name.`)
    const response = await this.rest.send(
      `sending ${event} for ${name}`,
      this.paths.event,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: event,
          jobName: name,
          ...(extra.status !== undefined ? { status: extra.status } : {}),
          ...(extra.priority !== undefined ? { priority: extra.priority } : {}),
          ...(extra.comment !== undefined ? { comment: extra.comment } : {}),
        }),
      },
      signal,
    )
    return (await response.text()).trim()
  }

  async applyJil(jil: string, signal?: AbortSignal): Promise<string> {
    const response = await this.rest.send(
      'applying JIL',
      this.paths.jil,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: jil },
      signal,
    )
    return (await response.text()).trim()
  }
}

// -------------------------------------------------------------------------------------------------
// Tools

export interface AutosysToolOptions {
  client: () => Promise<AutosysClient>
  /** A pattern used when a request names no jobs, e.g. `PAY_*`. */
  defaultPattern?: string | undefined
}

function errorResult(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true }
}

const findSchema = z.object({
  pattern: z.string().optional().describe('Job name, with * wildcards — e.g. PAY_* or *_EOD_*.'),
  limit: z.number().int().min(1).max(200).optional().describe('How many. Default 50.'),
})

export function createAutosysFindJobsTool(options: AutosysToolOptions): Tool<z.infer<typeof findSchema>> {
  return {
    name: 'autosys_find_jobs',
    group: 'read',
    description:
      'Find AutoSys jobs by name pattern (* wildcards), with each job’s type, box and machine.' +
      (options.defaultPattern !== undefined ? ` Defaults to ${options.defaultPattern}.` : ''),
    parametersSchema: findSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const pattern = params.pattern ?? options.defaultPattern ?? '*'
        const jobs = await (await options.client()).findJobs(pattern)
        if (jobs.length === 0) return { content: `No AutoSys jobs match ${pattern}.` }
        const shown = jobs.slice(0, params.limit ?? 50)
        return {
          content: [
            `${String(jobs.length)} job(s) match ${pattern}${jobs.length > shown.length ? `, showing ${String(shown.length)}` : ''}:`,
            ...shown.map((job) => {
              const box = field(job, 'boxName', 'box_name')
              const machine = field(job, 'machine')
              return `- ${field(job, 'name', 'jobName') ?? '?'}  (${field(job, 'jobType', 'job_type', 'type') ?? '?'}${box !== undefined ? `, in box ${box}` : ''}${machine !== undefined ? `, on ${machine}` : ''})`
            }),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const jobSchema = z.object({ job: z.string().min(1).describe('The exact job name.') })

export function createAutosysJobTool(options: AutosysToolOptions): Tool<z.infer<typeof jobSchema>> {
  return {
    name: 'autosys_job',
    group: 'read',
    description:
      'Read an AutoSys job’s definition — command, machine, owner, conditions, start times, calendars, output files and every other attribute — with its current status, and the jobs inside it if it is a box.',
    parametersSchema: jobSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const definition = await client.job(params.job)
        const runs = await client.runInfo(params.job).catch(() => [] as AutosysRun[])
        const type = (field(definition, 'jobType', 'job_type', 'type') ?? '').toUpperCase()
        const members = type === 'BOX' || type === 'B' ? await client.boxMembers(params.job).catch(() => []) : []
        return {
          content: [
            `Definition of ${params.job}:`,
            ...renderDefinition(definition).map((line) => `  ${line}`),
            '',
            runs[0] !== undefined ? `Status: ${describeRun(runs[0])}` : 'Status: not available',
            ...(members.length > 0
              ? ['', `Jobs in this box (${String(members.length)}):`, ...members.map((member) => `- ${field(member, 'name', 'jobName') ?? '?'}`)]
              : []),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const statusSchema = z.object({
  pattern: z.string().optional().describe('Job name or pattern (* wildcards). Defaults to the configured pattern.'),
  only: z
    .enum(['FAILURE', 'TERMINATED', 'RUNNING', 'ON_HOLD', 'ON_ICE', 'SUCCESS', 'INACTIVE', 'STARTING', 'ACTIVATED', 'RESTART'])
    .optional()
    .describe('Only jobs in this status, e.g. FAILURE for what failed.'),
})

export function createAutosysStatusTool(options: AutosysToolOptions): Tool<z.infer<typeof statusSchema>> {
  return {
    name: 'autosys_status',
    group: 'read',
    description:
      'Current status of AutoSys jobs — like autorep -J: status, last start and end, exit code, run number and machine. Use only: FAILURE to see what failed.',
    parametersSchema: statusSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const pattern = params.pattern ?? options.defaultPattern
        if (pattern === undefined) return { content: 'Give a job name or pattern — no default pattern is configured.', isError: true }
        const runs = (await (await options.client()).runInfo(pattern)).filter(
          (run) => params.only === undefined || run.status.toUpperCase() === params.only,
        )
        if (runs.length === 0) return { content: `No jobs matching ${pattern}${params.only !== undefined ? ` are ${params.only}` : ''}.` }
        return { content: [`${String(runs.length)} job(s):`, ...runs.slice(0, 200).map((run) => `- ${describeRun(run)}`)].join('\n') }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const logSchema = z.object({
  job: z.string().min(1).describe('The exact job name.'),
  runNum: z.string().optional().describe('A run number from autosys_status. Default the latest run.'),
  type: z.enum(['stdout', 'stderr']).optional().describe('Which output. Default stderr, where failures usually explain themselves.'),
  search: z.string().optional().describe('Only lines matching this regular expression, with context.'),
  tailLines: z.number().int().min(10).max(2000).optional().describe('How many lines from the end. Default 200.'),
})

export function createAutosysLogTool(options: AutosysToolOptions): Tool<z.infer<typeof logSchema>> {
  return {
    name: 'autosys_job_log',
    group: 'read',
    description:
      'Read an AutoSys job’s output log — stderr by default, or stdout — the end of it or only matching lines. Use it with autosys_status to find out why a job failed.',
    parametersSchema: logSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const type = params.type ?? 'stderr'
        const log = await client.log(params.job, params.runNum, type)
        if (log === undefined) {
          // No log endpoint on this server: say where the job writes, which is the next best answer.
          const definition = await client.job(params.job).catch(() => undefined)
          const file = definition === undefined ? undefined : field(definition, type === 'stdout' ? 'stdOutFile' : 'stdErrFile', type === 'stdout' ? 'std_out_file' : 'std_err_file')
          const machine = definition === undefined ? undefined : field(definition, 'machine')
          return {
            content:
              `This AutoSys server did not return a log for ${params.job} (its web services may not offer job logs, or answer at a different path — config:autosys (paths.log)).` +
              (file !== undefined ? ` The job writes ${type} to ${file}${machine !== undefined ? ` on ${machine}` : ''}.` : ''),
            isError: true,
          }
        }
        const lines = log.split(/\r?\n/)
        if (params.search !== undefined) {
          let pattern: RegExp
          try {
            pattern = new RegExp(params.search, 'i')
          } catch (error) {
            return { content: `Not a valid pattern: ${error instanceof Error ? error.message : String(error)}`, isError: true }
          }
          const kept = new Set<number>()
          lines.forEach((line, index) => {
            if (pattern.test(line)) for (let at = Math.max(0, index - 3); at <= Math.min(lines.length - 1, index + 3); at += 1) kept.add(at)
          })
          if (kept.size === 0) return { content: `No lines match /${params.search}/ in the ${type} log of ${params.job}.` }
          return {
            content: [...kept]
              .sort((a, b) => a - b)
              .slice(0, 400)
              .map((index) => `${String(index + 1)}: ${lines[index] ?? ''}`)
              .join('\n'),
          }
        }
        const tail = lines.slice(-(params.tailLines ?? 200))
        return { content: `${type} of ${params.job}${params.runNum !== undefined ? ` run ${params.runNum}` : ''} (${String(lines.length)} lines${lines.length > tail.length ? `, last ${String(tail.length)} shown` : ''}):\n${tail.join('\n')}` }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const eventSchema = z.object({
  job: z.string().min(1).describe('The exact job name.'),
  event: z
    .enum(AUTOSYS_EVENTS)
    .describe('FORCE_STARTJOB runs it now regardless of conditions; KILLJOB stops it; JOB_ON_HOLD / JOB_OFF_HOLD, JOB_ON_ICE / JOB_OFF_ICE; CHANGE_STATUS needs status.'),
  status: z.string().optional().describe('For CHANGE_STATUS: e.g. SUCCESS, FAILURE, INACTIVE, TERMINATED.'),
  priority: z.number().int().optional().describe('For CHANGE_PRIORITY.'),
  comment: z.string().max(255).optional().describe('Recorded with the event — why it was sent.'),
})

const EVENT_MEANING: Record<string, string> = {
  FORCE_STARTJOB: 'run it now, ignoring its starting conditions',
  STARTJOB: 'start it if its conditions are met',
  KILLJOB: 'kill it while it runs',
  JOB_ON_HOLD: 'put it on hold — it will not run, and jobs depending on it wait',
  JOB_OFF_HOLD: 'take it off hold — it runs if its conditions are met',
  JOB_ON_ICE: 'put it on ice — it will not run, and dependents treat it as satisfied',
  JOB_OFF_ICE: 'take it off ice',
  JOB_ON_NOEXEC: 'skip executing it, while still letting dependents proceed',
  JOB_OFF_NOEXEC: 'execute it normally again',
  CHANGE_STATUS: 'set its status by hand — dependents react as if it had happened',
  CHANGE_PRIORITY: 'change its queue priority',
  COMMENT: 'record a comment against it',
}

export function createAutosysSendEventTool(options: AutosysToolOptions): Tool<z.infer<typeof eventSchema>> {
  return {
    name: 'autosys_send_event',
    group: 'command',
    description:
      'Send an AutoSys event to a job — like sendevent: force-start, start, kill, hold, ice, no-exec, change status or priority, or comment. This changes a production schedule under the user’s name, so it is always shown to the user first, with what the event will do.',
    parametersSchema: eventSchema,
    async preview(params): Promise<ToolPreview> {
      const client = await options.client()
      const runs = await client.runInfo(params.job).catch(() => [] as AutosysRun[])
      return {
        kind: 'text',
        text: [
          `sendevent -E ${params.event} -J ${params.job}${params.status !== undefined ? ` -s ${params.status}` : ''}${params.priority !== undefined ? ` -q ${String(params.priority)}` : ''}${params.comment !== undefined ? ` -C "${params.comment}"` : ''}`,
          `This will ${EVENT_MEANING[params.event] ?? params.event}.`,
          runs[0] !== undefined ? `Now: ${describeRun(runs[0])}` : '',
          `Server: ${client.base}`,
          ...(params.event === 'CHANGE_STATUS' && params.status === undefined ? ['No status given — this will be refused.'] : []),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      }
    },
    async execute(params): Promise<ToolResult> {
      try {
        if (params.event === 'CHANGE_STATUS' && params.status === undefined) {
          return { content: 'CHANGE_STATUS needs a status, e.g. SUCCESS or INACTIVE.', isError: true }
        }
        const client = await options.client()
        const answer = await client.sendEvent(params.event, params.job, params)
        const after = await client.runInfo(params.job).catch(() => [] as AutosysRun[])
        return {
          content: [`Sent ${params.event} for ${params.job}.`, answer.length > 0 ? `AutoSys said: ${answer.slice(0, 500)}` : '', after[0] !== undefined ? `Now: ${describeRun(after[0])}` : '']
            .filter((line) => line.length > 0)
            .join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const jilSchema = z.object({
  jil: z
    .string()
    .min(1)
    .describe(
      'JIL to apply, exactly as for the jil command: insert_job / update_job / delete_job / delete_box with attributes, e.g. "update_job: PAY_EOD_EXTRACT\\ncondition: s(PAY_EOD_LOAD)". Read the job with autosys_job first.',
    ),
})

export function createAutosysApplyJilTool(options: AutosysToolOptions): Tool<z.infer<typeof jilSchema>> {
  return {
    name: 'autosys_apply_jil',
    group: 'command',
    description:
      'Create, change or delete AutoSys job definitions by applying JIL — like running the jil command. Changes production schedules, so the user always sees the whole JIL first. Prefer update_job with only the attributes that change.',
    parametersSchema: jilSchema,
    async preview(params): Promise<ToolPreview> {
      const client = await options.client()
      const verbs = [...params.jil.matchAll(/^\s*(insert_job|update_job|delete_job|delete_box|override_job)\s*:\s*(\S+)/gim)].map(
        (match) => `${match[1] ?? ''} ${match[2] ?? ''}`,
      )
      return {
        kind: 'text',
        text: [
          `Apply JIL on ${client.base}${verbs.length > 0 ? ` — ${verbs.join(', ')}` : ''}`,
          ...(/delete_(job|box)/i.test(params.jil) ? ['This DELETES job definitions.'] : []),
          '',
          params.jil,
        ].join('\n'),
      }
    },
    async execute(params): Promise<ToolResult> {
      try {
        const answer = await (await options.client()).applyJil(params.jil)
        return { content: `JIL applied.${answer.length > 0 ? `\nAutoSys said:\n${answer.slice(0, 4000)}` : ''}` }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

// --- dependencies

export interface ConditionReference {
  /** `s`, `f`, `d`, `n`, `t` or `e`, normalised from the long forms. */
  kind: 's' | 'f' | 'd' | 'n' | 't' | 'e'
  job: string
  /** `^INS` for a job on another AutoSys instance. */
  instance?: string | undefined
  /** The comparison after `e(JOB)`, e.g. `= 0`. */
  comparison?: string | undefined
}

const CONDITION_KIND: Record<string, ConditionReference['kind']> = {
  s: 's', success: 's', f: 'f', failure: 'f', d: 'd', done: 'd', n: 'n', notrunning: 'n', t: 't', terminated: 't', e: 'e', exitcode: 'e',
}

/** Every job a starting condition names. Global-variable tests (`v(...)`) are not jobs and are left out. */
export function parseConditions(condition: string): ConditionReference[] {
  const found: ConditionReference[] = []
  const pattern = /\b(success|failure|done|notrunning|terminated|exitcode|s|f|d|n|t|e)\s*\(\s*([A-Za-z0-9._#-]+)(\^[A-Za-z0-9]+)?(?:\s*,\s*[\d.:]+)?\s*\)(\s*(?:=|!=|<=|>=|<|>)\s*-?\d+)?/gi
  for (const match of condition.matchAll(pattern)) {
    const kind = CONDITION_KIND[(match[1] ?? '').toLowerCase()]
    if (kind === undefined || match[2] === undefined) continue
    found.push({
      kind,
      job: match[2],
      ...(match[3] !== undefined ? { instance: match[3].slice(1) } : {}),
      ...(kind === 'e' && match[4] !== undefined ? { comparison: match[4].trim() } : {}),
    })
  }
  return found
}

/** Whether a condition on a job in this status holds. Undefined when it cannot be told from status. */
export function conditionMet(kind: ConditionReference['kind'], status: string): boolean | undefined {
  const value = status.toUpperCase()
  switch (kind) {
    case 's':
      return value === 'SUCCESS'
    case 'f':
      return value === 'FAILURE'
    case 'd':
      return value === 'SUCCESS' || value === 'FAILURE' || value === 'TERMINATED'
    case 'n':
      return value !== 'RUNNING'
    case 't':
      return value === 'TERMINATED'
    case 'e':
      return undefined
  }
}

const KIND_WORDS: Record<ConditionReference['kind'], string> = {
  s: 'success of',
  f: 'failure of',
  d: 'completion of',
  n: 'not running:',
  t: 'termination of',
  e: 'exit code of',
}

const dependenciesSchema = z.object({
  job: z.string().min(1).describe('The exact job name.'),
  direction: z
    .enum(['upstream', 'downstream', 'both'])
    .optional()
    .describe('upstream: what it waits for — why has it not started? downstream: what waits for it. Default both.'),
  depth: z.number().int().min(1).max(5).optional().describe('How many levels of unmet upstream conditions to follow. Default 3.'),
  searchPattern: z
    .string()
    .optional()
    .describe('For downstream: which jobs to look through for conditions naming this one. Defaults to the configured pattern, else all.'),
})

export function createAutosysDependenciesTool(options: AutosysToolOptions): Tool<z.infer<typeof dependenciesSchema>> {
  return {
    name: 'autosys_dependencies',
    group: 'read',
    description:
      'An AutoSys job’s dependencies. Upstream: the jobs its starting condition names and the box it is in, each with its current status and whether the condition is met — following unmet ones further up — which answers "why has this not started?". Downstream: the jobs whose conditions name this one, and its members if it is a box.',
    parametersSchema: dependenciesSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const direction = params.direction ?? 'both'
        const lines: string[] = []

        if (direction !== 'downstream') {
          lines.push(`Upstream of ${params.job}:`)
          const statuses = new Map<string, string>()
          const statusOf = async (name: string): Promise<string> => {
            const known = statuses.get(name)
            if (known !== undefined) return known
            const run = (await client.runInfo(name).catch(() => [] as AutosysRun[]))[0]
            const status = run?.status ?? 'unknown'
            statuses.set(name, status)
            return status
          }
          const visited = new Set<string>()
          const walk = async (name: string, level: number, indent: string): Promise<void> => {
            if (visited.has(name)) {
              lines.push(`${indent}(${name} already shown above)`)
              return
            }
            visited.add(name)
            const definition = await client.job(name).catch(() => undefined)
            if (definition === undefined) {
              lines.push(`${indent}(${name}: definition not readable)`)
              return
            }
            const condition = field(definition, 'condition')
            const box = field(definition, 'boxName', 'box_name')
            if (box !== undefined) lines.push(`${indent}- in box ${box} [${await statusOf(box)}] — runs only while its box is running`)
            if (condition === undefined) {
              if (box === undefined) lines.push(`${indent}- no starting condition: it runs on its own schedule${field(definition, 'startTimes', 'start_times') !== undefined ? ` (${field(definition, 'startTimes', 'start_times') ?? ''})` : ''}`)
              return
            }
            lines.push(`${indent}condition: ${condition}`)
            for (const reference of parseConditions(condition)) {
              if (reference.instance !== undefined) {
                lines.push(`${indent}- ${KIND_WORDS[reference.kind]} ${reference.job} on instance ${reference.instance} (another instance: status not checked)`)
                continue
              }
              const status = await statusOf(reference.job)
              const met = conditionMet(reference.kind, status)
              lines.push(
                `${indent}- ${KIND_WORDS[reference.kind]} ${reference.job}${reference.comparison !== undefined ? ` ${reference.comparison}` : ''}: ${status} — ${met === undefined ? 'check the exit code' : met ? 'met' : 'NOT met'}`,
              )
              if (met === false && level < (params.depth ?? 3)) await walk(reference.job, level + 1, `${indent}    `)
            }
          }
          await walk(params.job, 1, '  ')
        }

        if (direction !== 'upstream') {
          if (lines.length > 0) lines.push('')
          lines.push(`Downstream of ${params.job}:`)
          const definition = await client.job(params.job).catch(() => undefined)
          const type = definition === undefined ? '' : (field(definition, 'jobType', 'job_type', 'type') ?? '').toUpperCase()
          if (type === 'BOX' || type === 'B') {
            const members = await client.boxMembers(params.job).catch(() => [])
            lines.push(`  box members: ${members.map((member) => field(member, 'name', 'jobName') ?? '?').join(', ') || 'none'}`)
          }
          const scope = params.searchPattern ?? options.defaultPattern ?? '*'
          const candidates = await client.findJobs(scope)
          // A list that omits conditions means reading each definition, which is capped.
          const listed = candidates.some((candidate) => 'condition' in candidate)
          const definitions = listed
            ? candidates
            : await Promise.all(
                candidates.slice(0, 300).map((candidate) => client.job(field(candidate, 'name', 'jobName') ?? '').catch(() => ({}) as Record<string, unknown>)),
              )
          const dependents = definitions.filter((candidate) =>
            parseConditions(field(candidate, 'condition') ?? '').some((reference) => reference.job.toLowerCase() === params.job.toLowerCase() && reference.instance === undefined),
          )
          lines.push(
            dependents.length === 0
              ? `  no job matching ${scope} has a condition naming it${!listed && candidates.length > 300 ? ' (only the first 300 were read — narrow searchPattern)' : ''}`
              : `  ${String(dependents.length)} job(s) wait on it:`,
            ...dependents.map((candidate) => `  - ${field(candidate, 'name', 'jobName') ?? '?'}: ${field(candidate, 'condition') ?? ''}`),
          )
        }
        return { content: lines.join('\n') }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

/** Every AutoSys tool, in the order they are registered. */
export function createAutosysTools(options: AutosysToolOptions): Tool<never>[] {
  return [
    createAutosysFindJobsTool(options),
    createAutosysJobTool(options),
    createAutosysStatusTool(options),
    createAutosysDependenciesTool(options),
    createAutosysLogTool(options),
    createAutosysSendEventTool(options),
    createAutosysApplyJilTool(options),
  ] as unknown as Tool<never>[]
}
