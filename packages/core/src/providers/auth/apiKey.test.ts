import { describe, expect, it } from 'vitest'
import type { SecretStore } from '../../platform/secrets.js'
import { ApiKeyAuthStrategy, NoAuthStrategy } from './apiKey.js'

class FakeSecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.values.set(key, value)
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key)
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  async clear(): Promise<void> {
    this.values.clear()
  }

  backendName(): string {
    return 'fake'
  }
}

describe('ApiKeyAuthStrategy', () => {
  it('resolves a Bearer header from the referenced secret', async () => {
    const secrets = new FakeSecretStore({ 'profile:test:apiKey': 'sk-real-key' })
    const strategy = new ApiKeyAuthStrategy(secrets, 'profile:test:apiKey')

    const headers = await strategy.resolveHeaders()

    expect(headers).toEqual({ Authorization: 'Bearer sk-real-key' })
  })

  it('fails clearly instead of sending an unauthenticated request when the secret is missing', async () => {
    const secrets = new FakeSecretStore()
    const strategy = new ApiKeyAuthStrategy(secrets, 'profile:test:apiKey')

    await expect(strategy.resolveHeaders()).rejects.toThrow(/API key missing/i)
  })
})

describe('NoAuthStrategy', () => {
  it('resolves no headers', async () => {
    const headers = await new NoAuthStrategy().resolveHeaders()
    expect(headers).toEqual({})
  })
})
