import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { replaceFile } from '../platform/node/replaceFile.js'

/**
 * Which skills and tools are used, by whom - the facts the usage dashboard is drawn from.
 *
 * **Names and times only, never arguments or results.** A tool's arguments are file paths, queries
 * and message bodies; a dashboard needs none of that to say "deploy-checklist was read 40 times by 6
 * people", and an event that carried them would turn a team store into a log of everybody's work.
 *
 * Collected only into a store the team already shares (`usage/auto.ts`) - the user's own configured
 * folder, bucket or vector store; invariant 4 (no telemetry) is about contacting anybody else.
 */
export interface UsageEvent {
  /** When, in milliseconds since the epoch. */
  t: number
  /** Who - `identity.owner`, or the OS user name. */
  u: string
  /** Which project, when known. */
  p?: string
  k: 'skill' | 'tool'
  /** The skill name, or the tool name as registered (`py__x` for a Python tool). */
  n: string
  /** The skill's or tool's author from its own label, so contribution is countable across machines. */
  a?: string
  /** Present, and false, only when the call failed - most succeed, and the file stays small. */
  ok?: false
  /** How long a tool call took, in milliseconds. */
  d?: number
}

export function isUsageEvent(value: unknown): value is UsageEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return (
    typeof event['t'] === 'number' &&
    typeof event['u'] === 'string' &&
    (event['k'] === 'skill' || event['k'] === 'tool') &&
    typeof event['n'] === 'string'
  )
}

/** One JSON object per line; a torn final line costs that line, never the file. */
export function parseUsageLines(text: string): UsageEvent[] {
  const events: UsageEvent[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isUsageEvent(parsed)) events.push(parsed)
    } catch {
      // A line half-written when a window closed. Skipped, not fatal.
    }
  }
  return events
}

/** `YYYY-MM-DD` in UTC - shard names must mean the same day on every machine. */
export function usageDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * This install, so two machines of one person write separate shards. Every session sharing a storage
 * folder (several VS Code windows) is one install: their days are merged into one shard by whichever
 * of them pushes.
 */
export function usageInstanceId(storageDir: string): string {
  return createHash('sha256').update(`${os.hostname()}\n${path.resolve(storageDir).toLowerCase()}`).digest('hex').slice(0, 12)
}

/** Writes a small file whole: a reader sees the old file or the new one, never half of either. */
export async function writeFileAtomically(target: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(temporary, text, 'utf8')
  try {
    await replaceFile(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** A day's local files as a comparable string: names and sizes, sorted. Changes whenever an event lands. */
export type DaySignature = string

interface DayFiles {
  files: { name: string; size: number }[]
  signature: DaySignature
}

const QUEUE_FILE = /^(\d{4}-\d{2}-\d{2})__([A-Za-z0-9-]+)\.jsonl$/

/**
 * The local half: events are written here as they happen and pushed to the shared store in batches, so
 * a store that is slow or briefly unreachable never slows a tool call or loses an event.
 *
 * **Safe with any number of sessions on one storage folder, without locks**, because nothing here is
 * ever written by two of them:
 *
 * - **Each session appends only to its own files**, one per day: `usage/queue/<day>__<session>.jsonl`.
 *   Several VS Code windows share a storage folder; with one shared file, a rewrite by one could drop a
 *   line another was appending. With a file each, there is no such moment.
 * - **What has been pushed is recorded per day as the day's signature** - its files' names and sizes -
 *   not as a point in time. A late or interleaved event changes the signature, so the day is pushed
 *   again; nothing can fall behind a mark another session moved past it.
 * - **Clean-up deletes whole files** of days older than the retention whose signature is the one
 *   recorded as pushed. It never rewrites a file another session might be writing (nobody writes to an
 *   old day), and two sessions deleting the same file is harmless.
 * - The record of what was pushed (`usage/pushed.json`) is written whole and merged before writing.
 *   Losing an update to a race only makes a day look unpushed, and pushing it again changes nothing.
 */
export class UsageLog {
  readonly queueDir: string
  private readonly manifestFile: string
  private readonly rolledFile: string
  private readonly legacyFile: string
  readonly session: string

  constructor(
    private readonly storageDir: string,
    session?: string,
  ) {
    this.queueDir = path.join(storageDir, 'usage', 'queue')
    this.manifestFile = path.join(storageDir, 'usage', 'pushed.json')
    this.rolledFile = path.join(storageDir, 'usage', 'rolled.json')
    this.legacyFile = path.join(storageDir, 'usage-events.jsonl')
    this.session = session ?? randomBytes(6).toString('hex')
  }

  async append(event: UsageEvent): Promise<void> {
    await fs.mkdir(this.queueDir, { recursive: true })
    await fs.appendFile(path.join(this.queueDir, `${usageDay(event.t)}__${this.session}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8')
  }

  /**
   * Replaces one fixed-name file of a day - the import of past conversations writes these. Replaced,
   * never appended, so two sessions importing at once leave one copy rather than two.
   */
  async writeFixed(day: string, name: string, events: readonly UsageEvent[]): Promise<void> {
    await writeFileAtomically(path.join(this.queueDir, `${day}__${name}.jsonl`), events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : ''))
  }

  /**
   * Moves a 0.156/0.157 single queue file into the per-day layout, once. Deterministic names, so two
   * sessions doing it at once write the same files; the old file is then renamed away by whichever
   * gets there first.
   */
  async migrateLegacy(): Promise<void> {
    let text: string
    try {
      text = await fs.readFile(this.legacyFile, 'utf8')
    } catch {
      return
    }
    const byDay = new Map<string, UsageEvent[]>()
    for (const event of parseUsageLines(text)) byDay.set(usageDay(event.t), [...(byDay.get(usageDay(event.t)) ?? []), event])
    for (const [day, events] of byDay) await this.writeFixed(day, 'legacy', events)
    await fs.rename(this.legacyFile, `${this.legacyFile}.migrated`).catch(() => undefined)
    await fs.rm(path.join(this.storageDir, 'usage-sync.json'), { force: true }).catch(() => undefined)
  }

  /** Every day with local files, and its signature. */
  async days(): Promise<Map<string, DayFiles>> {
    const days = new Map<string, DayFiles>()
    let names: string[]
    try {
      names = await fs.readdir(this.queueDir)
    } catch {
      return days
    }
    for (const name of names) {
      const match = QUEUE_FILE.exec(name)
      if (match === null) continue
      const size = await fs.stat(path.join(this.queueDir, name)).then((stat) => stat.size).catch(() => undefined)
      if (size === undefined) continue
      const entry = days.get(match[1]!) ?? { files: [], signature: '' }
      entry.files.push({ name, size })
      days.set(match[1]!, entry)
    }
    for (const entry of days.values()) {
      entry.files.sort((a, b) => a.name.localeCompare(b.name))
      entry.signature = entry.files.map((file) => `${file.name}:${String(file.size)}`).join('|')
    }
    return days
  }

  /** The signature of one day as it is now. */
  async daySignature(day: string): Promise<DaySignature> {
    return (await this.days()).get(day)?.signature ?? ''
  }

  /** Every event of one day, from every session's file. */
  async readDay(day: string): Promise<UsageEvent[]> {
    const entry = (await this.days()).get(day)
    if (entry === undefined) return []
    const texts = await Promise.all(entry.files.map((file) => fs.readFile(path.join(this.queueDir, file.name), 'utf8').catch(() => '')))
    return texts.flatMap(parseUsageLines).sort((a, b) => a.t - b.t)
  }

  /** Every queued event (the last few weeks), for finding names worth looking up. */
  async all(): Promise<UsageEvent[]> {
    const days = [...(await this.days()).keys()].sort()
    return (await Promise.all(days.map((day) => this.readDay(day)))).flat()
  }

  /** What has been pushed to `target`, by day. A different target has had nothing pushed. */
  async pushed(target: string): Promise<Record<string, DaySignature>> {
    try {
      const saved = JSON.parse(await fs.readFile(this.manifestFile, 'utf8')) as { target?: unknown; days?: unknown }
      return saved.target === target && saved.days !== null && typeof saved.days === 'object' ? (saved.days as Record<string, DaySignature>) : {}
    } catch {
      return {}
    }
  }

  /** Records a day as pushed with the signature that was pushed. Merged with the file as it is now. */
  async markPushed(target: string, day: string, signature: DaySignature): Promise<void> {
    const days = { ...(await this.pushed(target)), [day]: signature }
    await writeFileAtomically(this.manifestFile, JSON.stringify({ target, days }))
  }

  /** Months this install has rolled up in `target` (`usage/rollup.ts`): their late days go into the month. */
  async rolledMonths(target: string): Promise<Set<string>> {
    try {
      const saved = JSON.parse(await fs.readFile(this.rolledFile, 'utf8')) as { target?: unknown; months?: unknown }
      return new Set(saved.target === target && Array.isArray(saved.months) ? saved.months.filter((month): month is string => typeof month === 'string') : [])
    } catch {
      return new Set()
    }
  }

  async markRolled(target: string, month: string): Promise<void> {
    const months = await this.rolledMonths(target)
    if (months.has(month)) return
    months.add(month)
    await writeFileAtomically(this.rolledFile, JSON.stringify({ target, months: [...months].sort() }))
  }

  /** Deletes whole files of days older than `keepDays` that were pushed as they are. */
  async prune(target: string, keepDays: number, now = Date.now()): Promise<number> {
    const cutoff = usageDay(now - keepDays * 86_400_000)
    const pushed = await this.pushed(target)
    let removed = 0
    for (const [day, entry] of await this.days()) {
      if (day >= cutoff || pushed[day] !== entry.signature) continue
      for (const file of entry.files) {
        await fs.rm(path.join(this.queueDir, file.name), { force: true }).catch(() => undefined)
        removed++
      }
    }
    return removed
  }
}
