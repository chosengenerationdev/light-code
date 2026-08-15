import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAskExpertTool } from '../tools/askExpert.js'
import type { ToolExecutionContext } from '../tools/types.js'

const consultExpert = vi.hoisted(() => vi.fn())
vi.mock('./claudeCli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudeCli.js')>()),
  consultExpert,
}))

const context = { workspaceRoot: '/ws' } as unknown as ToolExecutionContext

/**
 * The budget reaches the expert, every time.
 *
 * It decides how many checkpoints the plan has, so a plan sized against a stale figure is the
 * failure this exists to prevent — and the figure moves with every consultation.
 */
describe('the budget line sent to the expert', () => {
  beforeEach(() => {
    consultExpert.mockReset()
    consultExpert.mockResolvedValue({ text: 'advice', sessionId: 's1', deniedTools: [], isError: false })
  })

  function questionSent(callIndex = 0): string {
    return String(consultExpert.mock.calls[callIndex]?.[1]?.question ?? '')
  }

  it('appends the remaining budget to the question', async () => {
    const tool = createAskExpertTool({
      cli: { available: true, executable: 'claude' },
      budgetSummary: () => '2 of 5 consultations left',
    })

    await tool.execute({ question: 'how should I split this?' }, context)
    expect(questionSent()).toContain('how should I split this?')
    expect(questionSent()).toContain('[2 of 5 consultations left]')
  })

  /**
   * Unlike the briefing, which is sent once. The number changes with each consultation, so
   * sending it only on a cold session would leave the expert planning against the figure it
   * saw at the start — the one case where re-sending is cheaper than not.
   */
  it('repeats it on a resumed session, where the briefing is not repeated', async () => {
    let session: string | undefined
    let remaining = 5
    const tool = createAskExpertTool({
      cli: { available: true, executable: 'claude' },
      briefing: () => 'INVENTORY',
      budgetSummary: () => `${String(remaining)} of 5 consultations left`,
      session: {
        get: () => session,
        set: (id) => {
          session = id
        },
      },
    })

    await tool.execute({ question: 'first' }, context)
    remaining = 4
    await tool.execute({ question: 'second' }, context)

    expect(questionSent(0)).toContain('INVENTORY')
    expect(questionSent(0)).toContain('[5 of 5 consultations left]')
    expect(questionSent(1)).not.toContain('INVENTORY')
    expect(questionSent(1)).toContain('[4 of 5 consultations left]')
  })

  it('adds nothing when no budget is set', async () => {
    const tool = createAskExpertTool({
      cli: { available: true, executable: 'claude' },
      budgetSummary: () => undefined,
    })

    await tool.execute({ question: 'plain' }, context)
    expect(questionSent()).toBe('plain')
  })
})
