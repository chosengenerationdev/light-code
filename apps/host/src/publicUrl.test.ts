import { describe, expect, it } from 'vitest'
import { publicAddressFor, publicLaunchUrl } from './publicUrl.js'

/**
 * The address somebody can actually paste into a browser.
 *
 * Reported from a JupyterHub host: the banner printed `http://127.0.0.1:<port>`, which is right on
 * a laptop and worthless on a headless server — there is no browser on that machine, and 127.0.0.1
 * from the reader's own laptop is the reader's own laptop. The only way out was the hub's proxy,
 * and the user had to have a script written to work out where that was.
 */
describe('working out where a browser can reach this', () => {
  it('prefers what the operator typed over anything derived', () => {
    const address = publicAddressFor(8080, {
      publicUrl: 'https://box.example/light',
      env: { JUPYTERHUB_SERVICE_PREFIX: '/user/ana/' },
    })
    expect(address?.base).toBe('https://box.example/light/')
    expect(address?.source).toBe('--public-url')
  })

  /*
   * `jupyter-server-proxy` exposes a local port beneath the user's own prefix. That convention is
   * exactly what had to be rediscovered by hand.
   */
  it('derives the JupyterHub proxy path from the environment', () => {
    const address = publicAddressFor(8080, { env: { JUPYTERHUB_SERVICE_PREFIX: '/user/ana/' } })
    expect(address?.base).toBe('/user/ana/proxy/8080/')
    expect(address?.source).toContain('append this to the host')
  })

  it('puts an origin in front of it when the hub gives one', () => {
    const address = publicAddressFor(8080, {
      env: { JUPYTERHUB_SERVICE_PREFIX: '/user/ana/', JUPYTERHUB_PUBLIC_URL: 'https://hub.example/' },
    })
    expect(address?.base).toBe('https://hub.example/user/ana/proxy/8080/')
  })

  /*
   * A path the reader appends to what is already in their address bar is useful. A guessed
   * hostname that resolves to nothing is worse than saying less.
   */
  it('says nothing at all when there is nothing to say', () => {
    expect(publicAddressFor(8080, { env: {} })).toBeUndefined()
    expect(publicAddressFor(8080, {})).toBeUndefined()
  })

  it('always ends the base in a slash, so a path can be appended without thought', () => {
    expect(publicAddressFor(8080, { publicUrl: 'https://box.example' })?.base).toBe(
      'https://box.example/',
    )
    expect(publicAddressFor(8080, { env: { JUPYTERHUB_SERVICE_PREFIX: '/user/ana' } })?.base).toBe(
      '/user/ana/proxy/8080/',
    )
  })
})

describe('the link that is printed', () => {
  const address = { base: '/user/ana/proxy/8080/', source: 'JupyterHub' }

  it('carries the handoff fragment, which is what makes the first load a session', () => {
    expect(publicLaunchUrl(address, false, 'abc')).toBe('/user/ana/proxy/8080/#t=abc')
  })

  /*
   * No leading slash on the segment: the base already ends in one, and `/admin` would climb back
   * to the root of the host and straight out of the proxy's prefix.
   */
  it('keeps the admin page inside the prefix', () => {
    expect(publicLaunchUrl(address, true, 'abc')).toBe('/user/ana/proxy/8080/admin#t=abc')
  })
})
