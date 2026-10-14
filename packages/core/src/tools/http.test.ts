import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NEGOTIATE_SCRIPT, negotiateRequest } from '../platform/node/negotiateHttp.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import { createHttpTool, hostsIn, userNamedHost, type HttpToolOptions } from './http.js'
import type { ToolExecutionContext } from './types.js'

function response(status: number, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }): HttpResponse {
  const bytes = new TextEncoder().encode(body)
  return {
    status,
    headers,
    text: async () => body,
    json: async <T>() => JSON.parse(body) as T,
    body: new ReadableStream({ start: (c) => (c.enqueue(bytes), c.close()) }),
  }
}

function setup(answer: (url: string, options: HttpRequestOptions) => HttpResponse, extra: Partial<HttpToolOptions> = {}) {
  const calls: { url: string; options: HttpRequestOptions }[] = []
  const http: HttpClient = { request: async (url, options = {}) => (calls.push({ url, options }), answer(url, options)) }
  const tool = createHttpTool({
    http,
    tls: async () => undefined,
    profileAuth: async () => ({ problem: 'none' }),
    secret: async (name) => (name === 'orders-token' ? 's3cr3t-value' : undefined),
    ...extra,
  })
  const context = (userText: string) => ({ userText: () => userText }) as unknown as ToolExecutionContext
  return { tool, calls, context }
}

describe('http_request', () => {
  it('finds hosts the user wrote, in URLs or bare', () => {
    expect([...hostsIn('try https://api.corp.test:8443/v1 and orders.corp.test, then 10.1.2.3')].sort()).toEqual(['10.1.2.3', 'api.corp.test', 'orders.corp.test'])
    expect(userNamedHost(new URL('https://orders.corp.test/x'), 'use orders.corp.test')).toBe(true)
    // Exact host only: naming the domain does not cover its subdomains, or a look-alike.
    expect(userNamedHost(new URL('https://api.corp.test/x'), 'use corp.test')).toBe(false)
    expect(userNamedHost(new URL('https://evil-corp.test/x'), 'use corp.test')).toBe(false)
  })

  it('refuses a host the user never named, and sends nothing', async () => {
    const { tool, calls, context } = setup(() => response(200, '{}'))
    const result = await tool.execute({ method: 'GET', url: 'https://attacker.test/steal' }, context('please call https://api.corp.test/v1/items'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('attacker.test is not a host the user named')
    expect(calls).toHaveLength(0)
    const preview = await tool.preview?.({ method: 'GET', url: 'https://attacker.test/steal' }, context(''))
    expect(JSON.stringify(preview)).toContain('WILL BE REFUSED')
  })

  it('resolves a secret on the wire but shows only its name in the approval', async () => {
    const { tool, calls, context } = setup(() => response(200, '{"items":[1,2]}'))
    const params = { method: 'GET' as const, url: 'https://api.corp.test/v1/items', headers: { Authorization: 'Bearer ${secret:orders-token}' }, query: { limit: 2 } }
    const preview = JSON.stringify(await tool.preview?.(params, context('api.corp.test')))
    expect(preview).toContain('${secret:orders-token}')
    expect(preview).not.toContain('s3cr3t-value')
    const result = await tool.execute(params, context('api docs: https://api.corp.test'))
    expect(calls[0]?.options.headers?.['Authorization']).toBe('Bearer s3cr3t-value')
    expect(calls[0]?.url).toBe('https://api.corp.test/v1/items?limit=2')
    expect(result.content).toContain('HTTP 200')
    expect(result.content).toContain('"items"')
  })

  it('posts JSON with its content type', async () => {
    const { tool, calls, context } = setup(() => response(201, '{"id":7}'))
    await tool.execute({ method: 'POST', url: 'https://api.corp.test/v1/items', json: { name: 'x' } }, context('api.corp.test'))
    expect(calls[0]?.options.method).toBe('POST')
    expect(calls[0]?.options.body).toBe('{"name":"x"}')
    expect(calls[0]?.options.headers?.['Content-Type']).toBe('application/json')
  })

  it('polls a 202 at its Location until the job finishes', async () => {
    let polls = 0
    const { tool, calls, context } = setup((url) => {
      if (url.endsWith('/jobs')) return response(202, '', { location: '/jobs/42', 'retry-after': '0.01' })
      polls += 1
      return polls < 3 ? response(202, '', { 'retry-after': '0.01' }) : response(200, '{"done":true}')
    })
    const result = await tool.execute({ method: 'POST', url: 'https://api.corp.test/jobs', json: {} }, context('api.corp.test'))
    expect(result.content).toContain('HTTP 200')
    expect(result.content).toContain('polling https://api.corp.test/jobs/42')
    expect(calls.map((c) => c.options.method)).toEqual(['POST', 'GET', 'GET', 'GET'])
  })

  it('will not follow a 202 to a host the user did not name', async () => {
    const { tool, context } = setup(() => response(202, '', { location: 'https://elsewhere.test/jobs/1' }))
    const result = await tool.execute({ method: 'GET', url: 'https://api.corp.test/jobs' }, context('api.corp.test'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('elsewhere.test')
  })

  it('borrows a provider profile\'s token, refreshing once on 401', async () => {
    let refreshed = false
    let n = 0
    const { tool, calls, context } = setup(() => (n++ === 0 ? response(401, '{}') : response(200, '{}')), {
      profileAuth: async () => ({
        resolveHeaders: async () => ({ Authorization: refreshed ? 'Bearer new' : 'Bearer old' }),
        onUnauthorized: async () => ((refreshed = true), true),
      }),
    })
    const result = await tool.execute({ method: 'GET', url: 'https://gw.corp.test/api', auth: { type: 'profile', profile: 'Gateway' } }, context('gw.corp.test'))
    expect(result.content).toContain('HTTP 200')
    expect(calls.map((c) => c.options.headers?.['Authorization'])).toEqual(['Bearer old', 'Bearer new'])
  })

  it('is a command that asks, so every request is shown first', () => {
    const { tool } = setup(() => response(200, '{}'))
    expect(tool.group).toBe('command')
    expect(ALWAYS_ASK_TOOLS.has('http_request')).toBe(false)
  })
})

describe('negotiate transport', () => {
  let server: Server
  let base = ''
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, body, header: req.headers['x-test'] ?? null }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })
  afterAll(() => server.close())

  it('is pure ASCII and takes the request only on stdin', () => {
    expect([...NEGOTIATE_SCRIPT].every((c) => c.charCodeAt(0) < 128)).toBe(true)
    expect(NEGOTIATE_SCRIPT).not.toMatch(/Invoke-Expression|iex /i)
  })

  it.skipIf(process.platform !== 'win32')('sends through Windows\' HTTP stack and reads the answer', async () => {
    const answer = await negotiateRequest({ method: 'POST', url: `${base}/echo`, headers: { 'X-Test': 'yes', 'Content-Type': 'application/json' }, body: '{"a":1}', timeoutSec: 20 })
    expect(answer.status).toBe(200)
    const echoed = JSON.parse(Buffer.from(answer.body).toString('utf8')) as { method: string; body: string; header: string }
    expect(echoed).toEqual({ method: 'POST', body: '{"a":1}', header: 'yes' })
  }, 60_000)
})

describe('the http_request proxy', () => {
  it('splits a typed address into a stored URL and a secret password', async () => {
    const { splitProxyLogin } = await import('../platform/proxy.js')
    expect(splitProxyLogin('http://ann:p%40ss@proxy.corp:8080')).toEqual({ url: 'http://ann@proxy.corp:8080', user: 'ann', password: 'p@ss' })
    expect(splitProxyLogin('proxy.corp:3128')).toEqual({ url: 'http://proxy.corp:3128' })
    expect(() => splitProxyLogin('socks5://proxy:1080')).toThrow(/http:\/\/ or https:\/\//)
  })

  it('picks the proxy by the target\'s scheme and honours no-proxy', async () => {
    const { proxyFor } = await import('./http.js')
    const proxy = { http: 'http://a:1@p1:8080', https: 'http://b:2@p2:8080', noProxy: '.internal' }
    expect(proxyFor(new URL('https://api.corp.test/x'), proxy)).toEqual({ url: 'http://p2:8080', user: 'b', password: '2' })
    expect(proxyFor(new URL('http://api.corp.test/x'), proxy)?.url).toBe('http://p1:8080')
    expect(proxyFor(new URL('https://svc.internal/x'), proxy)).toBeUndefined()
    expect(proxyFor(new URL('https://localhost/x'), proxy)).toBeUndefined()
  })

  it('goes through an authenticating proxy with the stored login', async () => {
    const { FetchHttpClient } = await import('../platform/http.js')
    const net = await import('node:net')
    const target = createServer((_req, res) => res.end('{"through":"proxy"}'))
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const seen: string[] = []
    const proxy = createServer()
    proxy.on('connect', (req, socket, head) => {
      seen.push(String(req.headers['proxy-authorization'] ?? 'none'))
      if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('ann:s3cret').toString('base64')}`) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
        return
      }
      const upstream = net.connect((target.address() as AddressInfo).port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const proxyUrl = `http://ann:s3cret@127.0.0.1:${String((proxy.address() as AddressInfo).port)}`
    // The target is reached by name so loopback is not exempted; the proxy resolves it itself.
    const tool = createHttpTool({
      http: new FetchHttpClient(),
      tls: async () => undefined,
      profileAuth: async () => ({ problem: 'none' }),
      secret: async () => undefined,
      proxy: async () => ({ http: proxyUrl, https: proxyUrl }),
    })
    const host = `api.corp.test:${String((target.address() as AddressInfo).port)}`
    const result = await tool.execute({ method: 'GET', url: `http://${host}/x` }, { userText: () => 'api.corp.test' } as unknown as ToolExecutionContext)
    proxy.close()
    target.close()
    expect(seen[0]).toBe(`Basic ${Buffer.from('ann:s3cret').toString('base64')}`)
    expect(result.content, result.content).toContain('{"through":"proxy"}')
    const preview = JSON.stringify(await tool.preview?.({ method: 'GET', url: `http://${host}/x` }, { userText: () => 'api.corp.test' } as unknown as ToolExecutionContext))
    expect(preview).toContain('Proxy: ann@127.0.0.1')
    expect(preview).not.toContain('s3cret')
  }, 30_000)
})

describe('the negotiate transport through a proxy', () => {
  it.skipIf(process.platform !== 'win32')('answers the proxy\'s login challenge with the stored credentials', async () => {
    const { request: forward } = await import('node:http')
    const target = createServer((_req, res) => res.end('{"via":"proxy"}'))
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const seen: string[] = []
    const proxy = createServer((req, res) => {
      const auth = req.headers['proxy-authorization']
      seen.push(String(auth ?? 'none'))
      if (auth !== `Basic ${Buffer.from('ann:s3cret').toString('base64')}`) {
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="corp"' })
        res.end()
        return
      }
      // A forward proxy: the request line carries the absolute URL; the made-up host is served from loopback.
      const wanted = new URL(req.url ?? '/')
      const upstream = forward({ host: '127.0.0.1', port: (target.address() as AddressInfo).port, path: wanted.pathname, method: req.method }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      })
      req.pipe(upstream)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const port = (target.address() as AddressInfo).port
    const answer = await negotiateRequest({
      method: 'GET',
      // Not 127.0.0.1: .NET never sends a loopback address through a proxy.
      url: `http://api.corp.test:${String(port)}/x`,
      headers: {},
      timeoutSec: 20,
      proxy: `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`,
      proxyUser: 'ann',
      proxyPassword: 's3cret',
    })
    proxy.close()
    target.close()
    expect(answer.status).toBe(200)
    expect(Buffer.from(answer.body).toString('utf8')).toBe('{"via":"proxy"}')
    expect(seen).toContain(`Basic ${Buffer.from('ann:s3cret').toString('base64')}`)
  }, 60_000)
})
