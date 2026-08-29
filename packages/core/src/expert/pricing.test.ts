import { describe, expect, it } from 'vitest'

import { describePricing, pricingForPrompt } from './pricing.js'

const measuredAt = Date.UTC(2026, 7, 27)

describe('reporting a measurement', () => {
  it('states both figures and the ratio when the resume worked', () => {
    const text = describePricing({ coldUsd: 0.187, resumedUsd: 0.0099, measuredAt, reportsCost: true, resumeWorked: true })
    expect(text).toContain('$0.19')
    expect(text).toContain('$0.0099')
    expect(text).toContain('19 times cheaper')
  })

  /**
   * The flaw this catches. If the CLI returns no session id the second call is also cold, both
   * samples cost the same, and a ratio read off them says "caching saves nothing here" — which is
   * exactly wrong. Two numbers labelled cold and resumed that were both cold is worse than none.
   */
  it('refuses to present two cold starts as a comparison', () => {
    const text = describePricing({ coldUsd: 0.0071, resumedUsd: 0.0065, measuredAt, reportsCost: true, resumeWorked: false })
    expect(text).toContain('did not resume')
    expect(text).not.toContain('times cheaper')
  })

  it('says so when the plan prices nothing', () => {
    expect(describePricing({ measuredAt, reportsCost: false })).toContain('reports no cost')
  })

  it('says nothing at all when there is no measurement', () => {
    expect(describePricing(undefined)).toBeUndefined()
  })

  /** A near-equal pair that did resume is a real finding, and is reported without the ratio. */
  it('reports a genuine near-equal pair without claiming a saving', () => {
    const text = describePricing({ coldUsd: 0.0071, resumedUsd: 0.0065, measuredAt, reportsCost: true, resumeWorked: true })
    expect(text).toContain('$0.0071')
    expect(text).not.toContain('times cheaper')
  })
})

describe('what the expert is told', () => {
  it('carries the measured figures so it plans in them', () => {
    const text = pricingForPrompt({ coldUsd: 0.187, resumedUsd: 0.0099, measuredAt, reportsCost: true, resumeWorked: true })
    expect(text).toContain('$0.19')
    expect(text).toContain('resumes the same session')
  })

  it('tells it nothing when the plan prices nothing', () => {
    expect(pricingForPrompt({ measuredAt, reportsCost: false })).toBeUndefined()
  })
})
