import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../agent/systemPrompt.js'
import { isValidSkillName, loadSkills, parseFrontmatter, renderSkill, renderSkillsForPrompt } from './index.js'

describe('parseFrontmatter', () => {
  it('reads name and description', () => {
    const parsed = parseFrontmatter('---\nname: http-client\ndescription: Our internal HTTP wrapper.\n---\n\nBody here.\n')
    expect(parsed.name).toBe('http-client')
    expect(parsed.description).toBe('Our internal HTTP wrapper.')
    expect(parsed.body.trim()).toBe('Body here.')
  })

  /** `name: "thing"` and `name: thing` look identical in the UI and must behave identically. */
  it('strips quotes so the two ways of writing a value agree', () => {
    expect(parseFrontmatter('---\nname: "quoted"\n---\n').name).toBe('quoted')
    expect(parseFrontmatter("---\nname: 'quoted'\n---\n").name).toBe('quoted')
  })

  it('handles CRLF, which is what a Windows checkout produces', () => {
    const parsed = parseFrontmatter('---\r\nname: a\r\ndescription: b\r\n---\r\n\r\nBody\r\n')
    expect(parsed).toMatchObject({ name: 'a', description: 'b' })
  })

  it('treats a file with no frontmatter as all body', () => {
    const parsed = parseFrontmatter('Just notes.\n')
    expect(parsed.name).toBeUndefined()
    expect(parsed.body).toBe('Just notes.\n')
  })
})

describe('renderSkill', () => {
  it('round-trips through the parser', () => {
    const rendered = renderSkill('my-skill', 'What it covers.', 'The body.\n')
    expect(parseFrontmatter(rendered)).toMatchObject({ name: 'my-skill', description: 'What it covers.' })
  })

  /**
   * A newline inside the description would close the frontmatter early and silently truncate
   * the skill's metadata — the file would still parse, just wrongly.
   */
  it('flattens a multi-line description rather than breaking the block', () => {
    const rendered = renderSkill('s', 'First line\nsecond line', 'body')
    expect(parseFrontmatter(rendered).description).toBe('First line second line')
    expect(parseFrontmatter(rendered).body.trim()).toBe('body')
  })
})

describe('isValidSkillName', () => {
  it('accepts kebab-case and rejects anything that could escape the directory', () => {
    expect(isValidSkillName('internal-http-client')).toBe(true)
    for (const name of ['../evil', 'has space', 'Upper', 'under_score', '', 'a'.repeat(70)]) {
      expect(isValidSkillName(name)).toBe(false)
    }
  })
})

describe('loadSkills', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-skills-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const write = (file: string, content: string): Promise<void> => fs.writeFile(path.join(dir, file), content, 'utf8')

  it('loads a well-formed skill', async () => {
    await write('a.md', renderSkill('a', 'About A.', 'Body A'))
    const loaded = await loadSkills(dir)
    expect(loaded.skills).toHaveLength(1)
    expect(loaded.skills[0]).toMatchObject({ name: 'a', description: 'About A.' })
  })

  /**
   * Without a description the model has nothing to decide on, so the skill would sit in the
   * prompt costing tokens forever and never be read. Reported rather than silently dropped.
   */
  it('refuses a skill with no description, and says why', async () => {
    await write('b.md', '---\nname: b\n---\n\nBody')
    const loaded = await loadSkills(dir)
    expect(loaded.skills).toEqual([])
    expect(loaded.issues[0]?.detail).toMatch(/description/)
  })

  it('falls back to the filename when frontmatter omits the name', async () => {
    await write('from-filename.md', '---\ndescription: Has one.\n---\n\nBody')
    expect((await loadSkills(dir)).skills[0]?.name).toBe('from-filename')
  })

  it('ignores non-markdown files', async () => {
    await write('notes.txt', 'not a skill')
    expect((await loadSkills(dir)).skills).toEqual([])
  })

  /** Order must be stable, or the prompt prefix changes between turns for no reason (§12). */
  it('returns skills in a deterministic order', async () => {
    await write('z.md', renderSkill('z', 'Z.', ''))
    await write('a.md', renderSkill('a', 'A.', ''))
    expect((await loadSkills(dir)).skills.map((skill) => skill.name)).toEqual(['a', 'z'])
  })

  it('returns nothing when the directory does not exist', async () => {
    expect(await loadSkills(path.join(dir, 'missing'))).toEqual({ skills: [], issues: [] })
  })
})

describe('renderSkillsForPrompt', () => {
  const skills = [
    { name: 'http', description: 'Our internal HTTP wrapper.', filePath: '/w/.lightcode/skills/http.md' },
  ]

  /**
   * Only summaries. A body in the prompt would cost its full length on every request, which
   * is precisely what reading on demand exists to avoid (§13).
   */
  it('includes the name, description and path, and tells the model to read the file', () => {
    const rendered = renderSkillsForPrompt(skills)
    expect(rendered).toContain('http: Our internal HTTP wrapper.')
    expect(rendered).toContain('/w/.lightcode/skills/http.md')
    expect(rendered).toMatch(/read its file/i)
  })

  it('is empty when there are none, so the prompt gains no dead section', () => {
    expect(renderSkillsForPrompt([])).toBe('')
  })
})

describe('the system prompt with skills', () => {
  /**
   * Skills sit at the very front of the prompt, so anything unstable here invalidates the
   * cache prefix *and every message after it*. Same input must give the same bytes.
   */
  it('is byte-identical for the same skills', () => {
    const options = { model: 'm', skills: renderSkillsForPrompt([{ name: 'a', description: 'A.', filePath: '/a.md' }]) }
    expect(buildSystemPrompt('/w', options)).toBe(buildSystemPrompt('/w', options))
  })

  it('gains the recording guidance only when writing is possible', () => {
    expect(buildSystemPrompt('/w', { canWriteSkills: true })).toMatch(/offer to record it with write_skill/)
    expect(buildSystemPrompt('/w', {})).not.toMatch(/write_skill/)
  })

  /** The behaviour the user actually asked for: teach it once, it offers to keep the note. */
  it('tells the model to ask first, and to update rather than duplicate', () => {
    const prompt = buildSystemPrompt('/w', { canWriteSkills: true })
    expect(prompt).toMatch(/Ask first/)
    expect(prompt).toMatch(/update that instead of creating a near-duplicate/)
    expect(prompt).toMatch(/stale skill is worse than a missing one/)
  })
})

describe('loadSkills across several folders', () => {
  let primary: string
  let shared: string

  beforeEach(async () => {
    primary = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-skills-primary-'))
    shared = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-skills-shared-'))
  })
  afterEach(async () => {
    await fs.rm(primary, { recursive: true, force: true })
    await fs.rm(shared, { recursive: true, force: true })
  })

  const put = (dir: string, file: string, content: string): Promise<void> =>
    fs.writeFile(path.join(dir, file), content, 'utf8')

  it('merges every folder and records where each skill came from', async () => {
    await put(primary, 'mine.md', renderSkill('mine', 'Personal note.', 'Body'))
    await put(shared, 'team.md', renderSkill('team', 'Team note.', 'Body'))

    const loaded = await loadSkills([primary, shared])

    expect(loaded.skills.map((skill) => skill.name)).toEqual(['mine', 'team'])
    expect(loaded.skills.find((skill) => skill.name === 'team')?.sourceDir).toBe(shared)
  })

  /**
   * The list is a search path, like `PATH`. Your own folder is first, so a personal skill
   * overrides a shared one of the same name — the only direction that lets someone correct a
   * shared note locally without editing everyone's copy.
   */
  it('lets an earlier folder win a name collision', async () => {
    await put(primary, 'deploy.md', renderSkill('deploy', 'Mine wins.', 'Body'))
    await put(shared, 'deploy.md', renderSkill('deploy', 'Shared loses.', 'Body'))

    const loaded = await loadSkills([primary, shared])

    expect(loaded.skills).toHaveLength(1)
    expect(loaded.skills[0]?.description).toBe('Mine wins.')
  })

  /** Two folders quietly disagreeing is impossible to diagnose from the outside. */
  it('reports the shadowed one rather than dropping it silently', async () => {
    await put(primary, 'deploy.md', renderSkill('deploy', 'Mine.', 'Body'))
    await put(shared, 'deploy.md', renderSkill('deploy', 'Theirs.', 'Body'))

    const loaded = await loadSkills([primary, shared])

    expect(loaded.issues).toHaveLength(1)
    expect(loaded.issues[0]?.detail).toMatch(/shadowed/i)
    expect(loaded.issues[0]?.detail).toContain(primary)
  })

  /**
   * Easy to configure by accident when one entry is relative and another absolute. Without
   * collapsing, every skill in that folder would shadow itself and report a false conflict.
   */
  it('collapses a folder listed twice', async () => {
    await put(primary, 'a.md', renderSkill('a', 'About A.', 'Body'))

    const loaded = await loadSkills([primary, primary, path.join(primary, '.')])

    expect(loaded.skills).toHaveLength(1)
    expect(loaded.issues).toHaveLength(0)
  })

  /** A shared folder may be on a drive that is not mounted; that is not an error. */
  it('ignores a folder that does not exist', async () => {
    await put(primary, 'a.md', renderSkill('a', 'About A.', 'Body'))

    const loaded = await loadSkills([primary, path.join(shared, 'nope')])

    expect(loaded.skills).toHaveLength(1)
    expect(loaded.issues).toHaveLength(0)
  })

  /** Prompt order must not depend on folder arrangement — it sits in the cached prefix (§12). */
  it('sorts by name regardless of which folder supplied it', async () => {
    await put(primary, 'zebra.md', renderSkill('zebra', 'Z.', 'Body'))
    await put(shared, 'alpha.md', renderSkill('alpha', 'A.', 'Body'))

    const loaded = await loadSkills([primary, shared])
    expect(loaded.skills.map((skill) => skill.name)).toEqual(['alpha', 'zebra'])
  })

  it('still accepts a single folder as a plain string', async () => {
    await put(primary, 'a.md', renderSkill('a', 'About A.', 'Body'))
    expect((await loadSkills(primary)).skills).toHaveLength(1)
  })
})

/**
 * The layout Claude and Claude Code use.
 *
 * Reported as "I don't see the existing skills listed in skills tab": a folder of skills
 * copied from there is entirely invisible if only top-level `.md` files are read, and there is
 * no error to notice — the tab simply shows nothing, which reads as the feature being broken.
 */
describe('a skill kept as a folder with SKILL.md inside', () => {
  it('is loaded, and takes its name from the folder', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-skills-'))
    await fs.mkdir(path.join(dir, 'invoice-format'))
    await fs.writeFile(
      path.join(dir, 'invoice-format', 'SKILL.md'),
      '---\ndescription: How our invoices are numbered\n---\n\nBody.\n',
      'utf8',
    )

    const { skills } = await loadSkills(dir)
    expect(skills.map((skill) => skill.name)).toEqual(['invoice-format'])
    expect(skills[0]?.filePath).toContain('SKILL.md')
  })

  it('is found whatever the case of the filename', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-skills-'))
    await fs.mkdir(path.join(dir, 'deploys'))
    await fs.writeFile(path.join(dir, 'deploys', 'skill.md'), '---\ndescription: How we deploy\n---\n', 'utf8')

    expect((await loadSkills(dir)).skills.map((skill) => skill.name)).toEqual(['deploys'])
  })

  it('lets frontmatter name override the folder, as it does for a file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-skills-'))
    await fs.mkdir(path.join(dir, 'some-folder'))
    await fs.writeFile(
      path.join(dir, 'some-folder', 'SKILL.md'),
      '---\nname: real-name\ndescription: Named in frontmatter\n---\n',
      'utf8',
    )

    expect((await loadSkills(dir)).skills.map((skill) => skill.name)).toEqual(['real-name'])
  })

  it('ignores a folder that holds no skill file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-skills-'))
    await fs.mkdir(path.join(dir, 'assets'))
    await fs.writeFile(path.join(dir, 'assets', 'notes.md'), '# not a skill\n', 'utf8')
    await fs.writeFile(path.join(dir, 'real.md'), '---\ndescription: A flat one\n---\n', 'utf8')

    const { skills, issues } = await loadSkills(dir)
    expect(skills.map((skill) => skill.name)).toEqual(['real'])
    expect(issues).toEqual([])
  })
})
