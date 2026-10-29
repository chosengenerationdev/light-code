import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildSystemPrompt } from '../agent/systemPrompt.js'
import { PathDenylist } from '../fs/denylist.js'
import { NodeFileSystem } from '../platform/node/filesystem.js'
import { readFileTool } from '../tools/readFile.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { cleanSkillDefaults, findPlaceholders, renderSkillDefaults, skillDefaultsReadNote } from './defaults.js'

describe('finding placeholders', () => {
  it('takes {{name}} and <NAME>, in order, once each', () => {
    const text = 'Deploy to {{ environment }} for <TEAM_NAME>. Then tell {{owner}} and {{environment}} again.'
    expect(findPlaceholders(text)).toEqual(['environment', 'TEAM_NAME', 'owner'])
  })

  it('leaves HTML, generics and shell variables alone', () => {
    expect(findPlaceholders('<div>List<string> and ${HOME} and <b>x</b></div>')).toEqual([])
  })
})

describe('what is kept', () => {
  it('drops empty boxes and trims', () => {
    expect(cleanSkillDefaults({ ' env ': ' prod ', team: '  ', '': 'x' })).toEqual({ env: 'prod' })
  })
})

describe('what the model is told', () => {
  it('lists only skills that exist and have defaults, and says not to ask', () => {
    const section = renderSkillDefaults({ deploy: { env: 'prod' }, gone: { a: 'b' }, empty: {} }, ['deploy', 'empty'])
    expect(section).toContain('## Skill defaults')
    expect(section).toContain('- deploy:')
    expect(section).toContain('env = prod')
    expect(section).toContain('do not stop to ask')
    expect(section).not.toContain('gone')
    expect(renderSkillDefaults(undefined, ['deploy'])).toBe('')
  })

  it('reaches the prompt beside the skills', () => {
    const prompt = buildSystemPrompt('D:/w', { skills: renderSkillDefaults({ deploy: { env: 'prod' } }, ['deploy']) })
    expect(prompt).toContain('env = prod')
  })

  it('comes back with the skill when read_file reads it', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lc-skill-defaults-')))
    try {
      await fs.writeFile(path.join(root, 'deploy.md'), 'Ask for {{env}}.')
      await fs.writeFile(path.join(root, 'other.md'), 'Nothing here.')
      const context = {
        workspaceRoot: root,
        denylist: new PathDenylist(),
        readFiles: new Set<string>(),
        fs: new NodeFileSystem(),
        annotateRead: (realPath: string) =>
          path.basename(realPath) === 'deploy.md' ? skillDefaultsReadNote('deploy', { env: 'prod' }) : undefined,
      } as unknown as ToolExecutionContext
      const skill = await readFileTool.execute({ path: 'deploy.md' }, context)
      expect(skill.content).toContain('Ask for {{env}}.')
      expect(skill.content).toContain('env = prod')
      const other = await readFileTool.execute({ path: 'other.md' }, context)
      expect(other.content).not.toContain('Defaults the user set')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
    expect(skillDefaultsReadNote('deploy', {})).toBeUndefined()
  })
})
