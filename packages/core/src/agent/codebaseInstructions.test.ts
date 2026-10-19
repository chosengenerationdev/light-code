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

  it('comes before the standing instructions and says which wins', () => {
    const prompt = buildSystemPrompt('D:/work', {
      codebaseInstructions: renderCodebaseInstructions('Use the payments logger.'),
      skills: renderAlwaysSkills([{ name: 'team-rules', description: 'd', filePath: 'f', always: true, body: 'Team rule.' }]),
    })
    const codebase = prompt.indexOf('## Codebase instructions')
    const standing = prompt.indexOf('## Standing instructions')
    expect(codebase).toBeGreaterThan(-1)
    expect(standing).toBeGreaterThan(codebase)
    expect(prompt).toContain('Use the payments logger.')
    expect(prompt).toContain('where the two disagree, follow these')
  })

  it('is cut past the limit, and the model is told so', () => {
    const rendered = renderCodebaseInstructions('x'.repeat(CODEBASE_INSTRUCTIONS_LIMIT + 50))
    expect(rendered).toContain('Cut at')
    expect(rendered.length).toBeLessThan(CODEBASE_INSTRUCTIONS_LIMIT + 1000)
  })
})
