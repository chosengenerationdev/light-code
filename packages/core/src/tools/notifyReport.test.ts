import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PathDenylist } from '../fs/denylist.js'
import { NodeFileSystem } from '../platform/node/filesystem.js'
import { createNotifyTool } from './notify.js'
import type { ToolExecutionContext } from './types.js'

/**
 * `notify` can point at a report the agent wrote as a file - an HTML one with its own styling - so
 * the notification opens that file (in Sun Code's viewer, or VS Code) instead of a copy of text.
 */
describe('notify with a report file', () => {
  let workspace: string
  const calls: { details: string | undefined; reportFile: string | undefined }[] = []
  const tool = createNotifyTool({ notify: (_m, _l, details, reportFile) => calls.push({ details, reportFile }) })

  beforeAll(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lc-notify-')))
    await fs.writeFile(path.join(workspace, 'coverage.html'), '<h1>Coverage</h1>')
    await fs.writeFile(path.join(workspace, 'data.csv'), 'a,b')
  })
  afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
  })

  const context = (): ToolExecutionContext =>
    ({ workspaceRoot: workspace, fs: new NodeFileSystem(), denylist: new PathDenylist(), readFiles: new Set() }) as unknown as ToolExecutionContext

  it('hands the resolved file over, and not the details as well', async () => {
    const result = await tool.execute({ message: 'Coverage is ready', report: 'coverage.html', details: '# ignored' }, context())
    expect(result.isError).toBeUndefined()
    expect(calls.at(-1)).toEqual({ details: undefined, reportFile: path.join(workspace, 'coverage.html') })
  })

  it('refuses what is not a report, and what does not exist yet', async () => {
    expect((await tool.execute({ message: 'x', report: 'data.csv' }, context())).isError).toBe(true)
    expect((await tool.execute({ message: 'x', report: 'later.md' }, context())).content).toContain('Write the report first')
  })

  it('refuses a file outside the workspace as any read would', async () => {
    const outside = path.join(os.tmpdir(), 'lc-notify-outside.md')
    await fs.writeFile(outside, '# no')
    expect((await tool.execute({ message: 'x', report: outside }, context())).isError).toBe(true)
    await fs.rm(outside, { force: true })
  })
})
