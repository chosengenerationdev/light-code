import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Tool } from '../tools/types.js'
import { filterToolsForSchedule, registryForSchedule, ScheduledApprovalGate, scheduledRunGuidance } from './runner.js'
import { describeNextRun, describeTrigger, nextFireTime } from './timing.js'
import { riskyGroupsIn, scheduleSchema, type Schedule } from './types.js'

function tool(name: string, group: Tool['group'] = 'read'): Tool {
  return { name, group, description: name, parametersSchema: z.object({}), execute: async () => ({ content: '' }) }
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1',
    name: 'Nightly check',
    prompt: 'Check the build',
    trigger: { kind: 'interval', everyMinutes: 60 },
    enabled: true,
    allowedTools: [],
    ...overrides,
  }
}

/** Local midday on a known Wednesday, so weekday arithmetic is unambiguous. */
const WEDNESDAY_NOON = new Date(2026, 7, 12, 12, 0, 0, 0).getTime()

describe('nextFireTime — interval', () => {
  /**
   * Counted from the last run, not from a fixed epoch. Firing on wall-clock multiples means a
   * job that overruns its interval is immediately due again and never rests.
   */
  it('counts from the last run', () => {
    const at = nextFireTime(schedule({ lastRunAt: WEDNESDAY_NOON }), WEDNESDAY_NOON + 60_000)
    expect(at).toBe(WEDNESDAY_NOON + 60 * 60_000)
  })

  it('counts from now when it has never run', () => {
    expect(nextFireTime(schedule(), WEDNESDAY_NOON)).toBe(WEDNESDAY_NOON + 60 * 60_000)
  })

  /**
   * A schedule due while VS Code was closed fires once, shortly after startup — never
   * immediately, or a morning launch fires every schedule at once, and never repeatedly to
   * catch up on a weekend of missed runs.
   */
  it('defers a missed run by a minute rather than firing at once', () => {
    const missed = schedule({ lastRunAt: WEDNESDAY_NOON - 10 * 60 * 60_000 })
    expect(nextFireTime(missed, WEDNESDAY_NOON)).toBe(WEDNESDAY_NOON + 60_000)
  })
})

describe('nextFireTime — daily', () => {
  it('fires later the same day when the time is still ahead', () => {
    const at = nextFireTime(schedule({ trigger: { kind: 'daily', hour: 18, minute: 30 } }), WEDNESDAY_NOON)
    const expected = new Date(2026, 7, 12, 18, 30, 0, 0).getTime()
    expect(at).toBe(expected)
  })

  it('rolls to tomorrow once the time has passed', () => {
    const at = nextFireTime(schedule({ trigger: { kind: 'daily', hour: 9, minute: 0 } }), WEDNESDAY_NOON)
    expect(at).toBe(new Date(2026, 7, 13, 9, 0, 0, 0).getTime())
  })

  /** Exactly now is in the past for this purpose, or a schedule would fire twice in one second. */
  it('treats the current minute as already gone', () => {
    const at = nextFireTime(schedule({ trigger: { kind: 'daily', hour: 12, minute: 0 } }), WEDNESDAY_NOON)
    expect(at).toBe(new Date(2026, 7, 13, 12, 0, 0, 0).getTime())
  })
})

describe('nextFireTime — weekly', () => {
  it('finds the next allowed weekday', () => {
    // Wednesday is 3; asking for Friday (5).
    const at = nextFireTime(schedule({ trigger: { kind: 'weekly', days: [5], hour: 9, minute: 0 } }), WEDNESDAY_NOON)
    expect(new Date(at).getDay()).toBe(5)
    expect(at).toBe(new Date(2026, 7, 14, 9, 0, 0, 0).getTime())
  })

  it('can fire later on the same weekday', () => {
    const at = nextFireTime(schedule({ trigger: { kind: 'weekly', days: [3], hour: 18, minute: 0 } }), WEDNESDAY_NOON)
    expect(at).toBe(new Date(2026, 7, 12, 18, 0, 0, 0).getTime())
  })

  /** Wrapping the week is where an offset calculation usually goes wrong. */
  it('wraps to next week when the only day has passed', () => {
    const at = nextFireTime(schedule({ trigger: { kind: 'weekly', days: [1], hour: 9, minute: 0 } }), WEDNESDAY_NOON)
    expect(new Date(at).getDay()).toBe(1)
    expect(at).toBeGreaterThan(WEDNESDAY_NOON)
  })
})

describe('describeTrigger', () => {
  it('says what a person would say', () => {
    expect(describeTrigger({ kind: 'interval', everyMinutes: 30 })).toBe('Every 30 minutes')
    expect(describeTrigger({ kind: 'interval', everyMinutes: 60 })).toBe('Every hour')
    expect(describeTrigger({ kind: 'interval', everyMinutes: 1440 })).toBe('Every day')
    expect(describeTrigger({ kind: 'daily', hour: 8, minute: 5 })).toBe('Every day at 08:05')
    expect(describeTrigger({ kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })).toBe('Weekdays at 09:00')
    expect(describeTrigger({ kind: 'weekly', days: [0], hour: 9, minute: 0 })).toBe('Sunday at 09:00')
  })
})

describe('describeNextRun', () => {
  it('says paused rather than a time when disabled', () => {
    expect(describeNextRun(schedule({ enabled: false }), WEDNESDAY_NOON)).toBe('Paused')
  })
})

/**
 * **The security property of this whole phase.** The plan asks for it to be verified by a
 * test rather than by inspection, because "the schedule happens not to call that tool" is a
 * convention and one prompt injection away from being false.
 */
describe('what a scheduled run may use', () => {
  const all = [
    tool('read_file', 'read'),
    tool('apply_diff', 'edit'),
    tool('execute_command', 'command'),
    tool('github__create_issue', 'mcp'),
    tool('py__report', 'command'),
    tool('attempt_completion', 'always'),
    tool('notify', 'always'),
    tool('ask_followup_question', 'always'),
  ]

  it('offers only the named tools', () => {
    const names = filterToolsForSchedule(all, { allowedTools: ['read_file'] }).map((entry) => entry.name)
    expect(names).toContain('read_file')
    expect(names).not.toContain('apply_diff')
    expect(names).not.toContain('execute_command')
    expect(names).not.toContain('github__create_issue')
  })

  /** Without these a run could never say it had finished, and would look like a hang. */
  it('always offers the control tools', () => {
    const names = filterToolsForSchedule(all, { allowedTools: [] }).map((entry) => entry.name)
    expect(names).toEqual(['attempt_completion', 'notify'])
  })

  /** Nobody can answer, so a run that asked would wait for a reply that never arrives. */
  it('never offers ask_followup_question, even if named', () => {
    const names = filterToolsForSchedule(all, { allowedTools: ['ask_followup_question'] }).map((entry) => entry.name)
    expect(names).not.toContain('ask_followup_question')
  })

  /** An allowlist, so a newly installed MCP server never widens an existing schedule. */
  it('does not grant a tool that appeared after the schedule was written', () => {
    const later = [...all, tool('newserver__delete_everything', 'mcp')]
    const names = filterToolsForSchedule(later, { allowedTools: ['read_file'] }).map((entry) => entry.name)
    expect(names).not.toContain('newserver__delete_everything')
  })

  /** Withheld from the prompt entirely, not merely refused at call time — §11's rule. */
  it('builds a registry the model is never told the rest of', () => {
    const registry = registryForSchedule(all, { allowedTools: ['read_file'] })
    expect(JSON.stringify(registry.toToolDefinitions())).not.toContain('execute_command')
    expect(registry.get('execute_command')).toBeUndefined()
  })
})

describe('ScheduledApprovalGate', () => {
  it('approves what the schedule named', async () => {
    const gate = new ScheduledApprovalGate({ allowedTools: ['apply_diff'] })
    await expect(gate.requestApproval({ id: '1', toolName: 'apply_diff', group: 'edit', preview: { kind: 'text', text: '' } })).resolves.toBe('approve')
  })

  /**
   * Should be unreachable — an unnamed tool is not registered — but if a future refactor
   * registers tools by another route, the run must stop rather than proceed unsupervised.
   */
  it('denies anything else and records it', async () => {
    const gate = new ScheduledApprovalGate({ allowedTools: ['read_file'] })
    const decision = await gate.requestApproval({
      id: '1',
      toolName: 'execute_command',
      group: 'command',
      preview: { kind: 'text', text: 'rm -rf /' },
    })

    expect(decision).toBe('deny')
    expect(gate.refused).toEqual(['execute_command'])
  })
})

describe('riskyGroupsIn', () => {
  const all = [tool('read_file', 'read'), tool('apply_diff', 'edit'), tool('github__x', 'mcp')]

  /** Reading unattended is ordinary; writing or executing unattended is the thing to warn about. */
  it('says nothing for a read-only selection', () => {
    expect(riskyGroupsIn(all, ['read_file'])).toEqual([])
  })

  it('names edit and mcp when they are selected', () => {
    expect(riskyGroupsIn(all, ['read_file', 'apply_diff', 'github__x'])).toEqual(['edit', 'mcp'])
  })
})

describe('scheduledRunGuidance', () => {
  it('tells the run that nobody can answer it', () => {
    expect(scheduledRunGuidance(schedule(), ['read_file'])).toMatch(/nobody can answer/i)
  })

  /** Otherwise a missing tool reads as a broken install and the run works around it. */
  it('explains that the narrow tool set is deliberate', () => {
    expect(scheduledRunGuidance(schedule(), ['read_file'])).toMatch(/deliberate, not a fault/i)
  })

  it('copes with a schedule granted nothing', () => {
    expect(scheduledRunGuidance(schedule(), [])).toMatch(/no tools beyond finishing/i)
  })
})

describe('the schedule schema', () => {
  it('rejects an interval faster than a minute — that is a loop, not a schedule', () => {
    expect(scheduleSchema.safeParse(schedule({ trigger: { kind: 'interval', everyMinutes: 0 } })).success).toBe(false)
  })

  it('rejects a weekly schedule with no days', () => {
    expect(scheduleSchema.safeParse(schedule({ trigger: { kind: 'weekly', days: [], hour: 9, minute: 0 } })).success).toBe(false)
  })

  it('accepts an empty allowlist — a schedule that only answers is legitimate', () => {
    expect(scheduleSchema.safeParse(schedule({ allowedTools: [] })).success).toBe(true)
  })
})
