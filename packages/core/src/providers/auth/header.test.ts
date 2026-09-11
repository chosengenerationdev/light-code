import { describe, expect, it } from 'vitest'

import { HeaderAuthStrategy } from './header.js'
import type { SecretStore } from '../../platform/secrets.js'

/**
 * A gateway that authenticates on a header it expects, with no API key involved.
 *
 * Requested from a real deployment. The load-bearing decision is that a value is a *reference*:
 * `ProviderProfile.headers` already existed and would have worked, but it is part of the config
 * file — exported, readable by anything that can read the workspace, printed by anything that logs
 * config — and §15 is explicit that a credential never goes there.
 */
function store(values: Record<string, string> = {}): SecretStore {
  return { get: async (key: string) => values[key] } as unknown as SecretStore
}

describe('authenticating with a header', () => {
  it('sends the value from secure storage', async () => {
    const strategy = new HeaderAuthStrategy(store({ 'profile:gw:header:0': 'sekret' }), [
      { name: 'X-Gateway-Key', valueRef: 'profile:gw:header:0' },
    ])
    await expect(strategy.resolveHeaders()).resolves.toEqual({ 'X-Gateway-Key': 'sekret' })
  })

  it('reads an env: reference from the environment instead', async () => {
    process.env['LC_TEST_HEADER'] = 'from-env'
    try {
      const strategy = new HeaderAuthStrategy(store(), [
        { name: 'X-Gateway-Key', valueRef: 'env:LC_TEST_HEADER' },
      ])
      await expect(strategy.resolveHeaders()).resolves.toEqual({ 'X-Gateway-Key': 'from-env' })
    } finally {
      delete process.env['LC_TEST_HEADER']
    }
  })

  it('sends several headers, which is why this is a list', async () => {
    // A key and a tenant, a token and a product id — one pair would have needed replacing.
    const strategy = new HeaderAuthStrategy(store({ a: '1', b: '2' }), [
      { name: 'X-Key', valueRef: 'a' },
      { name: 'X-Tenant', valueRef: 'b' },
    ])
    await expect(strategy.resolveHeaders()).resolves.toEqual({ 'X-Key': '1', 'X-Tenant': '2' })
  })

  it('applies a prefix exactly as given, trailing space included', async () => {
    /*
     * A trailing space is invisible in a form and is the difference between a working header and
     * a 401 that reads as a bad credential. Nothing here trims it.
     */
    const strategy = new HeaderAuthStrategy(store({ a: 'tok' }), [
      { name: 'Authorization', valueRef: 'a', prefix: 'Bearer ' },
    ])
    await expect(strategy.resolveHeaders()).resolves.toEqual({ Authorization: 'Bearer tok' })
  })

  it('names the header when its value is missing', async () => {
    // With several configured, "a credential is missing" leaves the user checking each by hand.
    const strategy = new HeaderAuthStrategy(store(), [{ name: 'X-Gateway-Key', valueRef: 'gone' }])
    await expect(strategy.resolveHeaders()).rejects.toThrow(/X-Gateway-Key/)
  })

  it('names the environment variable when that is where it should have come from', async () => {
    const strategy = new HeaderAuthStrategy(store(), [
      { name: 'X-Gateway-Key', valueRef: 'env:LC_NOT_SET_ANYWHERE' },
    ])
    await expect(strategy.resolveHeaders()).rejects.toThrow(/LC_NOT_SET_ANYWHERE/)
  })
})
