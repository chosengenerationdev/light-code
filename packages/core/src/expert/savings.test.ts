import { describe, expect, it } from 'vitest'

import { pruneEvents, startOfLocalDay, summariseSavings, type ExpertEvent } from './savings.js'

/**
 * The whole risk here is a number that looks measured and is not. These pin the two directions
 * that matters in: nothing is reported when nothing has been measured, and what *is* reported
 * is a floor built only from figures taken on this machine.
 */
const pricing = { coldUsd: 0.2, resumedUsd: 0.01, measuredAt: 0, reportsCost: true }

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const now = new Date('2026-09-01T15:00:00').getTime()

const juniorTurn = (at: number): ExpertEvent => ({ at, kind: 'juniorTurn' })
const consultation = (at: number, usd: number | undefined, resumed: boolean): ExpertEvent => ({
  at,
  kind: 'consultation',
  ...(usd === undefined ? {} : { usd }),
  resumed,
})

describe('what the expert has cost', () => {
  it('adds up spend in each window separately', () => {
    const savings = summariseSavings(
      [
        consultation(now - HOUR, 0.05, true),
        consultation(now - 5 * DAY, 0.03, true),
        consultation(now - 200 * DAY, 0.5, false),
      ],
      pricing,
      now,
    )

    expect(savings.today.spentUsd).toBeCloseTo(0.05)
    expect(savings.last30Days.spentUsd).toBeCloseTo(0.08)
    expect(savings.allTime.spentUsd).toBeCloseTo(0.58)
  })

  /** Counted apart rather than added as zero, so a total never looks exact while being partial. */
  it('keeps consultations the plan did not price out of the total', () => {
    const savings = summariseSavings([consultation(now - HOUR, undefined, true)], pricing, now)
    expect(savings.today.spentUsd).toBe(0)
    expect(savings.today.unpriced).toBe(1)
    expect(savings.today.consultations).toBe(1)
  })

  it('counts today from local midnight, not from twenty-four hours ago', () => {
    const lateYesterday = startOfLocalDay(now) - HOUR
    const savings = summariseSavings([consultation(lateYesterday, 0.09, true)], pricing, now)
    expect(savings.today.consultations).toBe(0)
    expect(savings.last30Days.consultations).toBe(1)
  })
})

describe('what it avoided', () => {
  /** Every turn the cheap model handled alone is one the expert would otherwise have taken. */
  it('prices junior turns at the measured cost of a resumed consultation', () => {
    const savings = summariseSavings([juniorTurn(now - HOUR), juniorTurn(now - 2 * HOUR)], pricing, now)
    expect(savings.today.avoidedUsd).toBeCloseTo(0.02)
  })

  it('adds the cold start each resumed consultation did not pay for', () => {
    const savings = summariseSavings([consultation(now - HOUR, 0.01, true)], pricing, now)
    expect(savings.today.avoidedUsd).toBeCloseTo(0.19)
  })

  it('credits nothing to a consultation that started its own session', () => {
    const savings = summariseSavings([consultation(now - HOUR, 0.2, false)], pricing, now)
    expect(savings.today.avoidedUsd).toBe(0)
  })

  /**
   * The honest answer with no measurement is "unknown". Zero would read as "this saved you
   * nothing", which is a claim, and the wrong one.
   */
  it('reports nothing at all when the price here has never been measured', () => {
    const savings = summariseSavings([juniorTurn(now - HOUR)], undefined, now)
    expect(savings.today.avoidedUsd).toBeUndefined()
    expect(savings.measured).toBe(false)
    // The turns still counted, so the panel can say what it would tell you once measured.
    expect(savings.today.juniorTurns).toBe(1)
  })

  /**
   * A measurement where resuming came out dearer means the resume never happened. A negative
   * saving would read as the feature costing money rather than as a bad measurement.
   */
  it('never reports a negative saving from a measurement that came out backwards', () => {
    const backwards = { coldUsd: 0.006, resumedUsd: 0.007, measuredAt: 0, reportsCost: true }
    const savings = summariseSavings([consultation(now - HOUR, 0.007, true)], backwards, now)
    expect(savings.today.avoidedUsd).toBe(0)
  })
})

describe('the event log', () => {
  it('drops only what can no longer change any window', () => {
    const kept = [juniorTurn(now - 300 * DAY), juniorTurn(now - HOUR)]
    const pruned = pruneEvents([...kept, juniorTurn(now - 400 * DAY)], now)
    expect(pruned).toEqual(kept)
  })
})

/**
 * A keep-alive ping and the two consultations a price measurement makes all cost real money.
 * Leaving them out made the panel's "spent" figure quietly wrong the moment anyone used either
 * feature — but counting them as consultations would be wrong the other way, since nobody asked
 * the expert anything.
 */
describe('spending that was not a question', () => {
  const overhead = (at: number, usd: number): ExpertEvent => ({
    at,
    kind: 'consultation',
    usd,
    resumed: true,
    overhead: true,
  })

  it('counts its money, and keeps it out of the consultation count', () => {
    const savings = summariseSavings(
      [overhead(now - HOUR, 0.01), consultation(now - HOUR, 0.05, true)],
      pricing,
      now,
    )
    expect(savings.today.spentUsd).toBeCloseTo(0.06)
    expect(savings.today.consultations).toBe(1)
    expect(savings.today.overheadCalls).toBe(1)
  })

  /** A ping avoided nothing; crediting it would be inventing a saving out of upkeep. */
  it('earns no avoided-cost credit', () => {
    const savings = summariseSavings([overhead(now - HOUR, 0.01)], pricing, now)
    expect(savings.today.avoidedUsd).toBe(0)
  })
})
