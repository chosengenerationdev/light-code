import { describe, expect, it } from 'vitest'

import { checkExpertBudget, expertBudgetUsage, type ExpertSpend } from './budget.js'

const spend = (usd: number, consultations: number, unpriced = 0): ExpertSpend => ({
  usd,
  consultations,
  unpriced,
})

describe('checkExpertBudget', () => {
  it('allows everything when nothing is capped', () => {
    expect(checkExpertBudget(spend(999, 999), {}).allowed).toBe(true)
    // Zero means "no limit", not "nothing allowed" — it is the value an emptied field lands on.
    expect(checkExpertBudget(spend(999, 999), { maxSpendUsd: 0, maxConsultations: 0 }).allowed).toBe(true)
  })

  it('stops on the consultation count', () => {
    expect(checkExpertBudget(spend(0, 2), { maxConsultations: 3 }).allowed).toBe(true)
    expect(checkExpertBudget(spend(0, 3), { maxConsultations: 3 }).allowed).toBe(false)
  })

  it('stops on spend', () => {
    expect(checkExpertBudget(spend(0.9, 5), { maxSpendUsd: 1 }).allowed).toBe(true)
    expect(checkExpertBudget(spend(1, 5), { maxSpendUsd: 1 }).allowed).toBe(false)
  })

  it('stops on whichever limit is reached first', () => {
    const limits = { maxSpendUsd: 10, maxConsultations: 2 }
    // Nowhere near the money, but out of consultations.
    expect(checkExpertBudget(spend(0.02, 2), limits).allowed).toBe(false)
  })

  /**
   * The count limit exists precisely for this: the CLI does not always report a price, and an
   * unpriced consultation still costs money. A spend limit alone would never fire.
   */
  it('still stops when every consultation was unpriced', () => {
    const limits = { maxSpendUsd: 1, maxConsultations: 4 }
    expect(checkExpertBudget(spend(0, 4, 4), limits).allowed).toBe(false)
  })

  it('mentions unpriced consultations when refusing on spend, so the total is not read as exact', () => {
    const verdict = checkExpertBudget(spend(1, 6, 2), { maxSpendUsd: 1 })
    expect(verdict.message).toMatch(/2 consultations reported no cost/)
  })

  it('tells the model what to do instead, not merely that it was refused', () => {
    const verdict = checkExpertBudget(spend(0, 3), { maxConsultations: 3 })
    expect(verdict.message).toMatch(/Continue on your own/)
    // Errors name a way forward (§17) — here, for the user rather than the model.
    expect(verdict.message).toMatch(/Settings → Expert/)
  })
})

describe('expertBudgetUsage', () => {
  it('is undefined when nothing is capped, so the UI can tell that from zero', () => {
    expect(expertBudgetUsage(spend(5, 5), {})).toBeUndefined()
  })

  it('reports the nearer of the two limits', () => {
    // A tenth of the money but half the consultations: the count is what will stop it.
    expect(expertBudgetUsage(spend(1, 5), { maxSpendUsd: 10, maxConsultations: 10 })).toBeCloseTo(0.5)
  })

  it('never exceeds one, so a bar cannot overflow its track', () => {
    expect(expertBudgetUsage(spend(50, 1), { maxSpendUsd: 10 })).toBe(1)
  })
})
