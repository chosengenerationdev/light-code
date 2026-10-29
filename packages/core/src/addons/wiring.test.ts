import fs from 'node:fs'
import url from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Reads `bridge.ts`, for the reason `config/retrieval.test.ts` does: the defect worth guarding is a
 * decision that never reaches its owner, which no test of the owner can see.
 *
 * `configureMcp` is where an add-on is held to the version enabled, kept off when a repository
 * names it, and run from where it is installed. One direct `mcp.configure(...)` anywhere else would
 * start add-on entries as written - an updated add-on running unreviewed.
 */
const bridge = fs.readFileSync(url.fileURLToPath(new URL('../host/bridge.ts', import.meta.url)), 'utf8')

describe('every change to the MCP server set', () => {
  it('goes through configureMcp', () => {
    const calls = [...bridge.matchAll(/mcp\.configure\(/g)].length
    expect(calls).toBe(1)
    const owner = bridge.slice(bridge.indexOf('async function configureMcp('))
    expect(owner.slice(0, owner.indexOf('\n  }\n'))).toContain('mcp.configure(')
    expect(owner.slice(0, owner.indexOf('\n  }\n'))).toContain('runnableServers(')
  })
})

describe('codebase instructions', () => {
  it('reach the prompt every turn and the shared codebase folder when there is one', () => {
    expect(bridge).toContain('codebaseInstructionsPath({ codebaseDir: services.codebaseDir, storageDir, workspaceRoot: projectRoot })')
    expect(bridge).toMatch(/const codebaseInstructions = renderCodebaseInstructions\(await readCodebaseInstructions\(codebaseInstructionsFile\)\)/)
    expect(bridge).toMatch(/\n\s+codebaseInstructions,\n/)
  })
})
