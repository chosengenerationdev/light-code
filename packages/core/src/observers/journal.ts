import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { AuditVerdict, DangerLevel, GuardVerdict, ObservedEvent } from './events.js'

/**
 * The Auditor's record on this machine: one JSON object per line, under the user's own storage folder.
 *
 * - **Written by the host, not by the model.** Every event is recorded whether or not the Auditor's model is
 *   reachable, configured, or running at all - "record all it does" must not depend on a network call.
 * - **One file per session and day** (`<day>__<session>.jsonl`), so no file ever has two writers: several
 *   windows or Fire Code chats on one project each append to their own (the usage queue's lesson, §12ag).
 * - **Outside the repository**, keyed by the case-folded workspace path: a transcript of somebody's work is
 *   theirs, and `.lightcode/` is committed.
 * - Redacted before it is written (the caller passes known secret values), like task history.
 */

export type AuditRecordType = 'event' | 'finding' | 'alert' | 'note' | 'status'

export interface AuditRecord {
  v: 1
  /** Epoch milliseconds. */
  at: number
  type: AuditRecordType
  session: string
  workspace: string
  project: string
  user: string
  task?: string
  event?: ObservedEvent
  finding?: AuditVerdict
  alert?: { level: DangerLevel; message: string; source: 'rules' | 'auditor' }
  note?: GuardVerdict
  status?: string
}

export function auditRoot(storageDir: string): string {
  return path.join(storageDir, 'audit')
}

/** This workspace's folder name: readable, and unique per case-folded path. */
export function workspaceAuditFolder(workspace: string): string {
  const resolved = path.resolve(workspace)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  // From the case-folded path, so one folder spelled two ways on Windows is one journal, name included.
  const base = path.basename(key).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'workspace'
  return `${base}-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`
}

export function newSessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function day(at: number): string {
  const d = new Date(at)
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class AuditJournal {
  private chain: Promise<void> = Promise.resolve()
  readonly folder: string

  constructor(
    storageDir: string,
    workspace: string,
    readonly session: string,
  ) {
    this.folder = path.join(auditRoot(storageDir), workspaceAuditFolder(workspace))
  }

  /** Appends in order; a failure is reported to `onError` and never blocks the next record. */
  append(record: AuditRecord, onError: (error: unknown) => void): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    const file = path.join(this.folder, `${day(record.at)}__${this.session}.jsonl`)
    this.chain = this.chain.then(async () => {
      try {
        await fs.mkdir(this.folder, { recursive: true })
        await fs.appendFile(file, line, 'utf8')
      } catch (error) {
        onError(error)
      }
    })
    return this.chain
  }

  /** Waits for every append so far - for tests and shutdown. */
  flushed(): Promise<void> {
    return this.chain
  }
}

/** Removes whole day files older than `days`, in every workspace's folder. Never rewrites one. */
export async function pruneAudit(storageDir: string, days: number, now = Date.now()): Promise<number> {
  const cutoff = day(now - days * 86_400_000)
  let removed = 0
  const root = auditRoot(storageDir)
  for (const folder of await fs.readdir(root).catch(() => [] as string[])) {
    for (const name of await fs.readdir(path.join(root, folder)).catch(() => [] as string[])) {
      const fileDay = /^(\d{4}-\d{2}-\d{2})__/.exec(name)?.[1]
      if (fileDay !== undefined && fileDay < cutoff) {
        await fs.rm(path.join(root, folder, name), { force: true }).then(() => (removed += 1), () => undefined)
      }
    }
  }
  return removed
}

export interface AuditQuery {
  /** Epoch ms bounds, inclusive. */
  from?: number
  until?: number
  types?: readonly AuditRecordType[]
  /** Exact tool name, on events. */
  tool?: string
  /** Case-insensitive text anywhere in the record. */
  contains?: string
  session?: string
  /** Every workspace's record, not only this one. */
  allWorkspaces?: boolean
  limit?: number
}

export interface AuditReadResult {
  records: AuditRecord[]
  /** Matches beyond `limit`, not returned. */
  more: number
  filesRead: number
  unreadable: string[]
}

/** Newest first. Reads only the day files the bounds can contain. */
export async function readAudit(storageDir: string, workspace: string | undefined, query: AuditQuery): Promise<AuditReadResult> {
  const root = auditRoot(storageDir)
  const folders =
    query.allWorkspaces === true || workspace === undefined
      ? await fs.readdir(root).catch(() => [] as string[])
      : [workspaceAuditFolder(workspace)]
  const fromDay = query.from !== undefined ? day(query.from) : undefined
  const untilDay = query.until !== undefined ? day(query.until) : undefined
  const files: string[] = []
  for (const folder of folders) {
    for (const name of await fs.readdir(path.join(root, folder)).catch(() => [] as string[])) {
      const fileDay = /^(\d{4}-\d{2}-\d{2})__(.+)\.jsonl$/.exec(name)
      if (fileDay === null) continue
      if (fromDay !== undefined && fileDay[1]! < fromDay) continue
      if (untilDay !== undefined && fileDay[1]! > untilDay) continue
      if (query.session !== undefined && fileDay[2] !== query.session) continue
      files.push(path.join(root, folder, name))
    }
  }
  const needle = query.contains?.toLowerCase()
  const types = query.types !== undefined && query.types.length > 0 ? new Set(query.types) : undefined
  const matched: AuditRecord[] = []
  const unreadable: string[] = []
  for (const file of files) {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (error) {
      unreadable.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let record: AuditRecord
      try {
        record = JSON.parse(line) as AuditRecord
      } catch {
        continue // A torn last line costs one record, not the file.
      }
      if (query.from !== undefined && record.at < query.from) continue
      if (query.until !== undefined && record.at > query.until) continue
      if (types !== undefined && !types.has(record.type)) continue
      if (query.tool !== undefined && !(record.event !== undefined && 'tool' in record.event && record.event.tool === query.tool)) continue
      if (needle !== undefined && !line.toLowerCase().includes(needle)) continue
      matched.push(record)
    }
  }
  matched.sort((a, b) => b.at - a.at)
  const limit = Math.max(1, Math.min(query.limit ?? 200, 2_000))
  return { records: matched.slice(0, limit), more: Math.max(0, matched.length - limit), filesRead: files.length - unreadable.length, unreadable }
}
