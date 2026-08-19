import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Tool } from '../tools/types.js'
import { filterToolsForSchedule, registryForSchedule, ScheduledApprovalGate, scheduledRunGuidance } from './runner.js'
import { describeNextRun, describeTrigger, isDue, nextFireTime } from './timing.js'
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
  it('counts forward from the moment given', () => {
    expect(nextFireTime(schedule(), WEDNESDAY_NOON)).toBe(WEDNESDAY_NOON + 60 * 60_000)
  })

  it('is a pure function of `from`, never of the clock', () => {
    expect(nextFireTime(schedule(), 0)).toBe(60 * 60_000)
  })
})

/**
 * **The bug this replaced, and the reason it survived a full test suite.**
 *
 * The timer used to ask `nextFireTime(schedule, now) <= now`. That function always answers with
 * a moment strictly in the future — correct for "when next?", and false by construction as a
 * due check. Every schedule silently never fired; only Run Now worked, because it skips the
 * check entirely.
 *
 * `nextFireTime` was tested thoroughly and was never wrong. Nothing tested the decision that
 * used it, which is what these do.
 */
describe('isDue', () => {
  it('is true once the stored time has passed', () => {
    expect(isDue(schedule({ nextRunAt: WEDNESDAY_NOON - 1 }), WEDNESDAY_NOON)).toBe(true)
    expect(isDue(schedule({ nextRunAt: WEDNESDAY_NOON }), WEDNESDAY_NOON)).toBe(true)
  })

  it('is false before it', () => {
    expect(isDue(schedule({ nextRunAt: WEDNESDAY_NOON + 1 }), WEDNESDAY_NOON)).toBe(false)
  })

  it('is false when paused, however overdue', () => {
    expect(isDue(schedule({ enabled: false, nextRunAt: 0 }), WEDNESDAY_NOON)).toBe(false)
  })

  /** Otherwise every existing schedule fires at once the first time a new build loads. */
  it('is false when never armed, rather than treating unknown as due', () => {
    expect(isDue(schedule(), WEDNESDAY_NOON)).toBe(false)
  })

  /**
   * The end-to-end property the old code failed. Arm a schedule the way the bridge does, and
   * it must actually become due once its interval has elapsed.
   */
  it('becomes due after the interval it was armed with', () => {
    const armed = schedule({ nextRunAt: nextFireTime(schedule(), WEDNESDAY_NOON) })
    expect(isDue(armed, WEDNESDAY_NOON + 59 * 60_000)).toBe(false)
    expect(isDue(armed, WEDNESDAY_NOON + 61 * 60_000)).toBe(true)
  })

  it('becomes due for a daily schedule once its time arrives', () => {
    const trigger = { kind: 'daily' as const, hour: 18, minute: 0 }
    const armed = schedule({ trigger, nextRunAt: nextFireTime({ trigger }, WEDNESDAY_NOON) })
    expect(isDue(armed, WEDNESDAY_NOON)).toBe(false)
    expect(isDue(armed, new Date(2026, 7, 12, 18, 0, 1).getTime())).toBe(true)
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

/**
 * What a schedule may be granted in advance, and what it may not.
 *
 * Editing files unattended is a legitimate thing to authorise: the user picked the tools, in
 * the open, for one named job, and that allowlist *is* their approval. Installing a Python tool
 * or a skill is a different act — model-authored code that later runs, and prose later injected
 * into the assistant's own context — and §13 requires approval showing the source, which is the
 * one thing that cannot happen with nobody watching.
 */
describe('what a schedule can never be granted', () => {
  const forbidden = ['create_python_tool', 'update_python_tool', 'delete_python_tool', 'write_skill', 'delete_skill']

  it('never registers a capability-granting tool, even when explicitly ticked', () => {
    const all = forbidden.map((name) => tool(name, 'edit'))
    const filtered = filterToolsForSchedule(all, { allowedTools: [...forbidden] })
    // Withheld from the registry, so the model is never told it exists — it cannot spend the
    // run working around something it was never offered.
    expect(filtered).toEqual([])
  })

  it('refuses one at the gate too, as a second line of defence', async () => {
    const gate = new ScheduledApprovalGate({ allowedTools: [...forbidden] })
    for (const name of forbidden) {
      const decision = await gate.requestApproval({
        id: '1',
        toolName: name,
        group: 'edit',
        preview: { kind: 'text', text: '' },
      })
      expect(decision).toBe('deny')
    }
  })

  /**
   * The distinction that matters: authorising a *change* is fine, authorising a *capability*
   * is not. A schedule that tidies files is the whole point of the feature.
   */
  it('still grants ordinary editing when it was ticked', async () => {
    const all = [tool('write_to_file', 'edit'), tool('apply_diff', 'edit'), tool('execute_command', 'command')]
    const filtered = filterToolsForSchedule(all, { allowedTools: ['write_to_file', 'execute_command'] })
    expect(filtered.map((entry) => entry.name).sort()).toEqual(['execute_command', 'write_to_file'])

    const gate = new ScheduledApprovalGate({ allowedTools: ['write_to_file'] })
    const decision = await gate.requestApproval({
      id: '1',
      toolName: 'write_to_file',
      group: 'edit',
      preview: { kind: 'diff', path: 'a.txt', before: '', after: 'x' },
    })
    expect(decision).toBe('approve')
  })

  it('still grants nothing at all by default', () => {
    const all = [tool('write_to_file', 'edit'), tool('apply_diff', 'edit')]
    expect(filterToolsForSchedule(all, { allowedTools: [] })).toEqual([])
  })
})
