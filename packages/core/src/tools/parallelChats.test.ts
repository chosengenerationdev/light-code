import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ShadowGit } from '../checkpoints/shadowGit.js'
import { PathDenylist } from '../fs/denylist.js'
import { NodeFileSystem } from '../platform/node/filesystem.js'
import { applyDiffTool } from './applyDiff/index.js'
import { readFileTool } from './readFile.js'
import type { ToolExecutionContext } from './types.js'
import { writeToFileTool } from './writeToFile.js'

/**
 * The safeguards that let several chats work in one codebase at once (Sun Code): an edit made
 * from a stale read is refused, and rolling a chat back restores only the files that chat changed.
 */
describe('several chats in one codebase', () => {
  let workspace: string
  let base: string

  beforeAll(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lc-parallel-')))
    workspace = path.join(base, 'ws')
    await fs.mkdir(workspace)
  })
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  const chat = (): ToolExecutionContext =>
    ({
      workspaceRoot: workspace,
      fs: new NodeFileSystem(),
      denylist: new PathDenylist(),
      readFiles: new Set<string>(),
      readStamps: new Map<string, string>(),
      changedFiles: new Set<string>(),
    }) as unknown as ToolExecutionContext

  it('refuses a whole-file write made from a read that another chat has since overtaken', async () => {
    await fs.writeFile(path.join(workspace, 'shared.txt'), 'one\n')
    const a = chat()
    const b = chat()
    await readFileTool.execute({ path: 'shared.txt' }, a)
    await readFileTool.execute({ path: 'shared.txt' }, b)

    const first = await writeToFileTool.execute({ path: 'shared.txt', content: 'from b, longer\n' }, b)
    expect(first.isError).toBeUndefined()

    const stale = await writeToFileTool.execute({ path: 'shared.txt', content: 'from a\n' }, a)
    expect(stale.isError).toBe(true)
    expect(stale.content).toContain('changed after you last read it')
    expect(await fs.readFile(path.join(workspace, 'shared.txt'), 'utf8')).toBe('from b, longer\n')

    // Reading again is the way through.
    await readFileTool.execute({ path: 'shared.txt' }, a)
    expect((await writeToFileTool.execute({ path: 'shared.txt', content: 'from a\n' }, a)).isError).toBeUndefined()
  })

  it('refuses apply_diff from a stale read too, and lets a chat keep editing its own writes', async () => {
    await fs.writeFile(path.join(workspace, 'code.py'), 'x = 1\ny = 2\n')
    const a = chat()
    await readFileTool.execute({ path: 'code.py' }, a)
    const diff = (from: string, to: string): string => `<<<<<<< SEARCH\n${from}\n=======\n${to}\n>>>>>>> REPLACE`
    expect((await applyDiffTool.execute({ path: 'code.py', diff: diff('x = 1', 'x = 10') }, a)).isError).toBeUndefined()
    // Its own write does not count as somebody else's change.
    expect((await applyDiffTool.execute({ path: 'code.py', diff: diff('y = 2', 'y = 20') }, a)).isError).toBeUndefined()

    await fs.writeFile(path.join(workspace, 'code.py'), 'x = 10\ny = 20\nz = 3, by hand\n')
    const stale = await applyDiffTool.execute({ path: 'code.py', diff: diff('x = 10', 'x = 11') }, a)
    expect(stale.content).toContain('changed after you last read it')
    expect(a.changedFiles?.has(path.join(workspace, 'code.py'))).toBe(true)
  })

  it('rolls back only the files one chat changed', async (ctx) => {
    if (!(await ShadowGit.isGitAvailable())) ctx.skip()
    await fs.writeFile(path.join(workspace, 'mine.txt'), 'original mine\n')
    await fs.writeFile(path.join(workspace, 'theirs.txt'), 'original theirs\n')
    const git = new ShadowGit(workspace, path.join(base, 'shadow.git'))
    const checkpoint = await git.snapshot()

    await fs.writeFile(path.join(workspace, 'mine.txt'), 'edited by this chat\n')
    await fs.writeFile(path.join(workspace, 'created.txt'), 'new from this chat\n')
    await fs.writeFile(path.join(workspace, 'theirs.txt'), 'edited by another chat\n')

    const result = await git.restoreFiles(checkpoint, [path.join(workspace, 'mine.txt'), path.join(workspace, 'created.txt'), path.join(base, 'outside.txt')])
    expect(result).toEqual({ restored: ['mine.txt'], removed: ['created.txt'] })
    expect(await fs.readFile(path.join(workspace, 'mine.txt'), 'utf8')).toBe('original mine\n')
    expect(await fs.readFile(path.join(workspace, 'theirs.txt'), 'utf8')).toBe('edited by another chat\n')
    await expect(fs.access(path.join(workspace, 'created.txt'))).rejects.toThrow()
  })
})
