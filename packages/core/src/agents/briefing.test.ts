import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildAgentBriefing } from './briefing.js'
import { buildTeamGuidance } from './guidance.js'
import type { ResolvedAgent } from './team.js'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

function agent(role: ResolvedAgent['role'], over: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    role,
    name: role,
    summary: `what the ${role} is for`,
    kind: 'profile',
    label: 'Some Model',
    prompt: 'you are a specialist',
    available: true,
    ...over,
  }
}

describe('what a specialist is told about the rest of the team', () => {
  it('names who is available and who is not', () => {
    const briefing = buildAgentBriefing({
      team: [agent('expert'), agent('reviewer')],
      self: 'expert',
    })

    expect(briefing).toContain('You are the **expert**')
    expect(briefing).toContain('**reviewer**')
    // The three nobody assigned, each said out loud rather than merely left off the list.
    expect(briefing).toContain('**tester** — nobody is assigned')
    expect(briefing).toContain('**programmer** — nobody is assigned')
    expect(briefing).toContain('**librarian** — nobody is assigned')
    expect(briefing).toContain('Not available, so the assistant cannot use them')
    expect(briefing).toContain('Do not put them in a plan')
  })

  /*
   * Reported: the expert produced a good plan that allocated nobody, on a machine where all four
   * other roles were assigned. It had been told who was available and told not to name anyone who
   * was not — so it named nobody, and wrote a plan for the assistant working alone. An
   * instruction that only says what not to do is satisfied by doing nothing.
   */
  it('asks the expert to allocate the specialists that do exist', () => {
    const briefing = buildAgentBriefing({
      team: [agent('expert'), agent('reviewer'), agent('tester')],
      self: 'expert',
    })
    expect(briefing).toContain('say who should be involved in which step')
    // And still bounded: routing every step through everybody is the opposite failure.
    expect(briefing).toContain('ceremony')
  })

  /*
   * Reported: a plan allocated the reviewer and the tester across four steps and the programmer
   * nowhere, with all of them assigned. The instruction asked for allocation where "another
   * reader" would change the outcome and called it "another pair of eyes" — review framing, with
   * a reviewer and a tester as its only examples. The programmer produces rather than reads, so a
   * plan written to that instruction correctly never names it.
   */
  it('asks for the writing role as well as the reading ones', () => {
    const briefing = buildAgentBriefing({
      team: [agent('expert'), agent('programmer'), agent('reviewer'), agent('tester')],
      self: 'expert',
    })
    expect(briefing).toContain('The programmer writes')
    expect(briefing).toContain('self-contained piece of code')
    // And the review framing is still there for the roles it actually describes.
    expect(briefing).toContain('another pair of')
  })

  it('does not ask for an allocation when there is nobody to allocate', () => {
    const briefing = buildAgentBriefing({ team: [agent('expert')], self: 'expert' })
    expect(briefing).not.toContain('say who should be involved in which step')
  })

  it('does not describe the consulted role to itself', () => {
    const briefing = buildAgentBriefing({ team: [agent('expert')], self: 'expert' })
    expect(briefing).not.toContain('**expert** — nobody is assigned')
    expect(briefing).toContain('no other specialists available')
  })

  it('gives the reason when a role is assigned but unreachable', () => {
    const briefing = buildAgentBriefing({
      team: [agent('expert'), agent('tester', { available: false, reason: 'That profile is gone.' })],
      self: 'expert',
    })
    expect(briefing).toContain('**tester** — That profile is gone.')
  })

  it('says nothing at all when there is nothing to say', () => {
    expect(buildAgentBriefing({})).toBe('')
  })
})

describe('what the assistant is told', () => {
  it('names the roles it must not reach for', () => {
    const guidance = buildTeamGuidance([agent('expert')], undefined, false, true)
    expect(guidance).toContain('These are the only ones that exist')
    expect(guidance).toContain('do not plan work for them')
    expect(guidance).toContain('**reviewer** — nobody assigned.')
  })

  /*
   * Reported with a screenshot: asked to build a to-do app in Agent team mode, the assistant
   * opened with "I'll start by understanding the workspace before proposing anything" and spent
   * seven tool calls surveying before any consultation. The build was correct and the guidance
   * was live — step one simply said "reading only what you need in order to ask a good question",
   * which that opening line is very nearly a quotation of. An open licence is not a bound.
   */
  it('bounds the looking around, so the expert is genuinely asked first', () => {
    const guidance = buildTeamGuidance([agent('expert')], undefined, false, false)
    expect(guidance).toContain('Look at almost nothing first')
    expect(guidance).toContain('Do **not** survey the codebase')
    // Named because it is the exact sentence that was produced, and a model reading its own
    // reasonable-sounding plan back should recognise it as the thing being ruled out.
    expect(guidance).toContain('getting a sense of the workspace before proposing anything')
  })

  it('says what is missing even when the whole team is unassigned', () => {
    const guidance = buildTeamGuidance([], undefined, false, true)
    expect(guidance).toContain('Nobody is assigned yet')
    expect(guidance).toContain('**expert** — nobody assigned.')
  })

  it('treats an assigned-but-broken role as unavailable, not as available', () => {
    const guidance = buildTeamGuidance(
      [agent('reviewer', { available: false, reason: 'No such profile.' })],
      undefined,
      false,
      true,
    )
    expect(guidance).toContain('**reviewer** — No such profile.')
    expect(guidance).not.toContain('(Some Model) — what the reviewer is for')
  })
})

describe('the expert is told the same thing whichever model it is', () => {
  /*
   * The request was explicit that this must hold when another provider is made the expert.
   *
   * It holds by construction — `consultAgent` assembles the prompt, briefing included, *above*
   * the `kind` branch, so the Claude CLI and a provider profile are handed the same text. That is
   * easy to undo by accident, and the symptom would be invisible: switching expert would quietly
   * produce worse plans, with nothing to point at. So it is pinned by reading the source, the way
   * a missing call has to be.
   */
  const bridge = read('../host/bridge.ts')
  const body = bridge.slice(bridge.indexOf('async function consultAgent'))
  const briefingAt = body.indexOf('buildAgentBriefing(')
  const branchAt = body.indexOf("if (agent.kind === 'cli')")

  it('builds the briefing before it decides which kind of expert to call', () => {
    expect(briefingAt).toBeGreaterThan(-1)
    expect(branchAt).toBeGreaterThan(-1)
    expect(briefingAt).toBeLessThan(branchAt)
  })

  it('passes the team and the role being consulted', () => {
    const call = body.slice(briefingAt, branchAt)
    expect(call).toContain('team: cachedTeam')
    expect(call).toContain('self: agent.role')
  })
})
