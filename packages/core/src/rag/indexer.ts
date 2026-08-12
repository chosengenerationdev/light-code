import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { PathDenylist } from '../fs/denylist.js'
import { chunkFile, looksLikeText, type ChunkOptions } from './chunk.js'
import type { Embedder } from './embedder.js'
import type { IndexedDocument, OpenSearchIndexWriter } from './opensearch/writer.js'

/**
 * Walks a workspace, chunks it, embeds it, and writes it to an index Light Code owns.
 *
 * **This is the largest egress in the product** — it sends the contents of the workspace to
 * the configured embedding endpoint. It only ever runs because the user pressed a button;
 * nothing here is reachable from a tool, and the model cannot start it.
 *
 * The security rule that shapes the walk: *anything `read_file` may not read must never be
 * embedded.* Otherwise indexing is a second route around the deny list, and a key excluded
 * from the model's reach arrives at a third-party endpoint instead.
 */

/** Directories never worth indexing, skipped before the ignore rules are even consulted. */
const ALWAYS_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  'vendor',
])

/**
 * Extensions worth embedding.
 *
 * An allowlist, not a denylist. A denylist silently starts indexing whatever new binary
 * format appears in a repo, and the failure is invisible — you find out from the bill, or
 * from a lockfile crowding out the code in every search result.
 */
const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.m', '.mm',
  '.php', '.pl', '.lua', '.dart', '.ex', '.exs', '.erl', '.hs', '.clj',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1',
  '.sql', '.graphql', '.proto',
  '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.md', '.mdx', '.rst', '.txt', '.adoc',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.xml',
])

/** Files that are technically indexable text but are noise, or worse. */
const SKIP_FILENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'poetry.lock',
  'Cargo.lock',
  'composer.lock',
  'go.sum',
  // Never embedded even though it is plain text and often not gitignored. A .env is the
  // single likeliest file in any repo to hold a live credential.
  '.env',
])

export interface IndexProgress {
  phase: 'scanning' | 'embedding' | 'writing' | 'done'
  filesSeen: number
  filesIndexed: number
  filesSkipped: number
  chunksWritten: number
  /** The file currently being handled, workspace-relative. */
  current?: string
}

export interface IndexResult {
  filesIndexed: number
  filesSkipped: number
  filesRemoved: number
  chunksWritten: number
  /** Reasons files were skipped, counted — so "nothing was indexed" is diagnosable. */
  skipReasons: Record<string, number>
}

/**
 * `path → content hash` of what is currently in the index.
 *
 * Reindexing is otherwise all-or-nothing: every run re-embeds a repository that has not
 * changed, which on a large codebase is slow and, against a metered endpoint, expensive.
 * The manifest lives beside the other per-user state, not in the workspace — it describes
 * *an index*, and two people indexing the same repo into different clusters must not share
 * one.
 */
export interface IndexManifest {
  /** Set when any of these change, since every chunk must then be recomputed. */
  model: string
  dimensions: number
  chunkSignature: string
  files: Record<string, string>
}

export interface IndexerOptions {
  workspaceRoot: string
  index: string
  embedder: Embedder
  writer: OpenSearchIndexWriter
  denylist: PathDenylist
  /** Loaded from and saved to disk by the caller. */
  manifest: IndexManifest
  saveManifest: (manifest: IndexManifest) => Promise<void>
  /** Extra ignore patterns, typically parsed from `.gitignore`. */
  isIgnored?: (relativePath: string) => boolean
  chunkOptions?: ChunkOptions
  onProgress?: (progress: IndexProgress) => void
  signal?: AbortSignal
  /** Documents per bulk request. Bounded so one failure does not lose a whole run. */
  batchSize?: number
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 32)
}

/** Changing any of these invalidates every stored chunk, so it forms part of the manifest. */
export function chunkSignatureFor(options: ChunkOptions | undefined): string {
  return JSON.stringify([options?.windowLines ?? null, options?.overlapLines ?? null, options?.maxChars ?? null])
}

export class IndexingCancelledError extends Error {
  constructor() {
    super('Indexing was cancelled.')
    this.name = 'IndexingCancelledError'
  }
}

export async function indexWorkspace(options: IndexerOptions): Promise<IndexResult> {
  const { workspaceRoot, index, embedder, writer, denylist, signal } = options
  const batchSize = options.batchSize ?? 64
  const skipReasons: Record<string, number> = {}
  const note = (reason: string): void => {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1
  }

  const progress: IndexProgress = {
    phase: 'scanning',
    filesSeen: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    chunksWritten: 0,
  }
  const report = (): void => options.onProgress?.({ ...progress })
  const throwIfCancelled = (): void => {
    if (signal?.aborted === true) throw new IndexingCancelledError()
  }

  await writer.ensureIndex(index, embedder.dimensions, signal)

  /*
   * A change to the model, its width, or the chunk shape makes every stored vector
   * incomparable with new ones. Silently mixing them produces a corpus that returns
   * confident nonsense, so the manifest is dropped and everything reindexes.
   */
  const signature = chunkSignatureFor(options.chunkOptions)
  const stale =
    options.manifest.model !== embedder.model ||
    options.manifest.dimensions !== embedder.dimensions ||
    options.manifest.chunkSignature !== signature
  const previous = stale ? {} : options.manifest.files
  const current: Record<string, string> = {}

  let pending: IndexedDocument[] = []
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return
    progress.phase = 'writing'
    report()
    await writer.bulkIndex(index, pending, signal)
    progress.chunksWritten += pending.length
    pending = []
  }

  const walk = async (dir: string): Promise<void> => {
    throwIfCancelled()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      throwIfCancelled()
      const absolute = path.join(dir, entry.name)
      const relative = path.relative(workspaceRoot, absolute).split(path.sep).join('/')

      if (entry.isDirectory()) {
        if (ALWAYS_SKIP.has(entry.name) || entry.name.startsWith('.')) continue
        if (options.isIgnored?.(`${relative}/`) === true) continue
        await walk(absolute)
        continue
      }
      // A symlink can point anywhere, including outside the workspace and at exactly the
      // key material the deny list exists to protect. Not followed at all.
      if (!entry.isFile()) continue

      progress.filesSeen++
      if (SKIP_FILENAMES.has(entry.name)) {
        progress.filesSkipped++
        note('excluded filename')
        continue
      }
      if (!INDEXABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        progress.filesSkipped++
        note('not an indexable file type')
        continue
      }
      if (options.isIgnored?.(relative) === true) {
        progress.filesSkipped++
        note('gitignored')
        continue
      }

      /*
       * The rule that makes indexing safe: anything a file-reading tool is forbidden to
       * read is forbidden here too. Checked per file rather than per directory because the
       * deny list resolves symlinks, and a denied file can be reached under another name.
       */
      if (await denylist.isDenied(absolute)) {
        progress.filesSkipped++
        note('on the deny list')
        continue
      }

      let content: string
      try {
        const stats = await fs.stat(absolute)
        // A file this large is generated, vendored or data. Embedding it costs real money
        // and buries the actual code in every result.
        if (stats.size > 1_000_000) {
          progress.filesSkipped++
          note('larger than 1MB')
          continue
        }
        content = await fs.readFile(absolute, 'utf8')
      } catch {
        progress.filesSkipped++
        note('unreadable')
        continue
      }

      if (!looksLikeText(content)) {
        progress.filesSkipped++
        note('binary')
        continue
      }

      const hash = hashContent(content)
      current[relative] = hash
      if (previous[relative] === hash) {
        note('unchanged since last index')
        continue
      }

      const chunks = chunkFile(content, options.chunkOptions)
      if (chunks.length === 0) {
        progress.filesSkipped++
        note('empty')
        continue
      }

      progress.phase = 'embedding'
      progress.current = relative
      report()

      // Replaced wholesale rather than diffed: line numbers shift when a file changes, so
      // a stale chunk would keep matching and cite a range that no longer says that.
      if (previous[relative] !== undefined) await writer.deleteByPaths(index, [relative], signal)

      const vectors = await embedder.embedBatch(
        chunks.map((chunk) => chunk.text),
        signal,
      )
      for (const [position, chunk] of chunks.entries()) {
        const vector = vectors[position]
        if (vector === undefined) continue
        pending.push({
          // Deterministic, so re-indexing overwrites rather than duplicating.
          id: `${hashContent(relative)}:${chunk.startLine}`,
          text: chunk.text,
          path: relative,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          vector,
        })
      }
      progress.filesIndexed++
      if (pending.length >= batchSize) await flush()
    }
  }

  await walk(workspaceRoot)
  await flush()

  // Files indexed previously and now gone must leave the index, or a search cites a path
  // that no longer exists and the model reads nothing.
  const removed = Object.keys(previous).filter((file) => current[file] === undefined)
  if (removed.length > 0) await writer.deleteByPaths(index, removed, signal)

  await options.saveManifest({
    model: embedder.model,
    dimensions: embedder.dimensions,
    chunkSignature: signature,
    files: current,
  })

  progress.phase = 'done'
  delete progress.current
  report()

  return {
    filesIndexed: progress.filesIndexed,
    filesSkipped: progress.filesSkipped,
    filesRemoved: removed.length,
    chunksWritten: progress.chunksWritten,
    skipReasons,
  }
}
