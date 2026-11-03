import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Reported: "why chat agent doesnt know about the strategy that is setup?" Three faults, none visible to a test of
 * the strategy itself, because each was the strategy *not reaching* the prompt - so this reads the bridge, as
 * `config/retrieval.test.ts` and `usage/usageWiring.test.ts` do for their wiring.
 */
const bridge = fs.readFileSync(path.join(import.meta.dirname, '..', 'host', 'bridge.ts'), 'utf8').replace(/\r\n/g, '\n')

function slice(start: string, end: string): string {
  const from = bridge.indexOf(start)
  expect(from, start).toBeGreaterThan(-1)
  return bridge.slice(from, bridge.indexOf(end, from))
}

describe('the strategy reaches the main agent', () => {
  it('in every mode, not only Agent team', () => {
    const prompt = slice('...(activeStrategy !== undefined', '\n          : {}),')
    expect(prompt).toContain('describeStrategy(activeStrategy')
    expect(prompt).not.toContain('AGENT_TEAM_MODE')
  })

  it('and survives a scheduled run, which sets the chat aside and must give its plan and strategy back', () => {
    const run = slice('const saved = {', 'runningScheduleId = undefined\n      runStartedAt = undefined')
    for (const field of ['plan: activePlan', 'strategy: activeStrategy', 'strategyProgress', 'strategyExchanges']) expect(run).toContain(field)
    for (const back of ['activePlan = saved.plan', 'activeStrategy = saved.strategy', 'strategyProgress = saved.strategyProgress', 'strategyExchanges = saved.strategyExchanges']) expect(run).toContain(back)
  })

  it('and moves into the new chat a handoff starts', () => {
    const handoff = slice("progress('starting')", 'composeHandoff(')
    expect(handoff).toContain('const carried = { strategy: activeStrategy')
    expect(handoff).toContain('activeStrategy = carried.strategy')
  })
})
