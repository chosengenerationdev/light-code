import { describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../../platform/http.js'
import { ApigeeAuthError, ApigeeMtlsAuthStrategy, defaultTokenUrl, describeTlsError } from './apigeeMtls.js'

/** A stand-in Apigee token endpoint: counts calls and can be made slow or failing. */
class MockTokenEndpoint implements HttpClient {
  public calls = 0
  public lastBody: string | undefined
  public lastTlsPresented = false

  constructor(
    private readonly respond: (call: number) => { status: number; payload: unknown },
    private readonly delayMs = 0,
  ) {}

  async request(_url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.calls += 1
    this.lastBody = options.body
    this.lastTlsPresented = options.tls !== undefined
    const { status, payload } = this.respond(this.calls)
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    return {
      status,
      headers: {},
      text: async () => JSON.stringify(payload),
      json: async <T>() => payload as T,
      body: null,
    }
  }
}

function ok(token: string, expiresIn?: number) {
  return () => ({
    status: 200,
    payload: expiresIn === undefined ? { access_token: token } : { access_token: token, expires_in: expiresIn },
  })
}

describe('defaultTokenUrl', () => {
  it('derives the token endpoint from the base URL origin', () => {
    expect(defaultTokenUrl('https://gw.example.com/v1/openai')).toBe('https://gw.example.com/oauth/token')
  })

  it('returns empty for an unparseable base URL rather than throwing', () => {
    expect(defaultTokenUrl('not a url')).toBe('')
  })
})

describe('token acquisition', () => {
  it('sends a client_credentials form body and attaches client TLS', async () => {
    const endpoint = new MockTokenEndpoint(ok('tok-1', 3600))
    const strategy = new ApigeeMtlsAuthStrategy(
      endpoint,
      { clientId: 'id', resolveClientSecret: async () => 'secret', scope: 'inference' },
      'https://gw.example.com/v1',
      async () => ({ cert: Buffer.from('cert'), key: Buffer.from('key') }),
    )

    const headers = await strategy.resolveHeaders()

    expect(headers.Authorization).toBe('Bearer tok-1')
    expect(endpoint.lastTlsPresented).toBe(true)
    const body = new URLSearchParams(endpoint.lastBody ?? '')
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('client_id')).toBe('id')
    expect(body.get('client_secret')).toBe('secret')
    expect(body.get('scope')).toBe('inference')
  })

  it('honours a custom header name and prefix', async () => {
    const endpoint = new MockTokenEndpoint(ok('tok', 3600))
    const strategy = new ApigeeMtlsAuthStrategy(
      endpoint,
      { tokenHeaderName: 'X-Gateway-Token', tokenHeaderPrefix: '' },
      'https://gw.example.com/v1',
      async () => undefined,
    )

    expect(await strategy.resolveHeaders()).toEqual({ 'X-Gateway-Token': 'tok' })
  })

  it('reads a token nested at a configured path', async () => {
    const endpoint = new MockTokenEndpoint(() => ({ status: 200, payload: { data: { jwt: 'nested-tok' } } }))
    const strategy = new ApigeeMtlsAuthStrategy(
      endpoint,
      { tokenPath: 'data.jwt', expiresInPath: 'data.ttl' },
      'https://gw.example.com/v1',
      async () => undefined,
    )

    expect((await strategy.resolveHeaders()).Authorization).toBe('Bearer nested-tok')
  })

  it('explains a missing token instead of sending an empty header', async () => {
    const endpoint = new MockTokenEndpoint(() => ({ status: 200, payload: { unexpected: true } }))
    const strategy = new ApigeeMtlsAuthStrategy(endpoint, {}, 'https://gw.example.com/v1', async () => undefined)

    await expect(strategy.resolveHeaders()).rejects.toThrow(/no token at "access_token"/)
  })

  it('surfaces a non-2xx token response with its status', async () => {
    const endpoint = new MockTokenEndpoint(() => ({ status: 401, payload: { error: 'invalid_client' } }))
    const strategy = new ApigeeMtlsAuthStrategy(endpoint, {}, 'https://gw.example.com/v1', async () => undefined)

    await expect(strategy.resolveHeaders()).rejects.toThrow(/HTTP 401/)
    await expect(strategy.resolveHeaders()).rejects.toBeInstanceOf(ApigeeAuthError)
  })
})

describe('caching and proactive refresh', () => {
  it('reuses a valid token rather than re-fetching per request', async () => {
    const endpoint = new MockTokenEndpoint(ok('tok', 3600))
    const strategy = new ApigeeMtlsAuthStrategy(endpoint, {}, 'https://gw.example.com/v1', async () => undefined)

    await strategy.resolveHeaders()
    await strategy.resolveHeaders()
    await strategy.resolveHeaders()

    expect(endpoint.calls).toBe(1)
  })

  it('refreshes before real expiry, by the configured skew', async () => {
    let clock = 1_000_000
    const endpoint = new MockTokenEndpoint((call) => ({
      status: 200,
      payload: { access_token: `tok-${call}`, expires_in: 100 },
    }))
    const strategy = new ApigeeMtlsAuthStrategy(
      endpoint,
      { refreshSkewSeconds: 30 },
      'https://gw.example.com/v1',
      async () => undefined,
      () => clock,
    )

    expect((await strategy.resolveHeaders()).Authorization).toBe('Bearer tok-1')

    // 69s in: still inside the refresh window (100 - 30 = 70).
    clock += 69_000
    expect((await strategy.resolveHeaders()).Authorization).toBe('Bearer tok-1')

    // 71s in: past the skew boundary but well before the token actually expires — the
    // whole point is never to wait for a 401.
    clock += 2_000
    expect((await strategy.resolveHeaders()).Authorization).toBe('Bearer tok-2')
    expect(endpoint.calls).toBe(2)
  })

  it('falls back to a default lifetime when the gateway omits expires_in', async () => {
    let clock = 0
    const endpoint = new MockTokenEndpoint(ok('tok'))
    const strategy = new ApigeeMtlsAuthStrategy(
      endpoint,
      { fallbackExpirySeconds: 600, refreshSkewSeconds: 60 },
      'https://gw.example.com/v1',
      async () => undefined,
      () => clock,
    )

    await strategy.resolveHeaders()
    clock += 500_000 // inside 600 - 60
    await strategy.resolveHeaders()
    expect(endpoint.calls).toBe(1)

    clock += 100_000 // past it
    await strategy.resolveHeaders()
    expect(endpoint.calls).toBe(2)
  })
})

describe('single-flight', () => {
  it('ten concurrent requests trigger exactly one token fetch', async () => {
    const endpoint = new MockTokenEndpoint(ok('tok', 3600), 20)
    const strategy = new ApigeeMtlsAuthStrategy(endpoint, {}, 'https://gw.example.com/v1', async () => undefined)

    const results = await Promise.all(Array.from({ length: 10 }, () => strategy.resolveHeaders()))

    expect(endpoint.calls).toBe(1)
    for (const headers of results) expect(headers.Authorization).toBe('Bearer tok')
  })

  it('a failed refresh does not wedge the strategy for later callers', async () => {
    let shouldFail = true
    const endpoint = new MockTokenEndpoint(() =>
      shouldFail ? { status: 500, payload: { error: 'boom' } } : { status: 200, payload: { access_token: 'tok' } },
    )
    const strategy = new ApigeeMtlsAuthStrategy(endpoint, {}, 'https://gw.example.com/v1', async () => undefined)

    await expect(strategy.resolveHeaders()).rejects.toThrow()

    // The in-flight promise must have been cleared, or every later call would reject too.
    shouldFail = false
    expect((await strategy.resolveHeaders()).Authorization).toBe('Bearer tok')
  })
})

describe('401 handling', () => {
  it('force-refreshes once and reports the retry is worth attempting', async () => {
    const endpoint = new MockTokenEndpoint((call) => ({ status: 200, payload: { access_token: `tok-${call}` } }))
    const strategy = new ApigeeMtlsAuthStrategy(endpoint, {}, 'https://gw.example.com/v1', async () => undefined)

    expect((await strategy.resolveHeaders()).Authorization).toBe('Bearer tok-1')

    expect(await strategy.onUnauthorized()).toBe(true)
    // The cached token was discarded, so the next header carries the new one.
    expect((await strategy.resolveHeaders()).Authorization).toBe('Bearer tok-2')
    expect(endpoint.calls).toBe(2)
  })

  it('reports no retry when the refresh itself fails, so the caller cannot loop', async () => {
    let calls = 0
    const endpoint = new MockTokenEndpoint(() => {
      calls += 1
      return calls === 1 ? { status: 200, payload: { access_token: 'tok' } } : { status: 401, payload: {} }
    })
    const strategy = new ApigeeMtlsAuthStrategy(endpoint, {}, 'https://gw.example.com/v1', async () => undefined)

    await strategy.resolveHeaders()
    expect(await strategy.onUnauthorized()).toBe(false)
  })
})

describe('stream lifetime', () => {
  it('replaces a token that would expire mid-generation', async () => {
    const clock = 0
    const endpoint = new MockTokenEndpoint((call) => ({
      status: 200,
      // First token is short-lived; the replacement is comfortable.
      payload: { access_token: `tok-${call}`, expires_in: call === 1 ? 90 : 3600 },
    }))
    const strategy = new ApigeeMtlsAuthStrategy(
      endpoint,
      { refreshSkewSeconds: 0 },
      'https://gw.example.com/v1',
      async () => undefined,
      () => clock,
    )

    await strategy.resolveHeaders()
    expect(endpoint.calls).toBe(1)

    // 90s of remaining life is under the 120s stream margin, so it is swapped out even
    // though it has not reached the ordinary refresh point.
    await strategy.ensureTokenForStream()
    expect(endpoint.calls).toBe(2)
    expect((await strategy.resolveHeaders()).Authorization).toBe('Bearer tok-2')
  })

  it('leaves a comfortably-valid token alone', async () => {
    const endpoint = new MockTokenEndpoint(ok('tok', 3600))
    const strategy = new ApigeeMtlsAuthStrategy(endpoint, {}, 'https://gw.example.com/v1', async () => undefined)

    await strategy.resolveHeaders()
    await strategy.ensureTokenForStream()
    expect(endpoint.calls).toBe(1)
  })
})

describe('describeTlsError', () => {
  it.each([
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /corporate root CA/],
    ['CERT_HAS_EXPIRED', /server certificate has expired/],
    ['ECONNREFUSED', /connection was refused/],
    ['ENOTFOUND', /host could not be resolved/],
  ])('translates %s into something actionable', (code, expected) => {
    const error = Object.assign(new Error('socket failure'), { code })
    expect(describeTlsError(error)).toMatch(expected)
  })

  it('never leaks a raw OpenSSL code to the user', () => {
    const error = Object.assign(new Error('routines::unable to get local issuer certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    })
    expect(describeTlsError(error)).not.toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE/)
  })

  /**
   * Regression: undici reports every transport failure as a bare `TypeError: fetch failed`
   * and hangs the real reason off `.cause`. Reading only the top level turned the most
   * likely corporate failure into an unactionable "fetch failed" — caught by running
   * against a real HTTPS server whose CA we had not trusted.
   */
  it('unwraps the cause chain undici hides the real reason behind', () => {
    const cause = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    })
    const wrapped = Object.assign(new TypeError('fetch failed'), { cause })

    expect(describeTlsError(wrapped)).toMatch(/corporate root CA/)
  })

  it('unwraps a doubly-nested cause', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' })
    const middle = Object.assign(new Error('socket error'), { cause: inner })
    const wrapped = Object.assign(new TypeError('fetch failed'), { cause: middle })

    expect(describeTlsError(wrapped)).toMatch(/connection was refused/)
  })

  it('falls back to the deepest cause rather than repeating "fetch failed"', () => {
    const cause = new Error('something specific the gateway said')
    const wrapped = Object.assign(new TypeError('fetch failed'), { cause })

    expect(describeTlsError(wrapped)).toBe('something specific the gateway said')
  })

  it('tolerates a self-referential cause without spinning', () => {
    const error: Error & { cause?: unknown } = new Error('loop')
    error.cause = error
    expect(describeTlsError(error)).toBe('loop')
  })
})
