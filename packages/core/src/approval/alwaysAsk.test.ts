import { describe, expect, it } from 'vitest'

import { ALWAYS_ASK_TOOLS, decideFromPolicy } from './policy.js'
import type { ApprovalRequest } from './types.js'

function request(toolName: string): ApprovalRequest {
  return { id: '1', toolName, group: 'edit', preview: { kind: 'text', text: 'source' } }
}

/**
 * Model-authored code and prose must always be seen by a human before it lands.
 *
 * A Python tool becomes a callable code path and a skill becomes standing instructions nobody
 * code-reviews (§13). Auto-approving their *creation* compounds: an injected instruction could
 * install a persistent capability, which the same setting then auto-approves on every later
 * call. "Auto-approve edits" is a statement about editing the files you are working on, not
 * about granting the assistant new abilities.
 */
describe('tools that always ask', () => {
  const everythingOn = {
    autoApprove: { read: true, edit: true, command: true, mcp: true },
    allowedTools: [...ALWAYS_ASK_TOOLS],
    allowedCommands: [],
  }

  it('asks even with every toggle on and the tool explicitly allowlisted', () => {
    for (const tool of ALWAYS_ASK_TOOLS) {
      expect(decideFromPolicy(request(tool), everythingOn)).toBeUndefined()
    }
  })

  it('covers creating, updating and deleting a Python tool', () => {
    expect(ALWAYS_ASK_TOOLS.has('create_python_tool')).toBe(true)
    expect(ALWAYS_ASK_TOOLS.has('update_python_tool')).toBe(true)
    // Deletion too: removing a tool the user relies on is not something to do silently.
    expect(ALWAYS_ASK_TOOLS.has('delete_python_tool')).toBe(true)
  })

  it('covers writing and deleting a skill', () => {
    expect(ALWAYS_ASK_TOOLS.has('write_skill')).toBe(true)
    expect(ALWAYS_ASK_TOOLS.has('delete_skill')).toBe(true)
  })

  /** The rest of the policy is unchanged — this is a carve-out, not a new default. */
  it('still auto-approves an ordinary edit when the toggle is on', () => {
    expect(decideFromPolicy(request('write_to_file'), everythingOn)).toBe('approve')
    expect(decideFromPolicy(request('apply_diff'), everythingOn)).toBe('approve')
  })

  it('still asks for an ordinary edit when nothing is configured', () => {
    expect(decideFromPolicy(request('write_to_file'), undefined)).toBeUndefined()
  })

  /** Control tools perform no work, so they were never approval-worthy. */
  it('leaves control tools alone', () => {
    const control: ApprovalRequest = {
      id: '1',
      toolName: 'attempt_completion',
      group: 'always',
      preview: { kind: 'text', text: '' },
    }
    expect(decideFromPolicy(control, undefined)).toBe('approve')
  })
})
