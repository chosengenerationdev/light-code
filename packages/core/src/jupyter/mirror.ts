import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { replaceFile } from '../platform/node/replaceFile.js'
import type { JupyterClient, RemoteEntry } from './client.js'
import { HUBIGNORE, HubIgnore } from './hubIgnore.js'
import { localFolderNames, type JupyterHubSpec } from './spec.js'

/**
 * The local copy of the hub folders, and the rules for keeping the two in step.
 *
 * Searching runs on the copy, because the hub has no search API and a search that downloads every
 * file each time is no search at all. Editing runs on the copy too, so the ordinary edit tools -
 * their diffs, approvals, read-before-edit and rollback - apply unchanged, and each approved edit is
 * then saved to the hub.
 *
 * **Nothing is overwritten that somebody changed.** The manifest remembers, per file, the hub's
 * timestamp and the local content hash at the last agreement:
 *
 * - fetching skips a file changed here since (it is waiting to be saved), and reports a file changed
 *   in both places as a conflict, keeping the local one;
 * - saving refuses when the hub's timestamp moved since (somebody edited it there), so their work is
 *   never replaced by an older copy's edit;
 * - a file deleted on the hub is removed here only when unchanged here.
 *
 * **What `.hubignore` lists is never synced** (`hubIgnore.ts`), either way: not fetched, not saved,
 * not reported as waiting. A file synced before it was listed simply stops being tracked - it is
 * left as it is on both sides rather than deleted from either.
 */

const MANIFEST = '.lightcode-hub.json'
const CONCURRENCY = 8

interface ManifestEntry {
  remote: string
  lastModified: string
  hash: string
}

type Manifest = Record<string, ManifestEntry>

export interface PullResult {
  fetched: string[]
  unchanged: number
  removed: string[]
  /** Changed both here and on the hub: the local version was kept. */
  conflicts: string[]
  /** Too large to copy. */
  skipped: string[]
  /** Synced before, listed in `.hubignore` now: no longer tracked, left as they are on both sides. */
  ignored: string[]
  failed: { path: string; problem: string }[]
}

export interface PendingChange {
  local: string
  remote: string
  kind: 'changed' | 'new' | 'deleted'
}

export class HubMirror {
  readonly folders: { remote: string; local: string }[]
  private manifest: Manifest | undefined
  /** One manifest writer at a time: pulls, saves and runs all update it. */
  private lock: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly client: JupyterClient,
    private readonly spec: JupyterHubSpec,
    readonly root: string,
  ) {
    const names = localFolderNames(spec.folders)
    this.folders = spec.folders.map((remote, i) => ({ remote, local: names[i] ?? 'home' }))
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lock.then(work)
    this.lock = next.catch(() => undefined)
    return next
  }

  private async loadManifest(): Promise<Manifest> {
    if (this.manifest !== undefined) return this.manifest
    try {
      this.manifest = JSON.parse(await fs.readFile(path.join(this.root, MANIFEST), 'utf8')) as Manifest
    } catch {
      this.manifest = {}
    }
    return this.manifest
  }

  private async saveManifest(): Promise<void> {
    const target = path.join(this.root, MANIFEST)
    const temporary = `${target}.${String(process.pid)}.tmp`
    await fs.mkdir(this.root, { recursive: true })
    await fs.writeFile(temporary, JSON.stringify(this.manifest ?? {}), 'utf8')
    await replaceFile(temporary, target)
  }

  /** The hub path for a local file, or undefined when it is not inside one of the hub folders. */
  remoteOf(localAbsolute: string): string | undefined {
    const relative = path.relative(this.root, localAbsolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
    const parts = relative.split(path.sep)
    const folder = this.folders.find((f) => f.local.toLowerCase() === (parts[0] ?? '').toLowerCase())
    if (folder === undefined) return undefined
    return [folder.remote, ...parts.slice(1)].filter((p) => p.length > 0).join('/')
  }

  /** The hub folder (remote path) a local folder or file belongs to, for running a script where it lives. */
  remoteFolderOf(localAbsolute: string): string | undefined {
    const remote = this.remoteOf(localAbsolute)
    if (remote === undefined) return undefined
    return remote.split('/').slice(0, -1).join('/')
  }

  /** Fetches what changed on the hub. Safe to call any time: it never overwrites a local change. */
  pull(signal?: AbortSignal): Promise<PullResult> {
    return this.serial(() => this.pullNow(signal))
  }

  private async pullNow(signal?: AbortSignal): Promise<PullResult> {
    const manifest = await this.loadManifest()
    const result: PullResult = { fetched: [], unchanged: 0, removed: [], conflicts: [], skipped: [], ignored: [], failed: [] }
    const maxBytes = (this.spec.maxFileMB ?? 20) * 1024 * 1024
    const seen = new Set<string>()

    for (const folder of this.folders) {
      let files: RemoteEntry[]
      try {
        files = await this.walk(folder, signal)
      } catch (error) {
        result.failed.push({ path: folder.remote || '(top folder)', problem: error instanceof Error ? error.message : String(error) })
        // A folder that could not be listed must not read as "everything in it was deleted".
        for (const key of Object.keys(manifest)) if (key.split('/')[0] === folder.local) seen.add(key)
        continue
      }
      await inBatches(files, CONCURRENCY, async (entry) => {
        const inside = folder.remote.length > 0 ? entry.path.slice(folder.remote.length + 1) : entry.path
        const key = `${folder.local}/${inside}`
        seen.add(key)
        const local = path.join(this.root, ...key.split('/'))
        const known = manifest[key]
        const localHash = await hashFile(local)
        const changedHere = localHash !== undefined && (known === undefined || known.hash !== localHash)
        const changedThere = known === undefined || known.lastModified !== entry.lastModified
        if (!changedThere && localHash !== undefined) {
          result.unchanged += 1
          return
        }
        if (changedHere) {
          // Edited here and not yet saved. Changed on the hub as well is a conflict to report.
          if (changedThere && known !== undefined) result.conflicts.push(key)
          else if (known === undefined && localHash !== undefined) result.conflicts.push(key)
          return
        }
        if (entry.size !== undefined && entry.size > maxBytes) {
          result.skipped.push(key)
          return
        }
        try {
          const file = await this.client.read(entry.path, signal)
          await writeWhole(local, file.bytes)
          manifest[key] = { remote: entry.path, lastModified: file.lastModified || entry.lastModified, hash: sha(file.bytes) }
          result.fetched.push(key)
        } catch (error) {
          result.failed.push({ path: key, problem: error instanceof Error ? error.message : String(error) })
        }
      })
    }

    // Gone from the hub: removed here too, unless changed here since. Not seen because .hubignore lists
    // it now is a different thing: tracking stops, and nothing is deleted on either side.
    for (const [key, known] of Object.entries(manifest)) {
      if (seen.has(key)) continue
      if (await this.ignoredHere(key)) {
        delete manifest[key]
        result.ignored.push(key)
        continue
      }
      const local = path.join(this.root, ...key.split('/'))
      const localHash = await hashFile(local)
      if (localHash !== undefined && localHash !== known.hash) {
        result.conflicts.push(key)
        continue
      }
      await fs.rm(local, { force: true })
      delete manifest[key]
      result.removed.push(key)
    }

    await this.saveManifest()
    return result
  }

  /**
   * Every file under a remote folder that is not ignored, folders listed in parallel. An ignored
   * folder is not listed at all - which is the point for a `node_modules` of forty thousand files.
   */
  private async walk(folder: { remote: string; local: string }, signal?: AbortSignal): Promise<RemoteEntry[]> {
    const files: RemoteEntry[] = []
    let level: { remote: string; inside: string; ignore: HubIgnore }[] = [{ remote: folder.remote, inside: '', ignore: new HubIgnore() }]
    while (level.length > 0) {
      const next: typeof level = []
      await inBatches(level, CONCURRENCY, async (dir) => {
        const entries = await this.client.list(dir.remote, signal)
        if (entries === undefined) {
          if (dir.remote === folder.remote) throw new Error(`The hub has no folder "${folder.remote}".`)
          return
        }
        let ignore = dir.ignore
        const rules = entries.find((entry) => entry.name === HUBIGNORE && entry.type !== 'directory')
        if (rules !== undefined) {
          // This machine's copy first: an edit made here applies before it has reached the hub.
          const local = path.join(this.root, folder.local, ...dir.inside.split('/').filter((p) => p.length > 0), HUBIGNORE)
          const text = await fs.readFile(local, 'utf8').catch(async () => (await this.client.read(rules.path, signal)).bytes.toString('utf8'))
          ignore = ignore.with(text, dir.inside)
        }
        for (const entry of entries) {
          const inside = dir.inside.length > 0 ? `${dir.inside}/${entry.name}` : entry.name
          if (ignore.ignores(inside, entry.type === 'directory')) continue
          if (entry.type === 'directory') next.push({ remote: entry.path, inside, ignore })
          else files.push(entry)
        }
      })
      level = next
    }
    return files
  }

  /**
   * Whether a local key (`<folder>/<path>`) is left out by `.hubignore` - the rules in this machine's
   * copy, from the synced folder down to the file, and any folder on the way that is itself left out.
   */
  async ignoredHere(key: string): Promise<boolean> {
    const [folderName, ...parts] = key.split('/')
    const folder = this.folders.find((f) => f.local.toLowerCase() === (folderName ?? '').toLowerCase())
    if (folder === undefined || parts.length === 0) return false
    let ignore = new HubIgnore()
    for (let depth = 0; depth < parts.length; depth++) {
      const inside = parts.slice(0, depth).join('/')
      const text = await fs.readFile(path.join(this.root, folder.local, ...parts.slice(0, depth), HUBIGNORE), 'utf8').catch(() => undefined)
      if (text !== undefined) ignore = ignore.with(text, inside)
      const here = parts.slice(0, depth + 1).join('/')
      if (ignore.ignores(here, depth < parts.length - 1)) return true
    }
    return false
  }

  /**
   * Saves one local file to the hub. Refuses - and changes nothing - when the hub's copy changed
   * since this copy last agreed with it.
   */
  push(localAbsolute: string, signal?: AbortSignal): Promise<{ saved: boolean; message: string; ignored?: true }> {
    return this.serial(() => this.pushNow(localAbsolute, signal))
  }

  private async pushNow(localAbsolute: string, signal?: AbortSignal): Promise<{ saved: boolean; message: string; ignored?: true }> {
    const remote = this.remoteOf(localAbsolute)
    if (remote === undefined) return { saved: false, message: 'not inside one of the JupyterHub folders, so it stays local' }
    const manifest = await this.loadManifest()
    const key = path.relative(this.root, localAbsolute).split(path.sep).join('/')
    if (await this.ignoredHere(key)) return { saved: false, ignored: true, message: `listed in ${HUBIGNORE} (or skipped by default), so it stays local` }
    let bytes: Buffer
    try {
      bytes = await fs.readFile(localAbsolute)
    } catch {
      return { saved: false, message: 'it no longer exists here; delete it on the hub yourself if that was meant' }
    }
    const hash = sha(bytes)
    const known = manifest[key]
    if (known !== undefined && known.hash === hash) return { saved: true, message: 'already the same on the hub' }

    const there = await this.client.stat(remote, signal)
    if (there !== undefined && (known === undefined || there.lastModified !== known.lastModified)) {
      return {
        saved: false,
        message:
          `the hub's copy of ${remote} changed since this one was fetched (${there.lastModified}), so this edit was NOT ` +
          'saved there - it would replace somebody\'s newer work. The edit is kept here. See theirs with hub_sync ' +
          'action "hub_version", then ask the user whether to merge by hand or take theirs ("use_hub_version").',
      }
    }
    if (there === undefined && known !== undefined) {
      return { saved: false, message: `${remote} was deleted on the hub since it was fetched, so it was not recreated. Ask the user.` }
    }
    const parent = remote.split('/').slice(0, -1).join('/')
    if (parent.length > 0) await this.client.ensureFolder(parent, signal)
    const lastModified = await this.client.write(remote, bytes, signal)
    manifest[key] = { remote, lastModified, hash }
    await this.saveManifest()
    return { saved: true, message: `saved to the hub as ${remote}` }
  }

  /** The hub's current copy of a local file, for comparing after a refused save. */
  async hubVersion(localAbsolute: string, signal?: AbortSignal): Promise<{ remote: string; text: string; lastModified: string }> {
    const remote = this.remoteOf(localAbsolute)
    if (remote === undefined) throw new Error('That file is not inside one of the JupyterHub folders.')
    const file = await this.client.read(remote, signal)
    return { remote, text: file.bytes.toString('utf8'), lastModified: file.lastModified }
  }

  /** Replaces the local file with the hub's copy - discarding the local edit - and agrees with it again. */
  useHubVersion(localAbsolute: string, signal?: AbortSignal): Promise<string> {
    return this.serial(async () => {
      const remote = this.remoteOf(localAbsolute)
      if (remote === undefined) throw new Error('That file is not inside one of the JupyterHub folders.')
      const manifest = await this.loadManifest()
      const file = await this.client.read(remote, signal)
      await writeWhole(localAbsolute, file.bytes)
      manifest[path.relative(this.root, localAbsolute).split(path.sep).join('/')] = { remote, lastModified: file.lastModified, hash: sha(file.bytes) }
      await this.saveManifest()
      return remote
    })
  }

  /** Local changes not yet on the hub. Reads only the local copy. */
  async pending(): Promise<PendingChange[]> {
    const manifest = await this.loadManifest()
    const changes: PendingChange[] = []
    const seen = new Set<string>()
    for (const folder of this.folders) {
      for (const local of await listLocal(path.join(this.root, folder.local), '', new HubIgnore())) {
        const key = path.relative(this.root, local).split(path.sep).join('/')
        seen.add(key)
        const known = manifest[key]
        const remote = this.remoteOf(local) ?? key
        if (known === undefined) changes.push({ local: key, remote, kind: 'new' })
        else if ((await hashFile(local)) !== known.hash) changes.push({ local: key, remote, kind: 'changed' })
      }
    }
    for (const [key, known] of Object.entries(manifest)) {
      if (!seen.has(key) && !(await this.ignoredHere(key))) changes.push({ local: key, remote: known.remote, kind: 'deleted' })
    }
    return changes
  }
}

async function hashFile(file: string): Promise<string | undefined> {
  try {
    return sha(await fs.readFile(file))
  } catch {
    return undefined
  }
}

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeWhole(target: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${String(process.pid)}.part`
  await fs.writeFile(temporary, bytes)
  await replaceFile(temporary, target)
}

/** The local files under one synced folder that are not ignored; `inside` is `folder`'s path within it. */
async function listLocal(folder: string, inside: string, ignore: HubIgnore): Promise<string[]> {
  const found: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(folder, { withFileTypes: true })
  } catch {
    return found
  }
  if (entries.some((entry) => entry.name === HUBIGNORE && entry.isFile())) {
    const text = await fs.readFile(path.join(folder, HUBIGNORE), 'utf8').catch(() => undefined)
    if (text !== undefined) ignore = ignore.with(text, inside)
  }
  for (const entry of entries) {
    const relative = inside.length > 0 ? `${inside}/${entry.name}` : entry.name
    if (ignore.ignores(relative, entry.isDirectory())) continue
    const full = path.join(folder, entry.name)
    if (entry.isDirectory()) found.push(...(await listLocal(full, relative, ignore)))
    else if (entry.isFile() && !entry.name.endsWith('.part')) found.push(full)
  }
  return found
}

async function inBatches<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T
      await work(item)
    }
  })
  await Promise.all(runners)
}
