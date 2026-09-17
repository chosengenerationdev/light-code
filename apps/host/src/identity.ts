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
  readonly describe: string
  private static readonly PRINCIPAL: Principal = { id: 'local', displayName: 'Local user' }
  private readonly principal: Principal

  /** Long-lived, minted per server run, only ever sent in an `Authorization` header. */
  private readonly sessionToken = crypto.randomBytes(32).toString('base64url')
  /**
   * Single-use and short-lived, because it travels in the launch URL's fragment where it
   * can end up in shell history or a terminal scrollback (§14).
   *
   * Ten seconds is right when the browser opens itself, and far too short when a person has to
   * move the URL by hand — into another application, a remote session, a phone. `--handoff-seconds`
   * raises it, and what that costs is stated where it is set: a longer window is a longer time in
   * which somebody reading that scrollback can use it before you do.
   */
  private handoffToken: string | undefined = crypto.randomBytes(32).toString('base64url')
  private handoffExpiresAt: number
  private readonly handoffSeconds: number

  /**
   * @param principal Who this server's storage is filed under. Defaults to the local user.
   *
   * Supplied when the platform named the account — `JUPYTERHUB_USER` and friends, see
   * `hostedUser.ts`. **It changes the name, not the gate.** The bearer token below still decides
   * who gets in, which is §14's rule that identity resolution must never become a way past the
   * door: knowing that a server was spawned for Ana says nothing about who is making this request.
   */
  constructor(handoffSeconds = 10, principal?: Principal) {
    this.handoffSeconds = handoffSeconds
    this.handoffExpiresAt = Date.now() + handoffSeconds * 1000
    this.principal = principal ?? SingleUserIdentity.PRINCIPAL
    this.describe =
      principal === undefined ? 'single user (local)' : `single user — ${principal.id}`
  }

  get launchToken(): string {
    if (this.handoffToken === undefined) throw new Error('handoff token already consumed')
    return this.handoffToken
  }

  /**
   * Mints a fresh handoff token, replacing any outstanding one.
   *
   * For the case the old design had no answer to: the token expired unused, and the only way back
   * was to stop the server and start it again — losing the session, the conversation and anything
   * running. A new token grants exactly what the first one did, to whoever can read the terminal,
   * which is the same person it was printed to in the first place.
   */
  remintHandoff(): string {
    this.handoffToken = crypto.randomBytes(32).toString('base64url')
    this.handoffExpiresAt = Date.now() + this.handoffSeconds * 1000
    return this.handoffToken
  }

  /**
   * Exchanges the handoff token for the session token, once.
   *
   * Cleared on the first attempt whether or not it matched: a wrong guess is either a bug
   * or an attack, and in both cases the right answer is that this token is now spent.
   */
  redeemHandoff(presented: string): string | undefined {
    return this.redeem(presented).token
  }

  /**
   * The same exchange, saying *why* it failed.
   *
   * The reasons need different handling and only one of them is anybody's fault. An expired token
   * is an ordinary mishap — the browser was slow, the URL was pasted late — and the right response
   * is to offer another. A token that does not match is either a bug or an attack, and the right
   * response there is nothing at all.
   */
  redeem(presented: string): { token?: string; reason?: 'expired' | 'spent' | 'mismatch' } {
    const expected = this.handoffToken
    const expiresAt = this.handoffExpiresAt
    // Cleared on the first attempt whether or not it matched: a wrong guess is either a bug or an
    // attack, and in both cases this token is now spent.
    this.handoffToken = undefined

    if (expected === undefined) return { reason: 'spent' }
    if (Date.now() > expiresAt) return { reason: 'expired' }
    return timingSafeEquals(presented, expected)
      ? { token: this.sessionToken }
      : { reason: 'mismatch' }
  }

  async authenticate(request: IncomingMessage): Promise<Principal | undefined> {
    const header = request.headers.authorization
    if (header === undefined || !header.startsWith('Bearer ')) return undefined
    return timingSafeEquals(header.slice('Bearer '.length), this.sessionToken)
      ? this.principal
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

/**
 * No token at all. Opt-in, for running locally without the launch-link dance.
 *
 * ## What is given up, precisely
 *
 * The bearer token is what stops a *non-browser* caller on this machine — any other process
 * running as you — from driving the agent. §3 already says Light Code does not defend against a
 * process running as the same user, so this narrows a gap rather than opening a new category. It
 * is still a real narrowing: without it, anything that can reach the port can read your files and
 * run commands as you.
 *
 * ## What is NOT given up, and this is the part that matters
 *
 * **Origin and Host are still checked on every request.** Those are what stop the attack people
 * actually mean when they say "a localhost server is dangerous": a page you have open in another
 * tab posting to 127.0.0.1, and DNS rebinding. A browser attaches a foreign `Origin` and the
 * request is refused, token or no token. Removing *those* would be a different and much worse
 * decision, and this does not touch them.
 *
 * ## Why it is a flag rather than the default
 *
 * Because the failure is silent and remote in time from the choice. Somebody who turns it on to
 * get past a launch link today is not thinking about the server still listening next week. A flag
 * is read at the moment of the decision, says so in the banner every start, and can be removed.
 */
export class OpenIdentity implements IdentityProvider {
  readonly describe = 'single user, no token (--no-token)'
  private static readonly PRINCIPAL: Principal = { id: 'local', displayName: 'Local user' }

  async authenticate(): Promise<Principal | undefined> {
    return OpenIdentity.PRINCIPAL
  }
}
