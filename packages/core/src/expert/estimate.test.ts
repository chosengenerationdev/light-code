import { describe, expect, it } from 'vitest'

import { assessmentForBriefing, buildAssessmentQuestion, type JuniorAssessment } from './assessment.js'
import { extractEstimate } from './estimate.js'

describe('extractEstimate', () => {
  it('reads the estimate and removes the marker from the advice', () => {
    const { text, estimate } = extractEstimate(
      'Here is the plan.\n\nStep one.\n\n[LIGHT-CODE-ESTIMATE consultations=4 usd=0.35]',
    )
    expect(estimate).toEqual({ consultations: 4, usd: 0.35 })
    // The marker is machinery. Leaving it in makes the user read past it every time.
    expect(text).not.toContain('LIGHT-CODE-ESTIMATE')
    expect(text).toContain('Step one.')
  })

  it('returns the advice unchanged when there is no estimate', () => {
    const { text, estimate } = extractEstimate('Just an answer.')
    expect(estimate).toBeUndefined()
    expect(text).toBe('Just an answer.')
  })

  it('tolerates a dollar sign and odd spacing', () => {
    expect(extractEstimate('x\n[LIGHT-CODE-ESTIMATE  usd = $1.20  consultations = 6 ]').estimate).toEqual({
      consultations: 6,
      usd: 1.2,
    })
  })

  it('accepts either field alone', () => {
    expect(extractEstimate('[LIGHT-CODE-ESTIMATE consultations=3]').estimate).toEqual({ consultations: 3 })
    expect(extractEstimate('[LIGHT-CODE-ESTIMATE usd=0.5]').estimate).toEqual({ usd: 0.5 })
  })

  /** A revised plan mid-answer means the later figure is the considered one. */
  it('takes the last marker when there are several', () => {
    const answer = '[LIGHT-CODE-ESTIMATE usd=0.10]\nOn reflection:\n[LIGHT-CODE-ESTIMATE usd=0.90]'
    expect(extractEstimate(answer).estimate).toEqual({ usd: 0.9 })
  })

  it('ignores a marker with nothing readable in it', () => {
    expect(extractEstimate('[LIGHT-CODE-ESTIMATE about forty cents]').estimate).toBeUndefined()
  })

  it('ignores a negative or unparseable number rather than storing it', () => {
    expect(extractEstimate('[LIGHT-CODE-ESTIMATE usd=-5]').estimate).toBeUndefined()
  })

  /**
   * The marker only counts on its own line. A model quoting the format while explaining it
   * must not set a budget as a side effect.
   */
  it('does not match a marker mentioned mid-sentence', () => {
    const answer = 'End with [LIGHT-CODE-ESTIMATE usd=0.35] when you are done.'
    expect(extractEstimate(answer).estimate).toBeUndefined()
    expect(extractEstimate(answer).text).toBe(answer)
  })

  it('leaves no run of blank lines where the marker was', () => {
    const { text } = extractEstimate('Plan.\n\n[LIGHT-CODE-ESTIMATE usd=0.2]\n\nMore.')
    expect(text).not.toMatch(/\n{3,}/)
  })
})

describe('the junior assessment prompt', () => {
  const results = [
    { id: 'a', measures: 'Following a format', prompt: 'do x', answer: 'alpha\nbeta\ngamma' },
    { id: 'b', measures: 'Admitting ignorance', prompt: 'what is y', answer: '', error: 'timed out' },
  ]

  it('includes what the junior actually said', () => {
    const question = buildAssessmentQuestion('qwen-coder', results)
    expect(question).toContain('alpha\nbeta\ngamma')
    expect(question).toContain('Following a format')
  })

  /** A probe that failed is itself a finding, not a gap to hide. */
  it('reports a probe the junior could not answer', () => {
    expect(buildAssessmentQuestion('qwen-coder', results)).toContain('timed out')
  })

  /**
   * The whole point. Asked about a name, the expert would answer from training data that may
   * predate the release — authoritative-sounding and unfalsifiable.
   */
  it('tells the expert to judge the answers rather than the model name', () => {
    const question = buildAssessmentQuestion('qwen-coder', results)
    expect(question).toMatch(/not by the name/i)
  })

  it('asks for something actionable rather than a score', () => {
    expect(buildAssessmentQuestion('m', results)).toMatch(/How to plan for it/)
  })

  /** An assessment is not a task, so it must not set a budget for one. */
  it('tells the expert not to emit a cost estimate', () => {
    // The prompt is wrapped, so the phrase spans a line break.
    expect(buildAssessmentQuestion('m', results).replace(/\s+/g, ' ')).toMatch(/not include a cost estimate/i)
  })
})

describe('assessmentForBriefing', () => {
  const assessment: JuniorAssessment = {
    model: 'qwen-coder',
    profileLabel: 'office gateway',
    assessedAt: Date.now(),
    verdict: 'Trust it with small edits. Do not trust it with multi-file refactors.',
    probes: [],
  }

  it('gives the expert its own verdict back', () => {
    const briefing = assessmentForBriefing(assessment)
    expect(briefing).toContain('multi-file refactors')
    expect(briefing).toContain('qwen-coder')
  })

  it('adds nothing when there is no assessment', () => {
    expect(assessmentForBriefing(undefined)).toBeUndefined()
  })

  it('adds nothing for an empty verdict, rather than an empty heading', () => {
    expect(assessmentForBriefing({ ...assessment, verdict: '   ' })).toBeUndefined()
  })
})
