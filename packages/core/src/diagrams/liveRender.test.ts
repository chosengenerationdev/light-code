import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { diagramFromToolCall, chartFromToolCall } from '../history/transcript.js'

const bridge = readFileSync(
  fileURLToPath(new URL('../host/bridge.ts', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n')

/**
 * A picture drawn during a turn has to appear during that turn.
 *
 * Reported from real use: `show_diagram` ran, the tool row showed a tick, the assistant described
 * what it had drawn — and there was no diagram. The derivation existed and the *live path* did
 * not, so the picture would only have appeared after reopening the task.
 *
 * This is the same failure the chart feature had, recorded in CLAUDE.md in those words: the
 * transcript derived it and the live path did not. Two places deciding one thing, and only one of
 * them updated — which is the defect shape this repository has paid for more than any other.
 *
 * Read from the source because what is missing is a *call*. No test of `diagramFromToolCall` can
 * see that nobody invokes it, which is exactly why it passed while the feature did not work.
 */
describe('a diagram drawn during a turn', () => {
  it('is turned into a diagram message by the live path', () => {
    expect(bridge).toContain('diagramFromToolCall(toolCall.name, toolCall.arguments)')
    expect(bridge).toContain("type: 'diagram',")
    expect(bridge).toContain("type: 'diagramError'")
  })

  /*
   * And is not *also* rendered as an ordinary tool row. The suppression and the posting are two
   * separate calls, and having only the second would draw the picture underneath a collapsed
   * "show_diagram ran" block that says nothing.
   */
  it('is suppressed from the ordinary tool rendering', () => {
    const suppression = bridge.indexOf(
      'if (diagramFromToolCall(toolCall.name, toolCall.arguments) !== undefined) return',
    )
    expect(suppression).toBeGreaterThan(-1)
    // Before the posting, or the row is emitted first and the picture arrives under it.
    expect(suppression).toBeLessThan(bridge.indexOf("type: 'diagram',"))
  })

  /* The chart path is the pattern being followed; if it ever moves, this should move with it. */
  it('sits beside the chart path rather than somewhere of its own', () => {
    expect(bridge).toContain('chartFromToolCall(toolCall.name, toolCall.arguments)')
  })
})

describe('the two derivations agree about what a call is', () => {
  const call = JSON.stringify({
    nodes: [{ id: 'a', label: 'A' }],
    edges: [],
  })

  it('recognises a diagram and leaves a chart alone', () => {
    expect(diagramFromToolCall('show_diagram', call)?.kind).toBe('diagram')
    expect(chartFromToolCall('show_diagram', call)).toBeUndefined()
  })

  it('recognises one made through the dispatcher', () => {
    const wrapped = JSON.stringify({ name: 'show_diagram', arguments: JSON.parse(call) })
    expect(diagramFromToolCall('call_tool', wrapped)?.kind).toBe('diagram')
  })

  /*
   * A refused spec is reported, not dropped. The model believes it drew something, so a silent
   * gap would leave the conversation reading as though a picture were on screen.
   */
  it('reports a spec it cannot use, naming the field', () => {
    const bad = JSON.stringify({ nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'z' }] })
    const result = diagramFromToolCall('show_diagram', bad)
    expect(result?.kind).toBe('diagramError')
    expect(result?.kind === 'diagramError' && result.message).toContain('No node has the id')
  })
})
