import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bridge = readFileSync(fileURLToPath(new URL('../host/bridge.ts', import.meta.url)), 'utf8')

/**
 * The assessment reaching the people who need it.
 *
 * Every defect in this area has been a *missing connection* rather than a wrong function: the
 * grading was wired to the Claude CLI alone, so the whole feature was unreachable for anybody
 * whose expert is a model on their gateway; and the stored verdict was read out of one config
 * field while another held the list. Neither is visible to a test of the module that got it
 * right, which is why these read the source — the same reasoning as `config/retrieval.test.ts`.
 */
describe('the assessment is reachable without a Claude command line', () => {
  it('grades through whoever holds the expert seat', () => {
    // Resolved from the team, not from `resolveExpert`, which answers only about the CLI.
    expect(bridge).toContain("team.find((agent) => agent.role === 'expert' && agent.available)")
    expect(bridge).toMatch(/askExpertSeat\(\s*\n?\s*buildAssessmentQuestion/)
  })

  /*
   * A profile-backed expert takes the same road as a CLI one. If this branch went missing the
   * symptom would be a button that does nothing for exactly the deployment this product is for.
   */
  it('has a profile branch as well as a CLI branch', () => {
    const at = bridge.indexOf('async function askExpertSeat')
    expect(at).toBeGreaterThan(-1)
    const body = bridge.slice(at, bridge.indexOf('async function handleAssessJunior', at))
    expect(body).toContain("expert.kind === 'cli'")
    expect(body).toContain('createChatProvider(')
    expect(body).toContain('consultExpert(cli, {')
  })

  /*
   * A CLI consultation spends real money whatever it was asked to do. A meter that counted the
   * ordinary consultations and not this one would under-report, and a limit the user set would
   * quietly not apply — §12b's objection to anything that spends invisibly.
   */
  it('still counts what a CLI grading costs', () => {
    const at = bridge.indexOf('async function askExpertSeat')
    const body = bridge.slice(at, bridge.indexOf('async function handleAssessJunior', at))
    expect(body).toContain('recordConsultation(')
  })
})

describe('one owner of what has been assessed', () => {
  /*
   * Two config fields hold assessments — the single legacy slot and the list that replaced it —
   * and every read goes through the module that reconciles them. A direct read of
   * `config.expert.assessment` is the second declaration of one fact, which is the defect this
   * repository has paid for more times than any other.
   */
  it('never reads the legacy assessment field directly', () => {
    expect(bridge).not.toMatch(/config\.expert\?\.assessment\b/)
    expect(bridge).not.toMatch(/settings\?\.assessment\b/)
  })

  it('chooses the one that applies to the model in the junior seat', () => {
    const at = bridge.indexOf('cachedAssessment =')
    expect(at).toBeGreaterThan(-1)
    // Sliced rather than matched on exact formatting, which prettier owns and which says nothing
    // about the property asserted: that the choice is made, through the module that owns it.
    expect(bridge.slice(at, at + 400)).toContain('assessmentFor(allAssessments(')
  })

  /*
   * A fresh install has no profile, and `resolveActiveProfile` reports that by throwing. Every
   * setting loads through `loadSettings`, so letting it escape means the one state where nothing
   * is configured cannot open its own settings - which is how it was found.
   */
  it('survives there being no profile at all', () => {
    const at = bridge.indexOf('cachedAssessment =')
    const before = bridge.slice(Math.max(0, at - 600), at)
    expect(before).toContain('return resolveActiveProfile(config)')
    expect(before).toContain('} catch {')
  })

  it('records into the list rather than overwriting a slot', () => {
    expect(bridge).toContain('recordAssessment(allAssessments(')
  })
})
