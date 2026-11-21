import type { PastRun } from './autosysRuns.js'

/**
 * What a job's own history and definitions say about its timing - asked for: the average run time of a job, an ETA for
 * one running now (in local time), the normal start time of a job that has no start time and is started by a dependency,
 * and every predecessor of a job, recursively up to the topmost job, with statuses. "I guess it needs to use the job
 * definitions": the predecessors and a dependency-driven start come from the definitions (`condition`, `box_name`,
 * `start_times`); the durations and observed starts from the run history. Pure, so every number is pinned by tests.
 */

export interface DurationStats {
  count: number
  meanMs: number
  medianMs: number
  /** One run in ten took this long or less. */
  p10Ms: number
  /** Nine runs in ten took this long or less - the "likely latest" for an ETA. */
  p90Ms: number
  minMs: number
  maxMs: number
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const position = (sorted.length - 1) * q
  const below = Math.floor(position)
  const above = Math.ceil(position)
  const low = sorted[below] ?? 0
  const high = sorted[above] ?? low
  return low + (high - low) * (position - below)
}

/**
 * How long finished runs took. Successful runs by default - a failure that stops after a minute says nothing about how
 * long the job takes - unless there are none, in which case every finished run counts and `onlySuccess` reports false.
 */
export function runDurations(runs: readonly PastRun[]): { durations: number[]; onlySuccess: boolean } {
  const finished = runs.filter((run) => run.start !== undefined && run.end !== undefined && run.end > run.start)
  const succeeded = finished.filter((run) => run.status.toUpperCase() === 'SUCCESS')
  const chosen = succeeded.length > 0 ? succeeded : finished
  return { durations: chosen.map((run) => (run.end ?? 0) - (run.start ?? 0)), onlySuccess: succeeded.length > 0 }
}

export function durationStats(durations: readonly number[]): DurationStats | undefined {
  if (durations.length === 0) return undefined
  const sorted = [...durations].sort((a, b) => a - b)
  return {
    count: sorted.length,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    medianMs: quantile(sorted, 0.5),
    p10Ms: quantile(sorted, 0.1),
    p90Ms: quantile(sorted, 0.9),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  }
}

/** "1 h 05 min", "4 min 12 s", "38 s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)} min ${String(seconds % 60).padStart(2, '0')} s`
  const hours = Math.floor(minutes / 60)
  return `${String(hours)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** A moment in this machine's local time: "14:05" today, else the date too, with the zone named once by the caller. */
export function localTime(at: number, now = new Date()): string {
  const date = new Date(at)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === now.toDateString()) return time
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  if (date.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`
}

/** The local time zone as people read it ("GMT+8" style when the platform has no name for it). */
export function localZone(now = new Date()): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(now).find((part) => part.type === 'timeZoneName')?.value ?? 'local time'
  } catch {
    return 'local time'
  }
}

export interface Eta {
  elapsedMs: number
  /** When it should finish, at its median run time. */
  expected: number
  /** When nine runs in ten would have finished. */
  latest: number
  /** Already running longer than nine runs in ten took. */
  overrun: boolean
}

export function etaFor(startedAt: number, stats: DurationStats, now = Date.now()): Eta {
  const elapsedMs = Math.max(0, now - startedAt)
  return {
    elapsedMs,
    expected: startedAt + stats.medianMs,
    latest: startedAt + Math.max(stats.p90Ms, stats.medianMs),
    overrun: elapsedMs > Math.max(stats.p90Ms, stats.medianMs),
  }
}

/** Minutes past local midnight. */
export function minuteOfDay(at: number): number {
  const date = new Date(at)
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
}

export function clockOfMinute(minute: number): string {
  const wrapped = ((Math.round(minute) % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

export interface TimeOfDayStats {
  count: number
  /** The usual start, minutes past midnight. */
  typical: number
  /** One start in ten was this early or earlier. */
  early: number
  /** Nine starts in ten were by this time. */
  late: number
  /** Late minus early, in minutes: how tight the habit is. */
  spreadMinutes: number
}

/**
 * The usual time of day of a set of moments, measured **around the clock**: a job that starts at 23:55 one night and
 * 00:05 the next usually starts at midnight, not at noon. The circular mean picks the centre; each start is then an
 * offset from it, and the median and the 10th and 90th percentiles of those offsets give the typical time and its range.
 */
export function timeOfDayStats(moments: readonly number[]): TimeOfDayStats | undefined {
  if (moments.length === 0) return undefined
  const minutes = moments.map(minuteOfDay)
  const angle = (minute: number): number => (minute / 1440) * 2 * Math.PI
  const sin = minutes.reduce((sum, minute) => sum + Math.sin(angle(minute)), 0)
  const cos = minutes.reduce((sum, minute) => sum + Math.cos(angle(minute)), 0)
  const centre = (((Math.atan2(sin, cos) / (2 * Math.PI)) * 1440) % 1440 + 1440) % 1440
  const offsets = minutes
    .map((minute) => {
      let offset = minute - centre
      if (offset > 720) offset -= 1440
      if (offset < -720) offset += 1440
      return offset
    })
    .sort((a, b) => a - b)
  const early = centre + quantile(offsets, 0.1)
  const late = centre + quantile(offsets, 0.9)
  return { count: minutes.length, typical: centre + quantile(offsets, 0.5), early, late, spreadMinutes: late - early }
}

/** Runs that show when the job starts by itself: no retries, and none started by hand (when that can be told). */
export function ownStarts(runs: readonly (PastRun & { how?: string })[]): number[] {
  return runs
    .filter((run) => run.start !== undefined && !(run.tryNum !== undefined && run.tryNum > 1) && run.how !== 'manual' && run.how !== 'retry')
    .map((run) => run.start ?? 0)
}

// ─── Predecessors ───────────────────────────────────────────────────────────────

export interface PredecessorReference {
  /** `s`, `f`, `d`, `n`, `t`, `e`, or `box` for the box the job sits in. */
  kind: string
  job: string
  instance?: string | undefined
  comparison?: string | undefined
}

export interface PredecessorNode {
  name: string
  status: string
  lastStart?: string | undefined
  lastEnd?: string | undefined
  condition?: string | undefined
  box?: string | undefined
  /** `start_times` etc. as a line, when it starts on a schedule of its own. */
  schedule?: string | undefined
  /** No condition and no box: the top of its chain. */
  top: boolean
  /** The definition could not be read. */
  unreadable?: string | undefined
  predecessors: { reference: PredecessorReference; met: boolean | undefined; onOtherInstance: boolean }[]
}

export interface PredecessorSource {
  definition(name: string): Promise<Record<string, unknown> | undefined>
  status(name: string): Promise<{ status: string; lastStart?: string | undefined; lastEnd?: string | undefined }>
  parseConditions(condition: string): PredecessorReference[]
  conditionMet(kind: string, status: string): boolean | undefined
  field(record: Record<string, unknown>, ...names: string[]): string | undefined
  /** The job's starting condition and box, wherever the server's definition holds them. */
  condition(definition: Record<string, unknown>): string | undefined
  box(definition: Record<string, unknown>): string | undefined
  schedule(definition: Record<string, unknown>): string | undefined
}

export interface PredecessorTrace {
  root: string
  nodes: Map<string, PredecessorNode>
  /** Jobs at the top of a chain: no condition and no box. */
  tops: string[]
  /** The walk stopped at the node limit. */
  truncated: boolean
  /** The deepest level reached. */
  depth: number
}

/**
 * Every predecessor of a job, recursively, to the topmost jobs - every job its condition names (met or not) and the box
 * it sits in, then theirs. Each job is read once however many paths reach it, so a diamond is not walked twice and a
 * cycle ends. Breadth-first, a level at a time, so the limit cuts the farthest jobs rather than one deep branch.
 */
export async function tracePredecessors(source: PredecessorSource, root: string, limits: { maxJobs?: number; maxDepth?: number } = {}): Promise<PredecessorTrace> {
  const maxJobs = limits.maxJobs ?? 200
  const maxDepth = limits.maxDepth ?? 30
  const nodes = new Map<string, PredecessorNode>()
  let level = [root]
  let depth = 0
  let truncated = false
  while (level.length > 0 && depth <= maxDepth) {
    const fresh = [...new Set(level)].filter((name) => !nodes.has(name.toLowerCase()))
    const room = maxJobs - nodes.size
    if (fresh.length > room) truncated = true
    const batch = fresh.slice(0, Math.max(0, room))
    const read = await Promise.all(
      batch.map(async (name): Promise<PredecessorNode> => {
        const [definition, state] = await Promise.all([source.definition(name).catch(() => undefined), source.status(name).catch((): { status: string; lastStart?: string; lastEnd?: string } => ({ status: 'unknown' }))])
        if (definition === undefined) return { name, status: state.status, top: false, unreadable: 'definition not readable', predecessors: [] }
        const condition = source.condition(definition)
        const box = source.box(definition)
        const references: PredecessorReference[] = [...(box !== undefined ? [{ kind: 'box', job: box }] : []), ...(condition !== undefined ? source.parseConditions(condition) : [])]
        const predecessors = await Promise.all(
          references.map(async (reference) => {
            if (reference.instance !== undefined) return { reference, met: undefined, onOtherInstance: true }
            const other = await source.status(reference.job).catch(() => ({ status: 'unknown' }))
            const met = reference.kind === 'box' ? other.status.toUpperCase() === 'RUNNING' : source.conditionMet(reference.kind, other.status)
            return { reference, met, onOtherInstance: false }
          }),
        )
        return {
          name,
          status: state.status,
          ...(state.lastStart !== undefined ? { lastStart: state.lastStart } : {}),
          ...(state.lastEnd !== undefined ? { lastEnd: state.lastEnd } : {}),
          ...(condition !== undefined ? { condition } : {}),
          ...(box !== undefined ? { box } : {}),
          ...(source.schedule(definition) !== undefined ? { schedule: source.schedule(definition) } : {}),
          top: condition === undefined && box === undefined,
          predecessors,
        }
      }),
    )
    for (const node of read) nodes.set(node.name.toLowerCase(), node)
    const next: string[] = []
    for (const node of read) for (const each of node.predecessors) if (!each.onOtherInstance && !nodes.has(each.reference.job.toLowerCase())) next.push(each.reference.job)
    if (next.length > 0 && depth === maxDepth) truncated = true
    level = next
    depth += next.length > 0 ? 1 : 0
  }
  const tops = [...nodes.values()].filter((node) => node.top).map((node) => node.name)
  return { root, nodes, tops, truncated, depth }
}

const KIND_WORDS: Record<string, string> = { s: 'success of', f: 'failure of', d: 'completion of', n: 'not running:', t: 'termination of', e: 'exit code of', box: 'inside box' }

/** The trace as a tree a person reads: each job once in full, a repeat pointing back to it, the tops summarised. */
export function describeTrace(trace: PredecessorTrace, extra?: (node: PredecessorNode) => string | undefined): string {
  const lines: string[] = []
  const shown = new Set<string>()
  const line = (node: PredecessorNode | undefined, name: string, indent: string, via: string): void => {
    const key = name.toLowerCase()
    if (node === undefined) {
      lines.push(`${indent}${via}${name} - not traced (limit reached)`)
      return
    }
    if (shown.has(key)) {
      lines.push(`${indent}${via}${name} [${node.status}] (traced above)`)
      return
    }
    shown.add(key)
    const facts = [
      `[${node.status}]`,
      node.lastStart !== undefined ? `last start ${node.lastStart}` : undefined,
      node.lastEnd !== undefined ? `last end ${node.lastEnd}` : undefined,
      node.top ? `TOP${node.schedule !== undefined ? ` - starts ${node.schedule}` : ' - no condition, no box, no start schedule (started by hand or by another instance)'}` : undefined,
      node.unreadable,
      extra?.(node),
    ].filter((part): part is string => part !== undefined)
    lines.push(`${indent}${via}${name} ${facts.join(' · ')}`)
    if (node.condition !== undefined) lines.push(`${indent}    condition: ${node.condition}`)
    for (const each of node.predecessors) {
      const word = KIND_WORDS[each.reference.kind] ?? each.reference.kind
      const state = each.onOtherInstance ? 'on another instance - not checked' : each.met === undefined ? 'check the exit code' : each.met ? 'met' : 'NOT met'
      const label = `${word} (${state}${each.reference.comparison !== undefined ? `, ${each.reference.comparison}` : ''}) `
      if (each.onOtherInstance) {
        lines.push(`${indent}    ${label}${each.reference.job}^${each.reference.instance ?? ''}`)
        continue
      }
      line(trace.nodes.get(each.reference.job.toLowerCase()), each.reference.job, `${indent}    `, label)
    }
  }
  line(trace.nodes.get(trace.root.toLowerCase()), trace.root, '', '')
  const all = [...trace.nodes.values()]
  const notMet = all.flatMap((node) => node.predecessors.filter((each) => each.met === false).map((each) => `${node.name} waits on ${KIND_WORDS[each.reference.kind] ?? each.reference.kind} ${each.reference.job}`))
  const failed = all.filter((node) => ['FAILURE', 'TERMINATED'].includes(node.status.toUpperCase())).map((node) => `${node.name} [${node.status}]`)
  lines.push(
    '',
    `${String(all.length - 1)} predecessor job(s) over ${String(trace.depth)} level(s). Topmost: ${trace.tops.filter((name) => name.toLowerCase() !== trace.root.toLowerCase()).join(', ') || 'none (it is the top itself)'}.`,
    ...(failed.length > 0 ? [`Failed or terminated: ${failed.join(', ')}.`] : []),
    ...(notMet.length > 0 ? ['Not met now:', ...notMet.slice(0, 40).map((entry) => `- ${entry}`)] : []),
    ...(trace.truncated ? ['The walk stopped at its limit; raise maxJobs or maxDepth to go further.'] : []),
  )
  return lines.join('\n')
}

/**
 * When a job normally starts, worked out from its definitions rather than its history: a job with start times starts
 * then (its first one); a box member starts with its box; a job started by a condition starts when the last of the jobs
 * it waits on finishes - each of those at its own normal start plus its typical run time, recursively up to jobs with
 * start times. Minutes past midnight, which may run past 1440 when a chain crosses midnight. Undefined when a link is
 * missing (no start time at the top, or no run history for a job in between) - said by `missing`.
 */
export function expectedStartFromDefinitions(
  trace: PredecessorTrace,
  durations: ReadonlyMap<string, number>,
  startMinutes: ReadonlyMap<string, number>,
): { start: number | undefined; missing: string[]; via: string[] } {
  const memo = new Map<string, number | undefined>()
  const missing = new Set<string>()
  const via = new Map<string, string[]>()
  const visiting = new Set<string>()
  const startOf = (name: string): number | undefined => {
    const key = name.toLowerCase()
    if (memo.has(key)) return memo.get(key)
    if (visiting.has(key)) return undefined
    visiting.add(key)
    const node = trace.nodes.get(key)
    let result: number | undefined
    const own = startMinutes.get(key)
    if (own !== undefined) {
      result = own
      via.set(key, [`${name} starts at ${clockOfMinute(own)}`])
    } else if (node === undefined || node.top) {
      missing.add(`${name} (no start time)`)
    } else {
      const finishes: { name: string; at: number | undefined }[] = node.predecessors
        .filter((each) => !each.onOtherInstance && ['s', 'd', 'box'].includes(each.reference.kind))
        .map((each) => {
          const before = startOf(each.reference.job)
          if (each.reference.kind === 'box') return { name: each.reference.job, at: before }
          const took = durations.get(each.reference.job.toLowerCase())
          if (took === undefined) missing.add(`${each.reference.job} (no run history)`)
          return { name: each.reference.job, at: before === undefined || took === undefined ? undefined : before + took / 60_000 }
        })
      if (finishes.length > 0 && finishes.every((each) => each.at !== undefined)) {
        const last = finishes.reduce((latest, each) => ((each.at ?? 0) > (latest.at ?? 0) ? each : latest))
        result = last.at
        via.set(key, [...(via.get(last.name.toLowerCase()) ?? []), `${name} after ${last.name} (${clockOfMinute(last.at ?? 0)})`])
      } else if (finishes.length === 0) missing.add(`${name} (waits only on conditions that do not say when)`)
    }
    visiting.delete(key)
    memo.set(key, result)
    return result
  }
  const start = startOf(trace.root)
  return { start, missing: [...missing], via: via.get(trace.root.toLowerCase()) ?? [] }
}
