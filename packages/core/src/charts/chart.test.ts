import { describe, expect, it } from 'vitest'

import { chartSpecSchema, chartTotals } from './types.js'
import { toTranscript } from '../history/transcript.js'
import type { ChatMessage } from '../providers/types.js'

/**
 * A chart that renders is believed.
 *
 * Nobody audits a bar against the figures behind it — that is the entire reason to draw one. So
 * the validation here is strict in the same way `apply_diff` refuses a fuzzy match: a chart drawn
 * from misaligned data is the right shape and the wrong answer, and it announces nothing.
 */
describe('the chart specification', () => {
  const bar = {
    type: 'bar' as const,
    categories: ['Inbox', 'Alerts'],
    series: [{ name: 'Messages', values: [4, 9] }],
  }

  it('accepts a well-formed chart', () => {
    expect(chartSpecSchema.safeParse(bar).success).toBe(true)
  })

  it('refuses a series that does not line up with the categories', () => {
    const parsed = chartSpecSchema.safeParse({ ...bar, series: [{ name: 'Messages', values: [4] }] })
    expect(parsed.success).toBe(false)
    // Padding would draw a chart. That is the failure this prevents, so the message says so.
    expect(parsed.error?.issues[0]?.message).toContain('1 value(s) but there are 2 categories')
  })

  it('refuses a pie with several series rather than picking one', () => {
    const parsed = chartSpecSchema.safeParse({
      ...bar,
      type: 'pie',
      series: [
        { name: 'a', values: [1, 2] },
        { name: 'b', values: [3, 4] },
      ],
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses a negative slice, which cannot be drawn honestly', () => {
    const parsed = chartSpecSchema.safeParse({ ...bar, type: 'pie', series: [{ name: 'a', values: [-1, 2] }] })
    expect(parsed.success).toBe(false)
  })

  it('refuses a value that is not finite', () => {
    expect(chartSpecSchema.safeParse({ ...bar, series: [{ name: 'a', values: [1, Number.NaN] }] }).success).toBe(false)
  })

  it('totals each series and the whole chart', () => {
    const totals = chartTotals(chartSpecSchema.parse({ ...bar, series: [{ name: 'a', values: [4, 9] }] }))
    expect(totals.series).toEqual([{ name: 'a', total: 13 }])
    expect(totals.grand).toBe(13)
  })
})

/**
 * The chart is derived from the call that drew it, never stored beside it.
 *
 * Same rule §6b applies to the whole transcript: the messages are the record. A chart kept
 * separately would be a second copy to drift, and would vanish on reload — which is exactly the
 * bug class that has cost this project the most.
 */
describe('charts in a transcript', () => {
  function messagesWith(args: unknown): ChatMessage[] {
    return [
      { role: 'user', content: 'chart it' },
      {
        role: 'assistant',
        content: '',
        // Arguments travel as the JSON string a provider sends, which is what the derivation reads.
        toolCalls: [{ id: '1', name: 'show_chart', arguments: JSON.stringify(args) }],
      },
      { role: 'tool', toolCallId: '1', content: 'Drew a bar chart.' },
    ]
  }

  it('renders a chart entry rather than a tool block', () => {
    const entries = toTranscript(
      messagesWith({ type: 'bar', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] }),
    )
    const chart = entries.find((entry) => entry.kind === 'chart')
    expect(chart).toBeDefined()
    expect(entries.some((entry) => entry.kind === 'tool')).toBe(false)
  })

  it('survives a reload, because it is rebuilt from the messages', () => {
    const messages = messagesWith({ type: 'pie', categories: ['x'], series: [{ name: 's', values: [3] }] })
    // Two independent derivations of the same stored messages must agree exactly.
    expect(toTranscript(messages)).toEqual(toTranscript(messages))
  })

  it('says a chart could not be drawn instead of leaving a gap', () => {
    /*
     * A silent skip would leave the model believing a picture is on screen, and the conversation
     * reading as though one were. The reason is shown because it is nearly always fixable in one
     * turn — a series that does not line up with its categories.
     */
    const entries = toTranscript(
      messagesWith({ type: 'bar', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] }),
    )
    const failed = entries.find((entry) => entry.kind === 'chartError')
    expect(failed).toBeDefined()
    expect(failed?.kind === 'chartError' && failed.message).toContain('categories')
  })
})
