import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWriteSkillTool } from '../skills/tools.js'

/**
 * A change to a skill somebody else owns is sent for review and **nothing is written**: until it is approved,
 * everybody - the person who made it included - uses the approved version (the user's rule, stated twice).
 */

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-owned-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("writing somebody else's skill", () => {
  it('sends the change to its owner, labelled against the approved text, and leaves the file alone', async () => {
    const approved = '---\nname: deploy\ndescription: How we deploy\nauthor: alice\nversion: 3\n---\nStep one.\n'
    await fs.writeFile(path.join(dir, 'deploy.md'), approved)
    const submitted: { content: string; existingContent: string; owner: string }[] = []
    const saved: string[] = []
    const tool = createWriteSkillTool({
      skillsDir: dir,
      onChanged: async () => {},
      attribution: () => ({ author: 'bob', project: 'Payments' }),
      teamReview: {
        needed: async () => ({ owner: 'alice', existing: approved }),
        submit: async (request) => {
          submitted.push(request)
          return `sent to ${request.owner}`
        },
        saved: async (name) => {
          saved.push(name)
        },
      },
    })
    const params = { name: 'deploy', description: 'How we deploy', body: 'Step one, then two.' }
    const preview = await tool.preview?.(params, {} as never)
    expect(preview).toMatchObject({ kind: 'diff', before: approved })
    expect((preview as { note?: string }).note).toContain('Owned by alice')

    const result = await tool.execute(params, {} as never)
    expect(result.content).toBe('sent to alice')
    expect(await fs.readFile(path.join(dir, 'deploy.md'), 'utf8')).toBe(approved)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]!.existingContent).toBe(approved)
    expect(submitted[0]!.content).toContain('Step one, then two.')
    expect(submitted[0]!.content).toMatch(/version: 4/)
    expect(saved).toEqual([])
  })

  it('writes as before when nobody else owns it, and records the writer as owner', async () => {
    const saved: string[] = []
    const tool = createWriteSkillTool({
      skillsDir: dir,
      onChanged: async () => {},
      teamReview: {
        needed: async () => undefined,
        submit: async () => 'never',
        saved: async (name) => {
          saved.push(name)
        },
      },
    })
    await tool.execute({ name: 'mine', description: 'Mine', body: 'Text.' }, {} as never)
    expect(await fs.readFile(path.join(dir, 'mine.md'), 'utf8')).toContain('Text.')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(saved).toEqual(['mine'])
  })
})
