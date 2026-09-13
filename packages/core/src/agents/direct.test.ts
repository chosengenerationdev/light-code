import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describeDirectedRoles, findDirectedRoles } from './direct.js'
import type { ResolvedAgent } from './team.js'

function agent(role: string, over: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    role,
    name: role,
    summary: `the ${role}`,
    kind: 'profile',
    label: 'Gateway',
    prompt: '',
    available: true,
    usesTools: false,
    canWrite: false,
    ...over,
  }
}

const TEAM = [agent('expert'), agent('reviewer'), agent('tester', { available: false })]

describe('addressing a specialist with #', () => {
  it('finds one at the start of a message and mid-sentence', () => {
    expect(findDirectedRoles('#reviewer look at this', TEAM).addressed).toEqual(['reviewer'])
    expect(findDirectedRoles('and then #expert should plan it', TEAM).addressed).toEqual(['expert'])
  })

  it('finds several, without repeating one', () => {
    const found = findDirectedRoles('#reviewer and #expert and #reviewer again', TEAM)
    expect(found.addressed).toEqual(['reviewer', 'expert'])
  })

  /*
   * The reason the pattern is a role id and not "anything after a hash". A message full of `#2`
   * and `#include` is ordinary text, and a feature that reported those as unknown specialists
   * would be unusable in any conversation about code.
   */
  it('ignores a # that is not addressing anybody', () => {
    const found = findDirectedRoles('#include <stdio.h> and issue #42 and #1', TEAM)
    expect(found.addressed).toEqual([])
    expect(found.unknown).toEqual([])
  })

  it('ignores a hash inside a word', () => {
    expect(findDirectedRoles('see issue#reviewer', TEAM).addressed).toEqual([])
  })

  /*
   * An unavailable role is reported, not silently dropped. Dropping it produces a message that
   * does nothing unusual, which reads as the feature being broken rather than the role being
   * unassigned — the failure this codebase keeps producing in other places.
   */
  it('reports a role that cannot answer, and names who can', () => {
    const found = findDirectedRoles('#tester what breaks?', TEAM)
    expect(found.addressed).toEqual([])
    expect(found.unknown).toEqual(['tester'])

    const text = describeDirectedRoles(found, TEAM)
    expect(text).toContain('#tester')
    expect(text).toContain('expert, reviewer')
  })

  it('says so plainly when nobody is assigned at all', () => {
    const found = findDirectedRoles('#reviewer please', [])
    // With no team, a stray `#word` is not a failed address — it is just text.
    expect(found.unknown).toEqual([])
    expect(describeDirectedRoles(found, [])).toBe('')
  })

  /*
   * The narrowing that made `#include` safe also makes a typo silent. Recorded rather than
   * hidden: the picker is what prevents typos, and flagging every hash-shaped word was much the
   * worse of the two failures in a product people paste code into.
   */
  it('says nothing about a name that is not a role here', () => {
    const found = findDirectedRoles('#reviewr look at this', TEAM)
    expect(found.addressed).toEqual([])
    expect(found.unknown).toEqual([])
  })
})

describe('what the assistant is told', () => {
  it('treats it as decided rather than as a suggestion', () => {
    const text = describeDirectedRoles(findDirectedRoles('#reviewer look', TEAM), TEAM)
    expect(text).toContain('`ask_agent`')
    // The mode guidance spends its effort on whether a consultation is worth a round trip. This
    // is the case where that judgement was already made by the person who typed the name.
    expect(text).toContain('not a judgement call')
    expect(text).toContain('what came back')
  })

  it('says nothing at all when nothing was addressed', () => {
    expect(describeDirectedRoles(findDirectedRoles('just a message', TEAM), TEAM)).toBe('')
  })
})

describe('the wiring', () => {
  const bridge = readFileSync(fileURLToPath(new URL('../host/bridge.ts', import.meta.url)), 'utf8')

  /*
   * Resolved host-side, beside `@` mentions and for the same reason (§18): the user named the
   * specialist, so there is nothing for the model to decide. A missing call here is invisible —
   * the message simply sends without the direction, and the assistant answers as if nothing had
   * been asked of anybody.
   */
  it('resolves the message before it is sent', () => {
    expect(bridge).toContain('findDirectedRoles(text, cachedTeam)')
    expect(bridge).toContain('describeDirectedRoles(directed, cachedTeam)')
    const at = bridge.indexOf('findDirectedRoles(text, cachedTeam)')
    const used = bridge.indexOf('const messageText', at)
    expect(used).toBeGreaterThan(at)
  })
})
