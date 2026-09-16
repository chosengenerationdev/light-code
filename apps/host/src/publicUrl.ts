/**
 * The address somebody can actually paste into a browser.
 *
 * ## Why the printed URL is often useless
 *
 * The server binds loopback and the banner prints `http://127.0.0.1:<port>`, which is exactly
 * right on a laptop and worthless on a headless server: there is no browser on that machine, and
 * 127.0.0.1 from the reader's own laptop is the reader's own laptop.
 *
 * Reported from a JupyterHub host, where the only way out is the hub's proxy — it exposes an
 * arbitrary local port under `/user/<name>/proxy/<port>/`. The user had to have a script written
 * to work that out. The server knows its port, and JupyterHub tells every process it starts where
 * it lives, so between them the address is derivable rather than something to reconstruct by hand.
 *
 * ## Why the token still comes from here
 *
 * The launch fragment is single-use and short-lived, and it is what makes the first page load a
 * session. A published address without it is a page that cannot authenticate, so the fragment is
 * carried across unchanged — it never reaches the server anyway, which is the whole reason it is
 * a fragment.
 */

/** Where a proxy makes this server visible, and how that was worked out. */
export interface PublicAddress {
  /** The base, always ending in a slash so a path can be appended without thinking about it. */
  base: string
  /** One line for the banner, saying where this came from. */
  source: string
}

/**
 * The environment JupyterHub gives a server it started.
 *
 * `JUPYTERHUB_SERVICE_PREFIX` is the path this user's server is mounted at — `/user/<name>/` —
 * and `jupyter-server-proxy` exposes a local port beneath it at `proxy/<port>/`. That convention
 * is what the user's own script had to rediscover.
 */
export interface JupyterEnvironment {
  JUPYTERHUB_SERVICE_PREFIX?: string | undefined
  JUPYTERHUB_PUBLIC_URL?: string | undefined
  JUPYTERHUB_HOST?: string | undefined
}

/**
 * Works out the public address, preferring what the operator said over what can be guessed.
 *
 * `--public-url` wins outright: somebody who has typed their own address knows something this
 * cannot — a hostname, a port mapping, a reverse proxy in front of the hub.
 */
export function publicAddressFor(
  port: number,
  options: { publicUrl?: string | undefined; env?: JupyterEnvironment },
): PublicAddress | undefined {
  const stated = options.publicUrl?.trim()
  if (stated !== undefined && stated.length > 0) {
    return { base: withSlash(stated), source: '--public-url' }
  }

  const env = options.env ?? {}
  const prefix = env.JUPYTERHUB_SERVICE_PREFIX?.trim()
  if (prefix === undefined || prefix.length === 0) return undefined

  /*
   * The path is certain; the origin is not.
   *
   * `JUPYTERHUB_PUBLIC_URL` is set on newer hubs and absent on plenty of them, so the path alone
   * is reported when there is no origin to put in front of it. A path the reader appends to the
   * address already in their browser is useful; a guessed hostname that resolves to nothing is
   * worse than saying less.
   */
  const path = `${withSlash(prefix)}proxy/${String(port)}/`
  const origin = (env.JUPYTERHUB_PUBLIC_URL ?? env.JUPYTERHUB_HOST ?? '').trim()
  if (origin.length === 0) {
    return { base: path, source: 'JupyterHub — append this to the host in your browser' }
  }
  return { base: `${trimSlash(origin)}${path}`, source: 'JupyterHub' }
}

/**
 * The launch URL against a public base.
 *
 * An empty token means `--no-token`, and the fragment is then left off entirely rather than
 * printed empty. This file already records that mistake once: `#t=` with nothing after it sends
 * somebody looking for a token that was never minted, and instructions for a mechanism that is
 * not running are worse than none.
 */
export function publicLaunchUrl(address: PublicAddress, adminMode: boolean, token: string): string {
  // No leading slash on the segment: the base already ends in one, and `/admin` here would climb
  // back to the root of the host and out of the proxy's prefix entirely.
  const page = `${address.base}${adminMode ? 'admin' : ''}`
  return token.length > 0 ? `${page}#t=${token}` : page
}

function withSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}
