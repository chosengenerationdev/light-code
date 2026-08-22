import type { IncomingMessage } from 'node:http'
import net from 'node:net'
import type { IdentityProvider, Principal } from './identity.js'

export interface ProxyHeaderOptions {
  /** Header carrying the immutable directory id. */
  userHeader?: string
  /** Optional header carrying something a human recognises. Falls back to the id. */
  nameHeader?: string
  /**
   * Addresses the header is believed from. Empty means **nothing is trusted** — see below.
   *
   * Accepts literal addresses. IPv4-mapped IPv6 (`::ffff:10.0.0.5`) is normalised, because that
   * is what Node reports when a v4 client reaches a dual-stack listener and an operator writing
   * `10.0.0.5` will not think to write it twice.
   */
  trustedProxies?: readonly string[]
}

const DEFAULT_USER_HEADER = 'x-forwarded-user'
const DEFAULT_NAME_HEADER = 'x-forwarded-display-name'

/** `::ffff:10.0.0.5` and `10.0.0.5` are the same machine and must compare equal. */
export function normalizeAddress(address: string | undefined): string | undefined {
  if (address === undefined || address.length === 0) return undefined
  const lower = address.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped !== null) return mapped[1]
  // ::1 and 127.0.0.1 are both loopback but are *not* interchangeable as a trust statement:
  // an operator who wrote one and not the other meant one and not the other.
  return lower
}

/**
 * Who the request is from, according to a reverse proxy in front.
 *
 * The deployment this is for already has IIS or nginx terminating Kerberos, NTLM or OIDC. Light
 * Code does not re-do that: the proxy authenticates and states the result in a header.
 *
 * ## The header is not the trust boundary — the address is
 *
 * Any client that can reach this port can send `X-Forwarded-User: whoever`. So a header is
 * believed **only** from an address the operator named, and the check is on the socket's remote
 * address, which a client cannot choose. Get this wrong and the product has authentication that
 * anyone can spoof by typing a header, which is worse than having none: nobody would have
 * assumed a wide-open server was enforcing anything.
 *
 * With no trusted proxy configured, every request is refused rather than trusted. A misconfigured
 * deployment that refuses everyone is a support call; one that believes everyone is a breach.
 */
export class ProxyHeaderIdentity implements IdentityProvider {
  readonly describe: string
  private readonly userHeader: string
  private readonly nameHeader: string
  private readonly trusted: ReadonlySet<string>

  constructor(options: ProxyHeaderOptions = {}) {
    this.userHeader = (options.userHeader ?? DEFAULT_USER_HEADER).toLowerCase()
    this.nameHeader = (options.nameHeader ?? DEFAULT_NAME_HEADER).toLowerCase()
    this.trusted = new Set(
      (options.trustedProxies ?? [])
        .map((address) => normalizeAddress(address))
        .filter((address): address is string => address !== undefined),
    )
    this.describe =
      this.trusted.size === 0
        ? `proxy header "${this.userHeader}" — NO TRUSTED PROXY CONFIGURED, every request is refused`
        : `proxy header "${this.userHeader}" from ${[...this.trusted].join(', ')}`
  }

  /** True when the socket peer is an address the operator named. */
  trusts(request: IncomingMessage): boolean {
    const peer = normalizeAddress(request.socket.remoteAddress ?? undefined)
    return peer !== undefined && this.trusted.has(peer)
  }

  async authenticate(request: IncomingMessage): Promise<Principal | undefined> {
    if (!this.trusts(request)) return undefined

    const raw = request.headers[this.userHeader]
    // A repeated header arrives as an array. Two values means two answers to "who is this", and
    // there is no safe way to pick one — a proxy that appends rather than replaces is exactly
    // how an attacker-supplied value ends up beside the real one.
    if (typeof raw !== 'string') return undefined

    const id = raw.trim()
    if (id.length === 0) return undefined

    const nameRaw = request.headers[this.nameHeader]
    const displayName = typeof nameRaw === 'string' && nameRaw.trim().length > 0 ? nameRaw.trim() : id
    return { id, displayName }
  }
}

/**
 * Rejects an address the operator clearly did not mean, at startup rather than at request time.
 *
 * A typo in `--trust-proxy` otherwise presents as "every user is refused", which is a long way
 * from the cause.
 */
export function validateTrustedProxies(addresses: readonly string[]): string[] {
  return addresses.filter((address) => {
    const normalized = normalizeAddress(address)
    return normalized === undefined || net.isIP(normalized) === 0
  })
}
