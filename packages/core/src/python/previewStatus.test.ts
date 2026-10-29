import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Logger } from '../logging/logger.js'
import { PythonManager } from './manager.js'
import { hashSource, writeRegistryFile } from './registry.js'

/**
 * The Python tab before Python has started (reported: on a managed machine the tab took a long time to show
 * the tools, because it waited for uv and the worker). What it may show at once is what each folder's
 * registry already says - read from disk, no interpreter - and never a guess that something needs approval.
 */
let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-preview-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('the Python tab before Python starts', () => {
  it('lists the tools approved in each folder, and nothing as waiting for approval', async () => {
    const tools = path.join(root, '.lightcode', 'tools')
    const team = path.join(root, 'team-tools')
    await fs.mkdir(tools, { recursive: true })
    await fs.mkdir(team, { recursive: true })
    const approved = 'def run() -> str:\n    """Job status."""\n    return "ok"\n'
    await fs.writeFile(path.join(tools, 'jobs.py'), approved)
    await writeRegistryFile(tools, { version: 1, tools: { jobs: { description: 'Job status.', schema: {}, hash: hashSource(approved) } } } as never)
    // A colleague's new tool: whether it needs approval is only known once Python is up.
    await fs.writeFile(path.join(team, 'fresh.py'), 'def run() -> str:\n    return "new"\n')

    const manager = new PythonManager({
      workspaceRoot: root,
      storageDir: path.join(root, 'storage'),
      logger: new Logger({ level: 'error', sink: () => {} }),
      secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    } as never)
    const started = Date.now()
    const preview = await manager.previewStatus({ toolsDir: tools, extraToolDirs: [team] })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(preview.starting).toBe(true)
    expect(preview.ready).toBe(false)
    expect(preview.tools.map((tool) => tool.name)).toEqual(['jobs'])
    expect(preview.tools[0]?.description).toBe('Job status.')
    expect(preview.issues).toEqual([])
    expect(preview.detail).toMatch(/Starting Python/)
  })
})
