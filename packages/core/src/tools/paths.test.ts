import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { PathDenylist } from '../fs/denylist.js'
import { resolveToolPath } from './paths.js'
import type { ToolExecutionContext } from './types.js'

/**
 * Asking the user for access to a path outside the workspace is a *widening* of the
 * filesystem boundary, so the tests here are about the cases where it must not widen:
 * writes, denied files, and unattended runs.
 */
describe('resolveToolPath — access outside the workspace', () => {
  let workspace: string
  let outside: string
  let outsideFile: string
  let secretFile: string
  let denylist: PathDenylist

  beforeAll(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-paths-'))
    workspace = path.join(base, 'workspace')
    outside = path.join(base, 'share')
    await fs.mkdir(workspace)
    await fs.mkdir(outside)
    outsideFile = path.join(outside, 'server.log')
    secretFile = path.join(outside, 'client.key')
    await fs.writeFile(outsideFile, 'log line\n')
    await fs.writeFile(secretFile, 'PRIVATE KEY\n')
    denylist = new PathDenylist()
    await denylist.add(secretFile)
  })

  afterAll(async () => {
    await fs.rm(path.dirname(workspace), { recursive: true, force: true })
  })

  function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
    return {
      workspaceRoot: workspace,
      denylist,
      ...overrides,
    } as ToolExecutionContext
  }

  it('asks, and reads the file when the user approves', async () => {
    const requestPathAccess = vi.fn().mockResolvedValue(true)
    const result = await resolveToolPath(makeContext({ requestPathAccess }), outsideFile)

    expect(result.ok).toBe(true)
    // Ground truth: the *resolved* path is what the user was shown, not the argument.
    expect(requestPathAccess).toHaveBeenCalledWith(await fs.realpath(outsideFile))
  })

  it('refuses when the user declines, and says so rather than pretending the file is missing', async () => {
    const requestPathAccess = vi.fn().mockResolvedValue(false)
    const result = await resolveToolPath(makeContext({ requestPathAccess }), outsideFile)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('declined')
  })

  it('never asks about a denylisted file — invariant 6 is not a default', async () => {
    const requestPathAccess = vi.fn().mockResolvedValue(true)
    const result = await resolveToolPath(makeContext({ requestPathAccess }), secretFile)

    expect(result.ok).toBe(false)
    expect(requestPathAccess).not.toHaveBeenCalled()
  })

  it('does not ask for a write — an edit outside the workspace has no checkpoint', async () => {
    const requestPathAccess = vi.fn().mockResolvedValue(true)
    const result = await resolveToolPath(makeContext({ requestPathAccess }), outsideFile, { write: true })

    expect(result.ok).toBe(false)
    expect(requestPathAccess).not.toHaveBeenCalled()
  })

  it('refuses outright when nobody can be asked, as in a scheduled run', async () => {
    const result = await resolveToolPath(makeContext(), outsideFile)

    expect(result.ok).toBe(false)
  })

  it('does not ask when the folder is already a configured read root', async () => {
    const requestPathAccess = vi.fn().mockResolvedValue(true)
    const context = makeContext({ readRoots: [outside], requestPathAccess })
    const result = await resolveToolPath(context, outsideFile)

    expect(result.ok).toBe(true)
    expect(requestPathAccess).not.toHaveBeenCalled()
  })
})
