import { describe, expect, it } from 'vitest'
import type { JuniorAssessment } from './assessment.js'
import {
  allAssessments,
  assessmentFor,
  forgetAssessment,
  MAX_ASSESSMENTS,
  recordAssessment,
} from './assessments.js'

const made = (
  model: string,
  profileLabel = 'gateway',
  assessedAt = 1_000,
): JuniorAssessment => ({
  model,
  profileLabel,
  assessedAt,
  verdict: `about ${model}`,
  probes: [],
})

describe('keeping several models assessed', () => {
  it('reads the older single-assessment shape as a list of one', () => {
    expect(allAssessments({ assessment: made('qwen') }).map((entry) => entry.model)).toEqual([
      'qwen',
    ])
    expect(allAssessments({})).toEqual([])
  })

  /*
   * An upgrade writes the list and leaves the old field where it was — nothing rewrites config
   * behind the user. Counting both would show the first model assessed twice, and the duplicate
   * would look like a bug in the probes rather than in the reading.
   */
  it('does not count the legacy entry twice once the list describes that model', () => {
    const current = made('qwen', 'gateway', 2_000)
    const all = allAssessments({ assessment: made('qwen', 'gateway', 1_000), assessments: [current] })
    expect(all).toHaveLength(1)
    expect(all[0]?.assessedAt).toBe(2_000)
  })

  it('puts the newest first, whichever shape it came from', () => {
    const all = allAssessments({
      assessment: made('gemma', 'gateway', 3_000),
      assessments: [made('qwen', 'gateway', 1_000), made('mistral', 'gateway', 5_000)],
    })
    expect(all.map((entry) => entry.model)).toEqual(['mistral', 'gemma', 'qwen'])
  })
})

describe('finding the one that applies', () => {
  const all = [made('qwen', 'office', 2_000), made('qwen', 'laptop', 1_000)]

  /*
   * §12b's argument, one step on: the same weights behind two gateways behave differently, so a
   * verdict earned through one is not automatically evidence about the other.
   */
  it('prefers the assessment made through the same profile', () => {
    expect(assessmentFor(all, 'qwen', 'laptop')?.assessedAt).toBe(1_000)
    expect(assessmentFor(all, 'qwen', 'office')?.assessedAt).toBe(2_000)
  })

  it('falls back to the model alone, since a profile can be renamed', () => {
    expect(assessmentFor(all, 'qwen', 'renamed')).toBeDefined()
    expect(assessmentFor(all, 'gemma', 'office')).toBeUndefined()
  })

  // An unconfigured profile has no model, and matching that against an entry with an empty
  // model would hand back somebody else's verdict.
  it('matches nothing for an empty model', () => {
    expect(assessmentFor([made(''), ...all], '')).toBeUndefined()
  })
})

describe('recording one', () => {
  /*
   * Two verdicts about one model is a question nobody outside can answer, and the stale one is
   * fed back to the expert on later tasks.
   */
  it('replaces an earlier verdict about the same model and profile', () => {
    const all = recordAssessment([made('qwen', 'office', 1_000)], made('qwen', 'office', 2_000))
    expect(all).toHaveLength(1)
    expect(all[0]?.assessedAt).toBe(2_000)
  })

  it('keeps the same model assessed through a different profile', () => {
    const all = recordAssessment([made('qwen', 'office', 1_000)], made('qwen', 'laptop', 2_000))
    expect(all).toHaveLength(2)
  })

  it('caps the list, dropping the oldest', () => {
    let all: JuniorAssessment[] = []
    for (let index = 0; index < MAX_ASSESSMENTS + 3; index += 1) {
      all = recordAssessment(all, made(`model-${String(index)}`, 'gateway', index))
    }
    expect(all).toHaveLength(MAX_ASSESSMENTS)
    expect(all.some((entry) => entry.model === 'model-0')).toBe(false)
  })

  it('forgets one by subject', () => {
    const all = forgetAssessment([made('qwen', 'office'), made('gemma', 'office')], 'qwen', 'office')
    expect(all.map((entry) => entry.model)).toEqual(['gemma'])
  })
})
