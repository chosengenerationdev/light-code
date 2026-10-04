import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REGISTRY_FILE, writeRegistryFile } from './registry.js'

/**
 * Reported: every codebase in Fire Code asked to review the same Python tools. Approval lives in the
 * tool folder, and each codebase kept its own copy of the bucket folder. Fire Code now gives them one
 * (`mirrorRoot`), and these pin both halves of that.
 */
describe('Python tool approval shared between codebases', () => {
  it('copies every bucket folder under the shared root, never a codebase\'s own storage', async () => {
    const bridge = await fs.readFile(path.join(import.meta.dirname, '..', 'host', 'bridge.ts'), 'utf8')
    const calls = [...bridge.matchAll(/mirrorFolder\(\{\s*storageDir([^,\n]*)/g)].map((m) => m[1])
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((rest) => rest === ': mirrorRoot')).toBe(true)
  })

  it('writes the approval record whole, so another codebase never reads half of it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-registry-'))
    await writeRegistryFile(dir, { version: 1, tools: {} })
    await writeRegistryFile(dir, { version: 1, tools: {} })
    expect(await fs.readdir(dir)).toEqual([REGISTRY_FILE])
    await fs.rm(dir, { recursive: true, force: true })
  })
})
