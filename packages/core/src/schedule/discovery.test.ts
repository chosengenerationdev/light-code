import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import {
  filterToolsForSchedule,
  registryForSchedule,
  ScheduledApprovalGate,
  scheduleAppliesHere,
  scheduledRunGuidance,
} from './runner.js'
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

/**
 * What a schedule sees when the dispatcher is on.
 *
 * Worth pinning because it is easy to get backwards. In the chat, MCP and Python tools are
 * registered `dispatchOnly` — unadvertised, reachable only through `call_tool`. A schedule
 * builds a *fresh* registry from the tools it was granted, and registers them plainly, so a
 * granted tool is advertised to the run directly. `call_tool` is therefore a convenience here
 * and not the only route, which is the opposite of what it looks like from the chat side.
 */
describe('a granted tool that is dispatch-only in the chat', () => {
  it('is advertised directly to the scheduled run', () => {
    const registry = registryForSchedule([tool('s3__get_object'), tool('read_file')], {
      allowedTools: ['s3__get_object'],
    })

    expect(registry.promptList().map((entry) => entry.name)).toContain('s3__get_object')
    expect(registry.isDispatchOnly('s3__get_object')).toBe(false)
    // And the allowlist still decides: an ungranted tool is absent, not merely unadvertised.
    expect(registry.list().map((entry) => entry.name)).not.toContain('read_file')
  })

  /** So the dispatcher cannot be used to reach past the allowlist. */
  it('leaves call_tool unable to find anything the schedule did not name', () => {
    const registry = registryForSchedule([tool('deploy_service')], { allowedTools: [] })
    expect(registry.get('deploy_service')).toBeUndefined()
  })
})

/**
 * Requested as: a scheduled run should do some work, prepare a report, and put a link to it in
 * the notification. Most of the machinery existed — what was missing was the run being *told* to
 * use it, and the report surviving the toast that announced it.
 */
describe('what an unattended run is told about reporting', () => {
  const guidance = (tools: string[]): string =>
    scheduledRunGuidance({ name: 'Nightly', allowedTools: tools } as never, tools)

  it('asks for the report in details, not in the final answer', () => {
    const text = guidance(['notify', 'read_file'])
    expect(text).toMatch(/call `notify`/)
    expect(text).toMatch(/whole thing in `details`/)
    expect(text).toMatch(/written to a file/)
  })

  /**
   * A one-line notification saying "the check has finished" is the version of this feature that
   * wastes everyone's morning: it is the only thing on screen, so it has to carry the finding.
   */
  it('tells it to say what happened rather than that something happened', () => {
    expect(guidance(['notify'])).toMatch(/say what happened rather than that something happened/)
  })

  /** Silence about a tool it does not have is better than instructions it cannot follow. */
  it('says nothing about reporting when the schedule was not granted notify', () => {
    const text = guidance(['read_file'])
    expect(text).not.toMatch(/Reporting what you found/)
  })
})

/**
 * A schedule belongs to the project it was written in.
 *
 * They were a single global list, so one written against project A fired whatever project
 * happened to be open — running its prompt, with its granted tools, against B's files. For a
 * schedule granted editing that is a hazard rather than a scoping gap.
 */
describe('which project a schedule fires in', () => {
  it('runs in the project it was written in', () => {
    expect(scheduleAppliesHere({ workspaceRoot: '/repos/alpha' }, '/repos/alpha')).toBe(true)
  })

  it('does not run in a different one', () => {
    expect(scheduleAppliesHere({ workspaceRoot: '/repos/alpha' }, '/repos/beta')).toBe(false)
  })

  /** The same Windows spelling trap that made approvals silently stop applying. */
  it('is not fooled by how the path happens to be spelled', () => {
    expect(scheduleAppliesHere({ workspaceRoot: '/repos/alpha/' }, '/repos/alpha')).toBe(true)
    if (process.platform === 'win32') {
      expect(scheduleAppliesHere({ workspaceRoot: 'D:\\Repos\\Alpha' }, 'd:\\repos\\alpha')).toBe(true)
    }
  })

  /**
   * Schedules written before this had no project. Binding them to whatever happened to be open
   * at upgrade time would have stopped them firing with no explanation anywhere.
   */
  it('keeps firing anywhere when it predates the binding', () => {
    expect(scheduleAppliesHere({}, '/repos/beta')).toBe(true)
    expect(scheduleAppliesHere({}, undefined)).toBe(true)
  })

  it('does not fire with no folder open when it names one', () => {
    expect(scheduleAppliesHere({ workspaceRoot: '/repos/alpha' }, undefined)).toBe(false)
  })
})
