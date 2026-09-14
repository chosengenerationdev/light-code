import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { testConnection, TEST_CONNECTION_TIMEOUT_MS } from './testConnection.js'
import type { HttpClient } from '../platform/http.js'
import type { ProviderProfile } from './types.js'

const profile: ProviderProfile = {
  id: 'p',
  label: 'gateway',
  wireFormat: 'openai',
  baseUrl: 'https://gateway.invalid/v1',
  model: 'a-model',
  auth: { type: 'none' },
}

/** An HttpClient that never answers, which is the reported failure exactly. */
const silent: HttpClient = {
  request: (_url: string, options?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }),
} as unknown as HttpClient

const answering = (body: unknown, status = 200): HttpClient =>
  ({
    request: () =>
      Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: {},
        text: async () => JSON.stringify(body),
        json: async () => body,
      }),
  }) as unknown as HttpClient

/**
 * Test Connection has to come back.
 *
 * Reported from real use on the Node host: the button sat on "Testing…" for ever against a
 * gateway that answered chat completions perfectly well — proved by constructing a LangChain
 * client against the same URL and headers and invoking it successfully.
 *
 * Two separate faults. The catalogue step is not the chat path, so a gateway serving no
 * `/models` is nothing to fix; and the deadline was optional on the signature and the one caller
 * never passed one, so there was no bound anywhere. §14 states the rule: a request with no
 * deadline cannot fail, and something that cannot fail cannot report.
 */
describe('a connection test that never gets an answer', () => {
  it('reports rather than waiting for ever', async () => {
    const started = Date.now()
    const controller = new AbortController()
    // The real deadline is 20s; the outer signal stands in for it so the test is quick. What is
    // asserted is that *something* ends it and the result is reported, not the duration.
    setTimeout(() => controller.abort(), 20)
    const result = await testConnection(profile, { secrets: undefined } as never, silent, controller.signal)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result.steps.some((step) => step.step === 'models')).toBe(true)
  })

  it('has a deadline of its own, so no caller can forget one', () => {
    expect(TEST_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0)
    const source = readFileSync(
      fileURLToPath(new URL('./testConnection.ts', import.meta.url)),
      'utf8',
    )
    // Composed with the caller's signal rather than replacing it, or cancelling would stop working.
    expect(source).toContain('deadline.abort()')
    expect(source).toContain("signal?.addEventListener('abort', onOuterAbort)")
  })
})

/**
 * §9 has said since Phase 6 that the model dropdown must never be a hard dependency. The code
 * reported a red failure anyway, with a comment beside it saying this case was normal — the
 * comment and the code disagreeing, which is how a working connection came to look broken.
 */
describe('a gateway that publishes no catalogue', () => {
  it('is a note, not a failure, and the overall result is ok', async () => {
    const result = await testConnection(
      profile,
      { secrets: undefined } as never,
      answering({}, 404),
    )
    const models = result.steps.find((step) => step.step === 'models')
    expect(models?.status).toBe('note')
    expect(models?.detail).toContain('Type the model id by hand')
    expect(result.ok).toBe(true)
  })

  it('still passes when the catalogue is there', async () => {
    const result = await testConnection(
      profile,
      { secrets: undefined } as never,
      answering({ data: [{ id: 'a-model' }] }),
    )
    expect(result.steps.find((step) => step.step === 'models')?.status).toBe('ok')
    expect(result.ok).toBe(true)
  })
})
