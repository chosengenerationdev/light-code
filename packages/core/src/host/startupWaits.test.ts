import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadSkills } from '../skills/index.js'

/**
 * Reported: "Getting this chat ready" showed Skills and Python tools for four and a half minutes, and the first reply
 * waited for them. The bar now names the folder being read, slow steps are logged, and a reply waits for these at
 * most a bounded time.
 */
const folders: string[] = []
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

describe('reading skills', () => {
  it('names each folder as it reads it, and how long it took', async () => {
    const a = await mkdtemp(path.join(os.tmpdir(), 'lc-skills-a-'))
    const b = await mkdtemp(path.join(os.tmpdir(), 'lc-skills-b-'))
    folders.push(a, b)
    await mkdir(a, { recursive: true })
    await writeFile(path.join(a, 'deploy.md'), '---\nname: deploy\ndescription: How we deploy\n---\nSteps.')
    const seen: { dir: string; took?: number }[] = []
    const loaded = await loadSkills([a, b], (dir, took) => seen.push(took === undefined ? { dir } : { dir, took }))
    expect(loaded.skills.map((skill) => skill.name)).toEqual(['deploy'])
    expect(seen.map((entry) => [path.resolve(entry.dir), entry.took === undefined])).toEqual([
      [path.resolve(a), true],
      [path.resolve(a), false],
      [path.resolve(b), true],
      [path.resolve(b), false],
    ])
  })
})

describe('the first reply', () => {
  const bridge = readFileSync(path.join(import.meta.dirname, 'bridge.ts'), 'utf8')
  it('waits for skills and tools only a bounded time', () => {
    expect(bridge).toContain("await boundedWait(skillsReady, 'Skills')")
    expect(bridge).toContain("await boundedWait(toolsReady, 'Tools', 45)")
    expect(bridge).not.toMatch(/\n\s+await skillsReady\n/)
    expect(bridge).not.toMatch(/\n\s+await toolsReady\n/)
  })
})
