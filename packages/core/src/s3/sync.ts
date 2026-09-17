import type { FileSystem } from '../platform/filesystem.js'
import { normalisePrefix } from './keys.js'
import type { S3Target } from './tools.js'

/**
 * Mirrors a folder of a bucket onto this disk.
 *
 * ## Why a sync rather than a virtual folder
 *
 * Asked for as "point the skill storage at a folder in an S3 bucket", with the constraint stated
 * plainly: **indexing stays exactly as configured.** So only the *files* move. They arrive on disk
 * and are then loaded, watched, listed and indexed by the machinery that already exists, which
 * means an S3 skill and a local one are the same thing by the time anything looks at them.
 *
 * The alternative — teaching the skill loader, the watcher, `write_skill`, the indexer and the
 * documentation corpus each to understand a second kind of storage — is five places that would
 * have to agree, and §19's most expensive recurring bug is exactly that shape. Mirroring is one
 * place instead.
 *
 * The same function serves Python tools, because the requirement is identical and the only
 * differences are the extension and the folder. A second copy of this would drift.
 *
 * ## What it deliberately does not do
 *
 * It does not delete local files that are absent from the bucket. A half-finished sync that had
 * already emptied the folder would take a person's skills away over a network blip, and the cost
 * of the other choice is a stale file — visible, and fixable by hand. Deletion is somebody
 * pressing a button, not a side effect of a refresh.
 */

export interface S3SyncResult {
  /** Files written, relative to the local folder. */
  written: string[]
  /** Files already identical, so nothing was written. */
  unchanged: number
  /** Keys that could not be fetched, with the reason. Reported, never thrown. */
  failed: { key: string; problem: string }[]
}

export interface SyncOptions {
  target: S3Target
  /** Folder within the connection's own prefix. Empty means the prefix root. */
  prefix?: string
  /** Where the files land. */
  localDir: string
  fs: FileSystem
  /** Only these extensions are brought down, e.g. `['.md']`. */
  extensions: readonly string[]
  signal?: AbortSignal
  /** How many files to bring down at most, so a misconfigured prefix cannot fill a disk. */
  limit?: number
}

const DEFAULT_LIMIT = 500

export async function syncFromS3(options: SyncOptions): Promise<S3SyncResult> {
  const base = normalisePrefix(options.target.prefix)
  const where = normalisePrefix(`${base}${options.prefix ?? ''}`)
  const result: S3SyncResult = { written: [], unchanged: 0, failed: [] }

  const objects = await options.target.client.list(where, options.limit ?? DEFAULT_LIMIT, options.signal)

  for (const object of objects) {
    const relative = object.key.slice(where.length)
    // A "folder" in S3 is a zero-byte key ending in `/`. There is nothing to write for one.
    if (relative === '' || relative.endsWith('/')) continue
    if (!options.extensions.some((extension) => relative.toLowerCase().endsWith(extension))) continue
    /*
     * A key that would escape the folder is skipped rather than written.
     *
     * S3 keys are arbitrary strings, so `../../.ssh/id_rsa` is a perfectly legal key for somebody
     * with write access to the bucket to create — and following it would write outside the folder
     * this sync is supposed to own. The bucket is not necessarily trusted just because the
     * connection to it is.
     */
    if (relative.split('/').includes('..')) {
      result.failed.push({ key: object.key, problem: 'The key would write outside the folder.' })
      continue
    }

    try {
      const bytes = await options.target.client.get(object.key, options.signal)
      const localPath = join(options.localDir, relative)

      // Compared before writing, so an unchanged file does not churn the watcher that is
      // watching this very folder — which would reload every skill on every sync.
      let existing: Buffer | undefined
      try {
        existing = await options.fs.readBytes(localPath)
      } catch {
        // Not there yet, which is the ordinary case on a first sync.
      }
      if (existing !== undefined && existing.equals(bytes)) {
        result.unchanged += 1
        continue
      }

      await options.fs.mkdir(dirname(localPath))
      await options.fs.writeBytes(localPath, bytes)
      result.written.push(relative)
    } catch (error) {
      result.failed.push({
        key: object.key,
        problem: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}

/**
 * Sends one file up, for a skill or tool written here that belongs in the bucket.
 *
 * Separate from the sync rather than a "push" mode of it, because they are different acts: one
 * refreshes a local copy and the other publishes. Mixing them would mean a refresh could
 * overwrite a colleague's file with a stale local one.
 */
export async function uploadToS3(options: {
  target: S3Target
  /** Folder within the connection's prefix, matching the one the sync reads. */
  prefix?: string
  /** Path within that folder, e.g. `deployment.md`. */
  relative: string
  contents: Uint8Array
  signal?: AbortSignal
}): Promise<void> {
  if (options.target.readOnly === true) {
    throw new Error(`The connection "${options.target.label}" is read-only.`)
  }
  const base = normalisePrefix(options.target.prefix)
  const where = normalisePrefix(`${base}${options.prefix ?? ''}`)
  await options.target.client.put(`${where}${options.relative}`, options.contents, undefined, options.signal)
}

/* Joined and split with `/` rather than `node:path`, so a key is handled the same on every OS. */
function join(dir: string, relative: string): string {
  const left = dir.replace(/[\\/]+$/, '')
  return `${left}/${relative}`
}

function dirname(filePath: string): string {
  const cut = filePath.lastIndexOf('/')
  return cut === -1 ? filePath : filePath.slice(0, cut)
}
