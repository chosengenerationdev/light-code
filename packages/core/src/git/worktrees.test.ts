import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { branchLabel } from './branchLabel.js'
import {
  addWorktree,
  branchFolderName,
  copySetupFiles,
  currentBranchOf,
  defaultBaseBranch,
  listBranches,
  listWorktrees,
  mainCheckoutOf,
  removeWorktree,
  setupMarkerFor,
  worktreeFolderFor,
  worktreeStatus,
} from './worktrees.js'

/* Several branches of one repository at once, each in its own folder - against real git. */

let root: string
let repo: string
const run = (args: string[], cwd = repo): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-wt-'))
  repo = path.join(root, 'payments')
  await fs.mkdir(repo)
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'core.autocrlf', 'false'])
  await fs.writeFile(path.join(repo, 'app.txt'), 'v1\n')
  run(['add', '.'])
  run(['commit', '-m', 'first'])
  run(['branch', 'feature/login'])
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('branch folders', () => {
  it('opens a branch beside the repository, with its own files, sharing the history', async () => {
    const folder = worktreeFolderFor(repo, 'feature/login')
    expect(folder).toBe(path.join(root, 'payments.worktrees', 'feature-login'))
    await addWorktree({ repo, branch: 'feature/login', folder })
    expect(currentBranchOf(folder)).toBe('feature/login')
    expect(mainCheckoutOf(folder)).toBe(path.resolve(repo))
    expect(mainCheckoutOf(repo)).toBeUndefined()

    // An edit there does not touch the main checkout, and a commit there is in the one repository.
    await fs.writeFile(path.join(folder, 'app.txt'), 'v2 on the branch\n')
    expect(await fs.readFile(path.join(repo, 'app.txt'), 'utf8')).toBe('v1\n')
    run(['commit', '-am', 'on the branch'], folder)
    expect(run(['log', '--oneline', 'feature/login'])).toContain('on the branch')

    const list = await listWorktrees(repo)
    expect(list.map((each) => [path.basename(each.path), each.branch, each.main])).toEqual([
      ['payments', 'main', true],
      ['feature-login', 'feature/login', false],
    ])
  })

  it('makes a new branch from another, and git refuses one branch in two folders', async () => {
    const folder = worktreeFolderFor(repo, 'PAY-12-fix')
    await addWorktree({ repo, branch: 'PAY-12-fix', from: 'main', folder })
    expect((await listBranches(repo)).local).toContain('PAY-12-fix')
    await expect(addWorktree({ repo, branch: 'PAY-12-fix', folder: worktreeFolderFor(repo, 'PAY-12-fix') })).rejects.toThrow()
    await expect(addWorktree({ repo, branch: '--upload-pack=evil', from: 'main', folder: path.join(root, 'x') })).rejects.toThrow(/not a branch name/)
  })

  it('closes a folder only after saying what would be lost, and never deletes the branch', async () => {
    const folder = worktreeFolderFor(repo, 'feature/login')
    await addWorktree({ repo, branch: 'feature/login', folder })
    await fs.writeFile(path.join(folder, 'new.txt'), 'not committed\n')
    expect(await worktreeStatus(folder)).toEqual({ uncommitted: 1, noUpstream: true })
    await expect(removeWorktree(repo, folder)).rejects.toThrow()
    expect(existsSync(folder)).toBe(true)
    await removeWorktree(repo, folder, true)
    expect(existsSync(folder)).toBe(false)
    expect((await listBranches(repo)).local).toContain('feature/login')
    await expect(removeWorktree(repo, repo)).rejects.toThrow(/not a branch folder|main checkout/)
  })

  it('keeps its setup marker outside the branch folder, and copies untracked files from the main checkout', async () => {
    const folder = worktreeFolderFor(repo, 'feature/login')
    await addWorktree({ repo, branch: 'feature/login', folder })
    const marker = setupMarkerFor(folder)
    expect(marker).toBeDefined()
    expect(path.relative(folder, marker as string).startsWith('..')).toBe(true)
    await fs.writeFile(path.join(repo, '.env'), 'TOKEN=local\n')
    const result = await copySetupFiles(repo, folder, ['.env', 'missing.cfg', '../outside.txt'])
    expect(result.copied).toEqual(['.env'])
    expect(result.skipped).toEqual(['missing.cfg (not in the main checkout)', '../outside.txt (outside the checkout)'])
    expect(await fs.readFile(path.join(folder, '.env'), 'utf8')).toBe('TOKEN=local\n')
    // A folder too - an uncommitted .vscode - adding what the branch lacks, never replacing what it has.
    await fs.mkdir(path.join(repo, '.vscode'))
    await fs.writeFile(path.join(repo, '.vscode', 'launch.json'), '{"main":true}')
    await fs.writeFile(path.join(repo, '.vscode', 'settings.json'), '{"main":true}')
    await fs.mkdir(path.join(folder, '.vscode'))
    await fs.writeFile(path.join(folder, '.vscode', 'settings.json'), '{"branch":true}')
    expect((await copySetupFiles(repo, folder, ['.vscode'])).copied).toEqual(['.vscode'])
    expect(await fs.readFile(path.join(folder, '.vscode', 'launch.json'), 'utf8')).toBe('{"main":true}')
    expect(await fs.readFile(path.join(folder, '.vscode', 'settings.json'), 'utf8')).toBe('{"branch":true}')
  })
})

describe('where a new branch starts', () => {
  it('is the main branch, even when the checkout is on another', async () => {
    run(['checkout', 'feature/login'])
    expect(await defaultBaseBranch(repo)).toBe('main')
    run(['branch', '-m', 'main', 'master'])
    expect(await defaultBaseBranch(repo)).toBe('master')
  })
})

describe('naming', () => {
  it('turns a branch into a folder name', () => {
    expect(branchFolderName('feature/login')).toBe('feature-login')
    expect(branchFolderName('origin/release/2.0')).toBe('release-2.0')
  })

  it('shows a long branch trimmed, keeping a Jira key whole', () => {
    expect(branchLabel('main')).toBe('main')
    expect(branchLabel('PAY-1234-add-retry-to-the-settlement-batch-job')).toBe('PAY-1234 add-retry-to-the-…')
    expect(branchLabel('feature/a-very-long-branch-name-without-a-key')).toBe('feature/a-very-long-branch-…')
    expect(branchLabel('PAY-1234')).toBe('PAY-1234')
  })
})

describe('a branch folder in the host', () => {
  const read = (...parts: string[]): string => readFileSync(path.join(__dirname, ...parts), 'utf8')
  it("files settings, approvals and codebase instructions under the repository, and runs setup once", () => {
    const bridge = read('..', 'host', 'bridge.ts')
    expect(bridge).toContain('const projectRoot = workspaceRoot !== undefined ? (mainCheckoutOf(workspaceRoot) ?? workspaceRoot) : undefined')
    expect(bridge).toContain('new ConfigManager(services.configStore, projectRoot)')
    expect(bridge).toContain("const approvalsKey = projectRoot ?? '__no_workspace__'")
    expect(bridge).toContain('codebaseInstructionsPath({ codebaseDir: services.codebaseDir, storageDir, workspaceRoot: projectRoot })')
    // The marker goes before anything runs, so a failure never runs it twice.
    const setup = bridge.slice(bridge.indexOf('async function prepareBranchFolder('))
    expect(setup.indexOf('await fs.rm(marker')).toBeLessThan(setup.indexOf('copySetupFiles('))
    const extension = read('..', '..', '..', '..', 'apps', 'vscode', 'src', 'extension.ts')
    expect(extension).toContain('(mainCheckoutOf(workspaceRoot) ?? workspaceRoot)')
  })
})
