import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { replaceFile } from '../platform/node/replaceFile.js'

/**
 * The team's skills and Python tools kept in a Bitbucket repository - every person's pushed there, and
 * everyone's brought back.
 *
 * Asked for: "a bitbucket repository (different from working directory git repository) where all the
 * skills created and tools created by the team should be pushed ... existing tools and skills should be
 * committed to that repository and all the changes should be maintained there automatically ... for a
 * team". The user chose: commit directly to a branch (configurable - not every team may commit to main),
 * sync both ways, and leave a deleted skill or tool in the repository rather than delete it there.
 *
 * ## How it stays safe for a team
 *
 * - **Pull, then push.** Pulling reads the branch's newest commit and fetches only what changed since the
 *   last sync, into a local copy that loads as a read-only folder - exactly as a bucket mirror does, so a
 *   tool from the repository still needs approving on each machine before it runs (§13).
 * - **A file is pushed only when the repository still holds what this machine last pushed**, or does not
 *   hold it at all. A colleague's newer version, or the same name with other content, is a conflict: it is
 *   reported, never overwritten. The commit also carries the commit the file was last seen at, so
 *   Bitbucket itself refuses (409) a change that slipped in between.
 * - **Everything is REST under /rest/** with the Bitbucket token, through the one HttpClient (invariant 2) -
 *   no git, so deleting in the repository is not offered (the REST API cannot).
 *
 * The record of what was synced (\`.lightcode-teamrepo.json\` beside the copy) is written whole, by rename.
 */

export interface TeamRepoFiles {
  branchHead(branch: string): Promise<string | undefined>
  defaultBranch(): Promise<string | undefined>
  createBranch(name: string, startPoint: string): Promise<void>
  listFiles(folder: string, at: string): Promise<string[]>
  changes(since: string, until: string): Promise<{ path: string; type: string; from?: string | undefined }[]>
  readBytes(path: string, at: string): Promise<Uint8Array | undefined>
  commitFile(file: { path: string; bytes: Uint8Array; branch: string; message: string; sourceCommitId?: string | undefined }): Promise<string | undefined>
}

export interface TeamRepoState {
  /** 2: hashes are of the text with line endings normalised - see `contentHash`. */
  version: 2
  /** The branch's newest commit at the last pull. */
  head?: string | undefined
  /** Every repository file seen: the commit it was last seen at, and a hash of its bytes then. */
  files: Record<string, { commit: string; hash: string; deleted?: boolean }>
  /** What this machine last pushed, by repository path. */
  pushed: Record<string, string>
  /**
   * Files no longer kept in a folder here - their S3 bucket folder was switched off - that load from the
   * team copy. Not "deleted here"; and their base follows the repository, so an edit made here later (saved
   * into the project's folder) is an ordinary update rather than a clash. Dropped once a copy appears here.
   */
  released?: string[]
}

export interface TeamRepoReport {
  branch: string
  head?: string | undefined
  branchCreated?: string | undefined
  pulled: string[]
  removed: string[]
  pushed: string[]
  conflicts: { path: string; reason: string }[]
  /**
   * Newer in the repository while the copy here is unchanged since the last sync - usually a colleague's
   * edit that the S3 bucket has not brought here yet. Not a conflict: the next bucket sync catches up, and
   * the team copy already has theirs.
   */
  behind: string[]
  /** Pushed from here once, deleted here since, still in the repository. */
  deletedHere: string[]
}

export type TeamRepoKind = 'skills' | 'tools'

/**
 * What "Delete everywhere" commits in place of a file (asked for: "a force delete skill or tool even from
 * repo or s3 bucket"). Bitbucket Data Center's REST API cannot delete a file, and the user chose a marker
 * over running git: the file is replaced by one line saying who removed it and when, history keeps the old
 * version, and every Light Code treats the path as gone - the team copy drops it, and unchanged copies in
 * folders Light Code syncs are removed by the next sync. Writing a new one of the same name brings it back.
 */
export const TOMBSTONE_PREFIX = 'LIGHT-CODE-DELETED:'

export function tombstoneText(who: string, when: Date): string {
  return `${TOMBSTONE_PREFIX} removed for the team by ${who} on ${when.toISOString().slice(0, 10)}. Light Code no longer loads this file; writing a new one of the same name brings it back.\n`
}

export function isTombstone(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.slice(0, 64)).replace(/^\uFEFF/, '')
  return head.startsWith(TOMBSTONE_PREFIX)
}

export const TEAM_REPO_STATE_FILE = '.lightcode-teamrepo.json'

const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * What two copies are compared by: for text, the text with a byte-order mark dropped, CRLF read as LF and
 * trailing whitespace at the end ignored; for anything else, the bytes. A skill written on Windows and the
 * same skill as a server or a colleague's editor stores it must count as one version - otherwise every file
 * reads as "changed on both sides" for ever. Used only to compare; the bytes are what is committed.
 */
export function contentHash(bytes: Uint8Array): string {
  let text: string | undefined
  if (!bytes.includes(0)) {
    try {
      text = decoder.decode(bytes)
    } catch {
      text = undefined
    }
  }
  const digest = createHash('sha256')
  if (text === undefined) return digest.update(bytes).digest('hex')
  return digest.update(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')).digest('hex')
}
const hash = contentHash
const rawHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Where a kind lives in the repository: \`<folder>/skills/...\`, \`<folder>/tools/...\`. */
export function repoPathFor(folder: string, kind: TeamRepoKind, relative: string): string {
  const base = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return [base, kind, relative.replace(/\\/g, '/')].filter((part) => part.length > 0).join('/')
}

/** Which kind and relative path a repository path is, or undefined when it is not one we keep. */
export function classifyRepoPath(folder: string, repoPath: string): { kind: TeamRepoKind; relative: string } | undefined {
  for (const kind of ['skills', 'tools'] as const) {
    const prefix = `${repoPathFor(folder, kind, '')}/`
    if (!repoPath.startsWith(prefix)) continue
    const relative = repoPath.slice(prefix.length)
    const segments = relative.split('/')
    // Nothing hidden: a registry or a sync manifest must never travel.
    if (relative.length === 0 || segments.some((segment) => segment.length === 0 || segment.startsWith('.') || segment === '..')) return undefined
    // A tool is one .py file at the top of the folder; skills may be folders of files.
    if (kind === 'tools' && (segments.length !== 1 || !relative.endsWith('.py'))) return undefined
    return { kind, relative }
  }
  return undefined
}

/**
 * The record of the last sync. A version-1 record hashed raw bytes; its hashes are carried over by re-hashing
 * the team copy's file where that file is still exactly what was recorded, and dropped otherwise - a dropped
 * entry only means the next sync compares with the repository afresh.
 */
async function readState(file: string, mirrorFile: (repoPath: string) => string | undefined): Promise<TeamRepoState> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { version?: number } & Partial<TeamRepoState>
    const head = parsed.head !== undefined ? { head: parsed.head } : {}
    if (parsed.version === 2) {
      return { version: 2, files: parsed.files ?? {}, pushed: parsed.pushed ?? {}, ...head, ...(parsed.released !== undefined ? { released: parsed.released } : {}) }
    }
    if (parsed.version === 1) {
      const files: TeamRepoState['files'] = {}
      const pushed: TeamRepoState['pushed'] = {}
      for (const [repoPath, entry] of Object.entries(parsed.files ?? {})) {
        const local = mirrorFile(repoPath)
        if (local === undefined) continue
        const bytes = await fs.readFile(local).catch(() => undefined)
        if (bytes === undefined || rawHash(bytes) !== entry.hash) continue
        files[repoPath] = { commit: entry.commit, hash: contentHash(bytes) }
        if (parsed.pushed?.[repoPath] === entry.hash) pushed[repoPath] = contentHash(bytes)
      }
      return { version: 2, files, pushed, ...head }
    }
  } catch {
    // None yet, or unreadable: start from nothing, which only costs a full listing.
  }
  return { version: 2, files: {}, pushed: {} }
}

async function writeWhole(file: string, bytes: Uint8Array | string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid.toString(36)}${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(temp, bytes)
  await replaceFile(temp, file)
}

/**
 * The local files to push: every file under a skills folder, the top-level .py files of a tools folder.
 *
 * Every file, including ones an S3 bucket sync brought down. 0.177.0 skipped those as "a colleague's,
 * pushed by them" - and a team that keeps its skills and tools in a bucket then committed almost nothing
 * (reported: one skill synced, no tools). The bucket *is* the team's store; the repository is meant to hold
 * the same. Two people pushing the same bucket file meet as identical content, which is agreement, not a
 * conflict. Dotfiles (a registry, a sync manifest) never travel.
 */
async function localFiles(dir: string | undefined, kind: TeamRepoKind): Promise<{ relative: string; file: string }[]> {
  if (dir === undefined) return []
  const out: { relative: string; file: string }[] = []
  const walk = async (folder: string, prefix: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (kind === 'skills') await walk(path.join(folder, entry.name), relative)
      } else if (entry.isFile() && (kind === 'skills' || entry.name.endsWith('.py'))) {
        out.push({ relative, file: path.join(folder, entry.name) })
      }
    }
  }
  await walk(dir, '')
  return out.sort((a, b) => a.relative.localeCompare(b.relative))
}

export async function syncTeamRepo(options: {
  api: TeamRepoFiles
  branch: string
  folder: string
  /**
   * The folders skills and tools load from here - the save folder, the project's folder and S3 bucket
   * folders - in the order they win a name. Never the team copy itself.
   */
  local: { skills: readonly (string | undefined)[]; tools: readonly (string | undefined)[] }
  /** The team copy, loaded read-only. */
  mirror: { skills: string; tools: string }
  stateFile: string
  /** Named in commit messages. */
  author: string
  /** False: pull only, e.g. while nothing local is known yet. */
  push?: boolean
  /**
   * Folders Light Code syncs itself (S3 bucket copies, the folder new ones are saved in). An unchanged
   * copy there of something deleted for the team is removed by the sync; anywhere else it is reported.
   */
  removable?: readonly string[]
}): Promise<TeamRepoReport> {
  const { api, branch, folder } = options
  const mirrorFile = (kind: TeamRepoKind, relative: string): string => path.join(options.mirror[kind], ...relative.split('/'))
  const state = await readState(options.stateFile, (repoPath) => {
    const target = classifyRepoPath(folder, repoPath)
    return target === undefined ? undefined : mirrorFile(target.kind, target.relative)
  })
  const report: TeamRepoReport = { branch, pulled: [], removed: [], pushed: [], conflicts: [], behind: [], deletedHere: [] }

  // ---- Pull ----
  let head = await api.branchHead(branch)
  if (head !== undefined && head !== state.head) {
    const changed: { path: string; type: string; from?: string | undefined }[] =
      state.head !== undefined
        ? await api.changes(state.head, head)
        : (await api.listFiles(folder.replace(/^\/+|\/+$/g, ''), head)).map((relative) => ({
            path: [folder.replace(/^\/+|\/+$/g, ''), relative].filter((part) => part.length > 0).join('/'),
            type: 'ADD',
          }))
    for (const change of changed) {
      const gone = change.type === 'DELETE' ? change.path : change.type === 'MOVE' ? change.from : undefined
      if (gone !== undefined) {
        const was = classifyRepoPath(folder, gone)
        if (was !== undefined) {
          await fs.rm(mirrorFile(was.kind, was.relative), { force: true })
          delete state.files[gone]
          report.removed.push(gone)
        }
        if (change.type === 'DELETE') continue
      }
      const target = classifyRepoPath(folder, change.path)
      if (target === undefined) continue
      const bytes = await api.readBytes(change.path, head)
      if (bytes === undefined) continue
      const fetched = hash(bytes)
      const before = state.files[change.path]
      if (isTombstone(bytes)) {
        // Deleted for the team: never written to the team copy, and what was there goes.
        state.files[change.path] = { commit: head, hash: fetched, deleted: true }
        if (before?.deleted !== true) {
          await fs.rm(mirrorFile(target.kind, target.relative), { force: true })
          report.removed.push(change.path)
        }
        continue
      }
      state.files[change.path] = { commit: head, hash: fetched }
      // Our own push coming back, or a no-op change: nothing to write, so the folder watcher is not churned.
      if (before?.hash === fetched) continue
      await writeWhole(mirrorFile(target.kind, target.relative), bytes)
      report.pulled.push(change.path)
    }
    state.head = head
  }

  // ---- Push ----
  if (options.push !== false) {
    const locals: { relative: string; file: string; kind: TeamRepoKind }[] = []
    for (const kind of ['skills', 'tools'] as const) {
      for (const dir of new Set(options.local[kind].filter((entry): entry is string => entry !== undefined).map((entry) => path.resolve(entry)))) {
        locals.push(...(await localFiles(dir, kind)).map((entry) => ({ ...entry, kind })))
      }
    }
    const present = new Set<string>()
    /** The copy pushed for each repository path: the first folder holding it, as it loads here. */
    const chosen = new Map<string, { hash: string; file: string }>()
    for (const entry of locals) {
      const repoPath = repoPathFor(folder, entry.kind, entry.relative)
      present.add(repoPath)
      const bytes = new Uint8Array(await fs.readFile(entry.file))
      const mine = hash(bytes)
      const earlier = chosen.get(repoPath)
      if (earlier !== undefined) {
        // The same name in a second folder here: identical is one file; different is said, not pushed.
        if (earlier.hash !== mine) {
          report.conflicts.push({
            path: repoPath,
            reason: `two different copies on this machine (${earlier.file} and ${entry.file}) - the first, which Light Code uses, is the one synced`,
          })
        }
        continue
      }
      chosen.set(repoPath, { hash: mine, file: entry.file })
      const known = state.files[repoPath]
      if (known?.deleted === true && state.pushed[repoPath] !== known.hash) {
        // Deleted for the team. This machine has not seen that yet: its copy is stale if unchanged.
        if (mine === state.pushed[repoPath]) {
          const inside = (options.removable ?? []).some((dir) => entry.file.toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep))
          if (inside) {
            await fs.rm(entry.file, { force: true })
            state.pushed[repoPath] = known.hash
            report.removed.push(`${repoPath} (copy on this computer)`)
          } else {
            report.conflicts.push({
              path: repoPath,
              reason: `deleted for the team in the repository, but an unchanged copy still loads here from ${entry.file} - delete it there if it should go`,
            })
          }
        } else {
          report.conflicts.push({
            path: repoPath,
            reason: 'deleted for the team in the repository, but changed here since - not re-added; delete yours, or write it again to bring it back',
          })
        }
        continue
      }
      // Deleted and acknowledged here: a file of that name now is a new one, and is committed (over the marker).
      if (known?.hash === mine) {
        state.pushed[repoPath] = mine
        continue
      }
      if (head === undefined) {
        // No branch yet: made from the default one, so the first push has somewhere to go.
        const base = (await api.defaultBranch()) ?? 'main'
        if (base !== branch) {
          await api.createBranch(branch, base)
          report.branchCreated = `${branch} (from ${base})`
        }
        head = await api.branchHead(branch)
      }
      let sourceCommitId: string | undefined
      if (known === undefined) {
        const remote = head !== undefined ? await api.readBytes(repoPath, head) : undefined
        if (remote !== undefined) {
          if (hash(remote) === mine) {
            state.files[repoPath] = { commit: head ?? '', hash: mine }
            state.pushed[repoPath] = mine
          } else {
            report.conflicts.push({ path: repoPath, reason: 'already in the repository with different content (another person\'s?) - not overwritten' })
          }
          continue
        }
      } else if (known.hash === state.pushed[repoPath]) {
        // The repository still holds what this machine last pushed: this is our own edit.
        sourceCommitId = known.commit
      } else if (mine === state.pushed[repoPath]) {
        // Unchanged here since the last sync, newer in the repository: only one side changed, so nothing
        // clashes. Usually a colleague's edit the S3 bucket has not brought here yet - the next bucket sync
        // catches up, and the team copy already holds theirs.
        report.behind.push(repoPath)
        continue
      } else {
        report.conflicts.push({
          path: repoPath,
          reason:
            state.pushed[repoPath] === undefined
              ? 'the repository has a different version (another person\'s) - not overwritten; theirs is in the team copy'
              : 'changed both here and in the repository since the last sync - not overwritten; theirs is in the team copy',
        })
        continue
      }
      try {
        const commit = await api.commitFile({
          path: repoPath,
          bytes,
          branch,
          message: `Light Code: ${known === undefined ? 'add' : 'update'} ${entry.kind}/${entry.relative} (${options.author})`,
          ...(sourceCommitId !== undefined ? { sourceCommitId } : {}),
        })
        state.files[repoPath] = { commit: commit ?? head ?? '', hash: mine }
        state.pushed[repoPath] = mine
        // The team copy holds it too, so it is not fetched back as a change by the next pull.
        await writeWhole(mirrorFile(entry.kind, entry.relative), bytes)
        report.pushed.push(repoPath)
      } catch (error) {
        const status = (error as { status?: unknown }).status
        if (status === 409) {
          // Often a colleague pushing the same file from the same bucket a moment earlier: the same bytes
          // are agreement, not a conflict.
          const now = await api.branchHead(branch).catch(() => undefined)
          const remote = now !== undefined ? await api.readBytes(repoPath, now).catch(() => undefined) : undefined
          if (now !== undefined && remote !== undefined && hash(remote) === mine) {
            state.files[repoPath] = { commit: now, hash: mine }
            state.pushed[repoPath] = mine
            continue
          }
        }
        report.conflicts.push({
          path: repoPath,
          reason:
            status === 409
              ? 'changed in the repository since the last sync - not overwritten; the next sync brings theirs into the team copy'
              : `not committed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    const released = new Set(state.released ?? [])
    for (const repoPath of [...released]) {
      if (present.has(repoPath)) released.delete(repoPath)
      else {
        // Not kept here: whatever the repository holds is the version an edit here would start from.
        const known = state.files[repoPath]
        if (known !== undefined) state.pushed[repoPath] = known.hash
      }
    }
    if (released.size > 0) state.released = [...released].sort()
    else delete state.released
    for (const repoPath of Object.keys(state.pushed)) {
      if (!present.has(repoPath) && !released.has(repoPath) && state.files[repoPath] !== undefined && state.files[repoPath]?.deleted !== true) report.deletedHere.push(repoPath)
    }
  }

  report.head = head
  await writeWhole(options.stateFile, JSON.stringify(state, null, 1))
  return report
}

/**
 * Whether the repository already holds everything in some folders here - the check before S3 bucket
 * folders are switched off (asked for: "safely switch s3 bucket off when repository is added cleanly and
 * updated with all the skills and tools").
 *
 * Reads the record the last sync left, so run a sync first. A file is covered when the repository holds the
 * same content, or a newer version of a copy that has not changed here since the last sync (the bucket was
 * merely behind). Anything else - not in the repository, or changed here and not committed - is listed.
 */
export async function checkCoverage(options: {
  folder: string
  stateFile: string
  mirror: { skills: string; tools: string }
  dirs: { skills: readonly string[]; tools: readonly string[] }
}): Promise<{ covered: { skills: number; tools: number }; problems: string[]; repoPaths: string[] }> {
  const { folder } = options
  const state = await readState(options.stateFile, (repoPath) => {
    const target = classifyRepoPath(folder, repoPath)
    return target === undefined ? undefined : path.join(options.mirror[target.kind], ...target.relative.split('/'))
  })
  const covered = { skills: 0, tools: 0 }
  const problems: string[] = []
  const repoPaths: string[] = []
  for (const kind of ['skills', 'tools'] as const) {
    for (const dir of new Set(options.dirs[kind].map((entry) => path.resolve(entry)))) {
      for (const entry of await localFiles(dir, kind)) {
        const repoPath = repoPathFor(folder, kind, entry.relative)
        const mine = hash(new Uint8Array(await fs.readFile(entry.file)))
        const known = state.files[repoPath]
        // Deleted for the team: nothing for the bucket folder to hand over.
        if (known?.deleted === true) continue
        if (known === undefined) problems.push(`${entry.file} - not in the repository yet`)
        else if (known.hash !== mine && state.pushed[repoPath] !== mine) problems.push(`${entry.file} - differs from the repository's copy`)
        else {
          covered[kind] += 1
          repoPaths.push(repoPath)
        }
      }
    }
  }
  return { covered, problems, repoPaths: [...new Set(repoPaths)] }
}

/**
 * Marks files whose folders stopped loading here (S3 bucket folders switched off) as released - see
 * `TeamRepoState.released`. Otherwise each would be reported as "deleted here, still in the repository",
 * and an edit made here later would read as a clash. They stay in the repository and in the team copy,
 * which is how they keep loading.
 */
export async function releaseFromRecord(stateFile: string, repoPaths: readonly string[]): Promise<void> {
  let parsed: TeamRepoState
  try {
    parsed = JSON.parse(await fs.readFile(stateFile, 'utf8')) as TeamRepoState
  } catch {
    return
  }
  parsed.released = [...new Set([...(parsed.released ?? []), ...repoPaths])].sort()
  await writeWhole(stateFile, JSON.stringify(parsed, null, 1))
}

/**
 * "Delete everywhere": commits the deletion marker over each of a skill's or tool's files in the repository.
 *
 * Each file carries the commit it was last seen at, so a colleague's change in between is refused (409) and
 * reported rather than overwritten. Stops at the first failure: the caller must not then remove the bucket
 * and local copies, or the next sync would bring the file straight back from the repository.
 */
export async function tombstoneInRepo(options: {
  api: TeamRepoFiles
  branch: string
  folder: string
  stateFile: string
  mirror: { skills: string; tools: string }
  repoPaths: readonly string[]
  who: string
  now?: Date
}): Promise<{ done: string[]; failed?: { path: string; problem: string } }> {
  const { folder } = options
  const mirrorFile = (repoPath: string): string | undefined => {
    const target = classifyRepoPath(folder, repoPath)
    return target === undefined ? undefined : path.join(options.mirror[target.kind], ...target.relative.split('/'))
  }
  const state = await readState(options.stateFile, mirrorFile)
  const bytes = new TextEncoder().encode(tombstoneText(options.who, options.now ?? new Date()))
  const marker = hash(bytes)
  const done: string[] = []
  let failed: { path: string; problem: string } | undefined
  for (const repoPath of options.repoPaths) {
    const known = state.files[repoPath]
    if (known === undefined || known.deleted === true) continue
    const kind = classifyRepoPath(folder, repoPath)?.kind ?? 'skills'
    try {
      const commit = await options.api.commitFile({
        path: repoPath,
        bytes,
        branch: options.branch,
        message: `Light Code: delete ${kind}/${repoPath.split('/').pop() ?? repoPath} for the team (${options.who})`,
        sourceCommitId: known.commit,
      })
      state.files[repoPath] = { commit: commit ?? known.commit, hash: marker, deleted: true }
      // Acknowledged here: a file of this name written later is a new one.
      state.pushed[repoPath] = marker
      const local = mirrorFile(repoPath)
      if (local !== undefined) await fs.rm(local, { force: true })
      done.push(repoPath)
    } catch (error) {
      const status = (error as { status?: unknown }).status
      failed = {
        path: repoPath,
        problem: status === 409
          ? 'changed in the repository since the last sync - press Sync now and try again'
          : error instanceof Error ? error.message : String(error),
      }
      break
    }
  }
  await writeWhole(options.stateFile, JSON.stringify(state, null, 1))
  return { done, ...(failed !== undefined ? { failed } : {}) }
}

/** The repository files that make up one skill (`name.md`, or `name/` and all in it) or tool (`name.py`), not yet deleted. */
export async function repoFilesOf(options: {
  folder: string
  stateFile: string
  mirror: { skills: string; tools: string }
  kind: TeamRepoKind
  name: string
}): Promise<string[]> {
  const state = await readState(options.stateFile, () => undefined)
  return Object.entries(state.files)
    .filter(([repoPath, entry]) => {
      if (entry.deleted === true) return false
      const target = classifyRepoPath(options.folder, repoPath)
      if (target === undefined || target.kind !== options.kind) return false
      return options.kind === 'tools'
        ? target.relative === `${options.name}.py`
        : target.relative.toLowerCase() === `${options.name.toLowerCase()}.md` || target.relative.toLowerCase().startsWith(`${options.name.toLowerCase()}/`)
    })
    .map(([repoPath]) => repoPath)
    .sort()
}
