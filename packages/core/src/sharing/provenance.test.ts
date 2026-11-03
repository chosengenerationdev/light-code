import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { gitFileHistory, parseGitLog } from './provenance.js'

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe("a skill's history", () => {
  it('reads who and when from git log lines, and a subject with the separator in it', () => {
    const line = ['abc1234', 'Ana Lee', 'ana@example.test', '1800000000', 'Tighten the disk rule'].join('\u001f')
    expect(parseGitLog(`${line}\n`)).toEqual([{ id: 'abc1234', by: 'Ana Lee', email: 'ana@example.test', at: 1_800_000_000, message: 'Tighten the disk rule' }])
    expect(parseGitLog('')).toEqual([])
  })

  it.skipIf(!hasGit)('is taken from the git checkout the file sits in, newest first, and says when it has changed since', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-provenance-'))
    const run = (args: string[], name: string) =>
      execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@example.test`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@example.test` } })
    run(['init', '-q'], 'ana')
    const file = path.join(repo, 'skills', 'disks.md')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'one\n')
    run(['add', '.'], 'ana')
    run(['commit', '-q', '-m', 'Add the disk monitor'], 'ana')
    fs.writeFileSync(file, 'two\n')
    run(['commit', '-q', '-am', 'Check every 10 minutes'], 'bo')
    const history = await gitFileHistory(file)
    expect(history?.source).toBe('git')
    expect(history?.commits.map((c) => [c.by, c.message])).toEqual([
      ['bo', 'Check every 10 minutes'],
      ['ana', 'Add the disk monitor'],
    ])
    expect(history?.where).toBe('skills/disks.md')
    expect(history?.uncommitted).toBeUndefined()
    fs.writeFileSync(file, 'three\n')
    expect((await gitFileHistory(file))?.uncommitted).toBe(true)
    // Outside any checkout: nothing, not an error.
    const loose = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-loose-')), 'x.md')
    fs.writeFileSync(loose, 'x')
    expect(await gitFileHistory(loose)).toBeUndefined()
  })
})
