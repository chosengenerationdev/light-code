import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { describeMigration, planMigration, runMigration } from './folders.js'

/**
 * Bringing skills and tools along when their folder changes.
 *
 * Asked for: *"is it possible to sync tools and skills from previously used folder to newly using
 * folder or bucket?"* Against a real filesystem, because every rule here is about what is on disk
 * afterwards - and the one that matters most is what is **still** on disk in the old place.
 */

let root: string
let from: string
let to: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-migrate-'))
  from = path.join(root, 'old')
  to = path.join(root, 'new')
  await fs.mkdir(from, { recursive: true })
  await fs.mkdir(to, { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const skill = (name: string, body = 'x'): Promise<void> =>
  fs.writeFile(path.join(from, `${name}.md`), `---\nname: ${name}\n---\n${body}\n`, 'utf8')

describe('planning', () => {
  it('finds both skill layouts, and leaves other files alone', async () => {
    // `name.md` is what `write_skill` produces; `name/SKILL.md` is what Claude Code uses (§13).
    await skill('deployment')
    await fs.mkdir(path.join(from, 'invoicing'), { recursive: true })
    await fs.writeFile(path.join(from, 'invoicing', 'SKILL.md'), '---\nname: invoicing\n---\n', 'utf8')
    await fs.writeFile(path.join(from, 'notes.txt'), 'not a skill', 'utf8')
    await fs.mkdir(path.join(from, 'scratch'), { recursive: true })

    const plan = await planMigration({ from, to, kind: 'skills' })
    expect(plan.copy.map((item) => item.name)).toEqual(['deployment', 'invoicing'])
    // A folder with no SKILL.md in it is somebody's notes, not a skill.
    expect(plan.copy.map((item) => item.name)).not.toContain('scratch')
  })

  it('skips a name that is already there rather than planning to replace it', async () => {
    /*
     * The sharpest rule. Replacing would mean somebody's newer version being silently overwritten
     * by the older one they were migrating away from - the worst outcome of an operation whose
     * whole point is not losing anything.
     */
    await skill('deployment', 'old version')
    await fs.writeFile(path.join(to, 'deployment.md'), 'new version', 'utf8')

    const plan = await planMigration({ from, to, kind: 'skills' })
    expect(plan.copy).toEqual([])
    expect(plan.skip).toEqual(['deployment'])
  })

  it('ignores dotfiles, so a tool folder does not drag its approvals across', async () => {
    // `.registry.json` records approvals for *that* folder. Copying it would claim approval in a
    // folder nobody approved anything in.
    await fs.writeFile(path.join(from, 'fetch_ledger.py'), 'def run(): pass\n', 'utf8')
    await fs.writeFile(path.join(from, '.registry.json'), '{"version":1,"tools":{}}', 'utf8')

    const plan = await planMigration({ from, to, kind: 'tools' })
    expect(plan.copy.map((item) => item.name)).toEqual(['fetch_ledger'])
  })

  it('does nothing when the two folders are the same', async () => {
    await skill('deployment')
    expect((await planMigration({ from, to: from, kind: 'skills' })).copy).toEqual([])
  })

  it('does nothing when the source does not exist', async () => {
    const plan = await planMigration({ from: path.join(root, 'nope'), to, kind: 'skills' })
    expect(plan).toEqual({ copy: [], skip: [] })
  })

  it('plans without touching anything', async () => {
    // §15's rule for importing a config: the first sight of what a change does must not be the
    // change having happened.
    await skill('deployment')
    await planMigration({ from, to, kind: 'skills' })
    expect(await fs.readdir(to)).toEqual([])
  })
})

describe('running', () => {
  it('copies, and leaves the original exactly where it was', async () => {
    /*
     * A copy, never a move. A migration that went to the wrong place then costs nothing to undo,
     * which matters because the folder being left is the one with everything in it.
     */
    await skill('deployment')
    const result = await runMigration(await planMigration({ from, to, kind: 'skills' }))

    expect(result.copied).toEqual(['deployment'])
    expect(await fs.readdir(to)).toContain('deployment.md')
    expect(await fs.readdir(from)).toContain('deployment.md')
  })

  it('takes a folder skill whole, with its reference files', async () => {
    // A skill's folder carries its pictures and its templates (§13), and a skill that arrived
    // without them is one whose `use_skill_file` fails later, a long way from here.
    await fs.mkdir(path.join(from, 'invoicing'), { recursive: true })
    await fs.writeFile(path.join(from, 'invoicing', 'SKILL.md'), '---\nname: invoicing\n---\n', 'utf8')
    await fs.writeFile(path.join(from, 'invoicing', 'template.xlsx'), 'binary', 'utf8')

    await runMigration(await planMigration({ from, to, kind: 'skills' }))
    expect(await fs.readdir(path.join(to, 'invoicing'))).toEqual(
      expect.arrayContaining(['SKILL.md', 'template.xlsx']),
    )
  })

  it('refuses to overwrite even if the destination appeared after planning', async () => {
    /*
     * The second lock. Between planning and running, a bucket sync could have brought the same
     * name down - and losing it here would be a deletion nobody asked for or saw.
     */
    await skill('deployment', 'older')
    const plan = await planMigration({ from, to, kind: 'skills' })
    await fs.writeFile(path.join(to, 'deployment.md'), 'newer', 'utf8')

    const result = await runMigration(plan)
    expect(result.copied).toEqual([])
    expect(result.failed.map((each) => each.name)).toEqual(['deployment'])
    expect(await fs.readFile(path.join(to, 'deployment.md'), 'utf8')).toBe('newer')
  })

  it('one failure does not cost the others', async () => {
    // The rule `handleSyncS3` follows: a partial answer is useful and a blanket failure is not.
    await skill('alpha')
    await skill('beta')
    const plan = await planMigration({ from, to, kind: 'skills' })
    await fs.writeFile(path.join(to, 'alpha.md'), 'already', 'utf8')

    const result = await runMigration(plan)
    expect(result.copied).toEqual(['beta'])
    expect(result.failed).toHaveLength(1)
  })
})

describe('describeMigration', () => {
  it('names what it skipped, rather than only counting it', () => {
    const line = describeMigration(
      { copied: ['a'], skipped: ['b', 'c'], failed: [] },
      'skills',
    )
    expect(line).toContain('1 skill(s) copied')
    expect(line).toContain('b, c')
  })

  it('says why a failure failed', () => {
    const line = describeMigration(
      { copied: [], skipped: [], failed: [{ name: 'a', problem: 'EPERM' }] },
      'tools',
    )
    expect(line).toContain('a (EPERM)')
  })
})
