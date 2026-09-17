import { afterEach, describe, expect, it } from 'vitest'
import { securityHeaders, setFrameAncestors } from './security.js'

const csp = (): string => securityHeaders()['Content-Security-Policy'] ?? ''

afterEach(() => setFrameAncestors([]))

/**
 * Who may put this page inside another.
 *
 * Asked for by somebody working in JupyterLab, where the natural way to see a local app is inside
 * the lab rather than in a separate tab — and an iframe is how that is done, which the default
 * policy forbids.
 *
 * **It is a real relaxation, which is why it is opt-in and named.** `frame-ancestors` is what
 * stops clickjacking: a hostile page embedding this one, overlaying it, and collecting a click
 * that lands on an approval. The approval gate is the thing being protected.
 */
describe('frame-ancestors', () => {
  it("is 'none' until somebody says otherwise", () => {
    expect(csp()).toContain("frame-ancestors 'none'")
  })

  it('names exactly the origins declared', () => {
    setFrameAncestors(['https://hub.example'])
    expect(csp()).toContain('frame-ancestors https://hub.example')
    expect(csp()).not.toContain("frame-ancestors 'none'")
  })

  it('takes more than one', () => {
    setFrameAncestors(['https://hub.example', 'https://lab.example'])
    expect(csp()).toContain('frame-ancestors https://hub.example https://lab.example')
  })

  /* Empty entries are dropped rather than emitted, which would make the directive malformed. */
  it('ignores blanks', () => {
    setFrameAncestors(['', '  ', 'https://hub.example'])
    expect(csp()).toContain('frame-ancestors https://hub.example')
  })

  it('goes back to none when the list is emptied', () => {
    setFrameAncestors(['https://hub.example'])
    setFrameAncestors([])
    expect(csp()).toContain("frame-ancestors 'none'")
  })

  /*
   * Everything else in the policy is untouched. The point is to widen one directive by a named
   * origin, not to become a laxer server because somebody wanted a tab.
   */
  it('changes nothing else', () => {
    setFrameAncestors(['https://hub.example'])
    const policy = csp()
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(policy).toContain(directive)
    }
  })
})
