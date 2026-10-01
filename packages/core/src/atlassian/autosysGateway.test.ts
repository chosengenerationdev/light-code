import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { AutosysGatewaySettings } from '../agent/protocol.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { ApigeeMtlsAuthStrategy } from '../providers/auth/apigeeMtls.js'
import { AutosysClient } from './autosys.js'
import { AUTOSYS_CLIENT_SECRET_REF, gatewayFromSettings, gatewayView } from './autosysGateway.js'

const blank = (): AutosysGatewaySettings => ({ ...gatewayView(undefined, false, false) })

function response(status: number, body: unknown): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return { status, headers: {}, text: async () => text, json: async <T>() => JSON.parse(text) as T, body: null }
}

/** A gateway issuing tokens at one host and an AutoSys API at another, recording every request. */
function fakeGateway(options: { rejectFirstApiCall?: boolean } = {}) {
  const calls: { url: string; options: HttpRequestOptions }[] = []
  let issued = 0
  let apiCalls = 0
  const http: HttpClient = {
    async request(url, requestOptions = {}) {
      calls.push({ url, options: requestOptions })
      if (url === 'https://gw.test/oauth/token') {
        issued += 1
        return response(200, { access_token: `tok-${issued}`, expires_in: 1800 })
      }
      apiCalls += 1
      if (options.rejectFirstApiCall === true && apiCalls === 1) return response(401, { message: 'expired' })
      return response(200, [])
    },
  }
  return { http, calls }
}

const tls = { cert: Buffer.from('CERT'), key: Buffer.from('KEY') }

describe('AutoSys through an API gateway', () => {
  it('fetches a token from the token URL and sends it to the AutoSys API, with the client certificate on both', async () => {
    const { http, calls } = fakeGateway()
    const auth = new ApigeeMtlsAuthStrategy(
      http,
      { tokenUrl: 'https://gw.test/oauth/token', clientId: 'lc-app', resolveClientSecret: async () => 's3cret' },
      'https://autosys.test',
      async () => tls,
    )
    const client = new AutosysClient(http, { baseUrl: 'https://autosys.test', token: '', auth, tls })
    await client.probe('lc-app')

    expect(calls[0]?.url).toBe('https://gw.test/oauth/token')
    expect(String(calls[0]?.options.body)).toContain('client_id=lc-app')
    expect(String(calls[0]?.options.body)).toContain('client_secret=s3cret')
    expect(calls[0]?.options.tls).toEqual(tls)
    expect(calls[1]?.url.startsWith('https://autosys.test/')).toBe(true)
    expect(calls[1]?.options.headers?.['Authorization']).toBe('Bearer tok-1')
    expect(calls[1]?.options.tls).toEqual(tls)
  })

  it('can send the client id and secret as a Basic header instead', async () => {
    const { http, calls } = fakeGateway()
    const auth = new ApigeeMtlsAuthStrategy(
      http,
      { tokenUrl: 'https://gw.test/oauth/token', clientId: 'lc-app', resolveClientSecret: async () => 's3cret', clientAuthentication: 'header' },
      'https://autosys.test',
      async () => undefined,
    )
    await new AutosysClient(http, { baseUrl: 'https://autosys.test', token: '', auth }).probe('x')
    expect(calls[0]?.options.headers?.['Authorization']).toBe(`Basic ${Buffer.from('lc-app:s3cret').toString('base64')}`)
    expect(String(calls[0]?.options.body)).not.toContain('client_secret')
  })

  /* §10: one retry with a fresh token, never a loop. */
  it('gets a fresh token and retries once when the API answers 401', async () => {
    const { http, calls } = fakeGateway({ rejectFirstApiCall: true })
    const auth = new ApigeeMtlsAuthStrategy(
      http,
      { tokenUrl: 'https://gw.test/oauth/token', clientId: 'lc-app', resolveClientSecret: async () => 's3cret' },
      'https://autosys.test',
      async () => undefined,
    )
    await new AutosysClient(http, { baseUrl: 'https://autosys.test', token: '', auth }).probe('x')
    const api = calls.filter((call) => call.url.startsWith('https://autosys.test/'))
    expect(api.map((call) => call.options.headers?.['Authorization'])).toEqual(['Bearer tok-1', 'Bearer tok-2'])
  })
})

describe('the gateway form', () => {
  it('round-trips, and stores the secret only as a reference', () => {
    const result = gatewayFromSettings(
      { ...blank(), enabled: true, tokenUrl: 'https://gw.test/oauth/token', clientId: 'lc-app', extraHeaders: 'x-api-key: abc', extraTokenParams: 'audience=autosys', tokenHeaderPrefix: 'Bearer' },
      { clientSecret: true, passphrase: false },
    )
    if ('error' in result) throw new Error(result.error)
    expect(result.auth).toMatchObject({
      type: 'apigee',
      clientSecretRef: AUTOSYS_CLIENT_SECRET_REF,
      extraHeaders: { 'x-api-key': 'abc' },
      extraTokenParams: { audience: 'autosys' },
      // "Bearer" without its space would send "Bearerabc…".
      tokenHeaderPrefix: 'Bearer ',
    })
    const view = gatewayView(result.auth, true, false)
    expect(view.extraHeaders).toBe('x-api-key: abc')
    expect(view.enabled).toBe(true)
  })

  it('refuses to switch on without what the token request needs, and names a malformed line', () => {
    expect(gatewayFromSettings({ ...blank(), enabled: true }, { clientSecret: true, passphrase: false })).toEqual({ error: 'Enter the token URL before switching the gateway on.' })
    expect(gatewayFromSettings({ ...blank(), enabled: true, tokenUrl: 'https://gw.test/t', clientId: 'a' }, { clientSecret: false, passphrase: false })).toHaveProperty('error')
    expect(gatewayFromSettings({ ...blank(), extraHeaders: 'no separator' }, { clientSecret: false, passphrase: false })).toEqual({ error: '"no separator" in Extra headers is not Name: value.' })
  })

  /* The DevOps save replaces the whole block; without carrying these, every save erased the gateway sign-in. */
  it('is not erased by an ordinary save of the AutoSys form', () => {
    const bridge = readFileSync(new URL('../host/bridge.ts', import.meta.url), 'utf8')
    expect(bridge).toContain("...(product === 'autosys' && before.autosys?.auth !== undefined ? { auth: before.autosys.auth } : {}),")
    expect(bridge).toContain("...(product === 'autosys' && before.autosys?.paths !== undefined ? { paths: before.autosys.paths } : {}),")
  })
})
