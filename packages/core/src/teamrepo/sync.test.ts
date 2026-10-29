import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AtlassianError } from '../atlassian/rest.js'
import { checkCoverage, classifyRepoPath, contentHash, releaseFromRecord, repoFilesOf, repoPathFor, syncTeamRepo, tombstoneInRepo, type TeamRepoFiles } from './sync.js'

/**
 * A Bitbucket repository in memory, with the one rule that keeps a team safe: a commit carrying an
 * out-of-date sourceCommitId - the file changed since - is refused with 409, as Bitbucket does.
 */
function fakeRepo(defaultBranch = 'main') {
  let counter = 0
  const commits: { id: string; branch: string; changes: { path: string; type: string }[] }[] = []
  const branches = new Map<string, Map<string, { bytes: Uint8Array; commit: string }>>()
  branches.set(defaultBranch, new Map())
  const newCommit = (branch: string, changes: { path: string; type: string }[]): string => {
    const id = `c${String(++counter)}`
    commits.push({ id, branch, changes })
    return id
  }
  newCommit(defaultBranch, [])
  const headOf = (branch: string): string | undefined => [...commits].reverse().find((commit) => commit.branch === branch)?.id
  const order = (id: string): number => commits.findIndex((commit) => commit.id === id)
  const api: TeamRepoFiles = {
    async branchHead(branch) {
      return branches.has(branch) ? headOf(branch) : undefined
    },
    async defaultBranch() {
      return defaultBranch
    },
    async createBranch(name, startPoint) {
      branches.set(name, new Map(branches.get(startPoint)))
      newCommit(name, [])
    },
    async listFiles(folder, at) {
      const branch = commits.find((commit) => commit.id === at)?.branch ?? defaultBranch
      const prefix = folder.length > 0 ? `${folder}/` : ''
      return [...(branches.get(branch)?.keys() ?? [])].filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length))
    },
    async changes(since, until) {
      return commits.slice(order(since) + 1, order(until) + 1).flatMap((commit) => commit.changes)
    },
    async readBytes(file, at) {
      const branch = commits.find((commit) => commit.id === at)?.branch ?? defaultBranch
      return branches.get(branch)?.get(file)?.bytes
    },
    async commitFile(file) {
      const files = branches.get(file.branch)
      if (files === undefined) throw new AtlassianError('no such branch', 404)
      const existing = files.get(file.path)
      if (existing !== undefined && (file.sourceCommitId === undefined || order(existing.commit) > order(file.sourceCommitId))) {
        throw new AtlassianError('file changed since', 409)
      }
      const id = newCommit(file.branch, [{ path: file.path, type: existing === undefined ? 'ADD' : 'MODIFY' }])
      files.set(file.path, { bytes: file.bytes, commit: id })
      return id
    },
  }
  /** A colleague's commit, straight to the repository. */
  const colleague = (branch: string, file: string, text: string): void => {
    const files = branches.get(branch)!
    const id = newCommit(branch, [{ path: file, type: files.has(file) ? 'MODIFY' : 'ADD' }])
    files.set(file, { bytes: new TextEncoder().encode(text), commit: id })
  }
  /** A deletion made in the repository, recorded as a commit as a real one is. */
  const remove = (branch: string, file: string): void => {
    branches.get(branch)!.delete(file)
    newCommit(branch, [{ path: file, type: 'DELETE' }])
  }
  const read = (branch: string, file: string): string | undefined => {
    const bytes = branches.get(branch)?.get(file)?.bytes
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes)
  }
  return { api, colleague, remove, read, branches }
}

let root: string
let local: { skills: string; tools: string }
let mirror: { skills: string; tools: string }
/** An S3 bucket folder in the search path, after the save folder. */
let bucket: { skills: string; tools: string }
let stateFile: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-teamrepo-'))
  local = { skills: path.join(root, 'mine', 'skills'), tools: path.join(root, 'mine', 'tools') }
  mirror = { skills: path.join(root, 'team', 'skills'), tools: path.join(root, 'team', 'tools') }
  stateFile = path.join(root, 'team', '.lightcode-teamrepo.json')
  bucket = { skills: path.join(root, 'bucket', 'skills'), tools: path.join(root, 'bucket', 'tools') }
  await fs.mkdir(local.skills, { recursive: true })
  await fs.mkdir(local.tools, { recursive: true })
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const sync = (api: TeamRepoFiles, branch = 'main') =>
  syncTeamRepo({ api, branch, folder: 'light-code', local: { skills: [local.skills, bucket.skills], tools: [local.tools, bucket.tools] }, mirror, stateFile, author: 'jsmith' })

describe('repository paths', () => {
  it('keeps skills (in folders too) and top-level .py tools, and never anything hidden', () => {
    expect(repoPathFor('light-code', 'skills', 'deploy.md')).toBe('light-code/skills/deploy.md')
    expect(repoPathFor('', 'tools', 'x.py')).toBe('tools/x.py')
    expect(classifyRepoPath('light-code', 'light-code/skills/deploy/SKILL.md')).toEqual({ kind: 'skills', relative: 'deploy/SKILL.md' })
    expect(classifyRepoPath('light-code', 'light-code/tools/x.py')).toEqual({ kind: 'tools', relative: 'x.py' })
    expect(classifyRepoPath('light-code', 'light-code/tools/.registry.json')).toBeUndefined()
    expect(classifyRepoPath('light-code', 'light-code/tools/sub/x.py')).toBeUndefined()
    expect(classifyRepoPath('light-code', 'light-code/skills/.lightcode-sync.json')).toBeUndefined()
    expect(classifyRepoPath('light-code', 'other/skills/a.md')).toBeUndefined()
  })
})

describe('syncing with the team repository', () => {
  it('commits existing skills and tools on the first sync, to a branch made from the default when missing', async () => {
    const repo = fakeRepo('main')
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy')
    await fs.mkdir(path.join(local.skills, 'report'), { recursive: true })
    await fs.writeFile(path.join(local.skills, 'report', 'SKILL.md'), '# report')
    await fs.writeFile(path.join(local.tools, 'fetch.py'), 'def run(): pass')
    await fs.writeFile(path.join(local.tools, '.registry.json'), '{}')

    const first = await sync(repo.api, 'team-skills')
    expect(first.branchCreated).toBe('team-skills (from main)')
    expect(first.pushed.sort()).toEqual(['light-code/skills/deploy.md', 'light-code/skills/report/SKILL.md', 'light-code/tools/fetch.py'])
    expect(repo.read('team-skills', 'light-code/tools/.registry.json')).toBeUndefined()
    expect(await fs.readFile(path.join(mirror.skills, 'deploy.md'), 'utf8')).toBe('# deploy')

    const second = await sync(repo.api, 'team-skills')
    expect(second.pushed).toEqual([])
    expect(second.conflicts).toEqual([])
  })

  it('brings a colleague\'s new skill into the team copy, and pushes an edit of our own', async () => {
    const repo = fakeRepo()
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy')
    await sync(repo.api)
    repo.colleague('main', 'light-code/skills/oncall.md', '# on call')
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy, v2')
    const report = await sync(repo.api)
    expect(report.pulled).toEqual(['light-code/skills/oncall.md'])
    expect(await fs.readFile(path.join(mirror.skills, 'oncall.md'), 'utf8')).toBe('# on call')
    expect(report.pushed).toEqual(['light-code/skills/deploy.md'])
    expect(repo.read('main', 'light-code/skills/deploy.md')).toBe('# deploy, v2')
  })

  it('never overwrites a colleague: edited on both sides, or the same name with other content', async () => {
    const repo = fakeRepo()
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy')
    await sync(repo.api)
    repo.colleague('main', 'light-code/skills/deploy.md', '# deploy, their fix')
    repo.colleague('main', 'light-code/tools/shared.py', 'def run(): return 1')
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy, my fix')
    await fs.writeFile(path.join(local.tools, 'shared.py'), 'def run(): return 2')
    const report = await sync(repo.api)
    expect(report.pushed).toEqual([])
    expect(report.conflicts.map((conflict) => conflict.path).sort()).toEqual(['light-code/skills/deploy.md', 'light-code/tools/shared.py'])
    expect(repo.read('main', 'light-code/skills/deploy.md')).toBe('# deploy, their fix')
    expect(repo.read('main', 'light-code/tools/shared.py')).toBe('def run(): return 1')
    // Theirs is in the team copy for the person to compare.
    expect(await fs.readFile(path.join(mirror.skills, 'deploy.md'), 'utf8')).toBe('# deploy, their fix')
  })

  it('refuses a change that slipped in between the pull and the commit (Bitbucket\'s 409)', async () => {
    const repo = fakeRepo()
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy')
    await sync(repo.api)
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# mine')
    const realCommit = repo.api.commitFile.bind(repo.api)
    repo.api.commitFile = async (file) => {
      repo.colleague('main', file.path, '# theirs, at the same moment')
      return realCommit(file)
    }
    const report = await sync(repo.api)
    expect(report.pushed).toEqual([])
    expect(report.conflicts[0]?.reason).toContain('changed in the repository since the last sync')
    expect(repo.read('main', 'light-code/skills/deploy.md')).toBe('# theirs, at the same moment')
  })

  it('commits what S3 buckets hold too - skills and tools - and a second person pushing the same file agrees', async () => {
    const repo = fakeRepo()
    await fs.mkdir(bucket.skills, { recursive: true })
    await fs.mkdir(bucket.tools, { recursive: true })
    await fs.writeFile(path.join(bucket.skills, 'theirs.md'), '# from the bucket')
    await fs.writeFile(path.join(bucket.skills, '.lightcode-sync.json'), '{}')
    await fs.writeFile(path.join(bucket.tools, 'report.py'), 'def run(): return 1')
    await fs.writeFile(path.join(local.skills, 'mine.md'), '# mine')
    const report = await sync(repo.api)
    expect(report.pushed.sort()).toEqual(['light-code/skills/mine.md', 'light-code/skills/theirs.md', 'light-code/tools/report.py'])
    expect(repo.read('main', 'light-code/skills/.lightcode-sync.json')).toBeUndefined()

    // A colleague with the same bucket syncs too: the same bytes are agreement, not a conflict.
    const theirState = path.join(root, 'colleague', '.lightcode-teamrepo.json')
    const colleague = await syncTeamRepo({
      api: repo.api, branch: 'main', folder: 'light-code',
      local: { skills: [bucket.skills], tools: [bucket.tools] },
      mirror: { skills: path.join(root, 'colleague', 'skills'), tools: path.join(root, 'colleague', 'tools') },
      stateFile: theirState, author: 'adoe',
    })
    expect(colleague.pushed).toEqual([])
    expect(colleague.conflicts).toEqual([])

    // Someone edits it in the bucket: the next sync commits the edit.
    await fs.writeFile(path.join(bucket.tools, 'report.py'), 'def run(): return 2')
    expect((await sync(repo.api)).pushed).toEqual(['light-code/tools/report.py'])
    expect(repo.read('main', 'light-code/tools/report.py')).toBe('def run(): return 2')
  })

  it('a file in two folders here: identical is one file, different syncs the one that loads and says so', async () => {
    const repo = fakeRepo()
    await fs.mkdir(bucket.skills, { recursive: true })
    await fs.writeFile(path.join(local.skills, 'same.md'), '# same')
    await fs.writeFile(path.join(bucket.skills, 'same.md'), '# same')
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy, mine')
    await fs.writeFile(path.join(bucket.skills, 'deploy.md'), '# deploy, older')
    const report = await sync(repo.api)
    expect(report.pushed.sort()).toEqual(['light-code/skills/deploy.md', 'light-code/skills/same.md'])
    expect(repo.read('main', 'light-code/skills/deploy.md')).toBe('# deploy, mine')
    expect(report.conflicts.map((conflict) => conflict.path)).toEqual(['light-code/skills/deploy.md'])
    expect(report.conflicts[0]?.reason).toContain('two different copies on this machine')
  })

  it('a 409 from someone committing the same bytes first is agreement', async () => {
    const repo = fakeRepo()
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy')
    await sync(repo.api)
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy, v2')
    const realCommit = repo.api.commitFile.bind(repo.api)
    repo.api.commitFile = async (file) => {
      repo.colleague('main', file.path, '# deploy, v2')
      return realCommit(file)
    }
    const report = await sync(repo.api)
    expect(report.conflicts).toEqual([])
    repo.api.commitFile = realCommit
    const again = await sync(repo.api)
    expect(again.pushed).toEqual([])
    expect(again.conflicts).toEqual([])
  })

  it('newer in the repository while unchanged here is not a clash - it waits for the bucket to catch up', async () => {
    const repo = fakeRepo()
    await fs.mkdir(bucket.skills, { recursive: true })
    await fs.writeFile(path.join(bucket.skills, 'deploy.md'), '# deploy')
    await sync(repo.api)
    // A colleague's edit reaches the repository before this machine's bucket sync brings it down.
    repo.colleague('main', 'light-code/skills/deploy.md', '# deploy, their fix')
    const early = await sync(repo.api)
    expect(early.conflicts).toEqual([])
    expect(early.behind).toEqual(['light-code/skills/deploy.md'])
    expect(early.pushed).toEqual([])
    expect(repo.read('main', 'light-code/skills/deploy.md')).toBe('# deploy, their fix')
    // The bucket catches up: agreement, nothing pushed, nothing listed.
    await fs.writeFile(path.join(bucket.skills, 'deploy.md'), '# deploy, their fix')
    const later = await sync(repo.api)
    expect(later.behind).toEqual([])
    expect(later.conflicts).toEqual([])
    expect(later.pushed).toEqual([])
  })

  it('treats CRLF here and LF in the repository as the same version', async () => {
    const repo = fakeRepo()
    repo.colleague('main', 'light-code/skills/deploy.md', '# deploy\nstep one\n')
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '\uFEFF# deploy\r\nstep one\r\n')
    const report = await sync(repo.api)
    expect(report.conflicts).toEqual([])
    expect(report.pushed).toEqual([])
    // An edit after that is still an edit.
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy\r\nstep one\r\nstep two\r\n')
    expect((await sync(repo.api)).pushed).toEqual(['light-code/skills/deploy.md'])
    expect(contentHash(new TextEncoder().encode('a\r\nb'))).toBe(contentHash(new TextEncoder().encode('a\nb\n')))
    expect(contentHash(new Uint8Array([0, 13, 10]))).not.toBe(contentHash(new Uint8Array([0, 10])))
  })

  it('carries a record written by the previous version over without reporting every file', async () => {
    const repo = fakeRepo()
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy\r\n')
    await sync(repo.api)
    // Rewrite the record as 0.178 and earlier kept it: raw-byte hashes, version 1.
    const current = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
      version: number
      files: Record<string, { hash: string }>
      pushed: Record<string, string>
    }
    const old = createHash('sha256').update('# deploy\r\n').digest('hex')
    current.version = 1
    const entry = current.files['light-code/skills/deploy.md']
    if (entry === undefined) throw new Error('nothing recorded')
    entry.hash = old
    current.pushed['light-code/skills/deploy.md'] = old
    await fs.writeFile(stateFile, JSON.stringify(current))
    const report = await sync(repo.api)
    expect(report.conflicts).toEqual([])
    expect(report.behind).toEqual([])
    expect(report.pushed).toEqual([])
    expect((JSON.parse(await fs.readFile(stateFile, 'utf8')) as { version: number }).version).toBe(2)
  })

  it('leaves a skill deleted here in the repository, and says so', async () => {
    const repo = fakeRepo()
    await fs.writeFile(path.join(local.skills, 'old.md'), '# old')
    await sync(repo.api)
    await fs.rm(path.join(local.skills, 'old.md'))
    const report = await sync(repo.api)
    expect(report.deletedHere).toEqual(['light-code/skills/old.md'])
    expect(repo.read('main', 'light-code/skills/old.md')).toBe('# old')
  })

  it('removes from the team copy what was deleted in the repository', async () => {
    const repo = fakeRepo()
    repo.colleague('main', 'light-code/skills/gone.md', '# soon gone')
    await sync(repo.api)
    expect(await fs.readFile(path.join(mirror.skills, 'gone.md'), 'utf8')).toBe('# soon gone')
    repo.remove('main', 'light-code/skills/gone.md')
    const report = await sync(repo.api)
    expect(report.removed).toEqual(['light-code/skills/gone.md'])
    await expect(fs.stat(path.join(mirror.skills, 'gone.md'))).rejects.toThrow()
  })
})

describe('before switching S3 bucket folders off', () => {
  it('is covered only when the repository holds every bucket file with the same content', async () => {
    const repo = fakeRepo()
    await fs.mkdir(bucket.skills, { recursive: true })
    await fs.mkdir(bucket.tools, { recursive: true })
    await fs.writeFile(path.join(bucket.skills, 'deploy.md'), '# deploy')
    await fs.writeFile(path.join(bucket.tools, 'report.py'), 'def run(): return 1')
    await sync(repo.api)
    const check = () => checkCoverage({ folder: 'light-code', stateFile, mirror, dirs: { skills: [bucket.skills], tools: [bucket.tools] } })
    const clean = await check()
    expect(clean.problems).toEqual([])
    expect(clean.covered).toEqual({ skills: 1, tools: 1 })
    expect(clean.repoPaths.sort()).toEqual(['light-code/skills/deploy.md', 'light-code/tools/report.py'])

    // A file the bucket brought after the last sync, and an edit not yet committed, are both listed.
    await fs.writeFile(path.join(bucket.skills, 'new.md'), '# new')
    await fs.writeFile(path.join(bucket.tools, 'report.py'), 'def run(): return 2')
    const dirty = await check()
    expect(dirty.problems).toHaveLength(2)
    expect(dirty.problems.join('\n')).toContain('not in the repository yet')
    expect(dirty.problems.join('\n')).toContain('differs from the repository')

    // A sync later, covered again.
    await sync(repo.api)
    expect((await check()).problems).toEqual([])
  })

  it('counts a bucket copy that is merely behind a newer repository version as covered', async () => {
    const repo = fakeRepo()
    await fs.mkdir(bucket.skills, { recursive: true })
    await fs.writeFile(path.join(bucket.skills, 'deploy.md'), '# deploy')
    await sync(repo.api)
    repo.colleague('main', 'light-code/skills/deploy.md', '# deploy, newer')
    await sync(repo.api)
    const result = await checkCoverage({ folder: 'light-code', stateFile, mirror, dirs: { skills: [bucket.skills], tools: [] } })
    expect(result.problems).toEqual([])
  })

  it('forgets files that only the switched-off folders held, so they are not reported as deleted here', async () => {
    const repo = fakeRepo()
    await fs.mkdir(bucket.skills, { recursive: true })
    await fs.writeFile(path.join(bucket.skills, 'deploy.md'), '# deploy')
    await sync(repo.api)
    await releaseFromRecord(stateFile, ['light-code/skills/deploy.md'])
    // The bucket folder no longer loads: only the project folder is left.
    const report = await syncTeamRepo({ api: repo.api, branch: 'main', folder: 'light-code', local: { skills: [local.skills], tools: [local.tools] }, mirror, stateFile, author: 'jsmith' })
    expect(report.deletedHere).toEqual([])
    expect(report.conflicts).toEqual([])
    expect(repo.read('main', 'light-code/skills/deploy.md')).toBe('# deploy')
    expect(await fs.readFile(path.join(mirror.skills, 'deploy.md'), 'utf8')).toBe('# deploy')
  })
})

describe('after the S3 bucket folders are switched off', () => {
  it('commits an edit made here to a skill that came from the bucket as an ordinary update', async () => {
    const repo = fakeRepo()
    await fs.mkdir(bucket.skills, { recursive: true })
    await fs.writeFile(path.join(bucket.skills, 'deploy.md'), '# deploy')
    await sync(repo.api)
    await releaseFromRecord(stateFile, ['light-code/skills/deploy.md'])
    const projectOnly = () =>
      syncTeamRepo({ api: repo.api, branch: 'main', folder: 'light-code', local: { skills: [local.skills], tools: [local.tools] }, mirror, stateFile, author: 'jsmith' })

    // A colleague improves it meanwhile; it reaches this machine through the team copy.
    repo.colleague('main', 'light-code/skills/deploy.md', '# deploy, their fix')
    const quiet = await projectOnly()
    expect(quiet.deletedHere).toEqual([])
    expect(quiet.conflicts).toEqual([])

    // Edited here, starting from the version the team copy holds: saved into the project's folder.
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy, their fix, and mine')
    const report = await projectOnly()
    expect(report.conflicts).toEqual([])
    expect(report.pushed).toEqual(['light-code/skills/deploy.md'])
    expect(repo.read('main', 'light-code/skills/deploy.md')).toBe('# deploy, their fix, and mine')

    // Kept here now: an ordinary file of this project, so deleting it is reported again.
    await fs.rm(path.join(local.skills, 'deploy.md'))
    expect((await projectOnly()).deletedHere).toEqual(['light-code/skills/deploy.md'])
  })
})

describe('deleting everywhere, through a deletion marker in the repository', () => {
  const colleagueSync = (api: TeamRepoFiles, dirs: { skills: string[]; tools: string[] }, removable: string[]) =>
    syncTeamRepo({
      api,
      branch: 'main',
      folder: 'light-code',
      local: dirs,
      mirror: { skills: path.join(root, 'colleague', 'team', 'skills'), tools: path.join(root, 'colleague', 'team', 'tools') },
      stateFile: path.join(root, 'colleague', 'state.json'),
      author: 'adoe',
      removable,
    })

  it('marks every file of a skill deleted, and brings it back only when written again', async () => {
    const repo = fakeRepo()
    await fs.mkdir(path.join(local.skills, 'report'), { recursive: true })
    await fs.writeFile(path.join(local.skills, 'report', 'SKILL.md'), '# report')
    await fs.writeFile(path.join(local.skills, 'report', 'chart.png'), 'png')
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy')
    await sync(repo.api)

    const paths = await repoFilesOf({ folder: 'light-code', stateFile, mirror, kind: 'skills', name: 'report' })
    expect(paths).toEqual(['light-code/skills/report/SKILL.md', 'light-code/skills/report/chart.png'])
    const result = await tombstoneInRepo({ api: repo.api, branch: 'main', folder: 'light-code', stateFile, mirror, repoPaths: paths, who: 'jsmith', now: new Date('2026-10-23T10:00:00Z') })
    expect(result.done).toEqual(paths)
    expect(repo.read('main', 'light-code/skills/report/SKILL.md')).toMatch(/^LIGHT-CODE-DELETED: removed for the team by jsmith on 2026-10-23/)
    expect(repo.read('main', 'light-code/skills/deploy.md')).toBe('# deploy')
    expect(existsSync(path.join(mirror.skills, 'report', 'SKILL.md'))).toBe(false)
    expect(await repoFilesOf({ folder: 'light-code', stateFile, mirror, kind: 'skills', name: 'report' })).toEqual([])

    // The local copies go too (the host does that next); the following sync is quiet.
    await fs.rm(path.join(local.skills, 'report'), { recursive: true })
    const quiet = await sync(repo.api)
    expect(quiet.deletedHere).toEqual([])
    expect(quiet.conflicts).toEqual([])
    expect(quiet.pushed).toEqual([])

    // Written again later: a new skill, committed over the marker.
    await fs.mkdir(path.join(local.skills, 'report'), { recursive: true })
    await fs.writeFile(path.join(local.skills, 'report', 'SKILL.md'), '# report, the new one')
    expect((await sync(repo.api)).pushed).toEqual(['light-code/skills/report/SKILL.md'])
    expect(repo.read('main', 'light-code/skills/report/SKILL.md')).toBe('# report, the new one')
  })

  it("removes a colleague's unchanged copy from folders Light Code syncs, and only reports one elsewhere or changed", async () => {
    const repo = fakeRepo()
    await fs.writeFile(path.join(local.skills, 'deploy.md'), '# deploy')
    await fs.writeFile(path.join(local.skills, 'oncall.md'), '# on call')
    await fs.writeFile(path.join(local.skills, 'notes.md'), '# notes')
    await sync(repo.api)

    // A colleague: deploy and oncall arrived through a bucket folder, notes sits in their project folder.
    const theirBucket = path.join(root, 'colleague', 'bucket')
    const theirProject = path.join(root, 'colleague', 'project')
    await fs.mkdir(theirBucket, { recursive: true })
    await fs.mkdir(theirProject, { recursive: true })
    await fs.writeFile(path.join(theirBucket, 'deploy.md'), '# deploy')
    await fs.writeFile(path.join(theirBucket, 'oncall.md'), '# on call')
    await fs.writeFile(path.join(theirProject, 'notes.md'), '# notes')
    const dirs = { skills: [theirProject, theirBucket], tools: [] }
    await colleagueSync(repo.api, dirs, [theirBucket])

    await tombstoneInRepo({
      api: repo.api, branch: 'main', folder: 'light-code', stateFile, mirror, who: 'jsmith',
      repoPaths: ['light-code/skills/deploy.md', 'light-code/skills/oncall.md', 'light-code/skills/notes.md'],
    })
    // Meanwhile the colleague had edited on-call.
    await fs.writeFile(path.join(theirBucket, 'oncall.md'), '# on call, my edit')

    const report = await colleagueSync(repo.api, dirs, [theirBucket])
    expect(existsSync(path.join(theirBucket, 'deploy.md'))).toBe(false)
    expect(report.removed).toContain('light-code/skills/deploy.md (copy on this computer)')
    expect(existsSync(path.join(theirBucket, 'oncall.md'))).toBe(true)
    expect(existsSync(path.join(theirProject, 'notes.md'))).toBe(true)
    const reasons = Object.fromEntries(report.conflicts.map((conflict) => [conflict.path, conflict.reason]))
    expect(reasons['light-code/skills/oncall.md']).toContain('changed here since')
    expect(reasons['light-code/skills/notes.md']).toContain('unchanged copy still loads here')
    // Nothing was put back.
    expect(report.pushed).toEqual([])
    expect(repo.read('main', 'light-code/skills/oncall.md')).toMatch(/^LIGHT-CODE-DELETED:/)
    // And the deleted one is not reported as "deleted here" afterwards.
    expect((await colleagueSync(repo.api, dirs, [theirBucket])).deletedHere).toEqual([])
  })

  it('stops at the first file the repository refuses, so the caller removes nothing else', async () => {
    const repo = fakeRepo()
    await fs.writeFile(path.join(local.tools, 'a.py'), 'def run(): return 1')
    await sync(repo.api)
    repo.colleague('main', 'light-code/tools/a.py', 'def run(): return 2')
    const result = await tombstoneInRepo({ api: repo.api, branch: 'main', folder: 'light-code', stateFile, mirror, who: 'jsmith', repoPaths: ['light-code/tools/a.py'] })
    expect(result.done).toEqual([])
    expect(result.failed?.problem).toContain('press Sync now and try again')
    expect(repo.read('main', 'light-code/tools/a.py')).toBe('def run(): return 2')
  })
})
