import path from 'node:path'
import { constants, promises as fs } from 'node:fs'

import type { VectorDocument, VectorIndexWriter } from './vectorStore.js'

/**
 * Moving existing indexes to the names a project name gives them — without re-embedding.
 *
 * ## Why this exists
 *
 * Setting a project name makes every *derived* index name start with it (`config/project.ts`), so
 * teams sharing a cluster can tell their indexes apart. For anybody already indexed that is a new,
 * empty name, and the next index run would pay to embed the whole repository again — the cost
 * `rag/indexNaming.ts` records paying once already. Embedding is the expensive part and the
 * vectors are still right, so they are **copied**: every backend can page a collection out
 * (`scan`) and write it back (`upsert`), which is what copying between stores already uses.
 *
 * ## What it does to the copy
 *
 * Each document is stamped with the project name on the way across, so the new index is labelled
 * as well as named. Nothing else changes: same ids, same text, same vectors.
 *
 * ## What it leaves alone
 *
 * The old index stays where it is. Nothing in Light Code deletes a collection, and removing one on
 * a shared cluster is a decision for whoever owns it — the result names it so it can be removed.
 * The local bookkeeping (the manifest that says what is already indexed, the documentation
 * fingerprints) is copied too, never moved, so the new index is incremental from its first run.
 */

export type RenamedIndexKind = 'codebase' | 'docs' | 'skills'

export interface IndexRename {
  kind: RenamedIndexKind
  from: string
  to: string
}

/**
 * The renames a project name implies: each derived name, before and after.
 *
 * `legacy` and `current` are the names with and without the project prefix; an index whose name
 * was typed by the user is passed as the same name twice and so produces nothing — a name somebody
 * chose is not ours to change.
 */
export function planIndexRenames(
  names: Record<RenamedIndexKind, { legacy: string | undefined; current: string | undefined }>,
): IndexRename[] {
  const plans: IndexRename[] = []
  for (const kind of ['codebase', 'docs', 'skills'] as const) {
    const { legacy, current } = names[kind]
    if (legacy === undefined || current === undefined || legacy === current) continue
    plans.push({ kind, from: legacy, to: current })
  }
  return plans
}

/** Whether a collection holds anything. A missing collection answers no rather than throwing. */
export async function hasDocuments(writer: VectorIndexWriter, collection: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const page = await writer.scan(collection, { pageSize: 1, ...(signal !== undefined ? { signal } : {}) })
    return page.documents.length > 0
  } catch {
    return false
  }
}

export interface CopyIndexOptions {
  writer: VectorIndexWriter
  from: string
  to: string
  dimensions: number
  /** Written onto every copied document. */
  project?: string | undefined
  /** Attached to the new collection, so team search keeps finding it under the same names. */
  aliases?: readonly string[] | undefined
  pageSize?: number
  onProgress?: (copied: number) => void
  signal?: AbortSignal
}

/** Copies one collection into another in the same store, a page at a time. Returns the count. */
export async function copyIndex(options: CopyIndexOptions): Promise<number> {
  const signal = options.signal !== undefined ? { signal: options.signal } : {}
  await options.writer.ensureCollection(options.to, options.dimensions, options.signal)
  if (options.writer.ensureAlias !== undefined) {
    for (const alias of options.aliases ?? []) {
      await options.writer.ensureAlias(options.to, alias, options.signal)
    }
  }

  let cursor: unknown
  let copied = 0
  for (;;) {
    options.signal?.throwIfAborted()
    const page = await options.writer.scan(options.from, {
      ...(cursor === undefined ? {} : { cursor }),
      pageSize: options.pageSize ?? 256,
      ...signal,
    })
    if (page.documents.length > 0) {
      const project = options.project
      const stamped: VectorDocument[] =
        project === undefined ? page.documents : page.documents.map((document) => ({ ...document, project }))
      await options.writer.upsert(options.to, stamped, options.signal)
      copied += stamped.length
      options.onProgress?.(copied)
    }
    if (page.next === undefined || page.next === null) break
    cursor = page.next
  }
  return copied
}

/**
 * Copies the local bookkeeping kept for `from` so it describes `to`.
 *
 * Files are named `<index>@<store>.json` and `<index>@<store>.<suffix>.json`, so the `@` is what
 * keeps `name-docs@store` from being mistaken for a file of `name`. An existing file for `to` is
 * left alone: it records something that was actually written there.
 */
export async function copyBookkeeping(directory: string, from: string, to: string, storeId: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(directory)
  } catch {
    return []
  }
  const prefix = `${from}@${storeId}.`
  const copied: string[] = []
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const target = `${to}@${storeId}.${entry.slice(prefix.length)}`
    try {
      await fs.copyFile(path.join(directory, entry), path.join(directory, target), constants.COPYFILE_EXCL)
      copied.push(target)
    } catch {
      // Already there, or unreadable: either way the destination's own record stands.
    }
  }
  return copied
}
