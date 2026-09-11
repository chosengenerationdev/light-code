// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { joinInterval, splitInterval } from './CustomDataTab.js'

/**
 * A cadence is stored as minutes and shown as a number and a unit.
 *
 * One stored number, two fields over it, so the two cannot disagree. The round trip is what
 * matters: opening a dataset and saving it without touching the schedule must not change the
 * schedule, which is exactly the sort of thing nobody notices until a nightly job starts running
 * every minute.
 */
describe('showing a sync interval', () => {
  it('reads a whole number of days as days', () => {
    expect(splitInterval(60 * 24 * 3)).toEqual({ every: 3, unit: 'days' })
  })

  it('reads a whole number of hours as hours', () => {
    expect(splitInterval(120)).toEqual({ every: 2, unit: 'hours' })
  })

  it('falls back to minutes when nothing divides exactly', () => {
    // 90 minutes is a real thing to want, and it is neither hours nor days.
    expect(splitInterval(90)).toEqual({ every: 90, unit: 'minutes' })
  })

  it('round-trips, so opening and saving does not change the schedule', () => {
    for (const minutes of [1, 5, 15, 45, 60, 90, 120, 360, 1440, 4320, 10080]) {
      const { every, unit } = splitInterval(minutes)
      expect(joinInterval(every, unit)).toBe(minutes)
    }
  })

  it('never produces an interval of zero from a typed value', () => {
    /*
     * Zero means "only when I ask", which is a separate checkbox. Reaching it by clearing the
     * number box would silently switch off a schedule somebody meant to edit.
     */
    expect(joinInterval(0, 'hours')).toBe(60)
    expect(joinInterval(-5, 'minutes')).toBe(1)
  })

  it('treats an unknown unit as minutes rather than throwing', () => {
    // Config is hand-editable, so an unrecognised unit must degrade rather than break the tab.
    expect(joinInterval(30, 'fortnights')).toBe(30)
  })
})
