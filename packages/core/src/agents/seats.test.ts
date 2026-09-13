import { describe, expect, it } from 'vitest'
import { ASSESSMENT_PROBES } from '../expert/assessment.js'
import { AGENT_ROLES } from './roles.js'
import { EXPERT_GUIDANCE, SEAT_FITS, unmappedProbes } from './seats.js'

/**
 * Deciding a seat from what a model did, rather than from what its name suggests.
 *
 * `expert/assessment.ts` already refuses to answer "is qwen2.5-coder any good" from recall, on the
 * grounds that it reads authoritatively and is unfalsifiable — and says nothing about the gateway
 * in front of it. Choosing which model reviews and which writes is the same question one step on,
 * and deserves the same answer: run the probes, read the answers.
 */
describe('mapping evidence to seats', () => {
  it('names a probe that exists for every seat it covers', () => {
    const known = new Set(ASSESSMENT_PROBES.map((probe) => probe.id))
    for (const fit of SEAT_FITS) {
      for (const probe of fit.probes) {
        expect(
          known.has(probe),
          `${fit.role} points at a probe "${probe}" that does not exist`,
        ).toBe(true)
      }
    }
  })

  it('only names real roles', () => {
    const roles = new Set<string>(AGENT_ROLES)
    for (const fit of SEAT_FITS) {
      expect(roles.has(fit.role), `${fit.role} is not a role`).toBe(true)
    }
  })

  /*
   * A probe nobody uses is evidence collected and thrown away — the model answered it, the expert
   * graded it, and nothing was decided by it. Adding a probe should mean deciding what it
   * predicts, and this fails until somebody does.
   */
  it('uses every probe that is run', () => {
    expect(unmappedProbes()).toEqual([])
  })

  /*
   * The expert is deliberately absent. Planning across files is the whole of what it does and no
   * short probe stands in for it; claiming otherwise would be exactly the confident unfalsifiable
   * answer this approach exists to avoid.
   */
  it('does not pretend to predict the expert seat', () => {
    expect(SEAT_FITS.some((fit) => fit.role === 'expert')).toBe(false)
    expect(EXPERT_GUIDANCE).toContain('no short probe stands in for it')
  })

  it('says what to look for in plain terms, not as a score', () => {
    for (const fit of SEAT_FITS) {
      // "6/10 at reasoning" changes nothing about who gets the seat. The assessment module makes
      // the same argument about its own verdict.
      expect(fit.lookFor.length).toBeGreaterThan(80)
      expect(fit.lookFor).not.toMatch(/\d\/10/)
    }
  })
})
