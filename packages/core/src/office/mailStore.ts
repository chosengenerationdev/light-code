import fs from 'node:fs/promises'
import path from 'node:path'

import type { MailRecord } from './mailIndex.js'

/**
 * Where the facts about indexed mail are kept on disk.
 *
 * One JSON object per line, appended. **The same shape as `expert-events.jsonl` and for the same
 * reason** (§12b): an array would mean read-modify-write on every sync, which is precisely the
 * pattern that corrupted `config.json`, and a torn final line costs one message rather than the
 * whole history.
 *
 * A rewrite happens only when pruning, which is rare, explicit and destructive — so it goes
 * through temp-and-rename like every other file this product owns.
 *
 * Nothing here is a secret store. Subjects and previews of the user's own mail sit in it, which
 * is exactly what indexing mail means, and is why the whole feature is opt-in and why the store
 * lives in per-user storage rather than in a workspace.
 */
export class MailStore {
  private readonly filePath: string

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'mail-index.jsonl')
  }

  /**
   * Every record, newest last.
   *
   * A malformed line is skipped rather than throwing. The file is append-only and rebuildable,
   * so one bad line is worth one message — refusing to load the other ten thousand because of it
   * would turn a trivial fault into a dead feature.
   */
  async load(): Promise<MailRecord[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch {
      return []
    }

    const records: MailRecord[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = JSON.parse(trimmed) as MailRecord
        if (typeof parsed.id === 'string' && typeof parsed.receivedAt === 'number') records.push(parsed)
      } catch {
        // See above: one torn line, one lost message.
      }
    }
    return records
  }

  /** Appends. Ids already present are the caller's problem — see `newestReceivedAt`. */
  async append(records: readonly MailRecord[]): Promise<void> {
    if (records.length === 0) return
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const lines = records.map((record) => JSON.stringify(record)).join('\n')
    await fs.appendFile(this.filePath, `${lines}\n`, 'utf8')
  }

  /**
   * Rewrites the file with exactly these records.
   *
   * Temp-and-rename, so an interrupted prune leaves the old index rather than half of one. §15's
   * rule, applied to the one operation here that is not an append.
   */
  async replace(records: readonly MailRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    const body = records.map((record) => JSON.stringify(record)).join('\n')
    await fs.writeFile(temporary, records.length === 0 ? '' : `${body}\n`, 'utf8')
    await fs.rename(temporary, this.filePath)
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true })
  }

  /** Size on disk, so the user can see it growing before deciding to prune. */
  async sizeBytes(): Promise<number> {
    try {
      return (await fs.stat(this.filePath)).size
    } catch {
      return 0
    }
  }
}

/**
 * The high-water mark to resume from, per folder.
 *
 * Per folder rather than one global timestamp, because folders are indexed independently and a
 * single mark would silently skip everything older in a folder added later.
 *
 * One second is subtracted: Outlook's restrict is inclusive at second granularity, and messages
 * arriving inside the same second as the previous run's newest would otherwise be missed
 * forever. Re-fetching a handful of already-seen messages is free; losing one is not.
 */
export function resumePoints(records: readonly MailRecord[]): Map<string, number> {
  const marks = new Map<string, number>()
  for (const record of records) {
    const existing = marks.get(record.folder)
    if (existing === undefined || record.receivedAt > existing) marks.set(record.folder, record.receivedAt)
  }
  for (const [folder, at] of marks) marks.set(folder, at - 1000)
  return marks
}

/** Which of these are genuinely new, so a re-fetch of the overlap costs nothing. */
export function withoutKnown(
  candidates: readonly MailRecord[],
  known: readonly MailRecord[],
): MailRecord[] {
  const seen = new Set(known.map((record) => record.id))
  const fresh: MailRecord[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    fresh.push(candidate)
  }
  return fresh
}
