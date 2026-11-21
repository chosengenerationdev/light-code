import { promises as fs } from 'node:fs'
import path from 'node:path'


/**
 * The skill and Python-tool folders, read in one go and kept between loads.
 *
 * Reported: a chat took a minute and a half to load its skills and tools from the folders mirrored from an S3
 * bucket - "it shouldnt take 1.5 mins!, please leverage the power of rust". The loaders read one file at a time (and
 * both copies again when a name sits in two folders), and on a managed Windows machine every open waits on a scan.
 * So the loaders read through this instead: one snapshot of every folder, taken by the Rust helper's `library`
 * operation in parallel - or, without the helper, by Node in parallel - and a file whose size and modified time have
 * not changed since the last snapshot is not read again. The loaders themselves are unchanged: they ask this for a
 * folder's entries and a file's text exactly as they asked the disk.
 */
export interface LibraryFs {
  /** The folder's entries; throws when it does not exist or cannot be read. */
  readdir(dir: string): Promise<{ name: string; isDirectory: boolean }[]>
  readFile(filePath: string): Promise<string>
}

/** Straight to the disk: the default, and what everything outside the loaders keeps using. */
export const diskLibraryFs: LibraryFs = {
  async readdir(dir) {
    return (await fs.readdir(dir, { withFileTypes: true })).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  },
  readFile: (filePath) => fs.readFile(filePath, 'utf8'),
}

export interface LibraryRoot {
  dir: string
  kind: 'skills' | 'tools'
}

interface Cached {
  /** The path as last reported, which is what the helper matches its "already have it" on. */
  path: string
  mtimeMs: number
  size: number
  text: string
}

const key = (target: string): string => {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const wantedInSkills = (name: string, isDirectory: boolean): boolean => !isDirectory && name.toLowerCase().endsWith('.md')
const wantedInTools = (name: string, isDirectory: boolean): boolean => !isDirectory && (name.toLowerCase().endsWith('.py') || name.toLowerCase() === '.registry.json')

/** At most this many files are read at once without the helper - wide, since the time is spent waiting. */
const NODE_PARALLEL = 24

async function inParallel<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) await work(items[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(NODE_PARALLEL, items.length) }, () => lane()))
}

export class LibraryReader {
  private readonly cache = new Map<string, Cached>()
  /** The helper has said it does not know `library` (an older Fire Code): Node from then on. */
  private helperLacksLibrary = false

  /**
   * `helper` sends one request to the Rust helper (`fire-fs`), or is undefined where there is none - passed in, so this
   * module, which the skill and tool loaders import, does not pull in the tool code.
   */
  constructor(
    private readonly helper: () => ((request: object) => Promise<Record<string, unknown>>) | undefined,
    private readonly log?: (message: string) => void,
  ) {}

  /**
   * One snapshot of these folders. Entries for every root and every skills sub-folder; the text of every file a loader
   * reads there. What fails in the helper falls back to Node for this snapshot, never to an error.
   */
  async snapshot(roots: readonly LibraryRoot[]): Promise<LibraryFs> {
    const unique = [...new Map(roots.map((root) => [key(root.dir), root])).values()]
    const ask = this.helper()
    if (ask !== undefined && !this.helperLacksLibrary) {
      try {
        return await this.fromHelper(ask, unique)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/Unknown operation/i.test(message)) this.helperLacksLibrary = true
        this.log?.(`reading skills and tools with Node: the Rust helper could not (${message})`)
      }
    }
    return this.fromNode(unique)
  }

  private known(): Record<string, [number, number]> {
    const known: Record<string, [number, number]> = {}
    for (const cached of this.cache.values()) known[cached.path] = [cached.mtimeMs, cached.size]
    return known
  }

  private async fromHelper(ask: (request: object) => Promise<Record<string, unknown>>, roots: readonly LibraryRoot[]): Promise<LibraryFs> {
    const answer = await ask({ op: 'library', roots: roots.map((root) => ({ dir: path.resolve(root.dir), kind: root.kind })), known: this.known() })
    if (answer['ok'] !== true) throw new Error(typeof answer['error'] === 'string' ? answer['error'] : 'no answer')
    const dirs = new Map<string, { name: string; isDirectory: boolean }[] | undefined>()
    for (const [dir, value] of Object.entries((answer['dirs'] ?? {}) as Record<string, { exists?: boolean; entries?: { name: string; dir: boolean }[] }>)) {
      dirs.set(key(dir), value.exists === true ? (value.entries ?? []).map((entry) => ({ name: entry.name, isDirectory: entry.dir })) : undefined)
    }
    const texts = new Map<string, string>()
    for (const [file, value] of Object.entries((answer['files'] ?? {}) as Record<string, { mtimeMs?: number; size?: number; text?: string; unchanged?: boolean; error?: string }>)) {
      const k = key(file)
      if (value.unchanged === true) {
        const cached = this.cache.get(k)
        if (cached !== undefined) texts.set(k, cached.text)
        continue
      }
      if (typeof value.text === 'string') {
        this.cache.set(k, { path: file, mtimeMs: value.mtimeMs ?? 0, size: value.size ?? 0, text: value.text })
        texts.set(k, value.text)
      }
    }
    return this.view(dirs, texts)
  }

  private async fromNode(roots: readonly LibraryRoot[]): Promise<LibraryFs> {
    const dirs = new Map<string, { name: string; isDirectory: boolean }[] | undefined>()
    const files: string[] = []
    const subFolders: string[] = []
    await inParallel(roots, async (root) => {
      const entries = await diskLibraryFs.readdir(root.dir).catch(() => undefined)
      dirs.set(key(root.dir), entries)
      for (const entry of entries ?? []) {
        if (root.kind === 'skills' && entry.isDirectory) subFolders.push(path.join(root.dir, entry.name))
        else if (root.kind === 'skills' ? wantedInSkills(entry.name, entry.isDirectory) : wantedInTools(entry.name, entry.isDirectory)) files.push(path.join(root.dir, entry.name))
      }
    })
    await inParallel(subFolders, async (folder) => {
      const entries = await diskLibraryFs.readdir(folder).catch(() => undefined)
      dirs.set(key(folder), entries)
      for (const entry of entries ?? []) if (!entry.isDirectory && entry.name.toLowerCase() === 'skill.md') files.push(path.join(folder, entry.name))
    })
    const texts = new Map<string, string>()
    await inParallel(files, async (file) => {
      const k = key(file)
      try {
        const stat = await fs.stat(file)
        const cached = this.cache.get(k)
        if (cached !== undefined && Math.abs(cached.mtimeMs - stat.mtimeMs) < 1 && cached.size === stat.size) {
          texts.set(k, cached.text)
          return
        }
        const text = await fs.readFile(file, 'utf8')
        this.cache.set(k, { path: file, mtimeMs: stat.mtimeMs, size: stat.size, text })
        texts.set(k, text)
      } catch {
        // Unreadable: the loader reports it when it asks.
      }
    })
    return this.view(dirs, texts)
  }

  /** A folder or file the snapshot holds is answered from it; anything else goes to the disk as before. */
  private view(dirs: Map<string, { name: string; isDirectory: boolean }[] | undefined>, texts: Map<string, string>): LibraryFs {
    return {
      async readdir(dir) {
        const k = key(dir)
        if (!dirs.has(k)) return diskLibraryFs.readdir(dir)
        const entries = dirs.get(k)
        if (entries === undefined) throw Object.assign(new Error(`ENOENT: no such directory, '${dir}'`), { code: 'ENOENT' })
        return entries
      },
      async readFile(filePath) {
        const text = texts.get(key(filePath))
        return text !== undefined ? text : diskLibraryFs.readFile(filePath)
      },
    }
  }
}
