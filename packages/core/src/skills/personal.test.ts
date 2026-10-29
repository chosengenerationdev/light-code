import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PathDenylist } from '../fs/denylist.js'
import { personalLibraryDir } from '../platform/node/sharedApprovals.js'
import { createCreatePythonTool, createDeletePythonTool, type PythonToolContext } from '../python/tools.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { createDeleteSkillTool, createWriteSkillTool } from './tools.js'

/*
 * "Only me" or "the team", chosen when a skill or tool is created (asked for: "an option to choose if he
 * wants to keep a skill for himself when it is created ... either s3 bucket or repo ... or for team").
 */

let root: string
let teamDir: string
let personalDir: string
const uploads: string[] = []

const execution = (): ToolExecutionContext => ({ workspaceRoot: root, denylist: new PathDenylist() }) as unknown as ToolExecutionContext

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lc-personal-'))
  teamDir = path.join(root, 'team-skills')
  personalDir = path.join(root, 'personal', 'skills')
  uploads.length = 0
})
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

const skillTools = (personal = true) => {
  const context = {
    skillsDir: teamDir,
    onChanged: async () => undefined,
    onSaved: async (name: string) => {
      uploads.push(name)
    },
    ...(personal ? { personalSkillsDir: personalDir, sharedWith: () => 'committed to the team repository TEAM/skills (main)' } : {}),
  }
  return { write: createWriteSkillTool(context), remove: createDeleteSkillTool(context) }
}

const skill = { name: 'deploy', description: 'How we deploy.', body: 'Steps.' }

describe('a skill kept to yourself', () => {
  it('goes to the personal folder, is never uploaded, and the prompt says so', async () => {
    const { write } = skillTools()
    const preview = await write.preview!({ ...skill, audience: 'me' }, execution())
    expect(preview).toMatchObject({ kind: 'diff', path: path.join(personalDir, 'deploy.md') })
    expect((preview as { note?: string }).note).toContain('only you')
    const result = await write.execute({ ...skill, audience: 'me' }, execution())
    expect(result.isError).not.toBe(true)
    expect(fs.existsSync(path.join(personalDir, 'deploy.md'))).toBe(true)
    expect(fs.existsSync(path.join(teamDir, 'deploy.md'))).toBe(false)
    expect(uploads).toEqual([])
  })

  it('for the team goes where the team shares, says where, and is published', async () => {
    const { write } = skillTools()
    const preview = await write.preview!({ ...skill, audience: 'team' }, execution())
    expect((preview as { note?: string }).note).toBe('For: the team - committed to the team repository TEAM/skills (main)')
    await write.execute({ ...skill, audience: 'team' }, execution())
    expect(fs.existsSync(path.join(teamDir, 'deploy.md'))).toBe(true)
    expect(uploads).toEqual(['deploy'])
  })

  it('stays personal when updated without saying who it is for, and can be deleted', async () => {
    const { write, remove } = skillTools()
    await write.execute({ ...skill, audience: 'me' }, execution())
    await write.execute({ ...skill, body: 'Steps, revised.' }, execution())
    expect(await fsp.readFile(path.join(personalDir, 'deploy.md'), 'utf8')).toContain('Steps, revised.')
    expect(fs.existsSync(path.join(teamDir, 'deploy.md'))).toBe(false)
    expect(uploads).toEqual([])
    await remove.execute({ name: 'deploy' }, execution())
    expect(fs.existsSync(path.join(personalDir, 'deploy.md'))).toBe(false)
  })

  it('is refused where there is no one person (a shared server), and nothing else changes there', async () => {
    const { write } = skillTools(false)
    const refused = await write.execute({ ...skill, audience: 'me' }, execution())
    expect(refused.isError).toBe(true)
    expect(refused.content).toContain('not available here')
    const preview = await write.preview!(skill, execution())
    expect((preview as { note?: string }).note).toBeUndefined()
  })
})

describe('a Python tool kept to yourself', () => {
  const toolContext = (findTool?: PythonToolContext['findTool']): PythonToolContext =>
    ({
      toolsDir: path.join(root, 'team-tools'),
      personalToolsDir: path.join(root, 'personal', 'tools'),
      sharedWith: () => 'uploaded to the S3 bucket team',
      worker: {} as never,
      onChanged: async () => undefined,
      ...(findTool !== undefined ? { findTool } : {}),
    }) as PythonToolContext

  it('is written into the personal folder and the approval prompt says it is only yours', async () => {
    const create = createCreatePythonTool(toolContext())
    const preview = await create.preview!({ name: 'report', audience: 'me', source: '"""Report."""\ndef run() -> int:\n    return 1\n' }, execution())
    expect(preview).toMatchObject({ kind: 'diff', path: path.join(root, 'personal', 'tools', 'report.py') })
    expect((preview as { note?: string }).note).toContain('only you')
    const team = await create.preview!({ name: 'report', audience: 'team', source: 'x' }, execution())
    expect((team as { note?: string }).note).toContain('uploaded to the S3 bucket team')
  })

  it('can be deleted from the personal folder, while a shared one still cannot', async () => {
    const personalTools = path.join(root, 'personal', 'tools')
    await fsp.mkdir(personalTools, { recursive: true })
    await fsp.writeFile(path.join(personalTools, 'report.py'), 'x')
    const remove = createDeletePythonTool(toolContext(() => ({ filePath: path.join(personalTools, 'report.py'), sourceDir: personalTools })))
    expect((await remove.execute({ name: 'report' }, execution())).isError).not.toBe(true)
    expect(fs.existsSync(path.join(personalTools, 'report.py'))).toBe(false)
    const shared = createDeletePythonTool(toolContext(() => ({ filePath: path.join(root, 'bucket', 'x.py'), sourceDir: path.join(root, 'bucket') })))
    expect((await shared.execute({ name: 'x' }, execution())).isError).toBe(true)
  })
})

describe('the personal folder', () => {
  it('is one per user, shared by the extension, the Node host and Fire Code - never on a shared server', () => {
    expect(personalLibraryDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a', 'win32')).toBe(
      path.join('C:\\Users\\a\\AppData\\Local', 'light-code', 'personal'),
    )
    const up = path.join(__dirname, '..', '..', '..', '..')
    expect(fs.readFileSync(path.join(up, 'apps', 'vscode', 'src', 'webview', 'hostServices.ts'), 'utf8')).toContain('personalDir: personalLibraryDir(),')
    expect(fs.readFileSync(path.join(up, 'apps', 'host', 'src', 'cli.ts'), 'utf8')).toContain('...(serverMode ? {} : { personalDir: personalLibraryDir() }),')
  })

  it('is never committed to the team repository nor sent to the team pool', () => {
    const bridge = fs.readFileSync(path.join(__dirname, '..', 'host', 'bridge.ts'), 'utf8')
    const sources = bridge.slice(bridge.indexOf('        local: {\n          skills: ['), bridge.indexOf('        local: {\n          skills: [') + 400)
    expect(sources).not.toContain('personal')
    expect(bridge).toContain('...skills.filter(isPersonalSkill).map((skill) => skill.name)])\n    const collection = skillsIndexName(config)')
  })
})
