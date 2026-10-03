import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { checkRequest, securityHeaders, setFrameAncestors } from './security.js'

const csp = (): string => securityHeaders()['Content-Security-Policy'] ?? ''

afterEach(() => setFrameAncestors([]))

/**
 * Who may put this page inside another.
 *
 * Asked for by somebody working in JupyterLab, where the natural way to see a local app is inside
 * the lab rather than in a separate tab — and an iframe is how that is done, which `'none'`
 * forbade.
 *
 * **Same-origin framing is the default and cross-origin framing is not.** `frame-ancestors` is
 * what stops clickjacking: a hostile page embedding this one, overlaying it, and collecting a
 * click that lands on an approval — the approval gate is the thing being protected. A page framing
 * *itself* is no such attack, and when a proxy serves this app under somebody's own host that is
 * exactly what a lab page does. So `'self'` allows the case that was asked for and refuses every
 * case the directive was written for.
 */
describe('frame-ancestors', () => {
  it("trusts the page's own origin, so a proxy can frame it with nothing configured", () => {
    expect(csp()).toContain("frame-ancestors 'self'")
  })

  /* The whole point: an attacker's page is a different origin and is still refused. */
  it('never becomes a wildcard', () => {
    setFrameAncestors(['https://hub.example'])
    expect(csp()).not.toMatch(/frame-ancestors[^;]*\*/)
  })

  it('adds a declared origin beside self rather than replacing it', () => {
    setFrameAncestors(['https://hub.example'])
    expect(csp()).toContain("frame-ancestors 'self' https://hub.example")
  })

  it('takes more than one', () => {
    setFrameAncestors(['https://hub.example', 'https://lab.example'])
    expect(csp()).toContain("frame-ancestors 'self' https://hub.example https://lab.example")
  })

  /* Empty entries are dropped rather than emitted, which would make the directive malformed. */
  it('ignores blanks', () => {
    setFrameAncestors(['', '  ', 'https://hub.example'])
    expect(csp()).toContain("frame-ancestors 'self' https://hub.example")
  })

  it('goes back to self alone when the list is emptied', () => {
    setFrameAncestors(['https://hub.example'])
    setFrameAncestors([])
    expect(csp()).toContain("frame-ancestors 'self'")
    expect(csp()).not.toContain('hub.example')
  })

  /*
   * Everything else in the policy is untouched. The point is to trust the page's own origin and
   * whatever was named, not to become a laxer server because somebody wanted a tab.
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

/*
 * Sun Code loads the page in an iframe from its own origin, which the browser marks
 * `cross-site`. Exactly that navigation is let through, and only for a named ancestor.
 */
describe('the frame navigation an embedding app makes', () => {
  const policy = { allowedHosts: ['127.0.0.1:7777'], allowedOrigins: ['http://127.0.0.1:7777'] }
  const frameLoad = (overrides: Record<string, string> = {}, method = 'GET', url = '/') =>
    ({
      method,
      url,
      headers: {
        host: '127.0.0.1:7777',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-dest': 'iframe',
        'sec-fetch-mode': 'navigate',
        ...overrides,
      },
    }) as unknown as IncomingMessage

  it('is refused while no ancestor is named', () => {
    expect(checkRequest(frameLoad(), policy, { requireOrigin: false })?.status).toBe(403)
  })

  it('is allowed once one is', () => {
    setFrameAncestors(['http://sun.localhost'])
    expect(checkRequest(frameLoad(), policy, { requireOrigin: false })).toBeUndefined()
  })

  it('never reaches the API, and is nothing but a framed GET', () => {
    setFrameAncestors(['http://sun.localhost'])
    expect(checkRequest(frameLoad({}, 'GET', '/api/events'), policy, { requireOrigin: false })?.status).toBe(403)
    expect(checkRequest(frameLoad({}, 'POST'), policy, { requireOrigin: false })?.status).toBe(403)
    expect(checkRequest(frameLoad({ 'sec-fetch-dest': 'document' }), policy, { requireOrigin: false })?.status).toBe(403)
    expect(checkRequest(frameLoad({ 'sec-fetch-mode': 'cors' }), policy, { requireOrigin: false })?.status).toBe(403)
  })
})
