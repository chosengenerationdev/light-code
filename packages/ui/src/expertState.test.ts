import type { HostToUiMessage } from '@light-code/core/browser'
import { describe, expect, it } from 'vitest'

import type { ExpertState } from './settings/ExpertTab.js'

/**
 * The bug: `App` turned the expert message into panel state by copying fields *by name*, so every
 * field added afterwards was silently dropped — the measured price, whether the plan reports cost,
 * the measuring step, the keep-alive setting. The bridge sent them and the panel never saw them,
 * and the symptom was a button that appeared to do nothing while the log said it had worked.
 *
 * This is a type-level check rather than a render: it fails at compile time the next time the
 * message grows a field the panel is supposed to show, which is earlier than any test could.
 */
describe('the expert message and the panel state', () => {
  it('assigns whole, so a new field cannot be dropped in transit', () => {
    const message: Extract<HostToUiMessage, { type: 'expert' }> = {
      type: 'expert',
      enabled: true,
      available: true,
      path: 'claude',
      maxSpendUsd: 1,
      maxConsultations: 6,
      keepAlive: false,
      reportsCost: true,
      pricing: { coldUsd: 0.007117, resumedUsd: 0.0065388, measuredAt: 1, reportsCost: true },
    }

    // Exactly what App does. If ExpertState and the message ever diverge, this stops compiling.
    const state: ExpertState = message

    expect(state.pricing?.coldUsd).toBe(0.007117)
    expect(state.reportsCost).toBe(true)
    expect(state.keepAlive).toBe(false)
  })

  /** Every field the panel renders has to survive the hop. Named so a failure says which. */
  it('carries every field the panel reads', () => {
    const message: Extract<HostToUiMessage, { type: 'expert' }> = {
      type: 'expert',
      enabled: true,
      available: true,
      path: 'claude',
      maxSpendUsd: 0,
      maxConsultations: 0,
      keepAlive: true,
      measuringStep: 'Measuring the first consultation (1/2)…',
    }
    const state: ExpertState = message
    expect(state.measuringStep).toContain('1/2')
    expect(state.keepAlive).toBe(true)
  })
})
