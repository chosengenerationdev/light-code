import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * Who a request is from.
 *
 * Local `npx light-code` has exactly one of these and never consults it for anything but
 * a storage path. It exists anyway because the alternative — bolting identity on later —
 * means retrofitting every place that touches config, secrets or task history, which is
 * most of the bridge.
 */
export interface Principal {
  /**
   * Stable across sessions. For SSO this is the immutable directory identifier — an Entra
   * object id or an AD SID — never the username or email, both of which get reassigned to
   * a different human when someone leaves.
   */
  id: string
  displayName: string
}

/**
 * Decides who a request is from, or refuses it.
 *
 * The one seam SSO needs. A provider validates whatever its deployment uses — an OIDC id
 * token, a Kerberos/NTLM `Authorization: Negotiate` handshake terminated by IIS, a header
 * injected by a trusted reverse proxy — and returns the principal. Everything downstream
 * is already keyed by `Principal.id`, so nothing else changes.
 */
export interface IdentityProvider {
  /** Human-readable, shown at startup so the operator can see which mode is live. */
  readonly describe: string
  /**
   * `undefined` refuses the request with 401. Never throw for an unauthenticated caller —
   * that is the normal case for a login redirect, not an error.
   */
  authenticate(request: IncomingMessage): Promise<Principal | undefined>
}

/**
 * The local case: one machine, one person, no directory.
 *
 * Authentication here is *not* about identity — there is only one person — it is about
 * making sure the request came from the page we opened rather than from any other site
 * the browser happens to have open. Hence a bearer token rather than a login.
 */
export class SingleUserIdentity implements IdentityProvider {
  readonly describe = 'single user (local)'
  private static readonly PRINCIPAL: Principal = { id: 'local', displayName: 'Local user' }

  /** Long-lived, minted per server run, only ever sent in an `Authorization` header. */
  private readonly sessionToken = crypto.randomBytes(32).toString('base64url')
  /**
   * Single-use and short-lived, because it travels in the launch URL's fragment where it
   * can end up in shell history or a terminal scrollback (§14).
   */
  private handoffToken: string | undefined = crypto.randomBytes(32).toString('base64url')
  private handoffExpiresAt = Date.now() + 10_000

  get launchToken(): string {
    if (this.handoffToken === undefined) throw new Error('handoff token already consumed')
    return this.handoffToken
  }

  /**
   * Exchanges the handoff token for the session token, once.
   *
   * Cleared on the first attempt whether or not it matched: a wrong guess is either a bug
   * or an attack, and in both cases the right answer is that this token is now spent.
   */
  redeemHandoff(presented: string): string | undefined {
    const expected = this.handoffToken
    const expiresAt = this.handoffExpiresAt
    this.handoffToken = undefined
    if (expected === undefined || Date.now() > expiresAt) return undefined
    return timingSafeEquals(presented, expected) ? this.sessionToken : undefined
  }

  async authenticate(request: IncomingMessage): Promise<Principal | undefined> {
    const header = request.headers.authorization
    if (header === undefined || !header.startsWith('Bearer ')) return undefined
    return timingSafeEquals(header.slice('Bearer '.length), this.sessionToken)
      ? SingleUserIdentity.PRINCIPAL
      : undefined
  }
}

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
export function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/**
 * A filesystem-safe directory name for a principal.
 *
 * Hashed rather than sanitised: a directory identifier can contain anything, two different
 * ids must never collapse to the same folder, and a hash cannot escape its parent no matter
 * what the directory service returns. The display name is not involved — it changes when
 * someone marries.
 */
export function storageKeyFor(principal: Principal): string {
  return crypto.createHash('sha256').update(principal.id).digest('hex').slice(0, 32)
}
