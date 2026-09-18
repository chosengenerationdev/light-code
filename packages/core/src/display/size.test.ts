import { describe, expect, it } from 'vitest'

import { chartSpecSchema } from '../charts/types.js'
import { diagramSpecSchema } from '../diagrams/types.js'
import { DEFAULT_DISPLAY_SIZE, DISPLAY_SIZES, displayMaxWidth } from './size.js'

/**
 * Asking for a smaller picture.
 *
 * Reported from the Node host: a chart filled the whole window, and asking the assistant for a
 * smaller one got nowhere because there was nothing to ask *for*. The request was explicitly that
 * it work for every kind of picture, diagrams included — so the vocabulary is shared rather than
 * added to each, and a chart and a diagram asked for "small" must agree about what that means.
 */

describe('the sizes', () => {
  it('mean the same thing to a chart and to a diagram', () => {
    for (const size of DISPLAY_SIZES) {
      const chart = chartSpecSchema.safeParse({
        type: 'bar',
        size,
        categories: ['a'],
        series: [{ name: 's', values: [1] }],
      })
      const diagram = diagramSpecSchema.safeParse({
        size,
        nodes: [{ id: 'a', label: 'A' }],
        edges: [],
      })
      expect([size, chart.success, diagram.success]).toEqual([size, true, true])
    }
  })

  it('get narrower in order', () => {
    expect(displayMaxWidth('small')).toBeLessThan(displayMaxWidth('medium') ?? 0)
    expect(displayMaxWidth('medium')).toBeLessThan(displayMaxWidth('large') ?? 0)
  })

  /* `full` is what everything did before this existed, so nothing already drawn changes. */
  it('leaves full uncapped', () => {
    expect(displayMaxWidth('full')).toBeUndefined()
    expect(DEFAULT_DISPLAY_SIZE).toBe('full')
  })

  it('leaves a picture that asked for nothing exactly as it was', () => {
    expect(displayMaxWidth(undefined)).toBeUndefined()
  })

  /*
   * A stored transcript may have been written by a version that knew a size this one does not. An
   * old picture drawn a little too wide is a far better failure than a task that will not reopen.
   */
  it('degrades to uncapped for a size it does not recognise', () => {
    expect(displayMaxWidth('enormous')).toBeUndefined()
  })
})

describe('the field on each spec', () => {
  it('is optional on a chart, so nothing existing has to change', () => {
    expect(
      chartSpecSchema.safeParse({
        type: 'bar',
        categories: ['a'],
        series: [{ name: 's', values: [1] }],
      }).success,
    ).toBe(true)
  })

  it('is optional on a diagram too', () => {
    expect(diagramSpecSchema.safeParse({ nodes: [{ id: 'a', label: 'A' }], edges: [] }).success).toBe(true)
  })

  /* A size nobody implements is refused rather than quietly ignored, on both. */
  it('refuses a size that does not exist', () => {
    expect(
      chartSpecSchema.safeParse({
        type: 'bar',
        size: 'gigantic',
        categories: ['a'],
        series: [{ name: 's', values: [1] }],
      }).success,
    ).toBe(false)
    expect(
      diagramSpecSchema.safeParse({ size: 'gigantic', nodes: [{ id: 'a', label: 'A' }], edges: [] }).success,
    ).toBe(false)
  })

  /* The model has to be told the word exists, or it can never use it. */
  it('describes itself identically in both tools', () => {
    const chartField = chartSpecSchema.safeParse({
      type: 'bar',
      categories: ['a'],
      series: [{ name: 's', values: [1] }],
    })
    expect(chartField.success).toBe(true)
    // The shared sentence is what both descriptions are built from; see `display/size.ts`.
    expect(DISPLAY_SIZES).toContain('small')
  })
})
