import { createHash, createHmac } from 'node:crypto'

/**
 * AWS Signature Version 4, for S3.
 *
 * ## Why this is written out rather than taken from a library
 *
 * Invariant 2: every outbound request goes through core's one `HttpClient`, so TLS material,
 * proxies and the corporate CA are configured in a single place. `boto3` and the AWS JS SDK both
 * carry their own HTTP stack and their own CA and proxy settings, which in a TLS-intercepting
 * corporate network is exactly where things break — and it would be a *second* place to configure
 * a root certificate, which §10 rules out in those words. The same reasoning produced three
 * hand-written vector-store clients rather than three vendor SDKs.
 *
 * What a library would genuinely buy is the credential chain — instance profiles, SSO, `~/.aws`.
 * None of that is signing, and none of it is needed for an access key and secret, which is what
 * this is built for. If a deployment ever needs the chain, that is a credential *source* and
 * plugs in where the key comes from; it is not a reason to move the signing.
 *
 * ## The parts that are easy to get subtly wrong
 *
 * Each of these is a silent 403 rather than an error that says what happened, which is why they
 * are stated here and pinned by tests:
 *
 * - **The payload hash is signed**, and S3 requires it in `x-amz-content-sha256` as well. An
 *   empty body is not "no hash": it is the SHA-256 of zero bytes.
 * - **Headers are signed in lower-cased, sorted order**, and the same list must appear in
 *   `SignedHeaders` in that order. Sorting one and not the other is a mismatch nothing reports.
 * - **The path is URI-encoded, but `/` is not**, and encoding is applied *once*. A key that is
 *   already encoded and gets encoded again signs a different object than the one requested.
 * - **`host` must be signed.** S3 rejects a signature that omits it.
 */

/** SHA-256 of zero bytes. S3 wants this literal for an empty payload, not an absent header. */
export const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex')

export interface SigV4Input {
  method: string
  /** Absolute URL, already carrying whatever query string the request needs. */
  url: string
  /** Header names in any case; they are lower-cased and sorted here. */
  headers: Record<string, string>
  /** The exact bytes being sent, or empty for a body-less request. */
  body?: Buffer
  region: string
  service?: string
  accessKeyId: string
  secretAccessKey: string
  /** Present only for temporary credentials. Signed as `x-amz-security-token`. */
  sessionToken?: string
  /** Overridable so the worked examples in the tests can be reproduced exactly. */
  now?: Date
}

export interface SignedRequest {
  headers: Record<string, string>
  /** Kept for the tests and for diagnosing a 403, which reports what it expected to sign. */
  canonicalRequest: string
  stringToSign: string
  signature: string
}

/**
 * Encodes one path segment the way S3 signs it.
 *
 * `encodeURIComponent` leaves `!'()*` alone and AWS does not, so they are escaped afterwards.
 * Getting this wrong signs a different key than the one fetched, which returns 403 rather than
 * anything that mentions encoding.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * The canonical path: each segment encoded exactly once, separators left alone.
 *
 * Decoded first, because `new URL(...).pathname` is *already* percent-encoded — so encoding it
 * again turns a space into `%2520` and signs an object nobody asked for. That returns 403 with no
 * mention of encoding, which is why there is a test for it rather than a comment alone.
 *
 * Decoding is not lossy here: a literal `%` in a key reaches the URL as `%25`, decodes back to
 * `%`, and re-encodes to `%25`. A malformed sequence is left as it stands rather than throwing —
 * a key we cannot decode is still a key, and refusing to sign it helps nobody.
 */
export function canonicalPath(pathname: string): string {
  if (pathname === '' || pathname === '/') return '/'
  return pathname
    .split('/')
    .map((segment) => {
      let raw = segment
      try {
        raw = decodeURIComponent(segment)
      } catch {
        // Not valid percent-encoding, so there is nothing to decode. Encode what is there.
      }
      return encodeSegment(raw)
    })
    .join('/')
}

/** The canonical query: parameters sorted by name, both halves encoded. */
export function canonicalQuery(search: string): string {
  const parameters = [...new URLSearchParams(search).entries()]
    .map(([name, value]) => [encodeSegment(name), encodeSegment(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  return parameters.map(([name, value]) => `${name}=${value}`).join('&')
}

/** `YYYYMMDDTHHMMSSZ`, which is the only timestamp format S3 accepts here. */
export function amzDate(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`
}

/** The HMAC chain that turns a secret into a key scoped to one day, region and service. */
export function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const dateKey = createHmac('sha256', `AWS4${secretAccessKey}`).update(date).digest()
  const regionKey = createHmac('sha256', dateKey).update(region).digest()
  const serviceKey = createHmac('sha256', regionKey).update(service).digest()
  return createHmac('sha256', serviceKey).update('aws4_request').digest()
}

export function signRequest(input: SigV4Input): SignedRequest {
  const service = input.service ?? 's3'
  const now = input.now ?? new Date()
  const timestamp = amzDate(now)
  const date = timestamp.slice(0, 8)
  const url = new URL(input.url)
  const body = input.body ?? Buffer.alloc(0)
  const payloadHash = createHash('sha256').update(body).digest('hex')

  /*
   * `host` is added here rather than left to the caller. S3 refuses a signature that does not
   * cover it, and a caller that forgets gets a 403 naming nothing.
   */
  const headers: Record<string, string> = {
    ...input.headers,
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
    ...(input.sessionToken !== undefined ? { 'x-amz-security-token': input.sessionToken } : {}),
  }

  const canonicalHeaderEntries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => a[0].localeCompare(b[0]))

  const signedHeaders = canonicalHeaderEntries.map(([name]) => name).join(';')
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.search),
    `${canonicalHeaderEntries.map(([name, value]) => `${name}:${value}`).join('\n')}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${date}/${input.region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')

  const signature = createHmac('sha256', signingKey(input.secretAccessKey, date, input.region, service))
    .update(stringToSign)
    .digest('hex')

  return {
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  }
}
