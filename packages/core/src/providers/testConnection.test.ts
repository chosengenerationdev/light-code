import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HttpClient, HttpResponse } from '../platform/http.js'
import type { SecretStore } from '../platform/secrets.js'
import type { AuthStrategyContext } from './auth/factory.js'
import { testConnection, type TestStepName, type TestStepResult } from './testConnection.js'
import type { ProviderProfile } from './types.js'

class FakeSecretStore implements SecretStore {
  private readonly values = new Map<string, string>()
  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.values.set(key, value)
  }
  async get(key: string) {
    return this.values.get(key)
  }
  async set(key: string, value: string) {
    this.values.set(key, value)
  }
  async delete(key: string) {
    this.values.delete(key)
  }
  async clear() {
    this.values.clear()
  }
  backendName() {
    return 'fake'
  }
}

/** Routes by URL so the token endpoint and the models endpoint can fail independently. */
function router(handlers: { token?: () => HttpResponse; models?: () => HttpResponse }): HttpClient {
  return {
    async request(url: string): Promise<HttpResponse> {
      const handler = url.includes('/oauth/token') ? handlers.token : handlers.models
      if (handler === undefined) throw new Error(`unexpected request to ${url}`)
      return handler()
    },
  }
}

function json(status: number, payload: unknown): HttpResponse {
  return {
    status,
    headers: {},
    text: async () => JSON.stringify(payload),
    json: async <T>() => payload as T,
    body: null,
  }
}

function statusOf(steps: TestStepResult[], step: TestStepName): string {
  return steps.find((entry) => entry.step === step)?.status ?? 'absent'
}

describe('testConnection', () => {
  let certDir: string

  beforeAll(async () => {
    // A stub PFX: read but not parsed, which is enough to exercise the step sequencing.
    certDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-testconn-'))
    await fs.writeFile(path.join(certDir, 'client.pfx'), Buffer.from([0x30, 0x82]))
  })

  afterAll(async () => {
    await fs.rm(certDir, { recursive: true, force: true })
  })

  function mtlsProfile(): ProviderProfile {
    return {
      id: 'gw',
      label: 'Gateway',
      wireFormat: 'openai',
      baseUrl: 'https://gw.example.com/v1',
      model: 'gpt-4o',
      auth: { type: 'apigeeMtls', certs: { certDir, pfxFile: 'client.pfx' }, apigee: {} },
    }
  }

  function context(http: HttpClient, overrides: Partial<AuthStrategyContext> = {}): AuthStrategyContext {
    return { secrets: new FakeSecretStore(), http, baseUrl: 'https://gw.example.com/v1', ...overrides }
  }

  it('reports all three steps green on a working configuration', async () => {
    const http = router({
      token: () => json(200, { access_token: 'tok', expires_in: 3600 }),
      models: () => json(200, { data: [{ id: 'gpt-4o' }] }),
    })

    const result = await testConnection(mtlsProfile(), context(http), http)

    expect(result.ok).toBe(true)
    expect(result.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok'])
    expect(result.steps[2]?.detail).toMatch(/1 model/)
  })

  it('never puts the token in a step detail', async () => {
    const http = router({
      token: () => json(200, { access_token: 'super-secret-token', expires_in: 3600 }),
      models: () => json(200, { data: [{ id: 'gpt-4o' }] }),
    })

    const result = await testConnection(mtlsProfile(), context(http), http)

    expect(JSON.stringify(result)).not.toContain('super-secret-token')
  })

  it('names the certificate step when certs fail, and skips the rest', async () => {
    const profile = mtlsProfile()
    profile.auth = { type: 'apigeeMtls', certs: { certDir, pfxFile: 'absent.pfx' }, apigee: {} }
    const http = router({ token: () => json(200, {}), models: () => json(200, {}) })

    const result = await testConnection(profile, context(http), http)

    expect(result.ok).toBe(false)
    expect(statusOf(result.steps, 'certificates')).toBe('failed')
    expect(statusOf(result.steps, 'token')).toBe('skipped')
    expect(statusOf(result.steps, 'models')).toBe('skipped')
    expect(result.steps[0]?.detail).toMatch(/PFX bundle not found/)
  })

  it('distinguishes a token failure from a certificate failure', async () => {
    const http = router({
      token: () => json(401, { error: 'invalid_client' }),
      models: () => json(200, { data: [] }),
    })

    const result = await testConnection(mtlsProfile(), context(http), http)

    expect(statusOf(result.steps, 'certificates')).toBe('ok')
    expect(statusOf(result.steps, 'token')).toBe('failed')
    expect(statusOf(result.steps, 'models')).toBe('skipped')
    expect(result.steps[1]?.detail).toMatch(/HTTP 401/)
  })

  it('distinguishes a models failure from a token failure', async () => {
    const http = router({
      token: () => json(200, { access_token: 'tok' }),
      models: () => json(403, {}),
    })

    const result = await testConnection(mtlsProfile(), context(http), http)

    expect(statusOf(result.steps, 'token')).toBe('ok')
    expect(statusOf(result.steps, 'models')).toBe('failed')
    expect(result.steps[2]?.detail).toMatch(/HTTP 403/)
  })

  it('skips the certificate step for an API-key profile rather than inventing one', async () => {
    const profile: ProviderProfile = {
      id: 'ds',
      label: 'DeepSeek',
      wireFormat: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      auth: { type: 'apiKey', apiKeyRef: 'profile:ds:apiKey' },
    }
    const http = router({ models: () => json(200, { data: [{ id: 'deepseek-chat' }] }) })

    const result = await testConnection(
      profile,
      context(http, { secrets: new FakeSecretStore({ 'profile:ds:apiKey': 'sk-x' }) }),
      http,
    )

    expect(statusOf(result.steps, 'certificates')).toBe('skipped')
    expect(statusOf(result.steps, 'token')).toBe('ok')
    expect(result.ok).toBe(true)
  })

  it('fails the credential step when an API key is missing', async () => {
    const profile: ProviderProfile = {
      id: 'ds',
      label: 'DeepSeek',
      wireFormat: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      auth: { type: 'apiKey', apiKeyRef: 'absent' },
    }
    const http = router({ models: () => json(200, { data: [] }) })

    const result = await testConnection(profile, context(http), http)

    expect(statusOf(result.steps, 'token')).toBe('failed')
    expect(result.steps[1]?.detail).toMatch(/API key missing/)
  })
})
