import { describe, expect, it } from 'vitest'

import { branchChoice, describeStrategy, type Strategy } from '../strategy/strategy.js'
import type { Decision } from './decide.js'
import { describeStep } from './firstPass.js'
import { describeSuggestions, handoverQuestion, newWorkQuestion, NOTHING_OPTION, picked, roleSuggestion, skillQuestion, toolQuestion, triageQuestion } from './more.js'
import { MAIN_OPTION } from './route.js'

/** Asked for: "please implement the pending ones too" - the rest of the decision model's uses. */

const best = (id: string, probability: number): Decision => ({ ok: true, best: { id, probability }, source: 'logprobs', raw: '', ms: 1 })

describe('role suggestions during a turn', () => {
  it('suggests another specialist only when sure, and never the one asked or the main assistant', () => {
    const name = (role: string): string => ({ tester: 'Tester', dba: 'Database expert' })[role] ?? role
    expect(roleSuggestion(best('dba', 0.9), 'tester', 0.75, name)).toContain('Database expert (`dba`) may fit this question better than Tester')
    expect(roleSuggestion(best('tester', 0.95), 'tester', 0.75, name)).toBeUndefined()
    expect(roleSuggestion(best(MAIN_OPTION, 0.95), 'tester', 0.75, name)).toBeUndefined()
    expect(roleSuggestion(best('dba', 0.6), 'tester', 0.75, name)).toBeUndefined()
  })
})

describe('the questions', () => {
  it('asks a score for a hand-over, yes/no for new work and for triage', () => {
    expect(handoverQuestion('the changed functions', 'I changed round()').kind).toBe('score')
    expect(newWorkQuestion('fix rounding', 'write the release notes').inputs?.text).toContain('Old plan:\nfix rounding')
    expect(triageQuestion({ monitor: 'Disk', level: 'Red' }).inputs?.json).toEqual({ monitor: 'Disk', level: 'Red' })
  })

  it("describes the Anti Hallucinator's step for the first pass", () => {
    const text = describeStep(
      [
        { kind: 'toolCall', at: 1, tool: 'run_tests', args: '{}' },
        { kind: 'toolResult', at: 2, tool: 'run_tests', ok: false, text: '2 failed' },
        { kind: 'assistant', at: 3, text: 'All tests pass.' },
      ],
      'fix the tests',
    )
    expect(text).toContain("User's request: fix the tests")
    expect(text).toContain('run_tests returned an error: 2 failed')
    expect(text).toContain('Assistant said: All tests pass.')
  })
})

describe('decision steps in a strategy', () => {
  const strategy = {
    id: 's',
    name: 'review',
    nodes: [
      { id: 'r', role: 'reviewer', x: 0, y: 0, decides: true, decisionQuestion: 'Did the review find a security problem?' },
      { id: 's', role: 'security', x: 1, y: 0 },
      { id: 'w', role: 'writer', x: 2, y: 0 },
    ],
    edges: [
      { id: 'e1', from: 'r', to: 's', label: 'security issue found' },
      { id: 'e2', from: 'r', to: 'w', label: 'all clear' },
    ],
  } as unknown as Strategy
  const name = (role: string): string => role[0]!.toUpperCase() + role.slice(1)

  it('offers each way on, by where it leads and its label', () => {
    const choice = branchChoice(strategy, 'reviewer', name)!
    expect(choice.question).toBe('Did the review find a security problem?')
    expect(choice.options).toEqual([
      { id: 'e1', label: 'Security', description: 'security issue found' },
      { id: 'e2', label: 'Writer', description: 'all clear' },
    ])
    expect(branchChoice(strategy, 'writer', name)).toBeUndefined()
  })

  it('tells the main agent the step decides, and changes nothing for a strategy without one', () => {
    expect(describeStrategy(strategy, name)).toContain('a decision step: once it answers, the decision model picks which way to go')
    const plain = { ...strategy, nodes: strategy.nodes.map((node) => ({ ...node, decides: undefined })) } as Strategy
    expect(describeStrategy(plain, name)).not.toContain('decision')
  })
})

describe('the skill and tool a request needs', () => {
  const probabilities = (p: Record<string, number>): Decision => {
    const top = Object.entries(p).sort((a, b) => b[1] - a[1])[0]!
    return { ok: true, probabilities: p, best: { id: top[0], probability: top[1] }, source: 'systemone', raw: '', ms: 1 }
  }

  it('offers "nothing in particular" first, and suggests nothing when it wins', () => {
    expect(skillQuestion('deploy it', [{ name: 'deploy', description: 'How we deploy. Steps follow.' }]).options?.map((o) => o.id)).toEqual([NOTHING_OPTION, 'deploy'])
    expect(picked(probabilities({ [NOTHING_OPTION]: 0.7, deploy: 0.3 }))).toEqual([])
  })

  it('suggests what is clearly ahead, best first, at most three, and says how to reach a hidden tool', () => {
    expect(picked(probabilities({ [NOTHING_OPTION]: 0.05, jira_search: 0.6, jira_issue: 0.3, read_file: 0.05 })).map((p) => p.id)).toEqual(['jira_search', 'jira_issue'])
    const text = describeSuggestions([{ id: 'deploy', probability: 0.8, filePath: 'C:/s/deploy.md' }], [{ id: 'jira_search', probability: 0.6, hidden: true }])
    expect(text).toContain('skill `deploy` (0.80) - read C:/s/deploy.md first')
    expect(text).toContain('tool `jira_search` (0.60) - its parameters come from search_docs, then call it through call_tool')
    expect(describeSuggestions([], [])).toBe('')
    expect(toolQuestion('x', [{ name: 'a', description: 'Does a.' }]).question).toBe('Which tool does this request need most?')
  })
})
