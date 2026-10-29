import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CODEBASE_INSTRUCTIONS_LIMIT,
  codebaseInstructionsPath,
  readCodebaseInstructions,
  renderCodebaseInstructions,
  writeCodebaseInstructions,
} from './codebaseInstructions.js'
import { buildSystemPrompt } from './systemPrompt.js'
import { renderAlwaysSkills } from '../skills/index.js'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-instr-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('where codebase instructions live', () => {
  it('in the codebase folder Fire Code gives every chat, in a folder of their own', () => {
    expect(codebaseInstructionsPath({ codebaseDir: 'D:/fc/projects/p1/codebase', storageDir: 'S', workspaceRoot: 'D:/work' })).toBe(
      path.join('D:/fc/projects/p1/codebase', 'instructions', 'codebase-instructions.md'),
    )
  })

  it('elsewhere, per workspace under the shared storage folder - one folder spelled two ways is one codebase', () => {
    const a = codebaseInstructionsPath({ storageDir: 'S', workspaceRoot: path.resolve('/work/Payments') })
    expect(a).toContain(path.join('S', 'codebases', 'payments-'))
    expect(codebaseInstructionsPath({ storageDir: 'S', workspaceRoot: path.resolve('/work/Other') })).not.toBe(a)
    if (process.platform === 'win32') {
      expect(codebaseInstructionsPath({ storageDir: 'S', workspaceRoot: 'D:\\Work\\Payments' })).toBe(
        codebaseInstructionsPath({ storageDir: 'S', workspaceRoot: 'd:\\work\\payments' }),
      )
    }
  })

  it('nowhere without a folder', () => {
    expect(codebaseInstructionsPath({ storageDir: 'S', workspaceRoot: undefined })).toBeUndefined()
  })
})

describe('reading and writing them', () => {
  it('round-trips, with Windows line endings made plain and a missing file read as none', async () => {
    const file = path.join(root, 'instructions', 'codebase-instructions.md')
    expect(await readCodebaseInstructions(file)).toBe('')
    await writeCodebaseInstructions(file, 'Run tests with pnpm test\r\nNever edit generated files\r\n')
    expect(await fs.readFile(file, 'utf8')).toBe('Run tests with pnpm test\nNever edit generated files\n')
    expect(await readCodebaseInstructions(file)).toBe('Run tests with pnpm test\nNever edit generated files')
  })
})

describe('in the prompt', () => {
  it('nothing at all when empty', () => {
    expect(renderCodebaseInstructions('  \n ')).toBe('')
  })

  /*
   * Reported as having no impact: they sat mid-prompt, before the skills and thousands of tokens of
   * tool and mode guidance. Now after all of that, before only the chat's plan, and named at the top.
   */
  it('comes after the standing instructions and the mode, before the plan, named at the top, and says which wins', () => {
    const prompt = buildSystemPrompt('D:/work', {
      codebaseInstructions: renderCodebaseInstructions('Use the payments logger.'),
      skills: renderAlwaysSkills([{ name: 'team-rules', description: 'd', filePath: 'f', always: true, body: 'Team rule.' }]),
      modeGuidance: ['## Mode guidance', 'Work in the shell.'].join(String.fromCharCode(10)),
      plan: '1. Fix the bug',
    })
    const pointer = prompt.indexOf('under "## Codebase instructions"')
    const codebase = prompt.lastIndexOf('## Codebase instructions')
    const standing = prompt.indexOf('## Standing instructions')
    const mode = prompt.indexOf('## Mode guidance')
    const plan = prompt.indexOf('Fix the bug')
    expect(pointer).toBeGreaterThan(-1)
    expect(pointer).toBeLessThan(standing)
    expect(codebase).toBeGreaterThan(standing)
    expect(codebase).toBeGreaterThan(mode)
    expect(plan).toBeGreaterThan(codebase)
    expect(prompt).toContain('Use the payments logger.')
    expect(prompt).toContain('disagree, follow these')
  })

  it('is cut past the limit, and the model is told so', () => {
    const rendered = renderCodebaseInstructions('x'.repeat(CODEBASE_INSTRUCTIONS_LIMIT + 50))
    expect(rendered).toContain('Cut at')
    expect(rendered.length).toBeLessThan(CODEBASE_INSTRUCTIONS_LIMIT + 1000)
  })
})
