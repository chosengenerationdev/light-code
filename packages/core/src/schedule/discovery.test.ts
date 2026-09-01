import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { filterToolsForSchedule, ScheduledApprovalGate } from './runner.js'
import { ALWAYS_AVAILABLE_TO_SCHEDULES } from './types.js'
import type { Tool } from '../tools/types.js'

/**
 * Asked for directly: a scheduled run "should be able to search docs and should be able to
 * learn about skills and tools, when it comes to tools it should be able to check if it has
 * access to that tool are not".
 *
 * The safety argument for granting these by default is that none of them reaches the
 * workspace, the network or a process — so what these tests really guard is that the list
 * stays that kind of list.
 */
const tool = (name: string, group: Tool['group'] = 'read'): Tool => ({
  name,
  group,
  description: name,
  parametersSchema: z.object({}),
  async execute() {
    return { content: '' }
  },
})

const all = [
  tool('attempt_completion', 'always'),
  tool('notify', 'always'),
  tool('search_docs'),
  tool('call_tool', 'always'),
  tool('read_tool_result'),
  tool('read_file'),
  tool('execute_command', 'command'),
  tool('ask_followup_question', 'always'),
  tool('ask_user_form', 'always'),
  tool('write_skill', 'edit'),
]

const namesFor = (allowedTools: string[]): string[] =>
  filterToolsForSchedule(all, { allowedTools }).map((entry) => entry.name)

describe('what a scheduled run may reach without being granted it', () => {
  it('can always look things up, even when the schedule named no tools at all', () => {
    const names = namesFor([])
    expect(names).toContain('search_docs')
    expect(names).toContain('read_tool_result')
  })

  /**
   * The dispatcher is on by default, so most tools are unadvertised and reachable only through
   * `call_tool`. Without it, a schedule granted an MCP tool had no way to invoke it at all.
   */
  it('can use the dispatcher, or a granted MCP tool would be unreachable', () => {
    expect(namesFor([])).toContain('call_tool')
  })

  it('still cannot reach anything that touches the workspace unless it was named', () => {
    const names = namesFor([])
    expect(names).not.toContain('read_file')
    expect(names).not.toContain('execute_command')
  })

  /** Nobody is there to answer either of them, so a run that asked would wait for ever. */
  it('is never given a tool that asks a person something, even if the allowlist names it', () => {
    const names = namesFor(['ask_followup_question', 'ask_user_form'])
    expect(names).not.toContain('ask_followup_question')
    expect(names).not.toContain('ask_user_form')
  })

  it('is never given one that installs code, even if the allowlist names it', () => {
    expect(namesFor(['write_skill'])).not.toContain('write_skill')
  })
})

describe('the approval gate agrees with the registry', () => {
  it('approves everything that is always available, so the two cannot disagree', async () => {
    const gate = new ScheduledApprovalGate({ allowedTools: [] })
    for (const name of ALWAYS_AVAILABLE_TO_SCHEDULES) {
      const decision = await gate.requestApproval({
        id: name,
        toolName: name,
        group: 'read',
        preview: { kind: 'text', text: '' },
      })
      expect(decision, name).toBe('approve')
    }
  })

  it('still denies a tool the schedule never named', async () => {
    const gate = new ScheduledApprovalGate({ allowedTools: ['read_file'] })
    const decision = await gate.requestApproval({
      id: '1',
      toolName: 'execute_command',
      group: 'command',
      preview: { kind: 'command', command: 'rm -rf /', cwd: '/tmp' },
    })
    expect(decision).toBe('deny')
  })
})
