import { describe, expect, it } from 'vitest'
import { createAskAgentTool } from './askAgent.js'
import type { ResolvedAgent } from '../agents/team.js'
import type { ToolExecutionContext } from './types.js'

function agent(role: string, over: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    role,
    name: role,
    summary: `what the ${role} is for`,
    kind: 'profile',
    label: 'Gateway model',
    prompt: '',
    available: true,
    usesTools: false,
    canWrite: false,
    ...over,
  }
}

async function consultAs(
  role: string,
  team: ResolvedAgent[],
): Promise<string> {
  const tool = createAskAgentTool({
    agents: () => team,
    consult: async (which) => ({ advice: 'ADVICE', label: which.label }),
  })
  const result = await tool.execute(
    { role, question: 'Q' },
    {} as unknown as ToolExecutionContext,
  )
  return typeof result.content === 'string' ? result.content : ''
}

/**
 * What the assistant is told to do with an answer, at the moment it has one.
 *
 * This lives in the tool result rather than only in the mode guidance on purpose: a standing
 * instruction is read every turn and applies to one moment in a few of them, and four separate
 * behaviours have failed in this codebase because an instruction did not happen to mention them.
 * A result cannot have been forgotten by the time it matters.
 */
describe('what comes back with a consultation', () => {
  it('sends a review back to the programmer, and says it may disagree', async () => {
    const content = await consultAs('reviewer', [agent('reviewer'), agent('programmer')])

    expect(content).toContain('take the findings back to it')
    expect(content).toContain('It may disagree')
    // The assistant settles it, because it is the only one of the three holding the file.
    expect(content).toContain('you have the real file')
    expect(content).toContain('Re-review only if')
  })

  /*
   * An instruction naming a role nobody assigned is the failure this whole area keeps producing.
   * With no programmer the finding is the assistant's to act on, and saying otherwise would send
   * it to consult somebody who is not there.
   */
  it('says none of that when there is no programmer to send it to', async () => {
    const content = await consultAs('reviewer', [agent('reviewer')])
    expect(content).not.toContain('take the findings back')
  })

  it('says none of it when the programmer is assigned but unreachable', async () => {
    const content = await consultAs('reviewer', [
      agent('reviewer'),
      agent('programmer', { available: false, reason: 'profile gone' }),
    ])
    expect(content).not.toContain('take the findings back')
  })

  /*
   * The librarian records skills itself now, through the approval gate — so the trailer must not
   * tell the assistant to propose one that has already been written and approved. Repeating it
   * would put the same skill in front of the user twice, which is how people learn to click
   * through approvals.
   */
  it('does not ask the assistant to re-propose a skill already written', async () => {
    const content = await consultAs('librarian', [agent('librarian', { usesTools: true })])
    expect(content).toContain('It can record a skill itself')
    expect(content).toContain('that is done and not something to repeat')
    expect(content).not.toContain('It cannot write one itself')
  })

  it('warns that the programmer wrote from what it was shown', async () => {
    const content = await consultAs('programmer', [agent('programmer')])
    expect(content).toContain('Check this against the real file')
    expect(content).toContain('a caller it was never shown')
  })

  /*
   * The trailer used to assert every specialist "has not seen your workspace", which stopped
   * being true when `agents/consult.ts` gave them the read group. It said so of a librarian that
   * had just read half the docs index.
   */
  it('describes what the specialist could actually see', async () => {
    const blind = await consultAs('tester', [agent('tester', { usesTools: false })])
    expect(blind).toContain('has not seen your workspace')

    const reading = await consultAs('librarian', [agent('librarian', { usesTools: true })])
    expect(reading).toContain('could read this workspace but cannot change anything')
    expect(reading).not.toContain('has not seen your workspace')
  })
})
