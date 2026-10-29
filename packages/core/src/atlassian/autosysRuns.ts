import { parseAutosysTime } from './autosysSchedule.js'

/**
 * A job's runs in a period, and how each one started - by its schedule or condition, by AutoSys
 * retrying it, or by a person (and who, and when).
 *
 * Asked for: "status of a given list of jobs for today or in the last N hours, if a job is rerun
 * manually or automatically, if manually who started it and at what time". Two sources answer it:
 * the job's run history (each run's start, end, status, run number and try) and its event history
 * (each sendevent: which event, when, from whom). A run with a FORCE_STARTJOB or STARTJOB from a
 * person shortly before it is manual; a later try of the same run number is an automatic retry
 * (n_retrys); anything else started on its own. Field names differ across AutoSys releases, so each
 * is read under every name it is known by, and a value that is not there is never guessed.
 */

export interface PastRun {
  start?: number | undefined
  end?: number | undefined
  status: string
  exitCode?: string | undefined
  runNum?: string | undefined
  /** The try within a run number: 2 and later are AutoSys retrying the job by itself. */
  tryNum?: number | undefined
  machine?: string | undefined
}

export interface JobEvent {
  type: string
  at?: number | undefined
  user?: string | undefined
  status?: string | undefined
  comment?: string | undefined
}

export interface ClassifiedRun extends PastRun {
  how: 'manual' | 'retry' | 'scheduled' | 'unknown'
  /** The event that started it by hand. */
  by?: JobEvent | undefined
}

function text(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name]
    if (value !== undefined && value !== null && value !== '') return String(value)
  }
  return undefined
}

export function toPastRun(record: Record<string, unknown>): PastRun {
  const tryNum = Number(text(record, 'ntry', 'tryNum', 'try', 'tryNumber', 'retry', 'attempt'))
  return {
    start: parseAutosysTime(text(record, 'start', 'startTime', 'start_time', 'lastStart', 'lastStartTime', 'runStart')),
    end: parseAutosysTime(text(record, 'end', 'endTime', 'end_time', 'lastEnd', 'lastEndTime', 'runEnd')),
    status: text(record, 'status', 'jobStatus', 'runStatus') ?? '?',
    exitCode: text(record, 'exitCode', 'exit_code', 'lastExitCode', 'exit'),
    runNum: text(record, 'runNum', 'run_num', 'runNumber', 'run'),
    ...(Number.isFinite(tryNum) && tryNum > 0 ? { tryNum } : {}),
    machine: text(record, 'machine', 'runMachine', 'run_machine'),
  }
}

export function toJobEvent(record: Record<string, unknown>): JobEvent {
  return {
    type: (text(record, 'eventType', 'event', 'type', 'eventName', 'name') ?? '?').toUpperCase(),
    at: parseAutosysTime(text(record, 'eventTime', 'time', 'timestamp', 'eventTimestamp', 'date', 'processedTime')),
    user: text(record, 'user', 'userName', 'sender', 'sentBy', 'who', 'owner', 'requestedBy'),
    status: text(record, 'status', 'newStatus'),
    comment: text(record, 'comment', 'text', 'description'),
  }
}

/** Events a person sends to start a job. */
const START_EVENTS = new Set(['FORCE_STARTJOB', 'STARTJOB'])
/** How long before a run's start its start event may be (the event processor takes a moment). */
const START_SLACK_MS = 5 * 60_000

/**
 * How each run started. A start event from a person within a few minutes before it makes it manual;
 * a try after the first of one run number is AutoSys retrying; otherwise it started on its own -
 * unless there are no events to look at, which is "unknown", not "scheduled".
 */
export function classifyRuns(runs: readonly PastRun[], events: readonly JobEvent[] | undefined): ClassifiedRun[] {
  const starts = (events ?? []).filter((event) => START_EVENTS.has(event.type) && event.at !== undefined)
  return runs.map((run): ClassifiedRun => {
    if (run.start !== undefined) {
      const start = run.start
      const trigger = starts
        .filter((event) => (event.at ?? 0) <= start + 60_000 && (event.at ?? 0) >= start - START_SLACK_MS)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0]
      if (trigger !== undefined) return { ...run, how: 'manual', by: trigger }
    }
    if (run.tryNum !== undefined && run.tryNum > 1) return { ...run, how: 'retry' }
    return { ...run, how: events === undefined ? 'unknown' : 'scheduled' }
  })
}

/** The start of the period asked for: local midnight for "today", else now minus the hours. */
export function periodStart(hours: number | undefined, now = new Date()): number {
  if (hours !== undefined) return now.getTime() - hours * 3_600_000
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/** Whether a run touched the period: started in it, ended in it, or is still running from before it. */
export function inPeriod(run: PastRun, since: number): boolean {
  return (run.start !== undefined && run.start >= since) || (run.end !== undefined && run.end >= since) || (run.start !== undefined && run.end === undefined && run.status.toUpperCase() === 'RUNNING')
}

/** A time as the person reads it: HH:MM:SS today, else the date too. */
export function clock(at: number | undefined, now = new Date()): string {
  if (at === undefined) return '?'
  const date = new Date(at)
  const time = date.toTimeString().slice(0, 8)
  return date.toDateString() === now.toDateString() ? time : `${date.toISOString().slice(0, 10)} ${time}`
}

/** One line per run, saying how it started. */
export function describeRun(run: ClassifiedRun, now = new Date()): string {
  const parts = [
    `${run.runNum !== undefined ? `run ${run.runNum}${run.tryNum !== undefined && run.tryNum > 1 ? ` try ${String(run.tryNum)}` : ''}` : 'run'}:`,
    run.status,
    run.exitCode !== undefined ? `exit ${run.exitCode}` : undefined,
    `started ${clock(run.start, now)}`,
    run.end !== undefined ? `ended ${clock(run.end, now)}` : run.status.toUpperCase() === 'RUNNING' ? 'still running' : undefined,
    run.machine !== undefined ? `on ${run.machine}` : undefined,
  ].filter((part): part is string => part !== undefined)
  const how =
    run.how === 'manual'
      ? `MANUAL - ${run.by?.type ?? 'start event'}${run.by?.user !== undefined ? ` by ${run.by.user}` : ' (sender not recorded)'} at ${clock(run.by?.at, now)}${run.by?.comment !== undefined ? ` ("${run.by.comment}")` : ''}`
      : run.how === 'retry'
        ? 'AUTOMATIC RETRY by AutoSys (n_retrys)'
        : run.how === 'scheduled'
          ? 'automatic - its schedule or condition'
          : 'how it started is not known (no event history)'
  return `${parts.join(' · ')} - ${how}`
}
