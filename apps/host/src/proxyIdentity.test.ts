import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'

import { normalizeAddress, ProxyHeaderIdentity, validateTrustedProxies } from './proxyIdentity.js'

function request(headers: Record<string, string | string[]>, remoteAddress?: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

const identity = new ProxyHeaderIdentity({ trustedProxies: ['10.0.0.5'] })

describe('who the proxy says this is', () => {
  it('reads the id and the display name', async () => {
    const principal = await identity.authenticate(
      request({ 'x-forwarded-user': 'entra-object-id-alice', 'x-forwarded-display-name': 'Alice' }, '10.0.0.5'),
    )
    expect(principal).toEqual({ id: 'entra-object-id-alice', displayName: 'Alice' })
  })

  it('falls back to the id when no name is supplied', async () => {
    const principal = await identity.authenticate(request({ 'x-forwarded-user': 'alice' }, '10.0.0.5'))
    expect(principal?.displayName).toBe('alice')
  })

  it('trims, and refuses a header that is only whitespace', async () => {
    expect((await identity.authenticate(request({ 'x-forwarded-user': '  alice  ' }, '10.0.0.5')))?.id).toBe('alice')
    expect(await identity.authenticate(request({ 'x-forwarded-user': '   ' }, '10.0.0.5'))).toBeUndefined()
  })
})

describe('the address is the trust boundary, not the header', () => {
  /**
   * The failure that would matter: anyone able to reach the port can type
   * `X-Forwarded-User: anyone`. Authentication that a client can assert for itself is worse than
   * none, because nobody would have assumed an open server was enforcing anything.
   */
  it('refuses the same header from an address that was not named', async () => {
    for (const peer of ['10.0.0.6', '127.0.0.1', '203.0.113.9', undefined]) {
      expect(await identity.authenticate(request({ 'x-forwarded-user': 'alice' }, peer))).toBeUndefined()
    }
  })

  /**
   * A deployment that refuses everyone is a support call. One that believes everyone is a breach.
   * So an empty trust list means nothing is trusted, never everything.
   */
  it('refuses every request when no proxy is configured', async () => {
    const open = new ProxyHeaderIdentity({})
    expect(await open.authenticate(request({ 'x-forwarded-user': 'alice' }, '10.0.0.5'))).toBeUndefined()
    expect(await open.authenticate(request({ 'x-forwarded-user': 'alice' }, '127.0.0.1'))).toBeUndefined()
    expect(open.describe).toContain('NO TRUSTED PROXY')
  })

  /**
   * Node reports an IPv4 peer as `::ffff:10.0.0.5` on a dual-stack listener, and an operator
   * writing `10.0.0.5` will not think to write it twice.
   */
  it('treats an IPv4-mapped IPv6 peer as the address it is', async () => {
    expect(normalizeAddress('::ffff:10.0.0.5')).toBe('10.0.0.5')
    expect(await identity.authenticate(request({ 'x-forwarded-user': 'alice' }, '::ffff:10.0.0.5'))).toEqual({
      id: 'alice',
      displayName: 'alice',
    })
  })

  /** Loopback in two spellings is two statements, and the operator made only one of them. */
  it('does not treat ::1 and 127.0.0.1 as interchangeable', async () => {
    const loopback = new ProxyHeaderIdentity({ trustedProxies: ['127.0.0.1'] })
    expect(await loopback.authenticate(request({ 'x-forwarded-user': 'alice' }, '::1'))).toBeUndefined()
    expect(await loopback.authenticate(request({ 'x-forwarded-user': 'alice' }, '127.0.0.1'))).toBeDefined()
  })
})

describe('a header that arrives twice', () => {
  /**
   * A proxy that appends rather than replaces is exactly how an attacker-supplied value ends up
   * beside the real one. Two answers to "who is this" has no safe resolution, so it is refused.
   */
  it('is refused rather than resolved', async () => {
    const doubled = request({ 'x-forwarded-user': ['alice', 'mallory'] }, '10.0.0.5')
    expect(await identity.authenticate(doubled)).toBeUndefined()
  })
})

describe('configuration mistakes are caught at startup', () => {
  it('names an address that is not one', () => {
    expect(validateTrustedProxies(['10.0.0.5', 'proxy.internal', '10.0.0.300', ''])).toEqual([
      'proxy.internal',
      '10.0.0.300',
      '',
    ])
  })

  it('accepts both families', () => {
    expect(validateTrustedProxies(['10.0.0.5', '::1', '2001:db8::1', '::ffff:10.0.0.5'])).toEqual([])
  })

  /** A typo otherwise presents as "every user is refused", a long way from the cause. */
  it('says which proxies it trusts, so a misconfiguration is visible at startup', () => {
    expect(new ProxyHeaderIdentity({ trustedProxies: ['10.0.0.5'] }).describe).toContain('10.0.0.5')
  })
})

describe('a custom header name', () => {
  it('is matched case-insensitively, as HTTP requires', async () => {
    const custom = new ProxyHeaderIdentity({ userHeader: 'X-Remote-User', trustedProxies: ['10.0.0.5'] })
    // Node lowercases incoming header names; the configured name must be folded to match.
    expect((await custom.authenticate(request({ 'x-remote-user': 'bob' }, '10.0.0.5')))?.id).toBe('bob')
  })

  it('ignores the default header once a different one is configured', async () => {
    const custom = new ProxyHeaderIdentity({ userHeader: 'x-remote-user', trustedProxies: ['10.0.0.5'] })
    expect(await custom.authenticate(request({ 'x-forwarded-user': 'bob' }, '10.0.0.5'))).toBeUndefined()
  })
})
