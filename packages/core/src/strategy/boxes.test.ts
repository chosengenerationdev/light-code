import { describe, expect, it } from 'vitest'

import { applyContracts } from './contractsTool.js'
import { answerForMain, beforeConsult, contractCheck, describeStrategy, handOverSources, strategyOrder, strategyProblems, type Strategy } from './strategy.js'

/**
 * Boxes as steps of the flow - asked for: "there is no arrow connecting option from parallel box to another agent or
 * another box, introduce normal boxes that can have group of agent under it, when they all completed then it can flow
 * to next agent that is connected to box".
 *
 * expert -> [parallel: tester, reviewer] -> [together: programmer -> documenter] -> expert-final
 */
const names: Record<string, string> = { expert: 'Expert', programmer: 'Programmer', tester: 'Tester', reviewer: 'Reviewer', documenter: 'Documenter', librarian: 'Librarian' }
const name = (role: string): string => names[role] ?? role

const strategy: Strategy = {
  id: 's',
  name: 'Boxes',
  updatedAt: 0,
  groups: [
    { id: 'gp', label: 'Checks', kind: 'parallel', x: 200, y: 0, w: 400, h: 120 },
    { id: 'gt', label: 'Build', kind: 'together', x: 700, y: 0, w: 400, h: 120 },
  ],
  nodes: [
    { id: 'n1', role: 'expert', x: 0, y: 20 },
    { id: 'n2', role: 'tester', x: 220, y: 40, group: 'gp' },
    { id: 'n3', role: 'reviewer', x: 420, y: 40, group: 'gp' },
    // Drawn right-to-left on purpose: the connector inside decides the order, not the canvas.
    { id: 'n5', role: 'documenter', x: 720, y: 40, group: 'gt' },
    { id: 'n4', role: 'programmer', x: 920, y: 40, group: 'gt' },
    { id: 'n6', role: 'librarian', x: 1200, y: 20 },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'gp', contract: 'the plan' },
    { id: 'e2', from: 'gp', to: 'gt', contract: 'the findings', requires: ['Findings'] },
    { id: 'e3', from: 'n4', to: 'n5' },
    { id: 'e4', from: 'gt', to: 'n6', requires: ['Changed files'] },
  ],
}

describe('a box as a step of the flow', () => {
  it('orders a box as one unit, its steps together and in their own order', () => {
    expect(strategyOrder(strategy).map((n) => n.role)).toEqual(['expert', 'tester', 'reviewer', 'programmer', 'documenter', 'librarian'])
  })

  it('tells the main agent what each box waits for and where the flow goes once all inside have answered', () => {
    const text = describeStrategy(strategy, name)
    expect(text).toContain('1. Expert - what it does here is yours to plan; then the box "Checks" (steps 2, 3) (passing on: the plan)')
    expect(text).toContain('The box "Checks" (steps 2, 3) - consulted together, in ONE ask_agents call, after Expert (step 1):')
    expect(text).toContain('The box "Build" (steps 4, 5) - done as a group, in the order below, after the box "Checks" (steps 2, 3):')
    expect(text).toContain('When every step in the box "Checks" (steps 2, 3) has answered: then the box "Build" (steps 4, 5) (passing on: the findings)')
    expect(text).toContain('When every step in the box "Build" (steps 4, 5) has answered: then Librarian (step 6)')
    // Only the parallel box is listed as parallel.
    expect(text).toMatch(/In parallel[^\n]*\n- Checks: Tester \(step 2\), Reviewer \(step 3\)\n/)
    expect(text).not.toContain('- Build:')
  })

  it('tells every step inside a box what arrives and what it passes on', () => {
    const tester = beforeConsult(strategy, {}, undefined, 'tester', name).addToPrompt
    expect(tester).toContain('From Expert you are given, as agreed: the plan.')
    expect(tester).toContain('Your answer, with the others from the box "Checks" (Tester, Reviewer), is passed on to the box "Build" (Documenter, Programmer). As agreed, together they must contain: the findings; each of Findings. Give your part of it.')
    const reviewer = beforeConsult(strategy, {}, undefined, 'reviewer', name).addToPrompt
    expect(reviewer).toContain('From Expert you are given, as agreed: the plan.')
    // A step whose box leads on with only required items still hears them, and no single answer is checked for them.
    expect(beforeConsult(strategy, {}, undefined, 'programmer', name).addToPrompt).toContain('each of Changed files')
    expect(contractCheck(strategy, 'programmer', 'nothing here')).toEqual([])
  })

  it('checks required items on a connector from a step into a box', () => {
    const toBox: Strategy = { ...strategy, edges: [...strategy.edges, { id: 'e5', from: 'n1', to: 'gt', requires: ['Scope'] }] }
    expect(beforeConsult(toBox, {}, undefined, 'expert', name).addToPrompt).toContain('Required in your answer for the box "Build" (Documenter, Programmer)')
    expect(contractCheck(toBox, 'expert', 'no scope')).toEqual([{ edgeId: 'e5', to: 'Build', required: ['Scope'], missing: ['Scope'] }])
  })

  it('accepts connectors to and from boxes, and names the ones that cannot work', () => {
    const roles = new Set(Object.keys(names))
    expect(strategyProblems(strategy, roles, roles)).toEqual([])
    const bad: Strategy = {
      ...strategy,
      edges: [
        ...strategy.edges,
        { id: 'x1', from: 'n2', to: 'gp' },
        { id: 'x2', from: 'gp', to: 'n6', twoWay: true },
      ],
    }
    const problems = strategyProblems(bad, roles, roles)
    expect(problems).toContain('A connector joins a box to a step inside it; connect the steps inside to each other instead.')
    expect(problems).toContain('A back-and-forth joins two steps, not a box: connect it to one step inside the box.')
  })

  it('lets one role appear twice in a box that is not parallel', () => {
    const roles = new Set(Object.keys(names))
    const twice: Strategy = { ...strategy, nodes: [...strategy.nodes, { id: 'n7', role: 'programmer', x: 820, y: 60, group: 'gt' }] }
    expect(strategyProblems(twice, roles, roles)).toEqual([])
    const inParallel: Strategy = { ...strategy, nodes: [...strategy.nodes, { id: 'n7', role: 'tester', x: 320, y: 60, group: 'gp' }] }
    expect(strategyProblems(inParallel, roles, roles).join(' ')).toContain('holds one role twice')
  })

  it('lets the main agent set a contract on a connector out of a box, named by the box', () => {
    const { strategy: next, unknown } = applyContracts(strategy, { contracts: [{ from: 'Build', to: 'librarian', contract: 'the release notes' }] }, name)
    expect(unknown).toEqual([])
    expect(next.edges.find((e) => e.id === 'e4')?.contract).toBe('the release notes')
  })

  it('reads a box saved before kinds existed as a parallel one', () => {
    const old: Strategy = { ...strategy, groups: [{ id: 'gp', label: 'Checks', x: 200, y: 0, w: 400, h: 120 }], edges: [], nodes: strategy.nodes.filter((n) => n.group === 'gp') }
    expect(describeStrategy(old, name)).toContain('consulted together, in ONE ask_agents call')
  })
})

describe('a custom role in a strategy', () => {
  it("names the id ask_agent takes beside the role's name", () => {
    const custom: Strategy = { id: 'c', name: 'Custom', updatedAt: 0, nodes: [{ id: 'a', role: 'security-reviewer', x: 0, y: 0 }, { id: 'b', role: 'programmer', x: 200, y: 0 }], edges: [{ id: 'e', from: 'a', to: 'b' }] }
    const text = describeStrategy(custom, (role) => (role === 'security-reviewer' ? 'Security Reviewer' : name(role)))
    expect(text).toContain('1. Security Reviewer (ask_agent role "security-reviewer")')
    // A built-in role's name is its id, so nothing is added.
    expect(text).toContain('2. Programmer - ')
  })
})

describe('hand-overs between specialists', () => {
  it('hands a step the answers of the steps connected into it, a box its sources, and a loop each side the other', () => {
    expect(handOverSources(strategy, 'tester').sort()).toEqual(['expert'])
    expect(handOverSources(strategy, 'programmer').sort()).toEqual(['reviewer', 'tester'])
    expect(handOverSources(strategy, 'librarian').sort()).toEqual(['documenter', 'programmer'])
    expect(handOverSources(strategy, 'expert')).toEqual([])
    const loop: Strategy = { id: 'l', name: 'Loop', updatedAt: 0, nodes: [{ id: 'p', role: 'programmer', x: 0, y: 0 }, { id: 't', role: 'tester', x: 200, y: 0 }], edges: [{ id: 'e', from: 'p', to: 't', twoWay: true }] }
    expect(handOverSources(loop, 'tester')).toEqual(['programmer'])
    expect(handOverSources(loop, 'programmer')).toEqual(['tester'])
  })
})

describe('what the main agent is given of an answer', () => {
  const long = `${'Detail line.\n'.repeat(400)}`
  it('is the summary section when there is one, with a pointer to the rest', () => {
    const answer = `${long}\n## Summary for the main agent:\n- Renamed invoice.ts\n- Needs a decision on the old export`
    const given = answerForMain(answer, 'Programmer')
    expect(given).toContain('- Renamed invoice.ts')
    expect(given).not.toContain('Detail line.')
    expect(given).toContain("The Programmer's full answer")
  })

  it('is the whole answer when it is short', () => {
    expect(answerForMain('Done: renamed it.', 'Programmer')).toBe('Done: renamed it.')
  })

  it('is the beginning of a long answer with no summary, said so', () => {
    const given = answerForMain(long, 'Programmer')
    expect(given.length).toBeLessThan(2_400)
    expect(given).toContain('Shortened for you')
  })
})
