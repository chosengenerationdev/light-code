import os from 'node:os'
import { describe, expect, it } from 'vitest'

import { reachableHosts, reachableOrigins } from './reachableHosts.js'

/**
 * Which names a server bound publicly should answer to.
 *
 * The allowlist used to come from the *bind address*, which is fine for `127.0.0.1` and useless
 * for `0.0.0.0` — nobody browses to that. Measured against the running server, `--bind 0.0.0.0`
 * accepted `localhost` and refused everything else with 421: not the machine's hostname, not its
 * LAN address, not even `127.0.0.1`. So binding publicly worked from nowhere except the one place
 * it was not for.
 *
 * The fix is a better derivation, not a weaker check — which is the distinction these tests exist
 * to hold. A foreign domain must still be refused, because that is what makes the `Host` check
 * worth having at all.
 */
describe('the names a public bind answers to', () => {
  const PORT = 7100

  it('always includes loopback, under both spellings', () => {
    // `127.0.0.1` was refused by the old derivation whenever the bind was a wildcard, which is
    // absurd on its face and is what made the bug obvious once measured.
    const hosts = reachableHosts('0.0.0.0', PORT)
    expect(hosts).toContain('localhost:7100')
    expect(hosts).toContain('127.0.0.1:7100')
  })

  it('includes this machine by name when bound to a wildcard', () => {
    /*
     * The hostname matters as much as the addresses: on a corporate network people are given a
     * name rather than an IP, so an allowlist of addresses alone refuses the URL they were told
     * to use.
     */
    expect(reachableHosts('0.0.0.0', PORT)).toContain(`${os.hostname().toLowerCase()}:7100`)
  })

  it('includes this machine by address when bound to a wildcard', () => {
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry !== undefined && !entry.internal && entry.family === 'IPv4')
    if (external === undefined) return
    expect(reachableHosts('0.0.0.0', PORT)).toContain(`${external.address}:7100`)
  })

  it('does not invent names when bound to one address', () => {
    // A specific bind is a specific intention; widening it would be answering a question that was
    // not asked.
    const hosts = reachableHosts('192.168.1.5', PORT)
    expect(hosts).toContain('192.168.1.5:7100')
    expect(hosts).not.toContain(`${os.hostname().toLowerCase()}:7100`)
  })

  it('never includes a name nobody declared', () => {
    /*
     * The property the whole check exists for. DNS rebinding turns on a *foreign* domain
     * resolving to this machine's address — and a foreign domain is exactly what is absent here,
     * before and after the fix.
     */
    expect(reachableHosts('0.0.0.0', PORT)).not.toContain('evil.example:7100')
    expect(reachableHosts('0.0.0.0', PORT).join(' ')).not.toContain('evil.example')
  })

  it('takes a declared name, with or without a port of its own', () => {
    const hosts = reachableHosts('0.0.0.0', PORT, ['proxy.internal', 'gateway.internal:443'])
    expect(hosts).toContain('proxy.internal:7100')
    // A proxy on a different port carries it, and is taken as written rather than re-suffixed.
    expect(hosts).toContain('gateway.internal:443')
  })

  it('brackets an IPv6 address, as a browser does', () => {
    const hosts = reachableHosts('0.0.0.0', PORT, ['[fe80::1]'])
    expect(hosts).toContain('[fe80::1]:7100')
  })
})

describe('the origins those names produce', () => {
  it('gives each host an http origin', () => {
    expect(reachableOrigins(['localhost:7100'])).toContain('http://localhost:7100')
  })

  it('takes a declared origin as written, trailing slash and all', () => {
    // The app embedding this in an iframe is a different origin and cannot be derived from a host.
    const origins = reachableOrigins(['localhost:7100'], ['https://app.internal:8501/'])
    expect(origins).toContain('https://app.internal:8501')
  })

  it('does not invent an https origin for itself', () => {
    // This server does not terminate TLS. A proxy that does is a different origin, declared.
    expect(reachableOrigins(['localhost:7100'])).not.toContain('https://localhost:7100')
  })
})

/**
 * A name the operator declared is taken as declared.
 *
 * Reported from JupyterHub: `--public-url https://hub` was refused with
 * `Host "hub" is not the one this server answers to`. Every name here gets this process's port
 * appended when it has none, so `hub` became `hub:64096` — while the browser sent `Host: hub`,
 * because the page is https on 443 and a default port is not written.
 *
 * Appending a *local* port to a name that exists because a proxy is in front is a guess, and it is
 * wrong in precisely the case the flag exists for: the port the browser used is the proxy's.
 */
describe('a declared host', () => {
  it('is accepted without a port, as a browser on 443 sends it', () => {
    expect(reachableHosts('127.0.0.1', 7100, ['hub.example'])).toContain('hub.example')
  })

  it('is still accepted with this port, for a proxy that forwards one', () => {
    expect(reachableHosts('127.0.0.1', 7100, ['hub.example'])).toContain('hub.example:7100')
  })

  /* A declared name that carries its own port is taken exactly as written. */
  it('leaves an explicit port alone', () => {
    const hosts = reachableHosts('127.0.0.1', 7100, ['hub.example:8443'])
    expect(hosts).toContain('hub.example:8443')
    expect(hosts).not.toContain('hub.example:8443:7100')
  })

  /*
   * And nothing else is widened. DNS rebinding turns on a *foreign* domain resolving here, and a
   * foreign domain is exactly what is absent from this list.
   */
  it('still refuses anything nobody declared', () => {
    expect(reachableHosts('127.0.0.1', 7100, ['hub.example'])).not.toContain('evil.example')
  })
})
