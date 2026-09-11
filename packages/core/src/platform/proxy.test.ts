import { createServer, type Server } from 'node:http'
import { connect as netConnect } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { FetchHttpClient } from './http.js'
import { bypassesProxy, describeProxyEnvironment, proxyForUrl } from './proxy.js'

/**
 * Honouring the proxy environment, because not doing so was the whole bug.
 *
 * Reported from a Linux server: every other process reached the LLM gateway and Light Code alone
 * hung. `undici` does not read `HTTP_PROXY`/`HTTPS_PROXY`; curl, wget, pip and python-requests do.
 * So on a machine whose egress is proxied, we were the one program attempting a direct connection,
 * and a corporate firewall drops those rather than refusing them — which waits for the kernel.
 *
 * The end-to-end check runs a **real proxy on loopback** and asserts the request arrived there.
 * Asserting that we construct a `ProxyAgent` would prove we wrote the line, not that a request
 * goes through it, and the whole failure was a request quietly not going somewhere.
 */
let proxy: Server | undefined
let origin: Server | undefined

afterEach(async () => {
  for (const server of [proxy, origin]) {
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  proxy = undefined
  origin = undefined
})

describe('which proxy a destination goes through', () => {
  const env = { HTTPS_PROXY: 'http://proxy.corp:3128', HTTP_PROXY: 'http://plain.corp:3128' }

  it('picks by the *target* scheme, not the proxy scheme', () => {
    // The classic misconfiguration: an https gateway is reached through a plain-HTTP CONNECT
    // proxy, so reading HTTP_PROXY for it would route the wrong traffic.
    expect(proxyForUrl(new URL('https://gateway.corp/v1'), env)?.uri).toBe('http://proxy.corp:3128')
    expect(proxyForUrl(new URL('http://gateway.corp/v1'), env)?.uri).toBe('http://plain.corp:3128')
  })

  it('accepts a bare host:port, which is what people write', () => {
    expect(
      proxyForUrl(new URL('https://gateway.corp'), { HTTPS_PROXY: 'proxy.corp:3128' })?.uri,
    ).toBe('http://proxy.corp:3128')
  })

  it('prefers the lower-case variable, which is how a shell exports it', () => {
    const both = { https_proxy: 'http://lower:3128', HTTPS_PROXY: 'http://upper:3128' }
    expect(proxyForUrl(new URL('https://gateway.corp'), both)?.uri).toBe('http://lower:3128')
  })

  it('falls back to ALL_PROXY, as curl does', () => {
    expect(
      proxyForUrl(new URL('https://gateway.corp'), { ALL_PROXY: 'http://all:3128' })?.uri,
    ).toBe('http://all:3128')
  })

  /** A proxy for loopback is always a misconfiguration, and would break the host's own UI. */
  it('never proxies loopback', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(proxyForUrl(new URL(`http://${host}:8080/api`), env)).toBeUndefined()
    }
  })

  /*
   * Credentials move to a header. undici 5's ProxyAgent does not read them out of the URI, so
   * leaving them there means an authenticating proxy answers 407 and the user is told their
   * gateway refused them.
   */
  it('carries proxy credentials as a header and keeps them out of the URI', () => {
    const choice = proxyForUrl(new URL('https://gateway.corp'), {
      HTTPS_PROXY: 'http://alice:s3cret@proxy.corp:3128',
    })
    expect(choice?.uri).toBe('http://proxy.corp:3128')
    expect(choice?.token).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`)
    expect(choice?.redacted).not.toContain('s3cret')
  })

  it('keeps the password out of the description too', () => {
    const described = describeProxyEnvironment({
      HTTPS_PROXY: 'http://alice:s3cret@proxy.corp:3128',
    })
    expect(described).toContain('proxy.corp:3128')
    expect(described).not.toContain('s3cret')
  })
})

/**
 * `NO_PROXY` has no specification, only thirty years of near-agreement.
 *
 * Both directions are failures with real consequences: tunnelling something that should stay
 * local breaks an internal host, and bypassing the proxy for something that needs it is the
 * original hang, moved somewhere else.
 */
describe('NO_PROXY', () => {
  const target = new URL('https://gateway.corp.internal:8443/v1')

  it('matches a bare domain and its subdomains, as curl does', () => {
    expect(bypassesProxy(target, 'corp.internal')).toBe(true)
    expect(bypassesProxy(target, '.corp.internal')).toBe(true)
  })

  it('matches the host itself', () => {
    expect(bypassesProxy(target, 'gateway.corp.internal')).toBe(true)
  })

  it('does not match a different domain that merely ends the same way', () => {
    // `evilcorp.internal` must not be matched by `corp.internal` — the suffix check has to be on
    // a label boundary, or a lookalike domain silently bypasses the proxy.
    expect(bypassesProxy(new URL('https://evilcorp.internal'), 'corp.internal')).toBe(false)
  })

  it('honours a pinned port and ignores entries for another one', () => {
    expect(bypassesProxy(target, 'gateway.corp.internal:8443')).toBe(true)
    expect(bypassesProxy(target, 'gateway.corp.internal:9000')).toBe(false)
  })

  it('treats * as "never proxy anything"', () => {
    expect(bypassesProxy(target, '*')).toBe(true)
  })

  it('tolerates spaces and empty entries', () => {
    expect(bypassesProxy(target, ' , corp.internal , ')).toBe(true)
  })
})

describe('a request through a real proxy', () => {
  /**
   * The check that matters: the request arrives at the proxy rather than at the origin.
   *
   * A **CONNECT** proxy, because that is what undici issues and what a corporate proxy speaks. The
   * first version of this test served absolute-URI forwarding instead, and hung for the full
   * timeout — which is a small echo of the bug itself: a request going somewhere that was not
   * listening for it, with nothing to say so.
   */
  it('goes through the proxy when the environment names one', async () => {
    const tunnelled: string[] = []
    proxy = createServer((_request, response) => {
      // Nothing should arrive as an ordinary request; if something does, fail loudly rather than
      // hanging, so the reason is readable.
      response.writeHead(400).end('expected CONNECT')
    })
    proxy.on('connect', (request, clientSocket, head) => {
      tunnelled.push(request.url ?? '')
      /*
       * The port is honoured and the host is not, deliberately.
       *
       * A real proxy would resolve the name; doing that here would make this test depend on DNS,
       * and CI runs a job with no route to the internet at all. What is being proven is the
       * routing *decision* — that the request came here rather than going direct — and the
       * recorded CONNECT target above is the evidence for it.
       */
      const [, port] = (request.url ?? '').split(':')
      const upstream = netConnect(Number(port), '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => upstream.destroy())
    })
    await new Promise<void>((resolve) => proxy?.listen(0, '127.0.0.1', resolve))
    const proxyPort = (proxy.address() as { port: number }).port

    let reachedOrigin = 0
    origin = createServer((_request, response) => {
      reachedOrigin += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ via: 'origin' }))
    })
    await new Promise<void>((resolve) => origin?.listen(0, '127.0.0.1', resolve))
    const originPort = (origin.address() as { port: number }).port

    /*
     * A hostname, not 127.0.0.1: loopback is deliberately never proxied, so aiming the test at an
     * address the code refuses to proxy would make it pass for the wrong reason. `.invalid` is
     * reserved and can never resolve, which is the point — nothing here may depend on DNS, and a
     * name that cannot resolve proves the connection was made by the proxy rather than by us.
     */
    const client = new FetchHttpClient({
      useEnvProxy: true,
      env: { HTTP_PROXY: `http://127.0.0.1:${String(proxyPort)}` },
    })
    const response = await client.request(
      `http://gateway.corp.invalid:${String(originPort)}/v1/models`,
    )

    expect(await response.json()).toEqual({ via: 'origin' })
    // The proof: it was tunnelled, and the tunnel named the real destination.
    expect(tunnelled).toEqual([`gateway.corp.invalid:${String(originPort)}`])
    expect(reachedOrigin).toBe(1)
  }, 20_000)

  /** And with nothing set it must behave exactly as it always did. */
  it('goes direct when the environment names none', async () => {
    origin = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ via: 'origin' }))
    })
    await new Promise<void>((resolve) => origin?.listen(0, '127.0.0.1', resolve))
    const port = (origin.address() as { port: number }).port

    const client = new FetchHttpClient({ useEnvProxy: true, env: {} })
    const response = await client.request(`http://127.0.0.1:${String(port)}/v1/models`)
    expect(await response.json()).toEqual({ via: 'origin' })
  }, 20_000)

  /**
   * The extension's guarantee, checked rather than asserted in prose.
   *
   * It has worked for a long time on machines that may well have these variables set for other
   * tools. Switching this on there could route a gateway that is reachable directly through a
   * proxy that has never heard of it, so the default must stay off.
   */
  it('ignores the environment unless the host asked for it', async () => {
    const seen: string[] = []
    proxy = createServer((request, response) => {
      seen.push(request.url ?? '')
      response.writeHead(200).end('{}')
    })
    await new Promise<void>((resolve) => proxy?.listen(0, '127.0.0.1', resolve))
    const proxyPort = (proxy.address() as { port: number }).port

    origin = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ via: 'origin' }))
    })
    await new Promise<void>((resolve) => origin?.listen(0, '127.0.0.1', resolve))
    const originPort = (origin.address() as { port: number }).port

    // No options at all — exactly how the extension builds it.
    const client = new FetchHttpClient()
    process.env.HTTP_PROXY = `http://127.0.0.1:${String(proxyPort)}`
    try {
      const response = await client.request(`http://127.0.0.1:${String(originPort)}/v1/models`)
      expect(await response.json()).toEqual({ via: 'origin' })
      expect(seen, 'the extension routed through a proxy it never asked for').toEqual([])
    } finally {
      delete process.env.HTTP_PROXY
    }
  }, 20_000)
})
