import { beforeEach, describe, expect, it, vi } from 'vitest'

import { checkExpertBudget, type ExpertLimits, type ExpertSpend } from './budget.js'
import { createAskExpertTool } from '../tools/askExpert.js'
import type { ToolExecutionContext } from '../tools/types.js'

const consultExpert = vi.hoisted(() => vi.fn())
vi.mock('./claudeCli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudeCli.js')>()),
  consultExpert,
}))

const context = { workspaceRoot: '/ws' } as unknown as ToolExecutionContext

/**
 * Raising the budget mid-task takes effect immediately.
 *
 * This is the whole point of putting the control in the chat rather than only in Settings: the
 * moment you want more budget is the moment the assistant has just been cut off, and a limit
 * that only applied to the *next* task would be useless then. The bridge reads the limits
 * through a closure on every call for exactly this reason, so the test drives it the same way.
 */
describe('raising the budget while a task is in progress', () => {
  let spend: ExpertSpend
  let limits: ExpertLimits

  beforeEach(() => {
    consultExpert.mockReset()
    consultExpert.mockResolvedValue({ text: 'advice', sessionId: 's1', deniedTools: [], isError: false })
    spend = { usd: 0, consultations: 0, unpriced: 0 }
    limits = { maxConsultations: 1 }
  })

  function makeTool() {
    return createAskExpertTool({
      cli: { available: true, executable: 'claude' },
      budget: () => checkExpertBudget(spend, limits),
      onConsultation: () => {
        spend = { ...spend, consultations: spend.consultations + 1 }
      },
    })
  }

  it('refuses at the limit, then allows once the limit is raised', async () => {
    const tool = makeTool()

    const first = await tool.execute({ question: 'one' }, context)
    expect(first.isError).not.toBe(true)

    const second = await tool.execute({ question: 'two' }, context)
    expect(second.isError).toBe(true)
    expect(consultExpert).toHaveBeenCalledTimes(1)

    // What the user does in the chat window: raise it, without starting a new task.
    limits = { maxConsultations: 3 }

    const third = await tool.execute({ question: 'three' }, context)
    expect(third.isError).not.toBe(true)
    expect(consultExpert).toHaveBeenCalledTimes(2)
  })

  it('lowering it mid-task stops the next consultation too', async () => {
    const tool = makeTool()
    limits = { maxConsultations: 10 }
    await tool.execute({ question: 'one' }, context)

    // An override that could only ever loosen is not an override.
    limits = { maxConsultations: 1 }
    const blocked = await tool.execute({ question: 'two' }, context)

    expect(blocked.isError).toBe(true)
    expect(consultExpert).toHaveBeenCalledTimes(1)
  })
})
