import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PathDenylist } from '../fs/denylist.js'
import { NodeFileSystem } from '../platform/node/filesystem.js'
import { readDocumentTool } from './readDocument.js'
import type { ToolExecutionContext } from './types.js'

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'documents',
  'fixtures',
  'chromium-report.pdf',
)

/** The whole path, not just the parser: confinement, byte read, extraction, and read-marking. */
describe('read_document on a PDF', () => {
  let workspace: string
  let context: ToolExecutionContext

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-pdf-'))
    await fs.copyFile(fixture, path.join(workspace, 'report.pdf'))
    context = {
      fs: new NodeFileSystem(),
      workspaceRoot: workspace,
      denylist: new PathDenylist(),
      readFiles: new Set<string>(),
    } as unknown as ToolExecutionContext
  })

  afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('returns the text through the tool', async () => {
    const result = await readDocumentTool.execute({ path: 'report.pdf' } as never, context)
    expect(result.isError).not.toBe(true)
    expect(result.content).toContain('Quarterly Report')
    expect(result.content).toContain('platform@example.internal')
  })

  it('counts as having read the file, so an edit is not refused afterwards', async () => {
    await readDocumentTool.execute({ path: 'report.pdf' } as never, context)
    expect(context.readFiles.size).toBeGreaterThan(0)
  })

  it('reports a file that is not really a PDF instead of throwing', async () => {
    await fs.writeFile(path.join(workspace, 'fake.pdf'), 'this is plain text')
    const result = await readDocumentTool.execute({ path: 'fake.pdf' } as never, context)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/not a PDF/)
  })
})
