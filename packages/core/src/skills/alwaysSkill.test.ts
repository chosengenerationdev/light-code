import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadSkills, parseFrontmatter, renderAlwaysSkills, renderSkillsForPrompt } from './index.js'

/**
 * Requested as "a master skill, which should be available in all sessions, so that agent will be
 * able to remember and follow it in every session".
 *
 * The ordinary mechanism deliberately keeps bodies out of the prompt — right for forty skills,
 * wrong for the one that says how a team works, which has to be present *before* the model
 * decides anything rather than found once it suspects it needs help.
 */
const dir = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'lc-always-'))

describe('a skill marked always', () => {
  it('is read from the frontmatter', () => {
    expect(parseFrontmatter('---\nname: house\ndescription: d\nalways: true\n---\n\nBody.').always).toBe(true)
  })

  /** Anything but an explicit true leaves it ordinary — the safe direction for a per-request cost. */
  it('is not switched on by a typo or by false', () => {
    expect(parseFrontmatter('---\ndescription: d\nalways: false\n---\n').always).toBeUndefined()
    expect(parseFrontmatter('---\ndescription: d\nalways: yes\n---\n').always).toBeUndefined()
    expect(parseFrontmatter('---\ndescription: d\n---\n').always).toBeUndefined()
  })

  it('carries its whole body, since that is what goes into the prompt', async () => {
    const folder = await dir()
    await fs.writeFile(
      path.join(folder, 'house-style.md'),
      '---\ndescription: How we work\nalways: true\n---\n\nAlways run the tests before saying done.\n',
      'utf8',
    )

    const { skills } = await loadSkills(folder)
    expect(skills[0]?.always).toBe(true)
    expect(skills[0]?.body).toContain('Always run the tests')
  })

  it('is rendered in full, above the summaries of the others', async () => {
    const folder = await dir()
    await fs.writeFile(path.join(folder, 'house.md'), '---\ndescription: d\nalways: true\n---\n\nRule one.\n', 'utf8')
    await fs.writeFile(path.join(folder, 'other.md'), '---\ndescription: Something else\n---\n\nBody.\n', 'utf8')

    const { skills } = await loadSkills(folder)
    const rendered = renderSkillsForPrompt(skills)

    expect(rendered).toContain('Standing instructions')
    expect(rendered).toContain('Rule one.')
    expect(rendered.indexOf('Standing instructions')).toBeLessThan(rendered.indexOf('## Skills'))
    // The ordinary one is still a summary, not a body.
    expect(rendered).toContain('other: Something else')
    expect(rendered).not.toContain('Body.')
  })

  it('does not appear twice — once as an instruction and again in the catalogue', async () => {
    const folder = await dir()
    await fs.writeFile(path.join(folder, 'house.md'), '---\ndescription: d\nalways: true\n---\n\nRule one.\n', 'utf8')

    const { skills } = await loadSkills(folder)
    const rendered = renderSkillsForPrompt(skills)
    expect(rendered).not.toContain('## Skills')
  })

  it('renders nothing when no skill asks for it', () => {
    expect(renderAlwaysSkills([{ name: 'a', description: 'd', filePath: '/a.md' }])).toBe('')
  })
})
