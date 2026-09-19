import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PathDenylist } from '../fs/denylist.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { createWriteSkillTool } from './tools.js'

import {
  appendSkillImages,
  renderSkillImage,
  skillImageName,
  skillImageType,
  SKILL_IMAGE_DIR,
} from './images.js'

/**
 * Pictures in a skill, and how they come to be findable.
 *
 * Asked for with a specific use in mind: a screenshot of a form field, with what goes in it, kept
 * so the assistant can use it later. Which settles the indexing question too — the words about the
 * picture are what anyone would search for, and they are worth as much to a person reading the
 * skill as to the index.
 *
 * So there is no image embedding and no second vector space. The description is **written into the
 * skill's own markdown**, where the existing text index picks it up for free.
 */

describe('what a description is for', () => {
  it('is written beside the picture as ordinary prose', () => {
    const rendered = renderSkillImage({
      name: 'invoice-field.png',
      alt: 'The invoice number field',
      description: 'The invoice number box on the claims form. Takes the eight digits, no prefix.',
    })

    expect(rendered).toContain(`![The invoice number field](${SKILL_IMAGE_DIR}/invoice-field.png)`)
    expect(rendered).toContain('eight digits, no prefix')
  })

  /*
   * Prose rather than an attribute or a comment, because that is what makes it do three jobs: it
   * is indexed, it is read by a person, and it is what a model sees when the skill loads as text.
   */
  it('is plain text, so the existing index embeds it with the rest', () => {
    const rendered = renderSkillImage({
      name: 'a.png',
      alt: 'A',
      description: 'A screenshot of the approvals queue.',
    })
    expect(rendered).not.toContain('<!--')
    expect(rendered.split('\n').at(-1)).toBe('A screenshot of the approvals queue.')
  })

  it('renders just the picture when there is nothing to say about it', () => {
    expect(renderSkillImage({ name: 'a.png', alt: 'A' })).toBe(`![A](${SKILL_IMAGE_DIR}/a.png)`)
  })
})

describe('placing pictures in a body', () => {
  it('appends the ones the body did not mention', () => {
    const body = appendSkillImages('How the claim is filed.', [{ name: 'form.png', alt: 'The form' }])
    expect(body).toContain('## Images')
    expect(body).toContain(`${SKILL_IMAGE_DIR}/form.png`)
  })

  /* A model that placed a picture itself has said where it wants it. */
  it('leaves a body that already references it alone', () => {
    const body = `See ![it](${SKILL_IMAGE_DIR}/form.png) for the layout.`
    expect(appendSkillImages(body, [{ name: 'form.png', alt: 'The form' }])).toBe(body)
  })

  it('appends only the ones that are missing', () => {
    const body = `![a](${SKILL_IMAGE_DIR}/a.png)`
    const out = appendSkillImages(body, [
      { name: 'a.png', alt: 'a' },
      { name: 'b.png', alt: 'b' },
    ])
    expect(out.split(`${SKILL_IMAGE_DIR}/a.png`).length - 1).toBe(1)
    expect(out).toContain(`${SKILL_IMAGE_DIR}/b.png`)
  })

  it('changes nothing when there are no pictures', () => {
    expect(appendSkillImages('Just prose.', [])).toBe('Just prose.')
  })
})

/**
 * The name is model-chosen, so it is reduced to one safe segment — a separator in it would write
 * outside the skill's own folder, which is the rule every other path here follows.
 */
describe('naming a picture inside the skill', () => {
  it('takes the source file name by default', () => {
    expect(skillImageName({ source: 'screens/Invoice Field.PNG', alt: 'x' })).toBe('invoice-field.png')
  })

  it('never lets a name escape the folder', () => {
    const name = skillImageName({ source: 'a.png', name: '../../evil.png', alt: 'x' })
    expect(name.includes('/')).toBe(false)
    expect(name.includes('\\')).toBe(false)
    expect(name).not.toBe('..')
  })

  /*
   * `path.extname('.png')` is empty — a leading dot is a dotfile — so this used to produce a file
   * called `png`, with no type, which the copy then refused as "not an image". The type comes
   * from the source when the proposed name has none.
   */
  it('takes the type from the source when the given name has none', () => {
    expect(skillImageName({ source: 'shot.png', name: '///.png', alt: 'x' })).toBe('image.png')
  })

  it('still refuses a picture that has no usable type anywhere', () => {
    expect(skillImageType(skillImageName({ source: 'notes', name: 'notes', alt: 'x' }))).toBeUndefined()
  })
})

describe('which files a skill may carry', () => {
  it('accepts the ordinary picture formats', () => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg']) {
      expect(skillImageType(name), name).toBeDefined()
    }
  })

  /* Not an asset library: a skill is a page of prose with illustrations in it. */
  it('refuses anything that is not one', () => {
    for (const name of ['a.pdf', 'a.exe', 'a.zip', 'a.mp4', 'a']) {
      expect(skillImageType(name), name).toBeUndefined()
    }
  })

  it('is not fooled by case', () => {
    expect(skillImageType('A.PNG')).toBe('image/png')
  })
})

/**
 * The copy itself, against a real filesystem.
 *
 * Every test above this point is about strings, and the whole of the copying path had none — so
 * the first skill ever written with pictures failed, with a containment error naming two paths one
 * of which was plainly inside the other. `confine` realpaths its root, and the skill's own folder
 * did not exist yet. A unit test of a name could not have seen it.
 */
describe('copying pictures in', () => {
  let root: string
  let skillsDir: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-skillimg-'))
    skillsDir = path.join(root, '.lightcode', 'skills')
    await fs.mkdir(skillsDir, { recursive: true })
    await fs.writeFile(path.join(root, 'flow.png'), 'not-really-a-png')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('works for the first skill in a folder that has no skill folders yet', async () => {
    const result = await createWriteSkillTool({
      skillsDir,
      onChanged: async () => undefined,
    }).execute(
      {
        name: 'deployment',
        description: 'How we deploy.',
        body: 'Look at the diagram.',
        images: [{ source: 'flow.png', alt: 'the flow', description: 'Release stages.' }],
      },
      { workspaceRoot: root, denylist: new PathDenylist() } as unknown as ToolExecutionContext,
    )

    if (result.isError === true) throw new Error(result.content)
    expect(
      await fs.readFile(path.join(skillsDir, 'deployment', SKILL_IMAGE_DIR, 'flow.png'), 'utf8'),
    ).toBe('not-really-a-png')
  })
})
