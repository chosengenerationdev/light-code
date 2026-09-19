import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PathDenylist } from '../fs/denylist.js'
import type { ToolExecutionContext } from '../tools/types.js'
import {
  appendSkillFiles,
  listSkillFiles,
  renderSkillFiles,
  skillFileAssetName,
  skillFilesDir,
} from './files.js'
import { loadSkills } from './index.js'
import { createDeleteSkillTool, createUseSkillFileTool, createWriteSkillTool } from './tools.js'

describe('skill reference file names', () => {
  it('takes the extension from the source when the given name has none', () => {
    expect(skillFileAssetName({ source: 'a/returns.xlsx', name: 'template', description: 'x' })).toBe(
      'template.xlsx',
    )
  })

  it('reduces a path to one segment, so a name cannot write outside the skill', () => {
    expect(
      skillFileAssetName({ source: 'x.xlsx', name: '../../evil.xlsx', description: 'x' }),
    ).toBe('evil.xlsx')
  })

  it('keeps the extension as given rather than lowercasing it', () => {
    // Mangling the case is how a `.XLSX` stops being recognised by something matching on it.
    expect(skillFileAssetName({ source: 'Book.XLSX', description: 'x' })).toBe('Book.XLSX')
  })

  it('never produces an empty name', () => {
    expect(skillFileAssetName({ source: '---', description: 'x' })).toBe('file')
  })
})

describe('the reference file block', () => {
  const files = [{ name: 'returns.xlsx', description: 'Monthly returns template.' }]

  it('tells the reader how to obtain a file, not just that it exists', () => {
    // The model that has found the skill has found this text. Leaving the instruction to the tool
    // description is what produces a `read_file` on a workbook and a report that it is corrupt.
    const rendered = renderSkillFiles('reporting', files)
    expect(rendered).toContain('use_skill_file')
    expect(rendered).toContain('"reporting"')
    expect(rendered).toContain('returns.xlsx')
    expect(rendered).toContain('Monthly returns template.')
  })

  it('does not append a second block when the body already has one', () => {
    const body = ['Do the thing.', '', '## Reference files', '', '- see below'].join('\n')
    expect(appendSkillFiles(body, 'reporting', files)).toBe(body)
  })

  it('appends even when the body mentions the file by name in prose', () => {
    // Matched on the heading, not the name: "fill in returns.xlsx" is a sentence, not a listing,
    // and treating it as one would drop the line saying how to obtain the file.
    const appended = appendSkillFiles('Fill in returns.xlsx and send it.', 'reporting', files)
    expect(appended).toContain('## Reference files')
  })

  it('leaves a body alone when there are no files', () => {
    expect(appendSkillFiles('Just prose.', 'reporting', [])).toBe('Just prose.')
  })
})

describe('where files live', () => {
  it('is inside a folder skill', () => {
    expect(skillFilesDir(path.join('/s', 'reporting', 'SKILL.md'))).toBe(
      path.join('/s', 'reporting', 'files'),
    )
  })

  it('is nowhere for a flat skill, because there is nowhere to put them', () => {
    expect(skillFilesDir(path.join('/s', 'reporting.md'))).toBeUndefined()
  })
})

describe('write_skill with reference files, against a real filesystem', () => {
  let root: string
  let skillsDir: string

  const context = (): ToolExecutionContext =>
    ({
      workspaceRoot: root,
      denylist: new PathDenylist(),
    }) as unknown as ToolExecutionContext

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-skillfiles-'))
    skillsDir = path.join(root, '.lightcode', 'skills')
    await fs.mkdir(skillsDir, { recursive: true })
    await fs.writeFile(path.join(root, 'returns.xlsx'), 'PK-not-really-a-zip')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  const write = () =>
    createWriteSkillTool({ skillsDir, onChanged: async () => undefined }).execute(
      {
        name: 'reporting',
        description: 'How monthly returns are produced.',
        body: 'Fill the template in and send it.',
        files: [
          { source: 'returns.xlsx', name: 'template.xlsx', description: 'The returns template.' },
        ],
      },
      context(),
    )

  it('copies the file in and converts the skill to the folder layout', async () => {
    const result = await write()
    if (result.isError === true) throw new Error(result.content)
    expect(result.isError).not.toBe(true)

    const stored = path.join(skillsDir, 'reporting', 'files', 'template.xlsx')
    expect(await fs.readFile(stored, 'utf8')).toBe('PK-not-really-a-zip')
    // A flat file beside the folder would load under the same name and shadow it.
    await expect(fs.stat(path.join(skillsDir, 'reporting.md'))).rejects.toThrow()
  })

  it('writes the description into the skill body, which is the only thing indexed', async () => {
    await write()
    const body = await fs.readFile(path.join(skillsDir, 'reporting', 'SKILL.md'), 'utf8')
    expect(body).toContain('The returns template.')
    expect(body).toContain('template.xlsx')
  })

  it('never puts the file contents into the skill text', async () => {
    // The whole reason these are copied rather than read: the bytes must not reach the corpus,
    // the prompt, or a team alias. The skill markdown is what gets embedded.
    await write()
    const body = await fs.readFile(path.join(skillsDir, 'reporting', 'SKILL.md'), 'utf8')
    expect(body).not.toContain('PK-not-really-a-zip')
  })

  it('is still a loadable skill afterwards', async () => {
    await write()
    const loaded = await loadSkills([skillsDir])
    expect(loaded.skills.map((skill) => skill.name)).toEqual(['reporting'])
    expect(loaded.issues).toEqual([])
  })

  it('lists its files from the folder', async () => {
    await write()
    const names = await listSkillFiles(path.join(skillsDir, 'reporting', 'SKILL.md'), {
      readdir: async (dir) =>
        (await fs.readdir(dir, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        })),
    })
    expect(names).toEqual(['template.xlsx'])
  })

  it('refuses a source outside the workspace, like every other path a model supplies', async () => {
    const result = await createWriteSkillTool({
      skillsDir,
      onChanged: async () => undefined,
    }).execute(
      {
        name: 'reporting',
        description: 'x',
        body: 'x',
        files: [{ source: path.join('..', '..', 'secret.xlsx'), description: 'x' }],
      },
      context(),
    )
    expect(result.isError).toBe(true)
  })

  describe('use_skill_file', () => {
    const tool = () =>
      createUseSkillFileTool({
        skillsDir,
        onChanged: async () => undefined,
        listSkills: () => [
          { name: 'reporting', filePath: path.join(skillsDir, 'reporting', 'SKILL.md') },
        ],
      })

    it('copies into the workspace and leaves the original untouched', async () => {
      await write()
      const result = await tool().execute(
        { skill: 'reporting', file: 'template.xlsx', destination: 'out/march.xlsx' },
        context(),
      )

      expect(result.isError).not.toBe(true)
      expect(await fs.readFile(path.join(root, 'out', 'march.xlsx'), 'utf8')).toBe(
        'PK-not-really-a-zip',
      )
      // Filling in the original would destroy the template for everyone who shares the folder.
      expect(
        await fs.readFile(path.join(skillsDir, 'reporting', 'files', 'template.xlsx'), 'utf8'),
      ).toBe('PK-not-really-a-zip')
    })

    it('returns a path, never the contents', async () => {
      await write()
      const result = await tool().execute(
        { skill: 'reporting', file: 'template.xlsx' },
        context(),
      )
      expect(result.content).not.toContain('PK-not-really-a-zip')
      expect(result.path).toBe(path.join(root, 'template.xlsx'))
    })

    it('names the files it does have when asked for one it does not', async () => {
      await write()
      const result = await tool().execute(
        { skill: 'reporting', file: 'nope.xlsx' },
        context(),
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('template.xlsx')
    })

    it('cannot be talked out of the skill folder with a traversing file name', async () => {
      await write()
      const result = await tool().execute(
        { skill: 'reporting', file: '../SKILL.md' },
        context(),
      )
      // Reduced to one segment, so this asks for a file called `SKILL.md` inside `files/`.
      expect(result.isError).toBe(true)
    })

    it('writes only inside the workspace, whatever destination is asked for', async () => {
      await write()
      const result = await tool().execute(
        { skill: 'reporting', file: 'template.xlsx', destination: '../escaped.xlsx' },
        context(),
      )
      expect(result.isError).toBe(true)
    })

    it('is an edit, so it goes through the approval gate and behind a checkpoint', () => {
      expect(tool().group).toBe('edit')
    })

    it('warns in the preview when it would replace an existing file', async () => {
      await write()
      await fs.writeFile(path.join(root, 'march.xlsx'), 'mine')
      const preview = await tool().preview?.(
        { skill: 'reporting', file: 'template.xlsx', destination: 'march.xlsx' },
        context(),
      )
      expect(preview?.kind).toBe('text')
      expect(preview?.kind === 'text' ? preview.text : '').toContain('already exists')
    })
  })

  it('delete_skill removes the folder, not just the text', async () => {
    // Removing only SKILL.md left megabytes of templates behind, invisible because nothing loads
    // them without a skill.
    await write()
    await createDeleteSkillTool({ skillsDir, onChanged: async () => undefined }).execute(
      { name: 'reporting' },
      context(),
    )
    await expect(fs.stat(path.join(skillsDir, 'reporting'))).rejects.toThrow()
  })
})
