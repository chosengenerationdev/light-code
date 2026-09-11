import fs from 'node:fs/promises'
import path from 'node:path'

import type { DatasetRecord } from './types.js'

/**
 * The facts of one dataset, on disk beside its vectors.
 *
 * ## Why a local copy at all, when the vector store already has them
 *
 * The same reason §12f keeps a sidecar for mail. Three operations need the records *exactly* and a
 * nearest-neighbour search answers none of them: knowing which ids to delete when the index is
 * cleared, knowing which are old enough for retention to remove, and saying how many there are.
 * Asking the vector store for "everything" is a scan on every backend and is not what any of them
 * is for.
 *
 * ## Why one file per dataset rather than one shared file
 *
 * Deleting a dataset is then deleting a file, and a corrupt one costs that dataset rather than all
 * of them. It also means a sync never rewrites another dataset's data, so two timers firing at
 * once cannot lose each other's work.
 *
 * File discipline follows `expert-events.jsonl` and `mail-index.jsonl` — one JSON object per line,
 * appended — for the reason §15 records: read-modify-write on every sync is the shape that
 * corrupted `config.json`, and a torn final line costs one record rather than the corpus. The
 * rewrite paths (replace, prune) go through temp-and-rename.
 */
export class DatasetStore {
  private readonly filePath: string
  private readonly statePath: string

  constructor(storageDir: string, datasetId: string) {
    // Sanitised, because a dataset id reaches this from config and a path separator in it would
    // write outside the directory. Ids are generated here, but config is hand-editable.
    const safe = datasetId.replace(/[^A-Za-z0-9._-]/g, '_')
    this.filePath = path.join(storageDir, 'datasets', `${safe}.jsonl`)
    this.statePath = path.join(storageDir, 'datasets', `${safe}.state.json`)
  }

  /** Every record. A malformed line is skipped — one bad line costs one record, not the corpus. */
  async load(): Promise<DatasetRecord[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch {
      return []
    }

    /*
     * Later lines win.
     *
     * The file is append-only, so an updated record is a *second* line with the same id. Keeping
     * the last is what makes "append" behave as "upsert" without rewriting the file on every sync.
     */
    const byId = new Map<string, DatasetRecord>()
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = JSON.parse(trimmed) as DatasetRecord
        if (typeof parsed.id === 'string' && typeof parsed.text === 'string') byId.set(parsed.id, parsed)
      } catch {
        // See above.
      }
    }
    return [...byId.values()]
  }

  /** Appends. Re-appending an existing id is how an update is recorded — see `load`. */
  async append(records: readonly DatasetRecord[]): Promise<void> {
    if (records.length === 0) return
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, '', { flag: 'a' })
    const lines = records.map((record) => JSON.stringify(record)).join('\n')
    await fs.appendFile(this.filePath, `${lines}\n`, 'utf8')
  }

  /** Rewrites with exactly these. Temp-and-rename, so an interrupted prune leaves the old file. */
  async replace(records: readonly DatasetRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    const body = records.map((record) => JSON.stringify(record)).join('\n')
    await fs.writeFile(temporary, records.length === 0 ? '' : `${body}\n`, 'utf8')
    await fs.rename(temporary, this.filePath)
  }

  /**
   * Rewrites the file with the duplicates collapsed.
   *
   * Append-as-upsert means a record updated every hour adds a line every hour, so the file grows
   * with the *number of syncs* rather than the size of the corpus. Compaction is cheap and only
   * worth doing when it would actually shrink anything, which the caller decides.
   */
  async compact(): Promise<{ before: number; after: number }> {
    let before: number
    try {
      before = (await fs.readFile(this.filePath, 'utf8')).split('\n').filter((line) => line.trim().length > 0).length
    } catch {
      return { before: 0, after: 0 }
    }
    const records = await this.load()
    if (records.length === before) return { before, after: before }
    await this.replace(records)
    return { before, after: records.length }
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true })
    await fs.rm(this.statePath, { force: true })
  }

  async sizeBytes(): Promise<number> {
    try {
      return (await fs.stat(this.filePath)).size
    } catch {
      return 0
    }
  }

  /**
   * When the last successful sync finished, passed to the collector as `since`.
   *
   * Written only on success, deliberately: after a failed run the next one must ask for the same
   * window again, or whatever the source produced while it was broken is skipped for ever with
   * nothing anywhere recording the gap.
   */
  async lastSyncedAt(): Promise<number | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as { lastSyncedAt?: unknown }
      return typeof parsed.lastSyncedAt === 'number' ? parsed.lastSyncedAt : undefined
    } catch {
      return undefined
    }
  }

  async recordSync(at: number): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.tmp`
    await fs.writeFile(temporary, JSON.stringify({ lastSyncedAt: at }), 'utf8')
    await fs.rename(temporary, this.statePath)
  }
}

/** Records older than the cutoff, and those kept. `undefined` timestamps are never old. */
export function partitionByAge(
  records: readonly DatasetRecord[],
  cutoff: number,
): { kept: DatasetRecord[]; removed: DatasetRecord[] } {
  const kept: DatasetRecord[] = []
  const removed: DatasetRecord[] = []
  for (const record of records) {
    // A record with no timestamp has no age, so retention cannot judge it. Removing it would
    // delete exactly the records whose source could not say when they were from.
    if (record.timestamp !== undefined && record.timestamp < cutoff) removed.push(record)
    else kept.push(record)
  }
  return { kept, removed }
}
