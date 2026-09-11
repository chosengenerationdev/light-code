import { describe, expect, it } from 'vitest'

import { OpenIdentity, SingleUserIdentity } from './identity.js'

/**
 * Serving with no bearer token, and what that does not turn off.
 *
 * Asked for, to run locally without the launch-link exchange. The reason it is a flag rather than
 * a deletion is that the failure is silent and remote in time from the choice: somebody who turns
 * it on to get past a launch link today is not thinking about the server still listening on
 * Thursday.
 *
 * **What it gives up** is the defence against another *process* on this machine driving the
 * agent — which §3 already declines to guarantee. **What it keeps** is Origin and Host
 * enforcement, which is what stops the attack people actually mean: a page open in another tab
 * posting to 127.0.0.1, and DNS rebinding.
 *
 * That second half is verified against a running server in `security.test.ts`'s manner rather than
 * asserted here, because it is a property of the request handler rather than of the identity —
 * and measured with a raw socket, since `fetch` rewrites the `Host` header and would quietly test
 * nothing at all.
 */
describe('serving without a token', () => {
  it('authenticates every request as the local user', async () => {
    const identity = new OpenIdentity()
    await expect(identity.authenticate()).resolves.toEqual({ id: 'local', displayName: 'Local user' })
  })

  it('says what it is, so the banner can say so too', () => {
    expect(new OpenIdentity().describe).toContain('--no-token')
  })

  it('is a different class from the ordinary one, so the server can tell them apart', () => {
    /*
     * The server branches on the type: an `OpenIdentity` answers `/api/session` to anyone, a
     * `SingleUserIdentity` demands a valid handoff. A flag on one class would have made that an
     * `if` somebody could forget.
     */
    expect(new OpenIdentity()).not.toBeInstanceOf(SingleUserIdentity)
  })

  it('still refuses nothing it was never asked to refuse', async () => {
    // No arguments, no token, no state: there is deliberately nothing here that can go wrong.
    const identity = new OpenIdentity()
    const first = await identity.authenticate()
    const second = await identity.authenticate()
    expect(first).toEqual(second)
  })
})
