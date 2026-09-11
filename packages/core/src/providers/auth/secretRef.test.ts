import { describe, expect, it } from 'vitest'

import { describeMissingSecret, describeSecretRef, resolveSecretRef } from './secretRef.js'
import type { SecretStore } from '../../platform/secrets.js'

/**
 * A credential may name the environment rather than the keychain.
 *
 * Requested for a Node host launched by a parent that already holds the token — a Streamlit app
 * whose internal library does the gateway's auth. The environment is the only thing a parent can
 * hand a child, so `env:API_TOKEN` is the handover.
 */
function store(values: Record<string, string> = {}): SecretStore {
  return {
    backend: 'file',
    get: async (key: string) => values[key],
    set: async (key: string, value: string) => {
      values[key] = value
    },
    delete: async (key: string) => {
      delete values[key]
    },
  } as unknown as SecretStore
}

describe('reading a credential from the environment', () => {
  it('resolves env: to the variable, without touching the secret store', async () => {
    const value = await resolveSecretRef('env:API_TOKEN', {
      // A store that would throw proves the env path never consults it.
      secrets: { get: () => Promise.reject(new Error('must not be read')) } as unknown as SecretStore,
      env: { API_TOKEN: 'tok-live' },
    })
    expect(value).toBe('tok-live')
  })

  it('treats a blank variable as unset', async () => {
    /*
     * A variable that exists but is empty is overwhelmingly a launcher whose own lookup failed.
     * Sending an empty bearer token produces a 401 that reads as a bad key rather than a missing
     * one, which sends the user to rotate a credential that was never the problem.
     */
    const value = await resolveSecretRef('env:API_TOKEN', { secrets: store(), env: { API_TOKEN: '   ' } })
    expect(value).toBeUndefined()
  })

  it('still reads ordinary references from the store', async () => {
    const value = await resolveSecretRef('profile:gateway:apiKey', {
      secrets: store({ 'profile:gateway:apiKey': 'stored' }),
      env: {},
    })
    expect(value).toBe('stored')
  })

  it('treats a bare "env:" as an ordinary reference rather than an unnamed variable', async () => {
    expect(describeSecretRef('env:').kind).toBe('store')
    expect(describeSecretRef('env:  ').kind).toBe('store')
  })

  it('names the variable when it describes one', () => {
    expect(describeSecretRef('env:MY_TOKEN')).toEqual({ kind: 'env', envVar: 'MY_TOKEN' })
  })
})

describe('explaining a credential that is missing', () => {
  it('names the environment variable rather than sending the user to Settings', () => {
    /*
     * The generic message tells somebody to "enter the API key again in Settings". For a profile
     * deliberately pointed at the environment that sends them to change the one thing that is not
     * broken — §17: name what failed and what to do next.
     */
    const message = describeMissingSecret('env:API_TOKEN')
    expect(message).toContain('API_TOKEN')
    expect(message).toContain('environment')
    expect(message).not.toContain('enter it again')
  })

  it('keeps the Settings advice for a stored key', () => {
    const message = describeMissingSecret('profile:gateway:apiKey')
    expect(message).toContain('Settings')
  })

  it('mentions that a variable exported after launch is not visible', () => {
    // The likeliest failure of the whole arrangement, and invisible unless said.
    expect(describeMissingSecret('env:API_TOKEN')).toContain('after the process began')
  })
})
