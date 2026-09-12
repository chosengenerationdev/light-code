import { describe, expect, it } from 'vitest'
import { toolsForConsultation } from './consult.js'
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

/**
 * The line a specialist cannot cross, and why it is sharper than "read-only is tidier".
 *
 * Consultation tool calls **do not go through the approval gate** — deliberately, because
 * prompting the user for every file a reviewer wants to read would train them to click through
 * prompts (`agents/consult.ts`). That is only safe while the tools are read-only. The moment a
 * specialist can write, there is a second agent changing the repository with nobody asked, which
 * is exactly what §8 and invariant 8 exist to prevent.
 *
 * The sharpest case is the one that prompted this test. `write_skill` writes prose that is
 * injected into **every later prompt** — §13 calls a skill a persistent prompt-injection vector,
 * which is why it is in `ALWAYS_ASK_TOOLS` and can never be auto-approved. A librarian able to
 * call it would create a permanent instruction no human ever read, through the one path that
 * asks nobody. It drafts skills instead; the assistant proposes them and the user sees the source.
 */
describe('what a specialist may never reach', () => {
  const registry = [
    tool('read_file', 'read'),
    tool('search_files', 'read'),
    tool('search_docs', 'read'),
    tool('write_to_file', 'edit'),
    tool('apply_diff', 'edit'),
    tool('write_skill', 'edit'),
    tool('delete_skill', 'edit'),
    tool('execute_command', 'command'),
    tool('use_mcp_tool', 'mcp'),
    tool('create_python_tool', 'edit'),
  ]

  const offered = toolsForConsultation(registry).map((candidate) => candidate.name)

  it('offers the read group and nothing else', () => {
    expect(offered).toEqual(['read_file', 'search_files', 'search_docs'])
  })

  /*
   * Nothing reaches a specialist *by group* that a human would otherwise have to see.
   *
   * A consultation can ask now — `runConsultation` takes an approver and routes always-ask tools
   * through it — but that is deliberately opt-in per name, not something the group filter can
   * hand out. If an always-ask tool ever landed in the `read` group it would be offered to every
   * specialist at once, and whether it then prompted would depend on a caller passing an
   * approver. That is a rule holding by accident, which is not a rule.
   */
  it('never offers, by group alone, a tool that would demand approval', () => {
    for (const name of offered) {
      expect(ALWAYS_ASK_TOOLS.has(name), `${name} is offered to specialists`).toBe(false)
    }
  })

  it('keeps write tools away from a specialist by default', () => {
    expect(offered).not.toContain('write_skill')
    expect(offered).not.toContain('delete_skill')
  })

  /*
   * The librarian is the one exception, and it is an exception to the *group* filter, never to
   * the approval rule. It was asked for directly; the objection was never that the librarian
   * should not record what it knows, but that a consultation asks nobody — so the fix was to make
   * this path ask, not to let the write through unseen.
   */
  it('lets a named extra past the group filter', () => {
    const withSkill = toolsForConsultation(registry, new Set(['write_skill']))
    expect(withSkill.map((candidate) => candidate.name)).toContain('write_skill')
    // Still nothing else: one name, not the edit group.
    expect(withSkill.map((candidate) => candidate.name)).not.toContain('write_to_file')
    expect(withSkill.map((candidate) => candidate.name)).not.toContain('delete_skill')
  })

  /*
   * The load-bearing rule for extras. Anything allowed past the group filter has to be a tool the
   * approval gate will stop on, because `runConsultation` only asks for tools in ALWAYS_ASK_TOOLS
   * — an extra outside that set would execute with nobody consulted, in the one path with no gate.
   */
  it('only ever admits extras that the approval gate will stop on', () => {
    for (const name of ['write_skill']) {
      expect(ALWAYS_ASK_TOOLS.has(name), name + ' would run ungated in a consultation').toBe(true)
    }
  })

  /*
   * Filtering by group rather than by name is what makes this hold for tools nobody has written
   * yet: a new `edit` tool is excluded by default. A name-based deny list would admit it.
   */
  it('excludes an edit tool it has never heard of', () => {
    const withNewcomer = toolsForConsultation([...registry, tool('rewrite_everything', 'edit')])
    expect(withNewcomer.map((candidate) => candidate.name)).not.toContain('rewrite_everything')
  })
})
