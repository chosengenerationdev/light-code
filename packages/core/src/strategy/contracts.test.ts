import { describe, expect, it } from 'vitest'

import { applyContracts, createSetStrategyContractsTool } from './contractsTool.js'
import { askForMissing, beforeConsult, contractCheck, describeStrategy, missingItems, type Strategy } from './strategy.js'

const names: Record<string, string> = { programmer: 'Programmer', tester: 'Tester', reviewer: 'Reviewer' }
const name = (role: string): string => names[role] ?? role

const strategy: Strategy = {
  id: 's',
  name: 'TDD',
  updatedAt: 0,
  nodes: [
    { id: 'p', role: 'programmer', x: 0, y: 0 },
    { id: 't', role: 'tester', x: 200, y: 0 },
    { id: 'r', role: 'reviewer', x: 400, y: 0 },
  ],
  edges: [
    { id: 'pt', from: 'p', to: 't', twoWay: true, until: 'tests pass', requires: ['Changed files', 'Tests run'] },
    { id: 'tr', from: 't', to: 'r' },
  ],
}

describe('checked contracts', () => {
  it('finds an item given as a line, a heading with content, or bold - and not one merely mentioned', () => {
    expect(missingItems('Changed files: a.ts\nTests run - test_round', ['Changed files', 'Tests run'])).toEqual([])
    expect(missingItems('## Changed files\n- a.ts\n\n**Tests run:** none yet', ['Changed files', 'Tests run'])).toEqual([])
    expect(missingItems('I changed files a.ts and b.ts.', ['Changed files'])).toEqual(['Changed files'])
    expect(missingItems('Changed files:\n## Next heading', ['Changed files'])).toEqual(['Changed files'])
    expect(missingItems('changed FILES: x', ['Changed files'])).toEqual([])
  })

  it('checks only the contracts a role sends along, and names what is missing', () => {
    expect(contractCheck(strategy, 'programmer', 'Changed files: a.ts')).toEqual([{ edgeId: 'pt', to: 'tester', required: ['Changed files', 'Tests run'], missing: ['Tests run'] }])
    expect(contractCheck(strategy, 'tester', 'anything')).toEqual([])
  })

  it('tells the sender the format the check reads, and the agent which items are required', () => {
    const asked = beforeConsult(strategy, {}, undefined, 'programmer', name).addToPrompt
    expect(asked).toContain('Changed files: ...\nTests run: ...')
    expect(asked).toContain('will ask you again')
    expect(describeStrategy(strategy, name)).toContain('Required in every hand-over: Changed files, Tests run.')
    expect(askForMissing(['Tests run'], 'old answer')).toContain('"Tests run: ..."')
    expect(askForMissing(['Tests run'], 'old answer')).toContain('old answer')
  })
})

describe('set_strategy_contracts', () => {
  it('sets a contract by the two roles it joins - either way round for a back-and-forth - and says what it left alone', () => {
    const { strategy: next, lines, unknown } = applyContracts(
      strategy,
      { contracts: [{ from: 'tester', to: 'programmer', requires: ['Failing tests'] }, { from: 'Tester', to: 'reviewer', contract: 'the test report' }, { from: 'reviewer', to: 'expert', contract: 'x' }] },
      name,
    )
    expect(next.edges.find((e) => e.id === 'pt')?.requires).toEqual(['Failing tests'])
    expect(next.edges.find((e) => e.id === 'tr')?.contract).toBe('the test report')
    expect(lines.join('\n')).toContain('required: Changed files, Tests run  →  Failing tests')
    expect(unknown).toEqual(['Reviewer → expert'])
  })

  it('shows the change before it is approved, and applies it to this chat only when run', async () => {
    let current: Strategy | undefined = strategy
    const tool = createSetStrategyContractsTool({ current: () => current, apply: async (next) => void (current = next), roleName: name })
    expect(tool.group).toBe('edit')
    const preview = await tool.preview?.({ contracts: [{ from: 'tester', to: 'reviewer', contract: 'the report', requires: ['Result'] }] }, {} as never)
    expect(preview).toMatchObject({ kind: 'text' })
    expect((preview as { text: string }).text).toContain('contract: (none)  →  the report')
    expect(current.edges.find((e) => e.id === 'tr')?.contract).toBeUndefined()
    await tool.execute({ contracts: [{ from: 'tester', to: 'reviewer', contract: 'the report', requires: ['Result'] }] }, {} as never)
    expect(current.edges.find((e) => e.id === 'tr')).toMatchObject({ contract: 'the report', requires: ['Result'] })
  })
})
