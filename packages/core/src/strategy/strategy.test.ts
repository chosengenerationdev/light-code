import { describe, expect, it } from 'vitest'

import { afterConsult, beforeConsult, describeStrategy, exchangeOf, readVerdict, strategyOrder, strategyProblems, strategySchema, type Strategy, type StrategyProgress } from './strategy.js'

const names: Record<string, string> = { expert: 'Expert', programmer: 'Programmer', tester: 'Tester', reviewer: 'Reviewer' }
const name = (role: string): string => names[role] ?? role

/** expert -> programmer <-> tester (until tests pass, max 3) -> reviewer (read-only) */
const strategy: Strategy = {
  id: 's1',
  name: 'Test-driven',
  updatedAt: 0,
  nodes: [
    { id: 'n1', role: 'expert', x: 0, y: 0, instructions: 'plan the change' },
    { id: 'n2', role: 'programmer', x: 200, y: 0 },
    { id: 'n3', role: 'tester', x: 400, y: 0 },
    { id: 'n4', role: 'reviewer', x: 600, y: 0, readOnly: true },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2' },
    { id: 'e2', from: 'n2', to: 'n3', twoWay: true, maxRounds: 3, until: 'every test passes' },
    { id: 'e3', from: 'n3', to: 'n4' },
  ],
}

describe('reading the chart', () => {
  it('orders steps along the connectors, and tells the agent to plan by them', () => {
    expect(strategyOrder(strategy).map((n) => n.role)).toEqual(['expert', 'programmer', 'tester', 'reviewer'])
    const text = describeStrategy(strategy, name)
    expect(text).toContain('1. Expert - the user\'s instructions for it: "plan the change"; then Programmer (step 2)')
    expect(text).toContain('2. Programmer - what it does here is yours to plan')
    expect(text).toContain('4. Reviewer - read-only: may not change anything')
    expect(text).toContain('Repeat until: "every test passes" (judged by Tester (step 3)), at most 3 rounds')
    expect(text).toContain('propose a plan with update_plan')
  })

  it('names what keeps a strategy from running', () => {
    const problems = strategyProblems({ ...strategy, edges: [...strategy.edges, { id: 'x', from: 'n1', to: 'gone' }] }, new Set(Object.keys(names)), new Set(['expert', 'programmer', 'tester']))
    expect(problems).toContain('Nobody is assigned to reviewer: give it a model in Settings → Agents.')
    expect(problems).toContain('A connector points at a step that is not there.')
    expect(strategyProblems({ ...strategy, nodes: [] , edges: [] }, new Set(), new Set())).toEqual(['It has no steps: add at least one role.'])
  })

  it('validates what the window saves', () => {
    expect(strategySchema.safeParse(strategy).success).toBe(true)
    expect(strategySchema.safeParse({ ...strategy, edges: [{ id: 'e', from: 'a', to: 'b', maxRounds: 0 }] }).success).toBe(false)
  })
})

describe('a back-and-forth', () => {
  it('reads the verdict line however a model formats it', () => {
    expect(readVerdict('Looks good.\nCONDITION: MET')).toEqual({ met: true, detail: '' })
    expect(readVerdict('**CONDITION: NOT MET** - two tests fail')).toEqual({ met: false, detail: 'two tests fail' })
    expect(readVerdict('condition: not met: login test fails')?.met).toBe(false)
    expect(readVerdict('no verdict here')).toBeUndefined()
  })

  it('asks the judge for a verdict, counts rounds from consultations that ran, and refuses one past the maximum', () => {
    let progress: StrategyProgress = {}
    let last: string | undefined
    const consult = (role: string, answer: string): string | undefined => {
      const before = beforeConsult(strategy, progress, last, role, name)
      if (before.refuse !== undefined) return `REFUSED: ${before.refuse}`
      const after = afterConsult(strategy, progress, role, answer, name)
      progress = after.progress
      last = role
      return after.note
    }
    expect(beforeConsult(strategy, progress, undefined, 'tester', name).addToPrompt).toContain('CONDITION: MET')
    consult('programmer', 'done')
    expect(consult('tester', 'CONDITION: NOT MET - 2 fail')).toContain('round 1 of 3 - not met - 2 fail')
    consult('programmer', 'fixed')
    consult('tester', 'CONDITION: NOT MET - 1 fails')
    consult('programmer', 'fixed again')
    expect(consult('tester', 'CONDITION: NOT MET - still 1')).toContain('all 3 rounds used')
    expect(consult('programmer', 'once more')).toMatch(/^REFUSED: The strategy allows at most 3 rounds/)
    // The rest of the strategy still runs.
    expect(consult('reviewer', 'fine')).toBeUndefined()
  })

  it('ends the loop when the judge says the condition is met', () => {
    const after = afterConsult(strategy, { e2: { rounds: 0, awaiting: true } }, 'tester', 'All green.\nCONDITION: MET', name)
    expect(after.progress['e2']).toMatchObject({ rounds: 1, met: true })
    expect(after.note).toContain('This loop is done')
  })

  it('makes a read-only step read-only, and says so to it', () => {
    const plan = beforeConsult(strategy, {}, 'tester', 'reviewer', name)
    expect(plan.readOnly).toBe(true)
    expect(plan.addToPrompt).toContain('read-only')
    expect(beforeConsult(strategy, {}, undefined, 'programmer', name).readOnly).toBe(false)
  })

  it("hands a step's instructions to its specialist", () => {
    expect(beforeConsult(strategy, {}, undefined, 'expert', name).addToPrompt).toBe("The user's instructions for you in this strategy:\nplan the change")
    expect(beforeConsult(strategy, {}, undefined, 'programmer', name).addToPrompt).toBe('')
  })
})

describe('contracts, parallel boxes and the exchange log', () => {
  const withContract: Strategy = {
    ...strategy,
    edges: strategy.edges.map((e) => (e.id === 'e2' ? { ...e, contract: 'the failing tests with file:line' } : e)),
    groups: [{ id: 'g', label: 'Review together', x: 0, y: 0, w: 900, h: 100 }],
    nodes: strategy.nodes.map((n) => (n.role === 'tester' || n.role === 'reviewer' ? { ...n, group: 'g' } : n)),
  }

  it('tells both ends of a connector what was agreed to pass along it', () => {
    expect(beforeConsult(withContract, {}, undefined, 'programmer', name).addToPrompt).toContain('Your answer is passed on to Tester. As agreed, it must contain: the failing tests with file:line')
    expect(beforeConsult(withContract, {}, undefined, 'tester', name).addToPrompt).toContain('From Programmer you are given, as agreed: the failing tests with file:line')
    expect(describeStrategy(withContract, name)).toContain('Each round Programmer (step 2) passes on: the failing tests with file:line.')
  })

  it('says which steps run together, and refuses one role twice in a box', () => {
    expect(describeStrategy(withContract, name)).toContain('- Review together: Tester (step 3), Reviewer (step 4)')
    expect(describeStrategy(withContract, name)).toContain('ONE ask_agents call')
    const twice: Strategy = { ...withContract, nodes: withContract.nodes.map((n) => (n.role === 'reviewer' ? { ...n, role: 'tester' } : n)) }
    expect(strategyProblems(twice, new Set(Object.keys(names)), new Set(Object.keys(names))).join(' ')).toContain('holds one role twice')
  })

  it('records an exchange with the loop it moved', () => {
    const after = afterConsult(strategy, { e2: { rounds: 0, awaiting: true } }, 'tester', 'CONDITION: NOT MET - 1 fails', name)
    const exchange = exchangeOf('tester', 'q', 'CONDITION: NOT MET - 1 fails', { e2: { rounds: 0, awaiting: true } }, after.progress, true)
    expect(exchange).toMatchObject({ role: 'tester', parallel: true, loops: [{ edgeId: 'e2', rounds: 1, met: false }] })
    expect(exchangeOf('x', 'a'.repeat(5000), 'b', {}, {}, false).question.length).toBeLessThan(4_100)
  })
})

