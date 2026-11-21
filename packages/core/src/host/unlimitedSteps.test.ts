import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Asked for: "an option to disable loop steps limit ... he should be able to let the agent run, anti halucinator is
 * enabled and it should be able to guide the agent". The limit is lifted for a chat's replies only: a scheduled run
 * keeps it, since nobody is there to press Stop. Read from the bridge, where the decision is made, because the
 * defect it guards against - the limit lifted for schedules too - is invisible to any test of the loop.
 */
const bridge = readFileSync(path.join(import.meta.dirname, 'bridge.ts'), 'utf8')

describe('no step limit', () => {
  it('lifts the limit for chat replies and never for a scheduled run', () => {
    expect(bridge).toContain('maxIterations: cachedUnlimitedSteps && schedule === undefined ? Number.POSITIVE_INFINITY : cachedMaxIterations')
  })

  it('is read from the setting and reported to the panel', () => {
    expect(bridge).toContain('cachedUnlimitedSteps = config.unlimitedSteps === true')
    expect(bridge).toContain('unlimitedSteps: cachedUnlimitedSteps,')
    expect(bridge).toMatch(/message\.type === 'setUnlimitedSteps'[\s\S]{0,120}unlimitedSteps: message\.value/)
  })
})
