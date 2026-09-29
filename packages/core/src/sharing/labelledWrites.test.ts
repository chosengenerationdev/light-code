import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { approveTool, isApprovedSource, repinApproval } from '../python/registry.js'
import { createWriteSkillTool } from '../skills/tools.js'
import { fillAttribution, readAttribution } from './attribution.js'

/**
 * Labels are written by the tools that save skills and Python tools — and what is approved must be
 * exactly what is written, even though the label carries the time of the save.
 */

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-labels-')))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('write_skill', () => {
  it('writes exactly the labelled text the approval showed, and moves the version on next time', async () => {
    const skillsDir = tempDir()
    const tool = createWriteSkillTool({
      skillsDir,
      onChanged: async () => {},
      attribution: () => ({ author: 'ana', project: 'Payments' }),
    })
    const params = { name: 'deploy', description: 'How we deploy', body: 'Steps.' }

    const preview = await tool.preview?.(params, {} as never)
    // Long enough that a second stamp would show a different time.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await tool.execute(params, {} as never)

    const written = fs.readFileSync(path.join(skillsDir, 'deploy.md'), 'utf8')
    expect(preview).toMatchObject({ kind: 'diff', after: written })
    expect(readAttribution('skill', written)).toMatchObject({ author: 'ana', project: 'Payments', version: 1 })

    const updated = { ...params, body: 'Better steps.' }
    await tool.preview?.(updated, {} as never)
    await tool.execute(updated, {} as never)
    const second = readAttribution('skill', fs.readFileSync(path.join(skillsDir, 'deploy.md'), 'utf8'))
    expect(second).toMatchObject({ author: 'ana', project: 'Payments', version: 2 })
  })
})

describe('labelling an approved tool', () => {
  const source = '"""Say hi."""\n\ndef run() -> str:\n    return "hi"\n'
  const described = { description: 'Say hi.', schema: {} }

  it('keeps the approval when the file was exactly what was approved', async () => {
    const dir = tempDir()
    await approveTool(dir, 'hello', source, described as never)
    const labelled = fillAttribution('tool', source, { author: 'ana', version: 1 })
    expect(await repinApproval(dir, 'hello', source, labelled)).toBe(true)
    expect(await isApprovedSource(dir, 'hello', labelled)).toBe(true)
  })

  it('does not approve a file that had already changed since it was approved', async () => {
    const dir = tempDir()
    await approveTool(dir, 'hello', source, described as never)
    const tampered = source.replace('"hi"', '__import__("os").system("x")')
    const labelled = fillAttribution('tool', tampered, { author: 'ana' })
    expect(await repinApproval(dir, 'hello', tampered, labelled)).toBe(false)
    expect(await isApprovedSource(dir, 'hello', labelled)).toBe(false)
  })
})

/**
 * Labelling existing files never guesses who wrote them or which project they belong to: the files
 * are mixed, and a wrong label — spread through the bucket — is worse than none. Read from the
 * source, like `config/retrieval.test.ts`, because the handler lives inside the bridge and the
 * defect would be a line that quietly came back.
 */
describe('the labelling job', () => {
  const handler = async (): Promise<string> => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'host', 'bridge.ts'), 'utf8')
    const start = source.indexOf('async function handleProjectStamp(')
    expect(start).toBeGreaterThan(-1)
    return source.slice(start, source.indexOf('\n  }\n', start))
  }

  it('takes author and project only from what the user chose, never from this machine', async () => {
    const body = await handler()
    expect(body).not.toContain('indexOwner(')
    expect(body).not.toContain('projectName(')
    expect(body).toContain('labels.find((label) => samePath(label.filePath, candidate.entry.filePath))')
    expect(body).toContain('if (candidate.entry.current.author === undefined && author !== undefined')
  })

  it('leaves files in the bucket alone unless the user chose to label them', async () => {
    expect(await handler()).toContain("if (candidate.entry.location === 'bucket' && chosen === undefined) continue")
  })

  it('only offers evidence in the preview, and applies it nowhere', async () => {
    const body = await handler()
    const applyPart = body.slice(body.indexOf("post({ type: 'projectStamp', running: true"))
    expect(applyPart).not.toContain('suggestion')
    expect(applyPart).not.toContain('gitFirstAuthors')
  })
})
