import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { explainStep } from './httpTrace.js'

describe('a failed step, read in words', () => {
  const step = (over: Partial<Parameters<typeof explainStep>[0]>) => ({ method: 'GET', url: 'https://jira.test/rest/api/2/myself', requestHeaders: {}, millis: 5, ...over })
  it('names the usual cause of each failure', () => {
    expect(explainStep(step({ error: 'getaddrinfo ENOTFOUND jira.test' }))).toMatch(/does not resolve/)
    expect(explainStep(step({ error: 'unable to verify the first certificate' }))).toMatch(/certificate is not trusted/)
    expect(explainStep(step({ status: 401 }))).toMatch(/Not signed in/)
    expect(explainStep(step({ status: 403 }))).toMatch(/may not do this/)
    expect(explainStep(step({ status: 404 }))).toMatch(/context path/)
    expect(explainStep(step({ status: 302, responseHeaders: { Location: 'https://sso.test/login' } }))).toMatch(/sso\.test\/login/)
    expect(explainStep(step({ status: 200, responseBody: '<!DOCTYPE html><html>Sign in</html>' }))).toMatch(/single sign-on/)
    expect(explainStep(step({ status: 200, responseBody: '{"name":"jsmith"}' }))).toBeUndefined()
  })

  it('leads the details with the first step that failed', () => {
    const text = renderTrace([step({ status: 200, responseBody: '{}' }), step({ status: 404, responseBody: 'Not Found' })])
    expect(text.startsWith('Likely cause (step #2): Nothing at this address')).toBe(true)
    expect(text).toContain('What this usually means:')
  })
})

import { AtlassianRest } from '../atlassian/rest.js'
import type { HttpClient, HttpResponse } from './http.js'
import { maskBody, maskHeaders, renderTrace, tracingHttpClient, type TraceEntry } from './httpTrace.js'

/*
 * Reported: Postman showed HTTP 403 for a service account; Light Code's test showed a different sentence.
 * The record behind the Details button is what the sentence was read from - and it is shown on screen
 * and copied into messages, so every credential must be masked before it is kept.
 */

function serve(status: number, body: string, headers: Record<string, string> = {}): HttpClient {
  return {
    async request(): Promise<HttpResponse> {
      return { status, headers, body: null, text: async () => body, json: async <T>() => JSON.parse(body) as T }
    },
  }
}

describe('masking', () => {
  it('keeps the scheme and, for Basic, the user name - never the password or token', () => {
    const basic = `Basic ${Buffer.from('svc_batch:hunter22').toString('base64')}`
    const masked = maskHeaders({ Authorization: 'Bearer abc.def.ghi', 'x-api-authorization-header-for-service-provider': basic, 'x-apigee-token': 'tok123', Accept: 'application/json' })
    expect(masked['Authorization']).toBe('Bearer ••• (11 characters)')
    expect(masked['x-api-authorization-header-for-service-provider']).toBe('Basic svc_batch:••• (base64 of user:password)')
    expect(masked['x-apigee-token']).toContain('•••')
    expect(masked['Accept']).toBe('application/json')
    expect(JSON.stringify(masked)).not.toMatch(/hunter22|abc\.def|tok123/)
  })

  it('masks secret fields in form and JSON bodies, and any known secret anywhere', () => {
    expect(maskBody('grant_type=client_credentials&client_id=app1&client_secret=s3cret')).toBe('grant_type=client_credentials&client_id=app1&client_secret=•••')
    const json = maskBody('{"access_token":"tok-1","expires_in":3600,"user":"svc"}')
    expect(json).not.toContain('tok-1')
    expect(json).toContain('3600')
    expect(maskBody('error: password hunter22 rejected', ['hunter22'])).not.toContain('hunter22')
  })
})

describe('the record', () => {
  it('keeps the status, headers and body of a 403 that the sentence summarises', async () => {
    const entries: TraceEntry[] = []
    const http = tracingHttpClient(serve(403, '{"message":"User svc_batch is not authorized for job-run-info"}', { 'content-type': 'application/json' }), entries, ['secret-pw'])
    const rest = new AtlassianRest(http, 'autosys', { baseUrl: 'https://wla.test', token: 'secret-pw', username: 'svc_batch' })
    await expect(rest.json('reading status', '/AEWS/job-run-info?filter=name%3D%3DX', { method: 'GET' })).rejects.toThrow(/HTTP 403 \(forbidden\)/)
    const text = renderTrace(entries)
    expect(text).toContain('#1 GET https://wla.test/AEWS/job-run-info')
    expect(text).toContain('Response: HTTP 403')
    expect(text).toContain('content-type: application/json')
    expect(text).toContain('not authorized for job-run-info')
    expect(text).toContain('Authorization: Basic svc_batch:•••')
    expect(text).not.toContain('secret-pw')
  })

  it('records a request that got no answer, with the reason under it', async () => {
    const entries: TraceEntry[] = []
    const failing: HttpClient = {
      async request() {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) })
      },
    }
    await expect(tracingHttpClient(failing, entries).request('https://wla.test/x')).rejects.toThrow()
    expect(renderTrace(entries)).toMatch(/No response after \d+ ms: TypeError: fetch failed <- unable to verify the first certificate \[UNABLE_TO_VERIFY_LEAF_SIGNATURE\]/)
  })

  it('says when nothing was sent at all', () => {
    expect(renderTrace([])).toContain('No request was sent')
  })
})

describe('wiring', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'host', 'bridge.ts'), 'utf8')

  it('records Test connection through the tracing client, gateway token request included', () => {
    const test = bridge.slice(bridge.indexOf('async function handleTestAtlassian('), bridge.indexOf('/** The panel\'s whole view of S3.'))
    expect(test).toContain('tracingHttpClient(httpClient, entries, knownSecrets)')
    expect(test.match(/diagnostics: renderTrace\(entries\)/g)).toHaveLength(2)
    expect(bridge).toContain('const gatewayAuth = await autosysGatewayAuth(config, tls, http)')
  })

  it('honours read-only access on all five DevOps connections', () => {
    for (const [label, cached] of [
      ['Confluence', 'cachedConfluence'],
      ['Jira', 'cachedJira'],
      ['Jenkins', 'cachedJenkins'],
      ['AutoSys', 'cachedAutosys'],
      ['Bitbucket', 'cachedBitbucket'],
    ]) {
      expect(bridge).toContain(`${cached}.readOnly === true,\n        '${label}',`)
    }
  })
})
