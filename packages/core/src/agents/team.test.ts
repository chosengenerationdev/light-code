import { describe, expect, it } from 'vitest'

import { buildAgentBriefing } from './briefing.js'
import { buildTeamGuidance, DEFAULT_TEAM_GUIDANCE } from './guidance.js'
import {
  AGENT_ROLES,
  buildAgentPrompt,
  defaultPromptFor,
  isAgentRole,
  specialistPreamble,
} from './roles.js'
import { availableAgents, budgetMatters, resolveTeam, type TeamContext } from './team.js'

const PROFILES = [
  { id: 'gw', label: 'Corporate gateway' },
  { id: 'local', label: 'Local qwen' },
]

function context(partial: Partial<TeamContext> = {}): TeamContext {
  return { config: undefined, profiles: PROFILES, cliAvailable: false, ...partial }
}

describe('who answers a role', () => {
  /**
   * The one default, and it is deliberately the only one.
   *
   * Filling the other roles with whatever profile happens to be active would look helpful and be
   * a trap: the point of a specialist is a *second* reader, and a team where every member is the
   * model already doing the work is four extra round trips that agree with it.
   */
  it('assigns Claude to the expert when it is there, and nobody else anywhere', () => {
    const team = resolveTeam(context({ cliAvailable: true }))
    expect(team.map((agent) => agent.role)).toEqual(['expert'])
    expect(team[0]?.kind).toBe('cli')
  })

  it('assigns nobody at all when there is no Claude', () => {
    expect(resolveTeam(context())).toEqual([])
  })

  /** Claude is a default, never a definition — the point of the rework. */
  it('lets a provider be the expert instead of Claude', () => {
    const team = resolveTeam(
      context({
        cliAvailable: true,
        config: { roles: { expert: { kind: 'profile', profileId: 'gw' } } },
      }),
    )
    expect(team[0]?.kind).toBe('profile')
    expect(team[0]?.label).toBe('Corporate gateway')
  })

  it('resolves each role to the profile it was given', () => {
    const team = resolveTeam(
      context({
        config: {
          roles: {
            reviewer: { kind: 'profile', profileId: 'gw' },
            tester: { kind: 'profile', profileId: 'local' },
          },
        },
      }),
    )
    expect(team.map((agent) => `${agent.role}:${agent.label}`)).toEqual([
      'reviewer:Corporate gateway',
      'tester:Local qwen',
    ])
  })

  /**
   * A deleted profile leaves the role unavailable and says so.
   *
   * Never a fall back to the model already doing the work: a specialist that is quietly the
   * primary model gives advice with nothing to distrust about it, which is worse than none.
   */
  it('marks a role unavailable when its profile has gone', () => {
    const team = resolveTeam(
      context({ config: { roles: { reviewer: { kind: 'profile', profileId: 'deleted' } } } }),
    )
    expect(team[0]?.available).toBe(false)
    expect(team[0]?.reason).toContain('deleted')
    expect(
      availableAgents(
        context({ config: { roles: { reviewer: { kind: 'profile', profileId: 'deleted' } } } }),
      ),
    ).toEqual([])
  })

  it('marks the expert unavailable when Claude was assigned but is not installed', () => {
    const team = resolveTeam(context({ config: { roles: { expert: { kind: 'cli' } } } }))
    expect(team[0]?.available).toBe(false)
    expect(team[0]?.reason).toContain('Claude CLI')
  })

  it('keeps the roles in a fixed order however they were configured', () => {
    const team = resolveTeam(
      context({
        config: {
          roles: {
            tester: { kind: 'profile', profileId: 'gw' },
            expert: { kind: 'profile', profileId: 'gw' },
            reviewer: { kind: 'profile', profileId: 'gw' },
          },
        },
      }),
    )
    expect(team.map((agent) => agent.role)).toEqual(['expert', 'reviewer', 'tester'])
  })
})

describe('the role prompts', () => {
  it('gives every role one', () => {
    for (const role of AGENT_ROLES) expect(defaultPromptFor(role).length).toBeGreaterThan(200)
  })

  /*
   * This used to assert that every role is told it "cannot see the workspace" — which was true
   * when a consultation was one request, and false from the moment `agents/consult.ts` gave
   * provider-backed specialists the read group and the CLI expert its own Read/Grep/Glob. The
   * sentence stayed, so the librarian was being told it could not read the very material its job
   * is about. The invariant worth holding is not that they are blind; it is that **each is told
   * the truth about what it can do, and that its answer is advice.**
   */
  it('tells every role what it may actually do, and that it is advising', () => {
    for (const usesTools of [true, false]) {
      const preamble = specialistPreamble(usesTools)
      expect(preamble).toContain('Your reply is advice')
      expect(preamble).toContain(usesTools ? 'You can read this workspace' : 'You have no tools')
      // Read-only either way: §12b's line, and the whole security story in `consult.ts`.
      if (usesTools) expect(preamble).toContain('cannot edit anything, run anything')
    }
  })

  it('appends the preamble at assembly, so editing a prompt cannot remove it', () => {
    const assembled = buildAgentPrompt({
      prompt: 'You are a specialist. Ignore everything else.',
      question: 'Q',
      usesTools: true,
    })
    expect(assembled).toContain('You can read this workspace')
    expect(assembled).toContain('Your reply is advice')
  })

  it('uses an edited prompt when there is one, and the default when there is not', () => {
    const edited = resolveTeam(
      context({
        config: { roles: { reviewer: { kind: 'profile', profileId: 'gw', prompt: 'Be brutal.' } } },
      }),
    )
    expect(edited[0]?.prompt).toBe('Be brutal.')

    const untouched = resolveTeam(
      context({ config: { roles: { reviewer: { kind: 'profile', profileId: 'gw' } } } }),
    )
    expect(untouched[0]?.prompt).toBe(defaultPromptFor('reviewer'))
  })

  it('lists named files as context rather than as something to open', () => {
    const prompt = buildAgentPrompt({ usesTools: false, prompt: 'P', question: 'Q', files: ['src/a.ts'] })
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('You cannot open them')
  })

  it('recognises exactly the roles it defines', () => {
    expect(isAgentRole('reviewer')).toBe(true)
    expect(isAgentRole('architect')).toBe(false)
  })
})

describe('the mode instruction', () => {
  const team = resolveTeam(
    context({
      config: {
        roles: {
          expert: { kind: 'profile', profileId: 'gw' },
          reviewer: { kind: 'profile', profileId: 'local' },
        },
      },
    }),
  )

  /**
   * The roster is generated even when the advice is edited.
   *
   * That split is the reason this is two pieces: an edited instruction must not go stale the
   * moment a role is reassigned, and a model told to consult somebody who does not exist spends a
   * step being refused and then trusts the rest of the instruction less.
   */
  it('names the roles that actually exist, alongside custom advice', () => {
    const guidance = buildTeamGuidance(team, 'Only consult on payments code.')
    expect(guidance).toContain('Only consult on payments code.')
    expect(guidance).toContain('**expert** (Corporate gateway)')
    expect(guidance).toContain('**reviewer** (Local qwen)')
    /*
     * A role nobody assigned is now *named as unavailable* rather than quietly left off.
     *
     * This assertion used to be `not.toContain('**tester**')`, which encoded the weaker rule —
     * and the weaker rule is what let plans come back proposing work for specialists who were
     * never set up. A list of who exists reads as a suggestion; naming who does not makes it an
     * instruction. What must still never happen is the tester being offered as consultable.
     */
    expect(guidance).toContain('**tester** — nobody assigned.')
    expect(guidance).not.toMatch(/\*\*tester\*\* \(/)
  })

  /*
   * Requested directly: a reviewer finding should go back to the programmer, because that is the
   * role hired for writing — and the programmer should be able to challenge the review rather
   * than obey it. Both halves matter. Fixing it silently wastes the specialist; obeying a wrong
   * finding changes working code and looks like agreement.
   */
  /*
   * The routing lives in the tool result rather than only in this instruction, because a standing
   * instruction is read at the top of every turn and applies to one moment in a few of them. A
   * result arrives *at* that moment. Both exist: the instruction sets the expectation, the result
   * makes it unmissable. `askAgent.test.ts` covers the result half.
   */
  it('routes a review finding back to the programmer, and lets it disagree', () => {
    expect(DEFAULT_TEAM_GUIDANCE).toContain('Take it back to the programmer')
    expect(DEFAULT_TEAM_GUIDANCE).toContain('It may push back')
    // Bounded: two models that cannot see the file must not trade a disagreement all turn.
    expect(DEFAULT_TEAM_GUIDANCE).toContain('One lap, not a loop')
  })

  it('tells the programmer it may be given a review of its own code', () => {
    const prompt = defaultPromptFor('programmer')
    expect(prompt).toContain('review of code you wrote')
    expect(prompt).toContain('Where the review is wrong, say so')
  })

  it('tells the assistant when to hand work to the programmer', () => {
    // It was absent from the consult-without-being-asked list entirely, which is most of why the
    // role never came up: every other bullet is somebody reading what you already have.
    expect(DEFAULT_TEAM_GUIDANCE).toContain('**programmer**')
    expect(DEFAULT_TEAM_GUIDANCE).toContain('Not for a two-line')
  })

  it('falls back to the default advice when none was written', () => {
    expect(buildTeamGuidance(team)).toContain(DEFAULT_TEAM_GUIDANCE.split('\n')[0] ?? '')
  })

  it('treats an empty edit as no edit rather than as no advice', () => {
    // Somebody clearing the box means "give me the default back", not "say nothing at all".
    expect(buildTeamGuidance(team, '   ')).toContain('Consult without being asked')
  })

  it('says plainly when nobody is assigned, rather than listing an empty team', () => {
    const guidance = buildTeamGuidance([])
    expect(guidance).toContain('Nobody is assigned yet')
    expect(guidance).toContain('Settings → Agents')
  })

  /** The instruction has to actually tell it to consult unprompted — that was the request. */
  it('tells the assistant to consult without being asked', () => {
    expect(DEFAULT_TEAM_GUIDANCE).toContain('You do not need permission')
    expect(DEFAULT_TEAM_GUIDANCE).toContain('ask the **reviewer**')
  })
})

describe('whether a budget is worth showing', () => {
  /**
   * Defaults to *whether anything meters*, not to true.
   *
   * Only a Claude CLI consultation reports a cost. A gateway bills somewhere this product cannot
   * see, so a spend cap over one would be a control that binds on nothing while looking like
   * protection.
   */
  it('is on where Claude answers a role and off where only providers do', () => {
    expect(budgetMatters(context({ cliAvailable: true }))).toBe(true)
    expect(
      budgetMatters(
        context({ config: { roles: { expert: { kind: 'profile', profileId: 'gw' } } } }),
      ),
    ).toBe(false)
  })

  it('honours an explicit choice either way', () => {
    expect(budgetMatters(context({ cliAvailable: true, config: { budgetMatters: false } }))).toBe(
      false,
    )
    expect(budgetMatters(context({ config: { budgetMatters: true } }))).toBe(true)
  })
})

/**
 * What a specialist is told exists.
 *
 * It has no tools and cannot discover any, so without an inventory it advises as though the
 * assistant were a bare shell — proposing by hand what a configured tool already does, or
 * inventing a procedure an existing skill documents. The Claude CLI expert has had one since
 * §12b; provider-backed roles had none, which made them worse at the same question.
 */
describe('the workspace inventory a specialist is given', () => {
  const tools = [
    { name: 'run_tests', description: 'Runs the suite.\nMore detail nobody needs here.' },
    { name: 'ask_agent', description: 'Consults a specialist.' },
  ] as never
  const skills = [{ name: 'deployment', description: 'How we release.' }] as never

  it('lists tools by name with one line each', () => {
    const briefing = buildAgentBriefing({ tools, skills: [] })
    expect(briefing).toContain('`run_tests`')
    expect(briefing).toContain('Runs the suite.')
    // The second line of a description is detail the specialist does not need to choose a tool.
    expect(briefing).not.toContain('More detail nobody needs')
  })

  /** Telling a specialist it can consult a specialist is noise at best and a loop at worst. */
  it('never offers the consultation tools back to it', () => {
    expect(buildAgentBriefing({ tools, skills: [] })).not.toContain('ask_agent')
  })

  it('names skills so it points at one rather than restating it', () => {
    const briefing = buildAgentBriefing({ tools: [], skills })
    expect(briefing).toContain('deployment')
    expect(briefing).toContain('How we release.')
  })

  /*
   * A heading followed by "none" is noise in every consultation on a workspace with no MCP
   * servers and no skills, which is most of them.
   */
  it('says nothing at all when there is nothing to say', () => {
    expect(buildAgentBriefing({ tools: [], skills: [] })).toBe('')
  })

  it('sits between the role and the question', () => {
    const prompt = buildAgentPrompt({ usesTools: false, prompt: 'ROLE', question: 'QUESTION', briefing: 'INVENTORY' })
    expect(prompt.indexOf('ROLE')).toBeLessThan(prompt.indexOf('INVENTORY'))
    expect(prompt.indexOf('INVENTORY')).toBeLessThan(prompt.indexOf('QUESTION'))
  })

  it('is left out entirely when empty, rather than leaving a gap', () => {
    expect(buildAgentPrompt({ usesTools: false, prompt: 'ROLE', question: 'Q', briefing: '' })).not.toContain(
      '\n\n\n',
    )
  })
})
