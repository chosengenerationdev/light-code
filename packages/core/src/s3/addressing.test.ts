import { describe, expect, it } from 'vitest'

import type { HttpClient } from '../platform/http.js'
import { S3Client, type S3Connection } from './client.js'
import { usesPathStyle } from './client.js'

/**
 * Where the bucket goes: in the host name, or in the path.
 *
 * Reported from real use: a listing failed with "the host could not be resolved", and the pattern
 * that works in that office is `https://<endpoint>/<bucket>/<key>`. The client was building
 * `<bucket>.s3.<region>.amazonaws.com` and asking the network to resolve a name it had never heard
 * of — the bucket prepended as a subdomain, which is what virtual-host style means.
 *
 * Path style was supported all along, behind a checkbox nobody had a reason to suspect. So the
 * default now follows what the endpoint *is*.
 */

const recording = (): { http: HttpClient; urls: string[] } => {
  const urls: string[] = []
  return {
    urls,
    http: {
      request: async (url) => {
        urls.push(url)
        return {
          status: 200,
          headers: {},
          text: async () => '',
          json: async () => ({}) as never,
          body: null,
        }
      },
    },
  }
}

const base: S3Connection = {
  bucket: 'reports',
  region: 'eu-west-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
}

const urlFor = async (connection: S3Connection): Promise<string> => {
  const { http, urls } = recording()
  await new S3Client(http, connection).get('notes.md')
  return urls[0] ?? ''
}

describe('deciding the addressing style', () => {
  /*
   * An internal endpoint would need wildcard DNS and a wildcard certificate per bucket to serve
   * virtual-host style. They do not have that, which is why this is the safe default.
   */
  it('puts the bucket in the path for an endpoint that is not AWS', () => {
    expect(usesPathStyle(undefined, 's3.internal.example')).toBe(true)
  })

  it('keeps the bucket in the host name for AWS itself', () => {
    expect(usesPathStyle(undefined, 's3.eu-west-1.amazonaws.com')).toBe(false)
  })

  /* A VPC endpoint is still AWS and is still built for virtual-host style. */
  it('keeps it for a VPC endpoint', () => {
    expect(usesPathStyle(undefined, 'bucket.vpce-0a1b.s3.eu-west-1.vpce.amazonaws.com')).toBe(false)
  })

  /* "Almost never" is not never, so a rule with no escape would be a guess nobody can correct. */
  it('obeys an explicit choice either way', () => {
    expect(usesPathStyle(true, 's3.eu-west-1.amazonaws.com')).toBe(true)
    expect(usesPathStyle(false, 's3.internal.example')).toBe(false)
  })

  /* Not a substring match: a host merely ending in something similar is not AWS. */
  it('is not fooled by a look-alike host name', () => {
    expect(usesPathStyle(undefined, 'notamazonaws.com')).toBe(true)
    expect(usesPathStyle(undefined, 'amazonaws.com.internal.example')).toBe(true)
  })
})

describe('the URL that comes out', () => {
  it('matches the pattern that works against an internal endpoint', async () => {
    expect(await urlFor({ ...base, endpoint: 'https://s3.internal.example' })).toBe(
      'https://s3.internal.example/reports/notes.md',
    )
  })

  it('is unchanged for AWS', async () => {
    expect(await urlFor(base)).toBe('https://reports.s3.eu-west-1.amazonaws.com/notes.md')
  })

  it('still lets somebody force either style', async () => {
    expect(await urlFor({ ...base, endpoint: 'https://s3.internal.example', pathStyle: false })).toBe(
      'https://reports.s3.internal.example/notes.md',
    )
  })

  /* The access key belongs in the Authorization header and has never been in the URL. */
  it('never puts the access key in the URL', async () => {
    const url = await urlFor({ ...base, endpoint: 'https://s3.internal.example' })
    expect(url).not.toContain('AKIAEXAMPLE')
  })
})
