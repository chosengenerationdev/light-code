import { describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { NoAuthStrategy } from './auth/apiKey.js'
import { listModels, lookupModelCapabilities, resolveModelCapabilities } from './models.js'
import type { AuthStrategy } from './types.js'

function respond(status: number, payload: unknown): HttpClient {
  return {
    async request(): Promise<HttpResponse> {
      return {
        status,
        headers: {},
        text: async () => JSON.stringify(payload),
        json: async <T>() => payload as T,
        body: null,
      }
    },
  }
}

const throwingHttp: HttpClient = {
  async request(): Promise<HttpResponse> {
    throw Object.assign(new Error('handshake failed'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
  },
}

const profile = { baseUrl: 'https://gw.example.com/v1' }

describe('lookupModelCapabilities', () => {
  it('recognises a known model', () => {
    const caps = lookupModelCapabilities('gpt-4o')
    expect(caps).toMatchObject({ contextWindow: 128_000, supportsVision: true, supportsTools: true, known: true })
  })

  it('prefers the more specific key when one id contains another', () => {
    expect(lookupModelCapabilities('gpt-4o-mini').contextWindow).toBe(128_000)
    // gpt-4 is a substring of gpt-4.1, and their windows differ — specificity decides.
    expect(lookupModelCapabilities('gpt-4.1').contextWindow).toBe(1_047_576)
    expect(lookupModelCapabilities('gpt-4').contextWindow).toBe(8_192)
  })

  it('matches a gateway alias that wraps a known family', () => {
    const caps = lookupModelCapabilities('corp-openai-GPT-4o-v2')
    expect(caps.known).toBe(true)
    expect(caps.contextWindow).toBe(128_000)
  })

  it('defaults conservatively for an unrecognised id, and says so', () => {
    const caps = lookupModelCapabilities('internal-alias-7')
    expect(caps.known).toBe(false)
    expect(caps.contextWindow).toBe(32_768)
    expect(caps.supportsVision).toBe(false)
  })

  it('records that deepseek-reasoner does not take tools', () => {
    expect(lookupModelCapabilities('deepseek-reasoner').supportsTools).toBe(false)
    expect(lookupModelCapabilities('deepseek-chat').supportsTools).toBe(true)
  })
})

describe('resolveModelCapabilities', () => {
  it('lets a per-profile override beat the table', () => {
    const caps = resolveModelCapabilities('gpt-4o', { contextWindow: 8_000 })
    expect(caps.contextWindow).toBe(8_000)
    expect(caps.supportsVision).toBe(true) // untouched fields still come from the table
  })

  it('marks an overridden unknown model as known', () => {
    expect(resolveModelCapabilities('mystery-alias', { contextWindow: 200_000 }).known).toBe(true)
  })

  it('ignores an override object with nothing set', () => {
    expect(resolveModelCapabilities('mystery-alias', {}).known).toBe(false)
  })
})

describe('listModels', () => {
  const auth: AuthStrategy = new NoAuthStrategy()

  it('reads the OpenAI-compatible data array', async () => {
    const http = respond(200, { data: [{ id: 'b-model' }, { id: 'a-model' }] })
    await expect(listModels(http, profile, auth)).resolves.toEqual({ ids: ['a-model', 'b-model'] })
  })

  it('reads Gemini-style entries and strips the models/ prefix', async () => {
    const http = respond(200, { models: [{ name: 'models/gemini-2.5-pro' }] })
    expect((await listModels(http, profile, auth)).ids).toEqual(['gemini-2.5-pro'])
  })

  it('accepts a bare array of strings', async () => {
    const http = respond(200, ['x', 'y', 'x'])
    expect((await listModels(http, profile, auth)).ids).toEqual(['x', 'y'])
  })

  it('treats a 404 as a note, not a failure — the dropdown is never a hard dependency', async () => {
    const result = await listModels(respond(404, {}), profile, auth)
    expect(result.ids).toEqual([])
    expect(result.warning).toMatch(/does not publish a model list/)
  })

  it('reports a non-2xx status without throwing', async () => {
    const result = await listModels(respond(500, {}), profile, auth)
    expect(result.warning).toMatch(/HTTP 500/)
  })

  it('translates a transport failure instead of surfacing an OpenSSL code', async () => {
    const result = await listModels(throwingHttp, profile, auth)
    expect(result.warning).toMatch(/corporate root CA/)
    expect(result.warning).not.toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE/)
  })

  it('reports a credential failure rather than listing anonymously', async () => {
    const failing: AuthStrategy = {
      async resolveHeaders() {
        throw new Error('API key missing for this provider profile.')
      },
    }
    const result = await listModels(respond(200, { data: [{ id: 'x' }] }), profile, failing)
    expect(result.ids).toEqual([])
    expect(result.warning).toMatch(/API key missing/)
  })

  it('presents client TLS when the strategy supplies it', async () => {
    let presented = false
    const http: HttpClient = {
      async request(_url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
        presented = options.tls !== undefined
        const payload = { data: [{ id: 'x' }] }
        return { status: 200, headers: {}, text: async () => '', json: async <T>() => payload as T, body: null }
      },
    }
    const mtlsAuth: AuthStrategy = {
      async resolveHeaders() {
        return {}
      },
      async tls() {
        return { cert: Buffer.from('c'), key: Buffer.from('k') }
      },
    }

    await listModels(http, profile, mtlsAuth)
    expect(presented).toBe(true)
  })
})

describe('self-hosted model families', () => {
  /** These arrive renamed behind a corporate gateway, which is what substring matching is for. */
  it('recognises Qwen, including prefixed gateway aliases', () => {
    expect(lookupModelCapabilities('qwen2.5-coder-32b-instruct').known).toBe(true)
    expect(lookupModelCapabilities('internal-qwen3-coder-480b').contextWindow).toBe(262_144)
    expect(lookupModelCapabilities('Qwen/Qwen2.5-72B-Instruct').known).toBe(true)
  })

  it('knows which Qwen variants take images', () => {
    expect(lookupModelCapabilities('qwen2.5-vl-7b').supportsVision).toBe(true)
    expect(lookupModelCapabilities('qwen2.5-coder').supportsVision).toBe(false)
  })

  it('falls back to the bare qwen entry for an unlisted version', () => {
    const caps = lookupModelCapabilities('qwen9-something-new')
    expect(caps.known).toBe(true)
    expect(caps.supportsTools).toBe(true)
  })

  it('recognises Gemma, including a version not in the table', () => {
    expect(lookupModelCapabilities('gemma-3-27b-it').contextWindow).toBe(131_072)
    expect(lookupModelCapabilities('gemma-2-9b').contextWindow).toBe(8_192)
    // A future or internally-named release still matches the family rather than
    // dropping to the 32k default, which is what made token counts wrong.
    expect(lookupModelCapabilities('gemma-4-12b').known).toBe(true)
  })

  it('treats Gemma as vision-capable, so pasting a screenshot is not silently refused', () => {
    expect(lookupModelCapabilities('gemma-3-12b-it').supportsVision).toBe(true)
  })
})
