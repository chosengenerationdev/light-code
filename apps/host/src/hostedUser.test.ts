import { describe, expect, it } from 'vitest'

import { hostedUser } from './hostedUser.js'

/**
 * Finding the current user without being told.
 *
 * Asked for after noticing the platform already knows: the URL suffix carries the name. It is read
 * from the **environment** rather than the URL, because a path is chosen by whoever made the
 * request and identity taken from one would be a way past the door (§14). The variable is set by
 * the platform in this process, which is a different kind of fact.
 */
describe('the user the platform started this server for', () => {
  it('takes the name JupyterHub set', () => {
    expect(hostedUser({ JUPYTERHUB_USER: 'a.patel' })?.id).toBe('a.patel')
  })

  it('says where the name came from, so it is not a name from nowhere', () => {
    expect(hostedUser({ JUPYTERHUB_USER: 'a.patel' })?.source).toBe('JUPYTERHUB_USER')
  })

  it('is absent when nothing was set, rather than guessing', () => {
    expect(hostedUser({})).toBeUndefined()
  })

  it('ignores a variable that is set but empty', () => {
    expect(hostedUser({ JUPYTERHUB_USER: '   ' })).toBeUndefined()
  })

  /*
   * The one that would look like it worked. On a shared host these name the *service* account, so
   * every person's settings, secrets and history would be filed under one name — silently, and
   * identically for everybody.
   */
  it('never falls back to the account the service runs as', () => {
    expect(hostedUser({ USER: 'svc-lightcode', USERNAME: 'svc-lightcode', LOGNAME: 'svc' })).toBeUndefined()
  })

  it('prefers the hub variable when both are present', () => {
    expect(hostedUser({ JUPYTERHUB_USER: 'ana', JUPYTER_USER: 'other' })?.id).toBe('ana')
  })
})
