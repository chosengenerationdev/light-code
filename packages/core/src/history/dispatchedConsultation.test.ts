import { describe, expect, it } from 'vitest'
import { chartFromToolCall, consultationFromToolCall } from './transcript.js'

const wrapped = (name: string, args: unknown): string =>
  JSON.stringify({ name, arguments: args })

/**
 * Who answered, when the consultation went through the dispatcher.
 *
 * Reported from real use: working a plan, the librarian's step arrived labelled "informed by
 * reviewer" — the reviewer's name over the librarian's words. The model had called
 * `call_tool({name: 'ask_agent', arguments: {role: 'librarian'}})`, the loop fires `onToolCall`
 * with the *raw* call and unwraps only later, so this returned `undefined` and the caller's
 * `informedBy` kept what the previous step had left in it.
 *
 * A stale label is not a missing one. The chat colours and names that role, and a colour is read
 * as a fact about who did the work — misattribution is worse than no attribution, which is the
 * whole reason the attribution exists.
 */
describe('a consultation routed through call_tool', () => {
  it('is attributed to the role that actually answered', () => {
    expect(
      consultationFromToolCall(
        'call_tool',
        wrapped('ask_agent', { role: 'librarian', question: 'how do we do this here?' }),
      ),
    ).toBe('librarian')
  })

  it('still works when called directly', () => {
    expect(consultationFromToolCall('ask_agent', JSON.stringify({ role: 'reviewer' }))).toBe(
      'reviewer',
    )
    expect(consultationFromToolCall('ask_expert', '{}')).toBe('claude')
  })

  it('sees the expert through the wrapper too', () => {
    expect(consultationFromToolCall('call_tool', wrapped('ask_expert', {}))).toBe('claude')
  })

  /*
   * The stale-label case stated directly: an ordinary dispatched tool is not a consultation, so
   * the caller must be told "not a consultation" rather than left holding the last role.
   */
  it('is not a consultation when the wrapper holds something else', () => {
    expect(consultationFromToolCall('call_tool', wrapped('read_file', { path: 'a.ts' }))).toBe(
      undefined,
    )
  })

  /*
   * A wrapper naming nothing is left as itself. Reporting it as the inner call would attribute
   * work to a role nobody named, which is the failure this whole function guards against.
   */
  it('does not guess at a malformed wrapper', () => {
    expect(consultationFromToolCall('call_tool', '{"arguments":{"role":"librarian"}}')).toBe(
      undefined,
    )
    expect(consultationFromToolCall('call_tool', 'not json')).toBe(undefined)
  })

  /*
   * An unreadable role is still a consultation, attributed to nobody. Unchanged by the unwrap,
   * and worth pinning: falling back to the *previous* role is exactly the reported bug.
   */
  it('attributes an unreadable role to nobody rather than to whoever went before', () => {
    expect(consultationFromToolCall('call_tool', wrapped('ask_agent', {}))).toBe('unknown')
  })
})

/**
 * The same wrapper, the same derivation, so it gets the same fix — leaving one would be the
 * one-fact-in-two-places split this repository keeps paying for. A chart drawn through the
 * dispatcher would otherwise render as nothing, which has already happened once by another road.
 */
describe('a chart drawn through call_tool', () => {
  const spec = {
    type: 'bar',
    title: 'Runs',
    categories: ['Mon', 'Tue'],
    series: [{ name: 'passes', values: [3, 5] }],
  }

  it('is still recognised as a chart', () => {
    const result = chartFromToolCall('call_tool', wrapped('show_chart', spec))
    expect(result?.kind).toBe('chart')
  })

  it('is still recognised when called directly', () => {
    expect(chartFromToolCall('show_chart', JSON.stringify(spec))?.kind).toBe('chart')
  })

  it('is not a chart when the wrapper holds something else', () => {
    expect(chartFromToolCall('call_tool', wrapped('read_file', { path: 'a.ts' }))).toBe(undefined)
  })
})
