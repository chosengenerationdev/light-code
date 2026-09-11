import { describe, expect, it } from 'vitest'

import { SingleUserIdentity } from './identity.js'

/**
 * The launch link's lifetime, and what happens when it lapses.
 *
 * Ten seconds suits a browser that opens itself and is far too short when the URL has to be
 * carried by hand — into another application, a remote session, a phone. Reported as exactly
 * that. Two things had to change: the window is configurable, and a lapsed link no longer means
 * restarting the server and losing whatever was running.
 */
describe('the handoff token', () => {
  it('lasts as long as it was told to', () => {
    const identity = new SingleUserIdentity(120)
    // Redeemable well past the ten seconds the old fixed window allowed.
    expect(identity.redeemHandoff(identity.launchToken)).toBeTypeOf('string')
  })

  it('expires, and says that is why', async () => {
    const identity = new SingleUserIdentity(0)
    const token = identity.launchToken
    // A zero window expires on the next tick, not within the same millisecond it was minted.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(identity.redeem(token).reason).toBe('expired')
  })

  it('is spent by one attempt, right or wrong', () => {
    /*
     * Cleared whether or not it matched: a wrong guess is either a bug or an attack, and in both
     * cases this token is now finished.
     */
    const identity = new SingleUserIdentity(60)
    const token = identity.launchToken
    expect(identity.redeem('wrong').reason).toBe('mismatch')
    expect(identity.redeem(token).reason).toBe('spent')
  })

  it('can mint a fresh one, which works', () => {
    // The whole point: a late paste costs a new link, not the session.
    const identity = new SingleUserIdentity(0)
    identity.redeem(identity.launchToken)

    const fresh = new SingleUserIdentity(60)
    fresh.redeem(fresh.launchToken)
    const second = fresh.remintHandoff()
    expect(fresh.redeemHandoff(second)).toBeTypeOf('string')
  })

  it('invalidates the old token when a new one is minted', () => {
    // Two live launch links would be two chances for somebody reading the scrollback.
    const identity = new SingleUserIdentity(60)
    const first = identity.launchToken
    identity.remintHandoff()
    expect(identity.redeem(first).reason).toBe('mismatch')
  })

  it('gives every session its own long-lived token', () => {
    const a = new SingleUserIdentity(60)
    const b = new SingleUserIdentity(60)
    expect(a.redeemHandoff(a.launchToken)).not.toBe(b.redeemHandoff(b.launchToken))
  })
})
