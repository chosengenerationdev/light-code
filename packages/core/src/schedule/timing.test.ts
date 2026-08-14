import { describe, expect, it } from 'vitest'

import { isDue, nextFireTime } from './timing.js'
import type { Schedule } from './types.js'

/**
 * The arm → fire → re-arm loop, driven the way the timer drives it.
 *
 * Every previous scheduler failure survived a green suite because `nextFireTime` and `isDue`
 * were each tested alone and nothing tested them *in sequence* — which is the only place the
 * bug could live. This walks a simulated clock through the whole cycle.
 */
describe('the schedule loop as the timer runs it', () => {
  interface Sim {
    fired: number[]
    schedule: Schedule
  }

  function armAndRun(trigger: Schedule['trigger'], startAt: number, ticks: number, tickMs: number): Sim {
    const schedule: Schedule = {
      id: 's',
      name: 's',
      prompt: 'p',
      trigger,
      enabled: true,
      allowedTools: [],
      nextRunAt: nextFireTime({ trigger }, startAt),
    }
    const sim: Sim = { fired: [], schedule }
    for (let tick = 1; tick <= ticks; tick++) {
      const now = startAt + tick * tickMs
      if (isDue(sim.schedule, now)) {
        sim.fired.push(now)
        // Exactly what `runSchedule`'s finally does: re-arm from completion.
        sim.schedule = { ...sim.schedule, nextRunAt: nextFireTime(sim.schedule, now) }
      }
    }
    return sim
  }

  it('fires a one-minute schedule about once a minute at a 15s tick', () => {
    const start = new Date('2026-08-14T09:00:00').getTime()
    const sim = armAndRun({ kind: 'interval', everyMinutes: 1 }, start, 40, 15_000)

    // 40 ticks of 15s is ten minutes. Allowing for tick granularity, this must be close to ten
    // firings — the failure being guarded against is zero.
    expect(sim.fired.length).toBeGreaterThanOrEqual(9)
    expect(sim.fired.length).toBeLessThanOrEqual(10)
  })

  it('never fires twice for one due moment', () => {
    const start = new Date('2026-08-14T09:00:00').getTime()
    const sim = armAndRun({ kind: 'interval', everyMinutes: 5 }, start, 60, 15_000)

    const gaps = sim.fired.slice(1).map((at, index) => at - (sim.fired[index] as number))
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(5 * 60_000)
  })

  it('fires a daily schedule once, on the day, and re-arms to tomorrow', () => {
    const start = new Date('2026-08-14T08:59:00').getTime()
    const sim = armAndRun({ kind: 'daily', hour: 9, minute: 0 }, start, 4 * 60, 60_000)

    expect(sim.fired).toHaveLength(1)
    expect(new Date(sim.fired[0] as number).getHours()).toBe(9)
    expect(new Date(sim.schedule.nextRunAt as number).getDate()).toBe(15)
  })

  it('a paused schedule never fires, however overdue', () => {
    const now = Date.now()
    const paused: Schedule = {
      id: 's',
      name: 's',
      prompt: 'p',
      trigger: { kind: 'interval', everyMinutes: 1 },
      enabled: false,
      allowedTools: [],
      nextRunAt: now - 60 * 60_000,
    }
    expect(isDue(paused, now)).toBe(false)
  })
})
