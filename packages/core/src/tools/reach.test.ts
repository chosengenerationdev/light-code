import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { decideFromPolicy } from '../approval/policy.js'
import { PathDenylist } from '../fs/denylist.js'
import { isSecretPath, isSystemPath } from '../fs/reach.js'
import { resolveToolPath } from './paths.js'
import type { ToolExecutionContext } from './types.js'
import { writeToFileTool } from './writeToFile.js'

/**
 * Fire Code's "reach anywhere": reads anywhere without a folder prompt, writes anywhere but
 * always asked about, and a floor - credentials and Windows folders - that no setting lifts.
 */
describe('reach anywhere', () => {
  let base: string
  let workspace: string
  let outsideFile: string
  let denylist: PathDenylist

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-reach-'))
    workspace = path.join(base, 'workspace')
    await fs.mkdir(workspace)
    await fs.mkdir(path.join(base, 'share'))
    await fs.mkdir(path.join(base, '.ssh'))
    outsideFile = path.join(base, 'share', 'report.csv')
    await fs.writeFile(outsideFile, 'a,b\n1,2\n')
    await fs.writeFile(path.join(base, '.ssh', 'id_ed25519'), 'PRIVATE')
    denylist = new PathDenylist()
  })
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true })
  })

  const context = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext =>
    ({ workspaceRoot: workspace, denylist, reach: 'anywhere', ...overrides }) as ToolExecutionContext

  it('reads outside the workspace without asking', async () => {
    const requestPathAccess = vi.fn(async () => false)
    const result = await resolveToolPath(context({ requestPathAccess }), outsideFile)
    expect(result.ok).toBe(true)
    expect(requestPathAccess).not.toHaveBeenCalled()
  })

  it('allows a write outside the workspace and marks it, so it is always asked about', async () => {
    const result = await resolveToolPath(context(), path.join(base, 'share', 'new.txt'), { write: true })
    expect(result).toMatchObject({ ok: true, outsideWorkspace: true })
  })

  it('never reaches credentials, read or write', async () => {
    const key = path.join(base, '.ssh', 'id_ed25519')
    expect((await resolveToolPath(context(), key)).ok).toBe(false)
    expect((await resolveToolPath(context(), key, { write: true })).ok).toBe(false)
  })

  it('still honours the configured deny list', async () => {
    const list = new PathDenylist()
    await list.add(outsideFile)
    expect((await resolveToolPath(context({ denylist: list }), outsideFile)).ok).toBe(false)
  })

  it('changes nothing for a host without reach', async () => {
    const result = await resolveToolPath({ workspaceRoot: workspace, denylist } as ToolExecutionContext, path.join(base, 'share', 'new.txt'), { write: true })
    expect(result.ok).toBe(false)
  })

  it('names the credential and system floors correctly', () => {
    expect(isSecretPath('C:\\Users\\a\\.ssh\\config')).toBe(true)
    expect(isSecretPath('C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data')).toBe(true)
    expect(isSecretPath('\\\\server\\share\\certs\\client.pfx')).toBe(true)
    expect(isSecretPath('C:\\Users\\a\\AppData\\Local\\fire-code\\vault.key')).toBe(true)
    // A JupyterHub codebase's copy sits beside the data folder, where the file tools may look -
    // inside it (0.8.0) the Rust search and file tools refused the codebase's own files.
    expect(isSecretPath('C:\\Users\\a\\AppData\\Local\\fire-code-hub\\p1\\pricing\\model.py')).toBe(false)
    expect(isSecretPath('\\\\server\\finance\\q3\\report.xlsx')).toBe(false)
    expect(isSystemPath('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(true)
    expect(isSystemPath('C:\\Program Files (x86)\\App\\x.ini')).toBe(true)
    expect(isSystemPath('D:\\work\\windows\\notes.txt')).toBe(false)
  })

  it('asks about a write outside the workspace even with edits auto-approved and always-allowed', async () => {
    const preview = await writeToFileTool.preview!({ path: path.join(base, 'share', 'new.txt'), content: 'x' }, {
      ...context(),
      fs: { exists: async () => false, readFile: async () => '' },
    } as unknown as ToolExecutionContext)
    expect(preview).toMatchObject({ kind: 'diff', outsideWorkspace: true })
    const decision = decideFromPolicy(
      { id: '1', toolName: 'write_to_file', group: 'edit', preview } as never,
      { autoApprove: { read: true, edit: true, command: true, mcp: true }, allowedTools: ['write_to_file'] } as never,
    )
    expect(decision).toBeUndefined()
  })
})
