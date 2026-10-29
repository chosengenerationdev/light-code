import { z } from 'zod'

import type { HttpClient } from '../platform/http.js'
import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import { AtlassianError, AtlassianRest, type AtlassianConnection } from './rest.js'
import {
  calendarDates,
  describeDays,
  jobSchedule,
  parseAutosysTime,
  startsInWindow,
  weekdayOf,
  wildcardMatches,
} from './autosysSchedule.js'
import {
  classifyRuns,
  clock,
  describeRun as describePastRun,
  inPeriod,
  periodStart,
  toJobEvent,
  toPastRun,
  type JobEvent,
  type PastRun,
} from './autosysRuns.js'

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
 * prefix). **The site address is used exactly as typed and carries that prefix** - typically
 * `https://host:9443/AEWS` - and the defaults below add only the resource and its query: `/job`,
 * `/job-run-info`, `/event`, `/jil`. They used to start with `/AEWS` themselves, so a site address
 * ending in `/AEWS` asked for `/AEWS/AEWS/...` and got a 404 (reported). Every request goes through a template that `autosys.paths` can
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
  /** Machines whose name matches `{pattern}` - definitions and status, like autorep -M. */
  machines: string
  /** One machine. */
  machine: string
  /** Global variables whose name matches `{pattern}`, like autorep -G. */
  globalVariables: string
  /** A standard calendar's dates: `{calendar}`. */
  calendar: string
  /** An extended calendar's rules: `{calendar}`. */
  extendedCalendar: string
  /** Past runs of one job (`{job}`): start, end, status, exit code, run number, try. */
  runHistory: string
  /** Events recorded for one job (`{filter:jobName}` or `{job}`): which event, when, and who sent it. */
  eventHistory: string
}

export const DEFAULT_AUTOSYS_PATHS: AutosysPaths = {
  jobs: '/job?filter={filter:name}',
  job: '/job/{job}',
  runInfo: '/job-run-info?filter={filter:name}',
  jobRunInfo: '/job-run-info/{job}',
  boxMembers: '/job?filter={filter:boxName}',
  event: '/event',
  jil: '/jil',
  log: '/job-log/{job}?runNum={runNum}&type={type}',
  machines: '/machine?filter={filter:name}',
  machine: '/machine/{machine}',
  globalVariables: '/global-variable?filter={filter:name}',
  calendar: '/calendar/standard/{calendar}',
  extendedCalendar: '/calendar/extended/{calendar}',
  // Neither is confirmed against a live server - a 404 makes the runs tool name the key to set.
  runHistory: '/job-run-info/{job}/history',
  eventHistory: '/event?filter={filter:jobName}',
}

/** Job names are letters, digits and `._-#` in AutoSys; `*` is allowed only where a pattern is. */
export function isAutosysName(name: string, pattern = false): boolean {
  return (pattern ? /^[A-Za-z0-9._#*-]{1,64}$/ : /^[A-Za-z0-9._#-]{1,64}$/).test(name)
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(filter:)?(\w+)\}/g, (_, filter: string | undefined, key: string) => {
    if (filter !== undefined) {
      // FIQL: `name==PAY_*`. The value is checked before it gets here, so only encoding remains.
      // `job` last, so a one-job address written as a filter (`/job?filter={filter:name}`) works too.
      return encodeURIComponent(`${key}==${values['pattern'] ?? values[key] ?? values['job'] ?? ''}`)
    }
    return encodeURIComponent(values[key] ?? '')
  })
}

export const AUTOSYS_PATH_KEYS = Object.keys(DEFAULT_AUTOSYS_PATHS) as (keyof AutosysPaths)[]

/** Addresses that are sent to, not read: never tried by a check, because trying one changes production. */
export const AUTOSYS_SENDING_KEYS: readonly (keyof AutosysPaths)[] = ['event', 'jil']

const PLACEHOLDERS = new Set(['pattern', 'job', 'runNum', 'type', 'machine', 'calendar', 'boxName', 'jobName'])

/** What an address must contain to say which job, machine or calendar it is about. */
const SUBJECT: Partial<Record<keyof AutosysPaths, readonly string[]>> = {
  jobs: ['pattern'],
  runInfo: ['pattern'],
  boxMembers: ['pattern', 'boxName'],
  machines: ['pattern'],
  globalVariables: ['pattern'],
  job: ['job'],
  jobRunInfo: ['job'],
  log: ['job'],
  runHistory: ['job'],
  eventHistory: ['job', 'jobName'],
  machine: ['machine'],
  calendar: ['calendar'],
  extendedCalendar: ['calendar'],
}

/**
 * Why an address template cannot be used, or undefined when it can.
 *
 * Templates are appended to the configured site, and the request carries the credential. So a template
 * must be a path on that site and nothing else: one that did not start with `/` would extend the *host
 * name* (`https://wla` + `.elsewhere.com/x`), and `..` would climb out of the site's context path. These
 * can now be written by the assistant (`autosys_set_addresses`, from a wiki page it read), which is why
 * the rule is checked rather than trusted - here and on every client built.
 */
export function autosysPathProblem(key: keyof AutosysPaths, template: string): string | undefined {
  if (!AUTOSYS_PATH_KEYS.includes(key)) return `"${String(key)}" is not an AutoSys address name.`
  if (template.length === 0 || template.length > 500) return 'An address must be 1 to 500 characters.'
  if (!template.startsWith('/') || template.startsWith('//')) return 'An address must start with a single "/" - it is added to the site address, never a site of its own.'
  if (/[\s\\#]/.test(template) || template.includes('://')) return 'An address may not contain spaces, backslashes, "#" or "://".'
  const pathPart = template.split('?')[0] ?? ''
  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    return 'The address has a broken %-escape.'
  }
  if (decoded.split('/').some((segment) => segment === '..' || segment === '.')) return 'An address may not contain "." or ".." segments.'
  const named = [...template.matchAll(/\{(filter:)?(\w+)\}/g)]
  const stripped = template.replace(/\{(filter:)?(\w+)\}/g, '')
  if (stripped.includes('{') || stripped.includes('}')) return 'Placeholders are written {job}, {pattern} or {filter:name}; this address has a stray brace.'
  for (const [, filter, name] of named) {
    if (filter === undefined && !PLACEHOLDERS.has(name ?? '')) return `{${name ?? ''}} is not a placeholder - use one of ${[...PLACEHOLDERS].map((p) => `{${p}}`).join(', ')}, or {filter:<field>}.`
  }
  const subject = SUBJECT[key]
  if (subject !== undefined && !named.some(([, filter, name]) => filter !== undefined || subject.includes(name ?? ''))) {
    return `The ${key} address must say which one it is about: include ${subject.map((p) => `{${p}}`).join(' or ')} (or a {filter:<field>}).`
  }
  return undefined
}

/** The result of trying one address once. */
export interface AutosysAddressCheck {
  key: keyof AutosysPaths
  template: string
  /** The path actually requested, filled in. */
  requested: string
  ok: boolean
  status?: number | undefined
  /** How many records came back, when the answer was a list or a record. */
  records?: number | undefined
  /** The first record's field names - what this server calls things. */
  fields?: string[] | undefined
  /** The server's words, or ours, when it did not work. */
  message?: string | undefined
  /** 401 or 403: the credential, not the address. Nothing further is worth trying. */
  signIn?: boolean | undefined
}

function jobNameOf(record: Record<string, unknown>): string | undefined {
  return field(record, 'name', 'jobName', 'job_name', 'job')
}

/** Most jobs a pattern is followed one job at a time, when the server has no pattern status address. */
const MAX_ONE_BY_ONE = 200

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

/**
 * Whether an answer says there is more than it holds - a server that pages (reported: a pattern found only
 * some of its jobs). Read from the totals servers commonly send beside the list, and from a "next" link.
 */
export function pagingNote(value: unknown, returned: number, what: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const o = value as Record<string, unknown>
  const total = ['total', 'totalCount', 'totalRecords', 'totalResults', 'totalSize', 'numFound', 'count', 'size']
    .map((k) => Number(o[k]))
    .find((n) => Number.isFinite(n) && n > returned)
  const next = ['next', 'nextPage', 'nextLink', 'hasMore', 'more', 'moreResults'].some((k) => o[k] === true || (typeof o[k] === 'string' && (o[k] as string).length > 0))
  if (total === undefined && !next) return undefined
  return (
    `AutoSys answered ${String(returned)} ${what}${total !== undefined ? ` of ${String(total)}` : ''} - it pages its answers, so some are missing. ` +
    'Add its page-size parameter to the address (config:autosys paths, e.g. "/job-run-info?filter={filter:name}&limit=1000" - the name of the ' +
    'parameter is in the server\'s API documentation or the office wiki); autosys_check_addresses shows what each address answers.'
  )
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
  private readonly overrides: Partial<AutosysPaths>

  constructor(
    private readonly http: HttpClient,
    private readonly connection: AtlassianConnection,
    paths?: Partial<AutosysPaths>,
  ) {
    this.rest = new AtlassianRest(http, 'autosys', connection)
    this.overrides = { ...(paths ?? {}) }
    for (const [key, template] of Object.entries(this.overrides)) {
      const problem = autosysPathProblem(key as keyof AutosysPaths, template)
      if (problem !== undefined) throw new AtlassianError(`The AutoSys address config:autosys (paths.${key}) "${template}" cannot be used: ${problem}`)
    }
    this.paths = { ...DEFAULT_AUTOSYS_PATHS, ...this.overrides }
  }

  get base(): string {
    return this.rest.base
  }

  /** What the last calls found worth saying - an answer that pages - for the tool to pass on, once. */
  private readonly notes: string[] = []
  takeNotes(): string[] {
    return [...new Set(this.notes.splice(0))]
  }

  /** The address templates in use, defaults included. */
  get addresses(): AutosysPaths {
    return { ...this.paths }
  }

  /** The same connection with some addresses replaced - to try candidates before anything is saved. */
  withPaths(paths: Partial<AutosysPaths>): AutosysClient {
    return new AutosysClient(this.http, this.connection, { ...this.overrides, ...paths })
  }

  /**
   * Tries one read address once and says what came back. Never for an address that is sent to
   * (`AUTOSYS_SENDING_KEYS`): a test POST of an event would be a real event.
   */
  async check(key: keyof AutosysPaths, values: Record<string, string>, signal?: AbortSignal): Promise<AutosysAddressCheck> {
    const template = this.paths[key]
    const requested = fill(template, values)
    if (AUTOSYS_SENDING_KEYS.includes(key)) {
      return { key, template, requested, ok: false, message: 'not tried - this address is sent to, and trying it would change production' }
    }
    try {
      if (key === 'log') {
        const text = await this.rest.text(`trying the ${key} address`, requested, signal)
        return { key, template, requested, ok: true, status: 200, records: text.length > 0 ? 1 : 0 }
      }
      const list = asList(await this.rest.json(`trying the ${key} address`, requested, { method: 'GET' }, signal))
      const first = list[0]
      return { key, template, requested, ok: true, status: 200, records: list.length, fields: first === undefined ? [] : Object.keys(first).slice(0, 15) }
    } catch (error) {
      const status = error instanceof AtlassianError ? error.status : undefined
      return {
        key,
        template,
        requested,
        ok: false,
        status,
        message: error instanceof Error ? error.message : String(error),
        signIn: status === 401 || status === 403,
      }
    }
  }

  /** Signs in and lists nothing: proves the credential and the path without fetching every job. */
  async probe(username: string, signal?: AbortSignal): Promise<string> {
    // Through runInfo, so a server with no pattern status address is tried at its job list instead.
    await this.runInfo('LIGHTCODE_PROBE_NO_SUCH_JOB*', signal)
    return username
  }

  async findJobs(pattern: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    if (!isAutosysName(pattern, true)) throw new AtlassianError(`"${pattern}" is not a job name or pattern — letters, digits, . _ - # and * only.`)
    const answer = await this.rest.json('finding jobs', fill(this.paths.jobs, { pattern }), { method: 'GET' }, signal)
    const list = asList(answer)
    const note = pagingNote(answer, list.length, `jobs for ${pattern}`)
    if (note !== undefined) this.notes.push(note)
    return list
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

  /**
   * Status of one job or every job a pattern matches.
   *
   * A pattern goes to the pattern address (`runInfo`). Reported from real use: a server with no such
   * address answered `JOB*UK` with a 404 while one job's status worked. So when the pattern address
   * answers 404, the jobs are listed with the definitions address (`jobs`) and each one's status is
   * read on its own - slower, and it works with what the server has. One job reads `jobRunInfo`, and
   * where that is missing too, a definition that carries a status.
   */
  async runInfo(pattern: string, signal?: AbortSignal): Promise<AutosysRun[]> {
    if (!isAutosysName(pattern, true)) throw new AtlassianError(`"${pattern}" is not a job name or pattern.`)
    if (!pattern.includes('*')) return this.oneRun(pattern, signal)
    try {
      const answer = await this.rest.json(`reading the status of ${pattern}`, fill(this.paths.runInfo, { pattern }), { method: 'GET' }, signal)
      const list = asList(answer)
      const note = pagingNote(answer, list.length, `statuses for ${pattern}`)
      if (note !== undefined) this.notes.push(note)
      return list.map(toRun)
    } catch (error) {
      if (!(error instanceof AtlassianError && error.status === 404)) throw error
      let jobs: Record<string, unknown>[]
      try {
        jobs = await this.findJobs(pattern, signal)
      } catch (listing) {
        if (listing instanceof AtlassianError && listing.status === 404) {
          throw new AtlassianError(
            `Neither the status address (${this.base}${fill(this.paths.runInfo, { pattern })}) nor the job list address ` +
              `(${this.base}${fill(this.paths.jobs, { pattern })}) answered for ${pattern} - both 404. Some servers answer 404 when ` +
              'nothing matches; otherwise this server uses other addresses. autosys_check_addresses tries them, and the office ' +
              "wiki's description of the AutoSys REST service usually names them.",
            404,
          )
        }
        throw listing
      }
      const names = [...new Set(jobs.map(jobNameOf).filter((name): name is string => name !== undefined && isAutosysName(name)))]
      const runs = await inBatches(names.slice(0, MAX_ONE_BY_ONE), async (name): Promise<AutosysRun[]> => {
        try {
          return await this.oneRun(name, signal)
        } catch {
          // One unreadable job must not cost the rest; it is listed as such rather than left out.
          return [{ name, status: 'UNREADABLE' }]
        }
      })
      return runs.flat()
    }
  }

  private async oneRun(name: string, signal?: AbortSignal): Promise<AutosysRun[]> {
    try {
      return asList(await this.rest.json(`reading the status of ${name}`, fill(this.paths.jobRunInfo, { job: name }), { method: 'GET' }, signal)).map(toRun)
    } catch (error) {
      if (!(error instanceof AtlassianError && error.status === 404)) throw error
      // No status address for one job: a definition that carries its status is the next best answer.
      const definitions = await this.optional(`reading job ${name}`, fill(this.paths.job, { job: name }), signal)
      const withStatus = (definitions ?? []).filter((record) => field(record, 'status', 'jobStatus') !== undefined)
      if (withStatus.length === 0) throw error
      return withStatus.map(toRun)
    }
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

  /**
   * Something this server may not offer at the documented address: undefined for a 404, so a tool can
   * say which setting (`autosys.paths`) points elsewhere, rather than reporting "found nothing".
   */
  private async optional(doing: string, path: string, signal?: AbortSignal): Promise<Record<string, unknown>[] | undefined> {
    try {
      return asList(await this.rest.json(doing, path, { method: 'GET' }, signal))
    } catch (error) {
      if (error instanceof AtlassianError && error.status === 404) return undefined
      throw error
    }
  }

  /** Machines matching a pattern, or one machine by name. Undefined: no machine endpoint here. */
  async machines(pattern: string, signal?: AbortSignal): Promise<Record<string, unknown>[] | undefined> {
    if (!isAutosysName(pattern, true)) throw new AtlassianError(`"${pattern}" is not a machine name or pattern - letters, digits, . _ - # and * only.`)
    return pattern.includes('*')
      ? this.optional(`listing machines ${pattern}`, fill(this.paths.machines, { pattern }), signal)
      : this.optional(`reading machine ${pattern}`, fill(this.paths.machine, { machine: pattern }), signal)
  }

  async globalVariables(pattern: string, signal?: AbortSignal): Promise<Record<string, unknown>[] | undefined> {
    if (!isAutosysName(pattern, true)) throw new AtlassianError(`"${pattern}" is not a variable name or pattern.`)
    return this.optional(`reading global variables ${pattern}`, fill(this.paths.globalVariables, { pattern }), signal)
  }

  /** A calendar, standard first, then extended. Undefined: neither answered. */
  async calendar(name: string, signal?: AbortSignal): Promise<{ kind: 'standard' | 'extended'; records: Record<string, unknown>[] } | undefined> {
    if (!isAutosysName(name)) throw new AtlassianError(`"${name}" is not a calendar name.`)
    const standard = await this.optional(`reading calendar ${name}`, fill(this.paths.calendar, { calendar: name }), signal)
    if (standard !== undefined && standard.length > 0) return { kind: 'standard', records: standard }
    const extended = await this.optional(`reading extended calendar ${name}`, fill(this.paths.extendedCalendar, { calendar: name }), signal)
    if (extended !== undefined && extended.length > 0) return { kind: 'extended', records: extended }
    return standard === undefined && extended === undefined ? undefined : { kind: 'standard', records: [] }
  }

  /** Past runs of a job, or undefined when this server has no such address. */
  async runHistory(name: string, signal?: AbortSignal): Promise<Record<string, unknown>[] | undefined> {
    if (!isAutosysName(name)) throw new AtlassianError(`"${name}" is not a job name.`)
    return this.optional(`reading the run history of ${name}`, fill(this.paths.runHistory, { job: name }), signal)
  }

  /** Events recorded for a job, or undefined when this server has no such address. */
  async eventHistory(name: string, signal?: AbortSignal): Promise<Record<string, unknown>[] | undefined> {
    if (!isAutosysName(name)) throw new AtlassianError(`"${name}" is not a job name.`)
    return this.optional(`reading the events of ${name}`, fill(this.paths.eventHistory, { job: name, jobName: name }), signal)
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
  machine: z.string().optional().describe('Only jobs defined to run on this machine (* wildcards).'),
  owner: z.string().optional().describe('Only jobs owned by this user (* wildcards), e.g. svc_batch or svc_*.'),
  box: z.string().optional().describe('Only jobs inside this box (* wildcards).'),
  type: z.string().optional().describe('Only this job type: CMD, BOX, FW (file watcher), FT, and so on.'),
  calendar: z.string().optional().describe('Only jobs whose run or exclude calendar is this one (* wildcards).'),
  commandContains: z.string().optional().describe('Only jobs whose command contains this text, e.g. a script name.'),
  limit: z.number().int().min(1).max(200).optional().describe('How many. Default 50.'),
})

/** Whether a definition passes the find filters. Absent filters pass everything. */
export function definitionMatches(definition: Record<string, unknown>, filters: z.infer<typeof findSchema>): boolean {
  const at = (...names: string[]): string | undefined => field(definition, ...names)
  if (filters.machine !== undefined && !wildcardMatches(filters.machine, at('machine'))) return false
  if (filters.owner !== undefined && !wildcardMatches(filters.owner, at('owner'))) return false
  if (filters.box !== undefined && !wildcardMatches(filters.box, at('boxName', 'box_name'))) return false
  if (filters.type !== undefined) {
    const type = (at('jobType', 'job_type', 'type') ?? '').toUpperCase()
    const wanted = filters.type.trim().toUpperCase()
    // A type is written in full (CMD, BOX, FW) or by its letter (c, b, f): either spelling matches.
    const same = type === wanted || ((type.length === 1 || wanted.length === 1) && type.charAt(0) === wanted.charAt(0))
    if (!same) return false
  }
  if (filters.calendar !== undefined) {
    const calendars = [at('runCalendar', 'run_calendar'), at('excludeCalendar', 'exclude_calendar')]
    if (!calendars.some((name) => wildcardMatches(filters.calendar ?? '', name))) return false
  }
  if (filters.commandContains !== undefined) {
    const command = at('command') ?? ''
    if (!command.toLowerCase().includes(filters.commandContains.toLowerCase())) return false
  }
  return true
}

export function createAutosysFindJobsTool(options: AutosysToolOptions): Tool<z.infer<typeof findSchema>> {
  return {
    name: 'autosys_find_jobs',
    group: 'read',
    description:
      'Find AutoSys jobs by name pattern (* wildcards), with each job’s type, box, machine and owner - and narrow them by ' +
      'what their definitions say: the machine they run on, owner, box, type, a calendar they use, or text in their command ' +
      '(e.g. "which jobs call load_gl.sh", "which jobs are defined on host X").' +
      (options.defaultPattern !== undefined ? ` Defaults to ${options.defaultPattern}.` : ''),
    parametersSchema: findSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const pattern = params.pattern ?? options.defaultPattern ?? '*'
        const client = await options.client()
        const all = await client.findJobs(pattern)
        const notes = client.takeNotes()
        const jobs = all.filter((job) => definitionMatches(job, params))
        if (jobs.length === 0) {
          return {
            content: [all.length === 0 ? `No AutoSys jobs match ${pattern}.` : `None of the ${String(all.length)} job(s) matching ${pattern} pass those filters.`, ...notes].join('\n\n'),
          }
        }
        const shown = jobs.slice(0, params.limit ?? 50)
        const matched = jobs.length === all.length ? `match ${pattern}` : `of the ${String(all.length)} matching ${pattern} pass the filters`
        return {
          content: [
            `${String(jobs.length)} job(s) ${matched}${jobs.length > shown.length ? `, showing ${String(shown.length)}` : ''}:`,
            ...shown.map((job) => {
              const box = field(job, 'boxName', 'box_name')
              const machine = field(job, 'machine')
              const owner = field(job, 'owner')
              return `- ${field(job, 'name', 'jobName') ?? '?'}  (${field(job, 'jobType', 'job_type', 'type') ?? '?'}${box !== undefined ? `, in box ${box}` : ''}${machine !== undefined ? `, on ${machine}` : ''}${owner !== undefined ? `, owner ${owner}` : ''})`
            }),
            ...(notes.length > 0 ? ['', ...notes] : []),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

/** At most this many lookups in flight at once — enough to be quick, few enough not to flood the server. */
const LOOKUPS_IN_FLIGHT = 4
/** A request for more than this many jobs is answered for the first ones, and says so. */
const MAX_JOBS = 200
/** Full definitions shown before switching to the requested fields or a one-line summary each. */
const MAX_FULL_DEFINITIONS = 10

/** Runs `work` over `items`, a few at a time, keeping the input order in the result. */
async function inBatches<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++
      results[at] = await work(items[at] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(LOOKUPS_IN_FLIGHT, items.length) }, () => lane()))
  return results
}

/** Names and patterns from both parameters, trimmed and de-duplicated, in the order given. */
function requested(jobs: readonly string[] | undefined, pattern: string | undefined, fallback: string | undefined): string[] {
  const all = [...(jobs ?? []), ...(pattern !== undefined ? [pattern] : [])].map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  const unique = [...new Set(all)]
  return unique.length > 0 ? unique : fallback !== undefined ? [fallback] : []
}

const STATUSES = [
  'FAILURE',
  'TERMINATED',
  'RUNNING',
  'ON_HOLD',
  'ON_ICE',
  'SUCCESS',
  'INACTIVE',
  'STARTING',
  'ACTIVATED',
  'RESTART',
  'QUE_WAIT',
  'ON_NOEXEC',
] as const

/** "12 SUCCESS · 2 FAILURE · 1 RUNNING" — the line somebody asking "how are my jobs" wants first. */
export function statusSummary(runs: readonly AutosysRun[]): string {
  const counts = new Map<string, number>()
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${String(count)} ${status}`)
    .join(' · ')
}

/** An attribute name as asked for matches its stored spelling in either style: start_times or startTimes. */
function attributeMatches(key: string, wanted: readonly string[]): boolean {
  const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).toLowerCase()
  const flat = key.toLowerCase().replace(/_/g, '')
  return wanted.some((name) => name === key.toLowerCase() || name === snake || name.replace(/_/g, '') === flat)
}

const jobSchema = z.object({
  job: z.string().min(1).optional().describe('One exact job name.'),
  jobs: z.array(z.string().min(1)).max(MAX_JOBS).optional().describe('Several job names or patterns (* wildcards) at once.'),
  pattern: z.string().min(1).optional().describe('A name pattern, e.g. PAY_* — every matching job.'),
  fields: z
    .array(z.string().min(1))
    .max(30)
    .optional()
    .describe('Only these attributes of each job, e.g. ["command", "machine", "start_times", "condition"]. Best for many jobs.'),
})

export function createAutosysJobTool(options: AutosysToolOptions): Tool<z.infer<typeof jobSchema>> {
  return {
    name: 'autosys_job',
    group: 'read',
    description:
      'Read AutoSys job definitions — command, machine, owner, conditions, start times, calendars, output files and every ' +
      'other attribute — with each job’s current status, and the jobs inside a box. Takes one job, a list (`jobs`), or a ' +
      'pattern (`pattern`, * wildcards) for every matching job; with many jobs, name the attributes wanted in `fields`.',
    parametersSchema: jobSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const wanted = requested([...(params.job !== undefined ? [params.job] : []), ...(params.jobs ?? [])], params.pattern, undefined)
        if (wanted.length === 0) return { content: 'Name a job, a list of jobs, or a pattern.', isError: true }

        // Patterns are expanded by the server; a name is read as itself.
        const definitions = new Map<string, Record<string, unknown>>()
        const problems: string[] = []
        const found = await inBatches(wanted, async (entry) => {
          try {
            if (entry.includes('*')) {
              const matches = await client.findJobs(entry)
              if (matches.length === 0) problems.push(`No jobs match ${entry}.`)
              return matches.map((job) => [field(job, 'name', 'jobName', 'job_name') ?? '?', job] as const)
            }
            return [[entry, await client.job(entry)] as const]
          } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error))
            return []
          }
        })
        // Kept in the order asked for, whatever order the lookups finished in.
        for (const [name, definition] of found.flat()) if (!definitions.has(name)) definitions.set(name, definition)
        const names = [...definitions.keys()]
        if (names.length === 0) return { content: problems.join('\n'), isError: true }
        const shownNames = names.slice(0, MAX_JOBS)

        // Status in the same answer: one lookup per job, a few at a time.
        const statuses = new Map<string, AutosysRun>()
        await inBatches(shownNames, async (name) => {
          const runs = await client.runInfo(name).catch(() => [] as AutosysRun[])
          if (runs[0] !== undefined) statuses.set(name, runs[0])
        })

        const fields = params.fields?.map((name) => name.trim().toLowerCase())
        const pick = (definition: Record<string, unknown>): Record<string, unknown> =>
          fields === undefined ? definition : Object.fromEntries(Object.entries(definition).filter(([key]) => attributeMatches(key, fields)))
        const full = fields === undefined && shownNames.length <= MAX_FULL_DEFINITIONS

        const sections: string[] = []
        if (shownNames.length > 1) {
          sections.push(
            `${String(names.length)} job(s)${names.length > shownNames.length ? `, showing ${String(shownNames.length)}` : ''}. ` +
              `Status: ${statusSummary([...statuses.values()]) || 'not available'}.`,
          )
        }
        for (const name of shownNames) {
          const definition = definitions.get(name) ?? {}
          const run = statuses.get(name)
          const status = run !== undefined ? describeRun(run) : `${name}: status not available`
          if (full || fields !== undefined) {
            const lines = renderDefinition(pick(definition)).map((line) => `  ${line}`)
            sections.push(
              [
                shownNames.length === 1 ? `Definition of ${name}:` : `${name}:`,
                ...(lines.length > 0 ? lines : ['  (none of the requested attributes are set)']),
                `  Status: ${run !== undefined ? status.slice(name.length + 2) : 'not available'}`,
              ].join('\n'),
            )
          } else {
            const type = field(definition, 'jobType', 'job_type', 'type')
            const box = field(definition, 'boxName', 'box_name')
            sections.push(`- ${status}${type !== undefined ? ` · ${type}` : ''}${box !== undefined ? ` · in ${box}` : ''}`)
          }
        }
        // A single box still lists its members, as the one-job version always did.
        if (shownNames.length === 1) {
          const only = shownNames[0] as string
          const type = (field(definitions.get(only) ?? {}, 'jobType', 'job_type', 'type') ?? '').toUpperCase()
          if (type === 'BOX' || type === 'B') {
            const members = await client.boxMembers(only).catch(() => [])
            if (members.length > 0) {
              sections.push(
                [`Jobs in this box (${String(members.length)}):`, ...members.map((member) => `- ${field(member, 'name', 'jobName') ?? '?'}`)].join('\n'),
              )
            }
          }
        }
        if (!full && fields === undefined) {
          sections.push('One line per job. Ask again with `fields` (e.g. command, machine, start_times, condition) for the attributes needed.')
        }
        if (problems.length > 0) sections.push(`Not found: ${problems.join(' ')}`)
        return { content: sections.join('\n\n') }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const statusSchema = z.object({
  pattern: z.string().optional().describe('Job name or pattern (* wildcards). Defaults to the configured pattern.'),
  jobs: z.array(z.string().min(1)).max(MAX_JOBS).optional().describe('Several job names or patterns at once, e.g. ["PAY_LOAD", "GL_*"].'),
  only: z
    .union([z.enum(STATUSES), z.array(z.enum(STATUSES)).min(1)])
    .optional()
    .describe('Only jobs in this status (or any of these), e.g. FAILURE, or ["FAILURE", "TERMINATED"].'),
  machine: z.string().optional().describe('Only jobs running (or last run) on this machine, * wildcards. With only: RUNNING answers "what is running on host X".'),
  withinHours: z.number().positive().max(24 * 31).optional().describe('Only jobs that started or ended in the last this-many hours, e.g. 6 with only: FAILURE.'),
  runningLongerThanMinutes: z.number().int().positive().optional().describe('Only jobs still RUNNING that started more than this many minutes ago - long runners.'),
})

/** Whether a run passes the status filters beyond its status. `now` is injectable for tests. */
export function runMatches(
  run: AutosysRun,
  filters: { machine?: string | undefined; withinHours?: number | undefined; runningLongerThanMinutes?: number | undefined },
  now = Date.now(),
): boolean {
  if (filters.machine !== undefined && !wildcardMatches(filters.machine, run.machine)) return false
  if (filters.withinHours !== undefined) {
    const since = now - filters.withinHours * 3_600_000
    const times = [parseAutosysTime(run.lastStart), parseAutosysTime(run.lastEnd)].filter((time): time is number => time !== undefined)
    if (!times.some((time) => time >= since)) return false
  }
  if (filters.runningLongerThanMinutes !== undefined) {
    if (run.status.toUpperCase() !== 'RUNNING') return false
    const started = parseAutosysTime(run.lastStart)
    if (started === undefined || now - started < filters.runningLongerThanMinutes * 60_000) return false
  }
  return true
}

/** " · running for 2 h 15 min", for a job still running. */
export function runningFor(run: AutosysRun, now = Date.now()): string {
  const started = parseAutosysTime(run.lastStart)
  if (run.status.toUpperCase() !== 'RUNNING' || started === undefined) return ''
  const minutes = Math.max(0, Math.round((now - started) / 60_000))
  return ` · running for ${minutes >= 60 ? `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min` : `${String(minutes)} min`}`
}

/** Failures first: they are what somebody reading a long list is looking for. */
const STATUS_ORDER = ['FAILURE', 'TERMINATED', 'RUNNING', 'STARTING', 'RESTART', 'ON_HOLD', 'ON_ICE']
const statusRank = (status: string): number => {
  const at = STATUS_ORDER.indexOf(status.toUpperCase())
  return at === -1 ? STATUS_ORDER.length : at
}

export function createAutosysStatusTool(options: AutosysToolOptions): Tool<z.infer<typeof statusSchema>> {
  return {
    name: 'autosys_status',
    group: 'read',
    description:
      'Current status of AutoSys jobs — like autorep -J: status, last start and end, exit code, run number and machine — ' +
      'for one job, a pattern, or many at once (`jobs`), with a count by status first. Use only: FAILURE to see what failed. ' +
      'Narrow by machine ("what is running on host X": machine with only: RUNNING), by time (withinHours: "what failed in ' +
      'the last 6 hours"), or find long runners (runningLongerThanMinutes). ' +
      'To follow a job until it finishes, check, `wait`, and check again.',
    parametersSchema: statusSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const wanted = requested(params.jobs, params.pattern, options.defaultPattern)
        if (wanted.length === 0) return { content: 'Give a job name, a list of jobs or a pattern — no default pattern is configured.', isError: true }
        const client = await options.client()
        const problems: string[] = []
        const lists = await inBatches(wanted, async (entry) => {
          try {
            return await client.runInfo(entry)
          } catch (error) {
            problems.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`)
            return [] as AutosysRun[]
          }
        })
        // One job named twice, or matched by two patterns, is still one job.
        const byName = new Map<string, AutosysRun>()
        for (const run of lists.flat()) if (!byName.has(run.name)) byName.set(run.name, run)
        const only =
          params.only === undefined ? undefined : (Array.isArray(params.only) ? params.only : [params.only]).map((status) => status.toUpperCase())
        const all = [...byName.values()]
        const filtered = params.machine !== undefined || params.withinHours !== undefined || params.runningLongerThanMinutes !== undefined
        const runs = all.filter((run) => (only === undefined || only.includes(run.status.toUpperCase())) && runMatches(run, params))
        // A machine filter over answers that carry no machine at all would read as "nothing runs there".
        if (params.machine !== undefined && all.length > 0 && all.every((run) => run.machine === undefined)) {
          return {
            content:
              "This AutoSys server's status answers do not say which machine a job ran on, so they cannot be filtered by machine. " +
              'Use autosys_machines (the jobs defined on and running on a machine) or autosys_find_jobs with machine instead.',
          }
        }
        const asked = wanted.join(', ')
        const paging = client.takeNotes()
        const unreadable = [...(problems.length > 0 ? ['', 'Could not read:', ...problems.map((problem) => `- ${problem}`)] : []), ...(paging.length > 0 ? ['', ...paging] : [])]
        if (runs.length === 0) {
          return {
            content: [
              all.length === 0
                ? `No jobs match ${asked}.`
                : `None of the ${String(all.length)} job(s) matching ${asked} are ${[
                    ...(only !== undefined ? [only.join(' or ')] : []),
                    ...(params.machine !== undefined ? [`on ${params.machine}`] : []),
                    ...(params.withinHours !== undefined ? [`active in the last ${String(params.withinHours)} h`] : []),
                    ...(params.runningLongerThanMinutes !== undefined ? [`running over ${String(params.runningLongerThanMinutes)} min`] : []),
                  ].join(', ')} (${statusSummary(all)}).`,
              ...unreadable,
            ].join('\n'),
            ...(problems.length > 0 && all.length === 0 ? { isError: true } : {}),
          }
        }
        const sorted = [...runs].sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name))
        const heading =
          only === undefined && !filtered
            ? `${String(runs.length)} job(s) — ${statusSummary(runs)}:`
            : only !== undefined && !filtered
              ? `${String(runs.length)} of the ${String(all.length)} matching job(s) are ${only.join(' or ')} (all: ${statusSummary(all)}):`
              : `${String(runs.length)} of the ${String(all.length)} matching job(s) pass the filters - ${statusSummary(runs)} (all: ${statusSummary(all)}):`
        return {
          content: [
            heading,
            ...sorted.slice(0, MAX_JOBS).map((run) => `- ${describeRun(run)}${runningFor(run)}`),
            ...(sorted.length > MAX_JOBS ? [`… and ${String(sorted.length - MAX_JOBS)} more; narrow the pattern or use only.`] : []),
            ...unreadable,
          ].join('\n'),
        }
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


/** Says which `autosys.paths` entry to set when this server answers somewhere else. */
function notOffered(what: string, pathKey: string): string {
  return (
    `This AutoSys server did not answer for ${what} at the documented address. Its web services may not offer it, or answer ` +
    `at a different path - set it in config:autosys (paths.${pathKey}).`
  )
}

const machinesSchema = z.object({
  machine: z.string().optional().describe('A machine name, or a pattern with * wildcards. Default every machine.'),
  jobs: z
    .boolean()
    .optional()
    .describe('Also list the jobs defined on each machine and those running on it now. Default true for one machine, false for a pattern.'),
  jobPattern: z.string().optional().describe('Which jobs to look through for those (* wildcards). Defaults to the configured pattern, else all.'),
})

export function createAutosysMachinesTool(options: AutosysToolOptions): Tool<z.infer<typeof machinesSchema>> {
  return {
    name: 'autosys_machines',
    group: 'read',
    description:
      'AutoSys machines (agents), like autorep -M: each machine’s definition and status - and, for one machine, the jobs ' +
      'defined on it and the jobs running on it right now, with their status. Answers "what is running on host X", ' +
      '"which jobs use this machine", "is the agent on X online".',
    parametersSchema: machinesSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const pattern = params.machine?.trim() || '*'
        const sections: string[] = []
        const machines = await client.machines(pattern)
        if (machines === undefined) sections.push(notOffered('machines', pattern.includes('*') ? 'machines' : 'machine'))
        else if (machines.length === 0) sections.push(`No AutoSys machines match ${pattern}.`)
        else {
          sections.push(
            [
              `${String(machines.length)} machine(s) match ${pattern}:`,
              ...machines.slice(0, MAX_JOBS).flatMap((machine) =>
                machines.length === 1 ? renderDefinition(machine).map((line) => `  ${line}`) : [`- ${describeMachine(machine)}`],
              ),
            ].join('\n'),
          )
        }

        const wantJobs = params.jobs ?? !pattern.includes('*')
        if (wantJobs) {
          const jobPattern = params.jobPattern ?? options.defaultPattern ?? '*'
          const [definitions, runs] = await Promise.all([
            client.findJobs(jobPattern).catch(() => [] as Record<string, unknown>[]),
            client.runInfo(jobPattern).catch(() => [] as AutosysRun[]),
          ])
          const statusOf = new Map(runs.map((run) => [run.name, run]))
          const defined = definitions.filter((job) => wildcardMatches(pattern, field(job, 'machine')))
          const running = runs.filter((run) => run.status.toUpperCase() === 'RUNNING' && wildcardMatches(pattern, run.machine))
          sections.push(
            running.length === 0
              ? `Nothing among ${jobPattern} is running on ${pattern} now.`
              : [`Running on ${pattern} now (${String(running.length)}):`, ...running.slice(0, MAX_JOBS).map((run) => `- ${describeRun(run)}${runningFor(run)}`)].join('\n'),
          )
          sections.push(
            defined.length === 0
              ? `No job among ${jobPattern} is defined to run on ${pattern}.`
              : [
                  `Defined to run on ${pattern} (${String(defined.length)}):`,
                  ...defined.slice(0, MAX_JOBS).map((job) => {
                    const name = field(job, 'name', 'jobName', 'job_name') ?? '?'
                    const run = statusOf.get(name)
                    return `- ${run !== undefined ? describeRun(run) : `${name}: status not available`}`
                  }),
                ].join('\n'),
          )
        }
        return { content: sections.join('\n\n') }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

/** One line per machine: name, type, status and whatever load figures the server reports. */
function describeMachine(machine: Record<string, unknown>): string {
  return [
    field(machine, 'name', 'machineName', 'machine') ?? '?',
    field(machine, 'status', 'machineStatus', 'state'),
    field(machine, 'type', 'machineType'),
    field(machine, 'nodeName', 'node_name') !== undefined ? `node ${field(machine, 'nodeName', 'node_name') ?? ''}` : undefined,
    field(machine, 'maxLoad', 'max_load') !== undefined ? `max load ${field(machine, 'maxLoad', 'max_load') ?? ''}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ')
}

const variablesSchema = z.object({
  name: z.string().optional().describe('A variable name or pattern (* wildcards). Default every variable.'),
  valueContains: z.string().optional().describe('Only variables whose value contains this text.'),
})

export function createAutosysGlobalVariablesTool(options: AutosysToolOptions): Tool<z.infer<typeof variablesSchema>> {
  return {
    name: 'autosys_global_variables',
    group: 'read',
    description:
      'AutoSys global variables, like autorep -G: name, value and when last set. Job conditions such as v(RUN_DATE) = "..." ' +
      'and commands using $VAR read these, so this answers "what is RUN_DATE set to" and "why is the condition on v(...) not met".',
    parametersSchema: variablesSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const pattern = params.name?.trim() || '*'
        const variables = await (await options.client()).globalVariables(pattern)
        if (variables === undefined) return { content: notOffered('global variables', 'globalVariables'), isError: true }
        const wanted = variables.filter((variable) =>
          params.valueContains === undefined ? true : (field(variable, 'value') ?? '').toLowerCase().includes(params.valueContains.toLowerCase()),
        )
        if (wanted.length === 0) return { content: `No global variables match ${pattern}${params.valueContains !== undefined ? ` with a value containing "${params.valueContains}"` : ''}.` }
        return {
          content: [
            `${String(wanted.length)} global variable(s):`,
            ...wanted.slice(0, MAX_JOBS).map((variable) => {
              const changed = field(variable, 'lastChanged', 'last_changed', 'lastUpdate', 'modified')
              return `- ${field(variable, 'name', 'variableName') ?? '?'} = ${field(variable, 'value') ?? '(empty)'}${changed !== undefined ? ` (set ${changed})` : ''}`
            }),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const calendarSchema = z.object({
  calendar: z.string().min(1).describe('The calendar name, as a job’s run_calendar or exclude_calendar names it.'),
  from: z.string().optional().describe('Only dates from this day, YYYY-MM-DD.'),
  to: z.string().optional().describe('Only dates up to this day, YYYY-MM-DD.'),
  date: z.string().optional().describe('Just answer whether this day (YYYY-MM-DD) is in the calendar.'),
})

export function createAutosysCalendarTool(options: AutosysToolOptions): Tool<z.infer<typeof calendarSchema>> {
  return {
    name: 'autosys_calendar',
    group: 'read',
    description:
      'An AutoSys calendar - the dates in a standard calendar, or an extended calendar’s rules - optionally between two dates, ' +
      'or whether one date is in it. With autosys_job’s run_calendar and exclude_calendar this answers "will this job run on the 31st?".',
    parametersSchema: calendarSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const found = await (await options.client()).calendar(params.calendar)
        if (found === undefined) return { content: notOffered(`calendar ${params.calendar}`, 'calendar'), isError: true }
        if (found.records.length === 0) return { content: `No AutoSys calendar called ${params.calendar}.`, isError: true }
        if (found.kind === 'extended') {
          return { content: [`${params.calendar} is an extended calendar (rules, not a date list):`, ...found.records.flatMap((record) => renderDefinition(record)).map((line) => `  ${line}`)].join('\n') }
        }
        const dates = calendarDates(found.records)
        if (params.date !== undefined) {
          return { content: `${params.date} ${dates.includes(params.date) ? 'is' : 'is not'} in calendar ${params.calendar} (${String(dates.length)} date(s) in it).` }
        }
        const shown = dates.filter((date) => (params.from === undefined || date >= params.from) && (params.to === undefined || date <= params.to))
        if (shown.length === 0) return { content: `Calendar ${params.calendar} has no dates${params.from !== undefined || params.to !== undefined ? ' in that range' : ''}.` }
        return {
          content: [
            `Calendar ${params.calendar}: ${String(shown.length)} date(s)${shown.length !== dates.length ? ` of ${String(dates.length)}` : ''}${shown.length > 400 ? ', first 400 shown' : ''}:`,
            shown.slice(0, 400).join(', '),
          ].join('\n'),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const scheduleSchema = z.object({
  pattern: z.string().optional().describe('Which jobs to look through (* wildcards). Defaults to the configured pattern, else all.'),
  from: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Window start, HH:MM (24 h). Default 00:00.'),
  to: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Window end, HH:MM. Default 23:59. A window past midnight (22:00 to 02:00) wraps.'),
  day: z.string().optional().describe('Only jobs that run on this day: a weekday (mon, saturday), today, tomorrow, or a date YYYY-MM-DD.'),
  machine: z.string().optional().describe('Only jobs defined on this machine (* wildcards).'),
  withStatus: z.boolean().optional().describe('Add each job’s current status. Default false.'),
})

export function createAutosysScheduleTool(options: AutosysToolOptions): Tool<z.infer<typeof scheduleSchema>> {
  return {
    name: 'autosys_schedule',
    group: 'read',
    description:
      'When AutoSys jobs are scheduled to start, read from their definitions (start_times, start_mins, days_of_week, ' +
      'run_calendar): which jobs start in a time window and on which day, in start order. Answers "what runs between 2 and ' +
      '4 am", "what is scheduled on Saturday", "what starts on host X tonight". Jobs started only by a condition or by their ' +
      'box have no start time of their own and are counted, not listed.',
    parametersSchema: scheduleSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const pattern = params.pattern ?? options.defaultPattern ?? '*'
        const from = params.from ?? '00:00'
        const to = params.to ?? '23:59'
        const day = params.day !== undefined ? weekdayOf(params.day) : undefined
        if (params.day !== undefined && day === undefined) {
          return { content: `"${params.day}" is not a day - use a weekday, today, tomorrow or YYYY-MM-DD.`, isError: true }
        }
        const definitions = (await client.findJobs(pattern)).filter(
          (job) => params.machine === undefined || wildcardMatches(params.machine, field(job, 'machine')),
        )
        const starts: { time: string; name: string; line: string }[] = []
        const byCalendar: string[] = []
        let unscheduled = 0
        for (const job of definitions) {
          const name = field(job, 'name', 'jobName', 'job_name') ?? '?'
          const schedule = jobSchedule(job)
          if (schedule === undefined) {
            unscheduled++
            continue
          }
          const times = startsInWindow(schedule, from, to, day)
          const where = [
            field(job, 'boxName', 'box_name') !== undefined ? `in ${field(job, 'boxName', 'box_name') ?? ''}` : undefined,
            field(job, 'machine') !== undefined ? `on ${field(job, 'machine') ?? ''}` : undefined,
            schedule.runCalendar !== undefined ? `calendar ${schedule.runCalendar}` : describeDays(schedule.days),
            schedule.excludeCalendar !== undefined ? `except calendar ${schedule.excludeCalendar}` : undefined,
            schedule.timezone !== undefined ? `time zone ${schedule.timezone}` : undefined,
          ]
            .filter((part): part is string => part !== undefined)
            .join(', ')
          if (times.length === 0 && schedule.runCalendar !== undefined && schedule.times.length === 0 && schedule.minutesPastHour.length === 0) {
            byCalendar.push(`- ${name} (${where})`)
            continue
          }
          // A calendar decides the day, not the weekday list: keep it and say which calendar to check.
          for (const time of times) starts.push({ time, name, line: `${time}  ${name} (${where})` })
        }
        starts.sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name))
        const statuses = new Map<string, AutosysRun>()
        if (params.withStatus === true && starts.length > 0) {
          const runs = await client.runInfo(pattern).catch(() => [] as AutosysRun[])
          for (const run of runs) statuses.set(run.name, run)
        }
        const window = `${from}-${to}${params.day !== undefined ? ` on ${params.day}` : ''}`
        const lines = [
          starts.length === 0
            ? `No job among ${pattern} is scheduled to start ${window}.`
            : `${String(new Set(starts.map((entry) => entry.name)).size)} job(s) among ${pattern} start ${window} (${String(starts.length)} start(s)):`,
          ...starts.slice(0, 400).map((entry) => {
            const run = statuses.get(entry.name)
            return `- ${entry.line}${run !== undefined ? ` - now ${run.status}` : ''}`
          }),
          ...(starts.length > 400 ? [`... and ${String(starts.length - 400)} more; narrow the window or the pattern.`] : []),
        ]
        if (byCalendar.length > 0) {
          lines.push('', 'Run by calendar with no start time of their own (read the calendar with autosys_calendar):', ...byCalendar.slice(0, 100))
        }
        if (unscheduled > 0) lines.push('', `${String(unscheduled)} job(s) have no start schedule - started by a condition, by their box, or by hand.`)
        if (day !== undefined && starts.some((entry) => entry.line.includes('calendar '))) {
          lines.push('', 'Jobs on a run calendar run on that calendar’s dates; check the date with autosys_calendar.')
        }
        return { content: lines.join('\n') }
      } catch (error) {
        return errorResult(error)
      }
    },
  }
}

const runsSchema = z.object({
  jobs: z.array(z.string().min(1)).min(1).max(50).describe('The job names to report on (exact names).'),
  hours: z.number().positive().max(24 * 31).optional().describe('The last this-many hours. Default: today, since midnight.'),
})

export function createAutosysRunsTool(options: AutosysToolOptions): Tool<z.infer<typeof runsSchema>> {
  return {
    name: 'autosys_runs',
    group: 'read',
    description:
      'Every run of the given AutoSys jobs today (or in the last N hours) with status, times and exit code - and how each ' +
      'started: on its own (schedule or condition), retried automatically by AutoSys, or MANUALLY, with who sent the ' +
      'FORCE_STARTJOB or STARTJOB and when. Also lists other events people sent to these jobs in the period (kill, hold, ' +
      'change status...). Answers "did anyone rerun PAY_LOAD today, and who?".',
    parametersSchema: runsSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const since = periodStart(params.hours)
        const period = params.hours !== undefined ? `in the last ${String(params.hours)} h` : 'today'
        let historyMissing = false
        let eventsMissing = false
        const sections = await inBatches([...new Set(params.jobs.map((job) => job.trim()))], async (name) => {
          try {
            const [history, eventRecords, current] = await Promise.all([
              client.runHistory(name),
              client.eventHistory(name),
              client.runInfo(name).catch(() => [] as AutosysRun[]),
            ])
            if (history === undefined) historyMissing = true
            if (eventRecords === undefined) eventsMissing = true
            const latest = current[0]
            // Without a run history, the latest run is all there is to say about runs.
            const runs: PastRun[] =
              history !== undefined
                ? history.map(toPastRun)
                : latest !== undefined
                  ? [toPastRun({ lastStart: latest.lastStart, lastEnd: latest.lastEnd, status: latest.status, exitCode: latest.exitCode, runNum: latest.runNum, machine: latest.machine })]
                  : []
            const events: JobEvent[] | undefined = eventRecords?.map(toJobEvent)
            const recent = runs.filter((run) => inPeriod(run, since)).sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
            const classified = classifyRuns(recent, events?.filter((event) => event.at === undefined || event.at >= since - 10 * 60_000))
            const manual = classified.filter((run) => run.how === 'manual')
            const retries = classified.filter((run) => run.how === 'retry')
            const headline = [
              `${name}: ${String(classified.length)} run(s) ${period}`,
              latest !== undefined ? `now ${latest.status}` : undefined,
              manual.length > 0 ? `started by hand ${String(manual.length)}x (${manual.map((run) => `${run.by?.user ?? 'unknown sender'} at ${clock(run.by?.at)}`).join(', ')})` : undefined,
              retries.length > 0 ? `${String(retries.length)} automatic retr${retries.length === 1 ? 'y' : 'ies'}` : undefined,
            ].filter((part): part is string => part !== undefined)
            // What people did to the job that is not a run start: kill, hold, ice, status changes, comments.
            const otherByPeople = (events ?? []).filter(
              (event) => event.at !== undefined && event.at >= since && !['FORCE_STARTJOB', 'STARTJOB'].includes(event.type) && event.user !== undefined,
            )
            return [
              headline.join(' · '),
              ...classified.map((run) => `  - ${describePastRun(run)}`),
              ...(otherByPeople.length > 0
                ? ['  Other events sent by people:', ...otherByPeople.map((event) => `  - ${clock(event.at)} ${event.type}${event.status !== undefined ? ` ${event.status}` : ''} by ${event.user ?? '?'}${event.comment !== undefined ? ` ("${event.comment}")` : ''}`)]
                : []),
            ].join('\n')
          } catch (error) {
            return `${name}: ${error instanceof Error ? error.message : String(error)}`
          }
        })
        const notes = [
          ...(historyMissing
            ? [`This server did not answer for run history at the configured address, so only each job's latest run is shown - set config:autosys (paths.runHistory).`]
            : []),
          ...(eventsMissing
            ? [`This server did not answer for event history at the configured address, so whether a run was started by hand, and by whom, cannot be told - set config:autosys (paths.eventHistory).`]
            : []),
        ]
        return { content: [...sections, ...(notes.length > 0 ? ['', ...notes] : [])].join('\n\n') }
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
    createAutosysRunsTool(options),
    createAutosysDependenciesTool(options),
    createAutosysLogTool(options),
    createAutosysMachinesTool(options),
    createAutosysGlobalVariablesTool(options),
    createAutosysCalendarTool(options),
    createAutosysScheduleTool(options),
    createAutosysSendEventTool(options),
    createAutosysApplyJilTool(options),
  ] as unknown as Tool<never>[]
}
