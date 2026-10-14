import { promises as fs } from 'node:fs'
import path from 'node:path'
import { usageDay, writeFileAtomically, type UsageEvent, type UsageLog } from './events.js'
import type { UsageHelper } from './store.js'

/**
 * The initial statistics: usage recovered from the conversations already saved on this machine, so
 * the dashboard has history the day collection starts rather than a week later (asked for: "process
 * existing info ... for initial statistics collection", through Fire Code's Rust helper when present).
 *
 * Read from the saved task files - the same transcripts the history list shows - and only the facts a
 * live event would carry: tool names, and a skill when a call read or copied its file. A saved task
 * has no time per message, so a task's calls are spread evenly between when it began and when it was
 * last saved; failures are not recorded at all, because a transcript does not say which calls failed.
 *
 * Runs once per install (`usage-backfill.json`) and covers only tasks last saved before it ran, so a
 * conversation continued afterwards has its earlier calls here and its later ones recorded live -
 * never both.
 */

export interface BackfillContext {
  user: string
  /** The configured project name for tasks in the current workspace; others use their folder name. */
  project?: string | undefined
  workspaceRoot?: string | undefined
  /** Skills by file, with their authors, so a `read_file` of one counts as a use of it. */
  skills: readonly { name: string; filePath: string; author?: string | undefined }[]
  /** Python tool authors by tool name (without `py__`). */
  toolAuthors: Readonly<Record<string, string>>
  /** Tools that are the model talking, not work: `attempt_completion` and friends. */
  skip: readonly string[]
  /** Only tasks last saved before this. */
  before: number
}

/** Paths compared the way Windows compares them, in either slash style. */
export function comparablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

interface SavedTask {
  workspaceRoot?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  messages?: unknown
}

/** The events one saved task implies. Pure, so the Rust helper's answer can be checked against it. */
export function eventsFromTask(task: SavedTask, context: BackfillContext): UsageEvent[] {
  const updated = typeof task.updatedAt === 'number' ? task.updatedAt : undefined
  if (updated === undefined || updated >= context.before || !Array.isArray(task.messages)) return []
  const created = typeof task.createdAt === 'number' && task.createdAt <= updated ? task.createdAt : updated
  const root = typeof task.workspaceRoot === 'string' ? task.workspaceRoot : undefined
  const project =
    root !== undefined && context.workspaceRoot !== undefined && comparablePath(root) === comparablePath(context.workspaceRoot)
      ? context.project
      : root !== undefined
        ? path.basename(root.replace(/\\/g, '/'))
        : undefined
  const skillsByPath = new Map(context.skills.map((skill) => [comparablePath(skill.filePath), skill]))
  const skip = new Set(context.skip)

  const calls: { name: string; args: Record<string, unknown> }[] = []
  for (const message of task.messages as unknown[]) {
    const entry = message as { role?: unknown; toolCalls?: unknown }
    if (entry.role !== 'assistant' || !Array.isArray(entry.toolCalls)) continue
    for (const call of entry.toolCalls as { name?: unknown; arguments?: unknown }[]) {
      if (typeof call.name !== 'string') continue
      let args: Record<string, unknown> = {}
      try {
        const parsed: unknown = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
        if (parsed !== null && typeof parsed === 'object') args = parsed as Record<string, unknown>
      } catch {
        // Unparseable arguments still count as a call of the tool.
      }
      let name = call.name
      if (name === 'call_tool' && typeof args['name'] === 'string') {
        name = args['name']
        const inner = args['arguments']
        args = inner !== null && typeof inner === 'object' ? (inner as Record<string, unknown>) : {}
      }
      if (!skip.has(name)) calls.push({ name, args })
    }
  }

  const events: UsageEvent[] = []
  calls.forEach((call, index) => {
    const t = calls.length === 1 ? updated : Math.round(created + ((updated - created) * index) / (calls.length - 1))
    const base = { t, u: context.user, ...(project !== undefined ? { p: project } : {}) }
    const toolAuthor = call.name.startsWith('py__') ? context.toolAuthors[call.name.slice(4)] : undefined
    events.push({ ...base, k: 'tool', n: call.name, ...(toolAuthor !== undefined ? { a: toolAuthor } : {}) })
    let skill: BackfillContext['skills'][number] | undefined
    if (call.name === 'read_file' && typeof call.args['path'] === 'string') {
      const requested = call.args['path']
      const absolute = path.isAbsolute(requested) || /^[A-Za-z]:[\\/]/.test(requested) || root === undefined ? requested : path.join(root, requested)
      skill = skillsByPath.get(comparablePath(absolute))
    }
    if (call.name === 'use_skill_file' && typeof call.args['skill'] === 'string') {
      const wanted = call.args['skill']
      skill = context.skills.find((each) => each.name === wanted)
    }
    if (skill !== undefined) events.push({ ...base, k: 'skill', n: skill.name, ...(skill.author !== undefined ? { a: skill.author } : {}) })
  })
  return events
}

/**
 * Every saved task in `tasksDir`, through the Rust helper when there is one (thousands of transcripts,
 * read in parallel) and plain Node otherwise. Says how many tasks it read and how many it could not.
 */
export async function backfillFromTasks(
  tasksDir: string,
  context: BackfillContext,
  helper?: UsageHelper,
): Promise<{ events: UsageEvent[]; tasks: number; unreadable: number; via: 'rust' | 'node' }> {
  if (helper !== undefined) {
    const answer = await helper({
      op: 'usage',
      root: tasksDir,
      action: 'backfill',
      user: context.user,
      ...(context.project !== undefined ? { project: context.project } : {}),
      ...(context.workspaceRoot !== undefined ? { workspaceRoot: context.workspaceRoot } : {}),
      skills: context.skills.map((skill) => ({ name: skill.name, path: comparablePath(skill.filePath), ...(skill.author !== undefined ? { author: skill.author } : {}) })),
      toolAuthors: context.toolAuthors,
      skip: context.skip,
      before: context.before,
    })
    if (answer['ok'] === true && Array.isArray(answer['events'])) {
      return {
        events: answer['events'] as UsageEvent[],
        tasks: typeof answer['tasks'] === 'number' ? answer['tasks'] : 0,
        unreadable: typeof answer['unreadable'] === 'number' ? answer['unreadable'] : 0,
        via: 'rust',
      }
    }
    // An older helper without the action falls through to Node rather than skipping history.
  }
  let names: string[]
  try {
    names = (await fs.readdir(tasksDir)).filter((name) => name.endsWith('.json') && name !== 'index.json')
  } catch {
    return { events: [], tasks: 0, unreadable: 0, via: 'node' }
  }
  const events: UsageEvent[] = []
  let unreadable = 0
  for (const name of names) {
    try {
      events.push(...eventsFromTask(JSON.parse(await fs.readFile(path.join(tasksDir, name), 'utf8')) as SavedTask, context))
    } catch {
      unreadable++
    }
  }
  return { events, tasks: names.length, unreadable, via: 'node' }
}

/**
 * Runs the import once per storage folder, safely alongside other sessions doing the same:
 *
 * - **The cut-off is claimed with an atomic create** (`usage/backfill-start.json`, `wx`): the first
 *   session fixes "conversations saved before this moment", and every other session reads the same
 *   moment, so they all compute the same events.
 * - **Results replace fixed-name files** (`<day>__backfill.jsonl`), never append, so two sessions
 *   importing at once leave one copy.
 * - **Done is recorded last** (`usage/backfill.json`). A session that stopped half-way leaves no record,
 *   and the next one repeats the import against the same cut-off - which rewrites the same files.
 */
export async function backfillOnce(options: {
  usageDir: string
  log: Pick<UsageLog, 'writeFixed'>
  /** Earlier versions kept the record in the storage folder itself. */
  legacyDoneFile?: string
  run: (before: number) => Promise<{ events: UsageEvent[]; tasks: number; unreadable: number; via: 'rust' | 'node' }>
  now?: () => number
}): Promise<{ ran: boolean; events?: number; tasks?: number; via?: 'rust' | 'node' }> {
  const doneFile = path.join(options.usageDir, 'backfill.json')
  for (const file of [doneFile, ...(options.legacyDoneFile !== undefined ? [options.legacyDoneFile] : [])]) {
    if (await fs.stat(file).then(() => true, () => false)) return { ran: false }
  }
  await fs.mkdir(options.usageDir, { recursive: true })
  const startFile = path.join(options.usageDir, 'backfill-start.json')
  let before: number
  try {
    before = (options.now ?? Date.now)()
    await fs.writeFile(startFile, JSON.stringify({ before }), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    /*
     * Created by another session, which may not have written it yet: an exclusive create makes the file
     * first and fills it a moment later, so an empty or partial read is retried briefly.
     */
    let claimed: number | undefined
    for (let attempt = 0; attempt < 40 && claimed === undefined; attempt++) {
      try {
        const parsed = JSON.parse(await fs.readFile(startFile, 'utf8')) as { before?: unknown }
        if (typeof parsed.before === 'number') claimed = parsed.before
      } catch {
        // Not written yet.
      }
      if (claimed === undefined) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (claimed === undefined) throw new Error(`${startFile} does not say when the import began.`, { cause: error })
    before = claimed
  }
  const result = await options.run(before)
  const byDay = new Map<string, UsageEvent[]>()
  for (const event of result.events) byDay.set(usageDay(event.t), [...(byDay.get(usageDay(event.t)) ?? []), event])
  for (const [day, events] of byDay) await options.log.writeFixed(day, 'backfill', events)
  await writeFileAtomically(doneFile, JSON.stringify({ at: before, tasks: result.tasks, events: result.events.length, unreadable: result.unreadable, via: result.via }))
  return { ran: true, events: result.events.length, tasks: result.tasks, via: result.via }
}
