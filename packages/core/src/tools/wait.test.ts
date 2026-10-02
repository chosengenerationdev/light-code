import { describe, expect, it } from 'vitest'

import { ALWAYS_AVAILABLE_TO_SCHEDULES } from '../schedule/types.js'
import { createDefaultToolRegistry } from './index.js'
import type { ToolExecutionContext } from './types.js'
import { createWaitTool } from './wait.js'

/** A clock that only moves when the tool sleeps, so a 10-minute wait runs instantly. */
function fakeClock() {
  let time = 0
  return { now: () => time, sleep: async (ms: number) => void (time += ms), elapsed: () => time }
}

describe('wait', () => {
  it('waits the time asked and says what it was waiting for', async () => {
    const clock = fakeClock()
    const result = await createWaitTool(clock).execute({ seconds: 600, reason: 'PAY_EOD to finish' }, {} as ToolExecutionContext)
    expect(clock.elapsed()).toBe(600_000)
    expect(result.content).toBe('Waited 600s for PAY_EOD to finish. Check again now.')
  })

  /* A long wait must never make somebody wait for a reply to the message they just sent. */
  it('stops as soon as the user sends something', async () => {
    const clock = fakeClock()
    const context = { hasNewUserInput: () => clock.elapsed() >= 5_000 } as ToolExecutionContext
    const result = await createWaitTool(clock).execute({ seconds: 900 }, context)
    expect(clock.elapsed()).toBe(5_000)
    expect(result.content).toContain('the user has sent something')
  })

  it('stops when the turn is cancelled', async () => {
    const clock = fakeClock()
    const controller = new AbortController()
    controller.abort()
    const result = await createWaitTool(clock).execute({ seconds: 60 }, { signal: controller.signal } as ToolExecutionContext)
    expect(result.isError).toBe(true)
  })

  it('is a built-in that touches nothing, available to scheduled runs, and capped', () => {
    const tool = createDefaultToolRegistry().get('wait')
    expect(tool?.group).toBe('always')
    expect(ALWAYS_AVAILABLE_TO_SCHEDULES).toContain('wait')
    expect(tool?.parametersSchema.safeParse({ seconds: 901 }).success).toBe(false)
  })
})
