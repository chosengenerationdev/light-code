import { describe, expect, it } from 'vitest'

import type { ResolvedAgent } from '../agents/team.js'
import { createAskAgentsTool } from './askAgent.js'

const agent = (role: string): ResolvedAgent => ({ role, name: role, summary: '', kind: 'profile', label: `${role}-model`, prompt: '', available: true, usesTools: true, canWrite: false })

/** A parallel box's steps really run at once: every consultation has started before any answers. */
describe('ask_agents', () => {
  it('consults several specialists at the same time, each marked parallel, and labels every answer', async () => {
    const started: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const tool = createAskAgentsTool({
      agents: () => [agent('tester'), agent('reviewer')],
      consult: async (a, request) => {
        started.push(`${a.role}:${String(request.parallel)}`)
        if (started.length === 2) release()
        await gate
        return { advice: `${a.role} says fine`, label: a.label }
      },
    })
    const result = await tool.execute({ requests: [{ role: 'tester', question: 'test it' }, { role: 'reviewer', question: 'review it' }] }, {} as never)
    expect(started).toEqual(['tester:true', 'reviewer:true'])
    expect(result.content).toContain('## tester')
    expect(result.content).toContain('reviewer says fine')
    expect(result.isError).toBeUndefined()
  })

  it('answers an unassigned role as a failure of that request alone', async () => {
    const tool = createAskAgentsTool({ agents: () => [agent('tester')], consult: async (a) => ({ advice: 'ok', label: a.label }) })
    const result = await tool.execute({ requests: [{ role: 'tester', question: 'q' }, { role: 'reviewer', question: 'q' }] }, {} as never)
    expect(result.content).toContain('## reviewer (failed)')
    expect(result.content).toContain('## tester\n\nok')
  })
})
