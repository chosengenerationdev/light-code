import { describe, expect, it } from 'vitest'

import type { HttpClient } from '../platform/http.js'
import { S3Client, type S3Connection } from './client.js'

/**
 * What a request that never reaches S3 says.
 *
 * Reported from real use: adding a bucket and asking for a listing failed with **"fetch failed"**.
 * That is undici's wrapper for *every* transport failure, with the real reason on `.cause` and
 * sometimes nested twice — so an untrusted corporate root, an unused proxy, a name that does not
 * resolve and a refused connection all arrive looking identical and none of them is actionable.
 *
 * `describeTlsError` already walks that chain for the gateway. Reusing it here rather than writing
 * a second one is the same rule the rest of this project follows about one owner per fact.
 */

const CONNECTION: S3Connection = {
  bucket: 'reports',
  region: 'eu-west-1',
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
}

/** Fails the way undici does: an opaque wrapper with the truth underneath. */
const throwing = (cause: { code?: string; message: string }): HttpClient => ({
  request: async () => {
    const error = new TypeError('fetch failed')
    ;(error as { cause?: unknown }).cause = Object.assign(new Error(cause.message), {
      ...(cause.code !== undefined ? { code: cause.code } : {}),
    })
    throw error
  },
})

const listFrom = async (http: HttpClient): Promise<string> => {
  try {
    await new S3Client(http, CONNECTION).list('')
    return 'no error'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('when the request never reaches S3', () => {
  it('never leaves the user with just "fetch failed"', async () => {
    const message = await listFrom(throwing({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }))
    expect(message).not.toBe('fetch failed')
  })

  /* Which host it tried is half the answer — an endpoint typo looks exactly like an outage. */
  it('names the host it tried to reach', async () => {
    const message = await listFrom(throwing({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }))
    expect(message).toContain('reports.s3.eu-west-1.amazonaws.com')
  })

  it('reports a name that does not resolve as exactly that', async () => {
    const message = await listFrom(throwing({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }))
    expect(message).toMatch(/could not be resolved/)
  })

  it('reports a refused connection as exactly that', async () => {
    const message = await listFrom(throwing({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }))
    expect(message).toMatch(/refused/)
  })

  /*
   * The corporate case, and the one worth naming in full: a TLS-intercepting network presents a
   * certificate signed by a root Node has never heard of. "fetch failed" sends somebody to check
   * their key; this sends them to the CA setting, which is the actual fix.
   */
  it('tells somebody behind TLS interception to add the corporate root', async () => {
    const message = await listFrom(
      throwing({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify the first certificate' }),
    )
    expect(message).toMatch(/certificate could not be verified/)
    expect(message).toMatch(/NODE_EXTRA_CA_CERTS|caFile/)
  })

  it('falls back to the deepest cause when it recognises nothing', async () => {
    const message = await listFrom(throwing({ message: 'something quite unusual' }))
    expect(message).toContain('something quite unusual')
  })
})
