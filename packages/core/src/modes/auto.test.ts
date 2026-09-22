import { describe, expect, it } from 'vitest'

import { buildAutoGuidance } from './autoGuidance.js'
import { AUTO_MODE, BUILTIN_MODES, CODE_MODE, findMode } from './builtin.js'

/** What the mode actually puts in the prompt, for an ordinary machine. */
const guidance = (): string =>
  buildAutoGuidance({
    shell: { command: undefined, kind: 'posix', label: '/bin/bash' },
    tools: { present: ['grep', 'sed', 'git'], missing: [] },
    platform: 'linux',
  })

/**
 * Auto mode is guidance, not a capability change — and the two things that make it safe live
 * elsewhere, so they are pinned here rather than left to be noticed.
 */
describe('auto mode', () => {
  it('is offered and resolves by id', () => {
    expect(BUILTIN_MODES).toContain(AUTO_MODE)
    expect(findMode('auto')).toBe(AUTO_MODE)
  })

  it('withholds nothing: the same groups as Code', () => {
    // The whole design is that it changes how the model works, not what it may do. A mode that
    // quietly removed a group would look like the model having got worse at something.
    expect([...AUTO_MODE.groups].sort()).toEqual([...CODE_MODE.groups].sort())
  })

  it('declares that its commands edit, so a checkpoint is taken before the first one', () => {
    // Without this the Rollback button is present and covers nothing — see `Mode.commandsEdit`.
    expect(AUTO_MODE.commandsEdit).toBe(true)
    expect(CODE_MODE.commandsEdit).toBeUndefined()
  })

  /*
   * These two rules moved into the generated guidance rather than out of the product, so they
   * are asserted against what is actually built. Deleting them with the static string would have
   * quietly dropped two constraints the mode depends on.
   */
  it('tells the model that reading in the shell does not satisfy read-before-edit', () => {
    // §6's constraint is populated by `read_file` alone. A model that learns this from a refused
    // edit has spent a step on something the prompt could have said.
    expect(guidance()).toContain('read_file before any apply_diff')
  })

  it('keeps consequential edits on the tools that render a diff', () => {
    // Invariant 8 is about what the user can judge, and a `sed` expression is not a change.
    expect(guidance()).toContain('apply_diff or')
  })

  it('does not require an expert', () => {
    expect(AUTO_MODE.requiresExpert).toBeUndefined()
  })
})
