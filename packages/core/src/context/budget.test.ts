import { describe, expect, it } from 'vitest'

import { calibrate, calibrationFor, promptTokensFromError, scaleBreakdown } from './budget.js'


describe('calibrating the estimate against the real count', () => {
  it('scales later estimates by what the provider reported, and reads the size out of a refusal', () => {
    calibrate('gw|qwen', 175_000, 241_500)
    const ratio = calibrationFor('gw|qwen')
    expect(ratio).toBeCloseTo(1.38, 2)
    expect(scaleBreakdown({ system: 1000, toolDefinitions: 2000, history: 3000, results: 4000, total: 10_000, contextWindow: 262_144, estimated: true }, ratio).total).toBe(13_800)
    // Noise is ignored.
    calibrate('gw|other', 1000, 50_000)
    expect(calibrationFor('gw|other')).toBeUndefined()
    expect(promptTokensFromError("This model's maximum context length is 262144 tokens. However, you requested 270,123 tokens (262,000 in the messages, 8123 in the completion). Your prompt contains at least 262001 input tokens.")).toBe(262_001)
    expect(promptTokensFromError('prompt is too long: 270123 tokens > 200000 maximum')).toBe(270_123)
    expect(promptTokensFromError('something else went wrong')).toBeUndefined()
  })
})
