import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { chartFromToolCall } from '../history/transcript.js'

const bridge = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host', 'bridge.ts'),
  'utf8',
)

/**
 * A chart must appear while the turn is running, not only after a reload.
 *
 * The defect this pins, reported as "I asked for a chart and it didn't show me anything": the
 * transcript derived charts from the stored messages, and the live turn posted an ordinary tool
 * call. So a chart drawn during a conversation rendered as a collapsed `show_chart` block — which
 * from the outside is nothing happening — and only became a picture once the panel was rebuilt
 * from history.
 *
 * That is the shape CLAUDE.md names as the most expensive in this project: **one fact decided in
 * two places, which drift.** Both halves were individually correct. So the fix is one owner —
 * `chartFromToolCall` — and this test reads `bridge.ts` to make sure the live path keeps asking
 * it rather than deciding again, because no test of the owner can see a caller that ignores it.
 */
describe('a chart drawn during a turn', () => {
  it('is classified by the shared owner, in the live path', () => {
    expect(bridge).toContain('chartFromToolCall(toolCall.name, toolCall.arguments)')
  })

  it('does not decide for itself what a chart is', () => {
    /*
     * Any of these in the bridge means the live path has grown its own opinion again. The name is
     * legitimate in a comment, so only code-shaped uses are rejected.
     */
    expect(bridge).not.toMatch(/toolCall\.name === 'show_chart'/)
    expect(bridge).not.toMatch(/name === "show_chart"/)
    expect(bridge).not.toMatch(/chartSpecSchema\.(safeParse|parse)\(/)
  })

  it('posts the chart instead of a tool block, in both directions', () => {
    // Suppressed on the call so nothing collapsed appears in its place, posted on the result.
    expect(bridge).toContain("type: 'chart'")
    expect(bridge).toContain("type: 'chartError'")
  })
})

describe('the shared classifier', () => {
  const good = JSON.stringify({
    type: 'bar',
    categories: ['a', 'b'],
    series: [{ name: 's', values: [1, 2] }],
  })

  it('recognises a chart from the raw arguments a provider sends', () => {
    const result = chartFromToolCall('show_chart', good)
    expect(result?.kind).toBe('chart')
  })

  it('passes over anything that is not show_chart', () => {
    // `undefined` is what lets a caller fall through to its ordinary handling.
    expect(chartFromToolCall('read_file', good)).toBeUndefined()
  })

  it('reports a malformed chart rather than pretending it is not one', () => {
    const result = chartFromToolCall(
      'show_chart',
      JSON.stringify({ type: 'bar', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] }),
    )
    expect(result?.kind).toBe('chartError')
  })

  it('survives arguments that are not JSON at all', () => {
    const result = chartFromToolCall('show_chart', 'not json')
    expect(result?.kind).toBe('chartError')
  })
})
