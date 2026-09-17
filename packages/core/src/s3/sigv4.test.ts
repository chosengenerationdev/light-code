import { describe, expect, it } from 'vitest'

import { EMPTY_PAYLOAD_SHA256, canonicalQuery, signRequest, signingKey } from './sigv4.js'

/**
 * Checked against AWS's own worked example, because a signing bug is a 403 that explains nothing.
 *
 * The example is the "GET Object" walkthrough from the S3 SigV4 documentation: a fixed date, fixed
 * example credentials and a published expected signature. Reproducing it end to end is the only
 * way to know the implementation is right without sending a request to AWS.
 */

const EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  now: new Date('2013-05-24T00:00:00Z'),
}

describe('signing an S3 request', () => {
  const signed = signRequest({
    ...EXAMPLE,
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { Range: 'bytes=0-9' },
  })

  it('builds the canonical request AWS documents', () => {
    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        '',
        'host:examplebucket.s3.amazonaws.com',
        'range:bytes=0-9',
        `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY_PAYLOAD_SHA256,
      ].join('\n'),
    )
  })

  it('produces the signature AWS publishes for it', () => {
    expect(signed.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  })

  it('names the credential scope and the signed headers in the Authorization header', () => {
    expect(signed.headers['Authorization']).toContain(
      'Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    )
    expect(signed.headers['Authorization']).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date')
  })

  /* An empty body is not "no hash" — S3 requires the hash of zero bytes, and signs it. */
  it('sends the empty-payload hash rather than omitting it', () => {
    expect(signed.headers['x-amz-content-sha256']).toBe(EMPTY_PAYLOAD_SHA256)
    expect(EMPTY_PAYLOAD_SHA256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('the parts that fail silently when wrong', () => {
  /* `host` unsigned is a 403 that names nothing, so it is added rather than left to the caller. */
  it('always signs host', () => {
    const signed = signRequest({ ...EXAMPLE, method: 'GET', url: 'https://b.example/k', headers: {} })
    expect(signed.canonicalRequest).toContain('host:b.example')
  })

  it('signs a body by its real hash', () => {
    const signed = signRequest({
      ...EXAMPLE,
      method: 'PUT',
      url: 'https://b.example/k',
      headers: {},
      body: Buffer.from('hello'),
    })
    // SHA-256 of "hello".
    expect(signed.headers['x-amz-content-sha256']).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('carries a session token into the signature when there is one', () => {
    const signed = signRequest({
      ...EXAMPLE,
      method: 'GET',
      url: 'https://b.example/k',
      headers: {},
      sessionToken: 'tok',
    })
    expect(signed.canonicalRequest).toContain('x-amz-security-token:tok')
  })

  /* A key with a space signs differently from one without; encoding it twice signs a third thing. */
  it('encodes a key exactly once', () => {
    const signed = signRequest({
      ...EXAMPLE,
      method: 'GET',
      url: 'https://b.example/my%20folder/a%20file.txt',
      headers: {},
    })
    expect(signed.canonicalRequest.split('\n')[1]).toBe('/my%20folder/a%20file.txt')
  })

  it('sorts query parameters by name', () => {
    expect(canonicalQuery('?list-type=2&prefix=a&delimiter=%2F')).toBe('delimiter=%2F&list-type=2&prefix=a')
  })

  it('derives a signing key scoped to the day, region and service', () => {
    const first = signingKey('secret', '20240101', 'eu-west-1', 's3').toString('hex')
    expect(signingKey('secret', '20240102', 'eu-west-1', 's3').toString('hex')).not.toBe(first)
    expect(signingKey('secret', '20240101', 'us-east-1', 's3').toString('hex')).not.toBe(first)
  })
})
