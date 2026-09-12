import { describe, expect, it } from 'vitest'
import { toolsForConsultation } from './consult.js'
import { specialistPreamble } from './roles.js'
import { resolveTeam } from './team.js'
import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import type { Tool } from '../tools/types.js'

function tool(name: string, group: Tool['group']): Tool {
  return {
    name,
    group,
    description: name,
    parametersSchema: { parse: (value: unknown) => value } as unknown as Tool['parametersSchema'],
    execute: async () => ({ content: '' }),
  }
}

const REGISTRY = [
  tool('read_file', 'read'),
  tool('search_docs', 'read'),
  tool('write_to_file', 'edit'),
  tool('apply_diff', 'edit'),
  tool('write_skill', 'edit'),
  tool('create_python_tool', 'edit'),
  tool('execute_command', 'command'),
]

/**
 * Letting a specialist change things, which is off everywhere until somebody says otherwise.
 *
 * §12b's decision was that a consultant is read-only, because a second agent mutating the
 * repository would sit outside the approval gate. That is no longer structural — every non-read
 * call in a consultation goes through the same gate the agent loop uses — so it becomes a choice
 * the user makes per role. The tests here are about the *gate* holding, not about the choice.
 */
describe('a role that may change things', () => {
  it('is off for every built-in role', () => {
    const team = resolveTeam({
      config: {
        roles: {
          expert: { kind: 'profile', profileId: 'gw' },
          programmer: { kind: 'profile', profileId: 'gw' },
          reviewer: { kind: 'profile', profileId: 'gw' },
          tester: { kind: 'profile', profileId: 'gw' },
          librarian: { kind: 'profile', profileId: 'gw' },
        },
      },
      profiles: [{ id: 'gw', label: 'Gateway' }],
      cliAvailable: false,
    })
    expect(team).toHaveLength(5)
    expect(team.every((agent) => !agent.canWrite)).toBe(true)
  })

  it('is off for a custom role unless it was asked for', () => {
    const build = (canWrite?: boolean) =>
      resolveTeam({
        config: {
          definitions: [
            {
              id: 'db',
              name: 'DB',
              summary: 's',
              prompt: 'p',
              ...(canWrite === undefined ? {} : { canWrite }),
            },
          ],
          roles: { db: { kind: 'profile', profileId: 'gw' } },
        },
        profiles: [{ id: 'gw', label: 'Gateway' }],
        cliAvailable: false,
      })

    expect(build()[0]?.canWrite).toBe(false)
    expect(build(true)[0]?.canWrite).toBe(true)
  })

  it('takes the assignment override where there is one', () => {
    const team = resolveTeam({
      config: { roles: { reviewer: { kind: 'profile', profileId: 'gw', write: true } } },
      profiles: [{ id: 'gw', label: 'Gateway' }],
      cliAvailable: false,
    })
    expect(team[0]?.canWrite).toBe(true)
  })

  /*
   * The rule that makes the whole thing safe, and the one that was nearly wrong.
   *
   * The gate first asked only about `ALWAYS_ASK_TOOLS`, which is right for `write_skill` and
   * silently wrong for `write_to_file` — an ordinary edit is not on that list, so it would have
   * run with nobody asked, in the one code path that asks nobody by default. Grouping is the
   * honest test: the filter admits `read` and nothing else, so any other group present arrived
   * through the extras and is privileged by definition.
   */
  it('never admits a write through the group filter itself', () => {
    const offered = toolsForConsultation(REGISTRY).map((candidate) => candidate.name)
    expect(offered).toEqual(['read_file', 'search_docs'])
  })

  it('admits exactly the names it was given, and no neighbours', () => {
    const offered = toolsForConsultation(
      REGISTRY,
      new Set(['write_to_file', 'apply_diff', 'write_skill']),
    ).map((candidate) => candidate.name)

    expect(offered).toContain('write_to_file')
    expect(offered).toContain('apply_diff')
    expect(offered).toContain('write_skill')
    // Authorising a capability is not the same as making a change: §13 wants a human reading the
    // source somewhere less hurried than the middle of a consultation.
    expect(offered).not.toContain('create_python_tool')
    expect(offered).not.toContain('execute_command')
  })

  it('tells a writing role what that means, and only then', () => {
    expect(specialistPreamble(true, false)).not.toContain('You can also change this workspace')

    const writing = specialistPreamble(true, true)
    expect(writing).toContain('You can also change this workspace')
    expect(writing).toContain('approved by them before it happens')
    // The read-only sentence stays: the paragraph adds a capability, it does not replace the
    // limits, and a preamble that contradicted itself would be worse than either.
    expect(writing).toContain('cannot edit anything, run anything')
  })

  /*
   * Nothing in the extras may be a tool the gate would wave through. `write_skill` is always-ask;
   * `write_to_file` and `apply_diff` are not, and are covered by the group rule instead — so this
   * asserts the property that actually matters: none of them is in the read group.
   */
  it('keeps every writable extra out of the read group', () => {
    for (const name of ['write_to_file', 'apply_diff', 'write_skill']) {
      const found = REGISTRY.find((candidate) => candidate.name === name)
      expect(found?.group, `${name} must not be a read tool`).not.toBe('read')
    }
    expect(ALWAYS_ASK_TOOLS.has('write_skill')).toBe(true)
  })
})
