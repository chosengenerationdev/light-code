import fs from 'node:fs/promises'
import path from 'node:path'
import type { TruncationStore } from '../../agent/truncate.js'
import { taskSummary, type Task, type TaskStore, type TaskSummary } from '../../history/types.js'
import type { Logger } from '../../logging/logger.js'

const INDEX_FILE = 'index.json'

interface IndexEntry extends TaskSummary {
  workspaceRoot: string
}

/**
 * One JSON file per task under `globalStorageUri/tasks/`, plus an index of summaries.
 *
 * **The index is a cache; the task files are the truth.** Listing by reading every
 * transcript would mean parsing megabytes to render a sidebar list, but an index that can
 * silently disagree with disk is worse than none — so a missing or unparseable index is
 * rebuilt by scanning, rather than treated as "no history".
 *
 * Tasks live in global storage rather than the workspace: a transcript is the user's, not
 * the repository's, and `.lightcode/` is checked in.
 */
export class JsonTaskStore implements TaskStore {
  private readonly directory: string

  constructor(
    globalStoragePath: string,
    private readonly truncationStore: TruncationStore,
    private readonly logger?: Logger,
  ) {
    this.directory = path.join(globalStoragePath, 'tasks')
  }

  async list(workspaceRoot: string): Promise<TaskSummary[]> {
    const index = await this.readIndex()
    return index
      .filter((entry) => entry.workspaceRoot === workspaceRoot)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        messageCount: entry.messageCount,
      }))
  }

  async load(id: string): Promise<Task | undefined> {
    if (!isValidId(id)) return undefined
    try {
      const raw = await fs.readFile(this.fileFor(id), 'utf8')
      return parseTask(raw)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn(`could not read task ${id}`, String(error))
      }
      return undefined
    }
  }

  async save(task: Task): Promise<void> {
    if (!isValidId(task.id)) throw new Error(`Refusing to save a task with an unexpected id: ${task.id}`)
    await fs.mkdir(this.directory, { recursive: true })

    // Write to a temp file and rename, so a crash mid-write cannot leave a truncated
    // transcript in place of a good one. Rename is atomic within a directory.
    const target = this.fileFor(task.id)
    const temporary = `${target}.tmp`
    await fs.writeFile(temporary, JSON.stringify(task, null, 2), 'utf8')
    await fs.rename(temporary, target)

    const index = await this.readIndex()
    const entry: IndexEntry = { ...taskSummary(task), workspaceRoot: task.workspaceRoot }
    await this.writeIndex([entry, ...index.filter((existing) => existing.id !== task.id)])
  }

  async delete(id: string): Promise<void> {
    if (!isValidId(id)) return

    // Read first: the handles are only recorded in the task file, so deleting it before
    // reading them would orphan every spilled result the task produced.
    const task = await this.load(id)
    if (task !== undefined && task.resultHandles.length > 0) {
      await this.truncationStore.deleteMany(task.resultHandles)
    }

    await fs.rm(this.fileFor(id), { force: true })
    const index = await this.readIndex()
    await this.writeIndex(index.filter((entry) => entry.id !== id))
  }

  private fileFor(id: string): string {
    return path.join(this.directory, `${id}.json`)
  }

  private async readIndex(): Promise<IndexEntry[]> {
    try {
      const raw = await fs.readFile(path.join(this.directory, INDEX_FILE), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter(isIndexEntry)
      this.logger?.warn('task index was not an array — rebuilding from disk')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn('task index unreadable — rebuilding from disk', String(error))
      } else {
        // No index yet. It may simply not exist, or it may have been lost while task
        // files survived; scanning covers both and costs nothing when there is nothing.
      }
    }
    return this.rebuildIndex()
  }

  /** Scans the task files. The fallback that keeps a lost index from losing history. */
  private async rebuildIndex(): Promise<IndexEntry[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.directory)
    } catch {
      return []
    }

    const entries: IndexEntry[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name === INDEX_FILE) continue
      const task = await this.load(name.slice(0, -'.json'.length))
      if (task !== undefined) entries.push({ ...taskSummary(task), workspaceRoot: task.workspaceRoot })
    }

    if (entries.length > 0) await this.writeIndex(entries)
    return entries
  }

  private async writeIndex(entries: IndexEntry[]): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    const target = path.join(this.directory, INDEX_FILE)
    const temporary = `${target}.tmp`
    await fs.writeFile(temporary, JSON.stringify(entries, null, 2), 'utf8')
    await fs.rename(temporary, target)
  }
}

/** Ids are ours (UUIDs) but reach here from message payloads — never trust one as a path. */
function isValidId(id: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(id)
}

function isIndexEntry(value: unknown): value is IndexEntry {
  const entry = value as Partial<IndexEntry> | null
  return (
    typeof entry?.id === 'string' &&
    typeof entry.title === 'string' &&
    typeof entry.workspaceRoot === 'string' &&
    typeof entry.updatedAt === 'number'
  )
}

/** A hand-edited or half-written file must not crash the panel — reject it instead. */
function parseTask(raw: string): Task | undefined {
  const parsed: unknown = JSON.parse(raw)
  const task = parsed as Partial<Task> | null
  if (typeof task?.id !== 'string' || typeof task.workspaceRoot !== 'string' || !Array.isArray(task.messages)) {
    return undefined
  }
  return {
    id: task.id,
    workspaceRoot: task.workspaceRoot,
    title: typeof task.title === 'string' ? task.title : 'Untitled task',
    createdAt: typeof task.createdAt === 'number' ? task.createdAt : Date.now(),
    updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : Date.now(),
    messages: task.messages,
    resultHandles: Array.isArray(task.resultHandles) ? task.resultHandles.filter((h) => typeof h === 'string') : [],
  }
}
