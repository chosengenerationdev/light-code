import type { HttpClient, HttpResponse } from '../platform/http.js'
import { readBody } from '../platform/readBody.js'
import { describeTlsError } from '../providers/auth/apigeeMtls.js'
import { signRequest } from './sigv4.js'

/**
 * A small S3 client over core's one `HttpClient`.
 *
 * Only what the tools need: list a prefix, read an object, write an object. No multipart, no
 * versioning, no lifecycle — S3's REST surface is enormous and almost all of it is somebody
 * else's job. Adding a verb here is cheap; carrying a vendor SDK to get all of them is not, and
 * §19 already settled that argument for the three vector stores.
 */

export interface S3Connection {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /**
   * The service endpoint. Absent means the ordinary AWS one for the region.
   *
   * Configurable because an organisation's S3 is often reached through a VPC endpoint or an
   * internal name rather than the public address, and refusing to let somebody type it would
   * make the feature unusable exactly where it is wanted.
   */
  endpoint?: string
  /**
   * `bucket.host/key` (the default) or `host/bucket/key`.
   *
   * AWS uses the first. Internal and S3-compatible deployments often need the second, and getting
   * it wrong gives a DNS failure or a 404, neither of which mentions addressing.
   */
  pathStyle?: boolean
}

export interface S3Object {
  key: string
  size: number
  lastModified: string
}

/** Everything one request needs that the connection does not already say. */
interface Call {
  method: 'GET' | 'PUT' | 'DELETE'
  key?: string
  query?: Record<string, string>
  bodyBytes?: Uint8Array
  headers?: Record<string, string>
  signal?: AbortSignal
}

export class S3Client {
  constructor(
    private readonly http: HttpClient,
    private readonly connection: S3Connection,
    /** Whatever the global TLS resolver produced, so a corporate CA reaches S3 too (§10). */
    private readonly tls?: { ca?: Buffer[]; rejectUnauthorized?: boolean },
  ) {}

  private url(call: Call): string {
    const { bucket, region, endpoint, pathStyle } = this.connection
    const origin = new URL(endpoint ?? `https://s3.${region}.amazonaws.com`)
    const key = call.key ?? ''

    const inPath = usesPathStyle(pathStyle, origin.host)
    const host = inPath ? origin.host : `${bucket}.${origin.host}`
    /*
     * Anything the endpoint itself carries is kept.
     *
     * `https://host/s3api` is a real shape — an internal store behind a gateway that routes by
     * path — and taking only the host dropped the `/s3api` silently, leaving a request to a path
     * that was never going to answer. Trailing slash removed so it does not double up with the
     * bucket segment below.
     */
    const mount = origin.pathname === '/' ? '' : origin.pathname.replace(/\/+$/, '')
    const prefix = inPath ? `${mount}/${bucket}` : mount
    // Encoded per segment, so a key with slashes stays a path and a space does not break the URL.
    const path =
      key === ''
        ? ''
        : `/${key
            .split('/')
            .map((part) => encodeURIComponent(part))
            .join('/')}`

    const url = new URL(`${origin.protocol}//${host}${prefix}${path}`)
    for (const [name, value] of Object.entries(call.query ?? {})) url.searchParams.set(name, value)
    return url.toString()
  }

  private async send(call: Call): Promise<{ status: number; text: string; bytes: Buffer }> {
    const url = this.url(call)
    const signed = signRequest({
      method: call.method,
      url,
      headers: call.headers ?? {},
      ...(call.bodyBytes !== undefined ? { body: Buffer.from(call.bodyBytes) } : {}),
      region: this.connection.region,
      accessKeyId: this.connection.accessKeyId,
      secretAccessKey: this.connection.secretAccessKey,
      ...(this.connection.sessionToken !== undefined
        ? { sessionToken: this.connection.sessionToken }
        : {}),
    })

    /*
     * A request that never reaches S3 is diagnosed rather than passed on.
     *
     * Reported from real use as "fetch failed" — which is undici's wrapper for *every* transport
     * failure, with the actual reason on `.cause`, sometimes nested twice (§19). On its own it is
     * unactionable: an untrusted corporate root, a proxy that was not used, a name that does not
     * resolve and a refused connection all look identical.
     *
     * `describeTlsError` already walks that chain for the gateway, so it is reused rather than
     * written again — and the host is named, because "the host could not be resolved" is only
     * useful alongside *which* host it tried.
     */
    let response: HttpResponse
    try {
      response = await this.http.request(url, {
        method: call.method,
        headers: signed.headers,
        ...(call.bodyBytes !== undefined ? { bodyBytes: call.bodyBytes } : {}),
        ...(call.signal !== undefined ? { signal: call.signal } : {}),
        ...(this.tls !== undefined ? { tls: this.tls } : {}),
      })
    } catch (error) {
      throw new Error(`Could not reach ${new URL(url).host}: ${describeTlsError(error)}`, { cause: error })
    }

    const bytes = await readBody(response)
    return { status: response.status, text: bytes.toString('utf8'), bytes }
  }

  /**
   * Objects under a prefix.
   *
   * Follows the continuation token rather than stopping at the first page: a folder of 1,200 files
   * silently reported as 1,000 is the kind of wrong answer nobody thinks to check.
   */
  async list(prefix: string, limit = 1000, signal?: AbortSignal): Promise<S3Object[]> {
    const found: S3Object[] = []
    let token: string | undefined

    while (found.length < limit) {
      const query: Record<string, string> = {
        'list-type': '2',
        'max-keys': String(Math.min(1000, limit - found.length)),
      }
      if (prefix !== '') query['prefix'] = prefix
      if (token !== undefined) query['continuation-token'] = token

      const result = await this.send({
        method: 'GET',
        query,
        ...(signal !== undefined ? { signal } : {}),
      })
      if (result.status !== 200) throw new Error(describeFailure(result.status, result.text))

      found.push(...parseListing(result.text))
      token = matchTag(result.text, 'NextContinuationToken')
      if (token === undefined) break
    }
    return found.slice(0, limit)
  }

  async get(key: string, signal?: AbortSignal): Promise<Buffer> {
    const result = await this.send({
      method: 'GET',
      key,
      ...(signal !== undefined ? { signal } : {}),
    })
    if (result.status !== 200) throw new Error(describeFailure(result.status, result.text, key))
    return result.bytes
  }

  /**
   * Removes one object.
   *
   * The only destructive call this client has, and it was deliberately absent until somebody asked
   * for it: everything else here is GET and PUT, so no amount of mis-wiring upstream could ever
   * take a colleague's file out of a bucket. That property is gone now, which is why the caller is
   * `s3/remove.ts` rather than anything that runs on its own — nothing syncs, refreshes or
   * reconciles its way here. A person presses a button.
   *
   * **204 and 404 are both success, and that is S3's own semantics, not leniency.** A DELETE of a
   * key that is not there returns 204 on AWS and 404 on some S3-compatible stores; both mean the
   * object is gone, which is what was asked for. Treating 404 as a failure would make removing a
   * skill somebody had already removed look like a broken connection.
   */
  async remove(key: string, signal?: AbortSignal): Promise<void> {
    const result = await this.send({
      method: 'DELETE',
      key,
      ...(signal !== undefined ? { signal } : {}),
    })
    if (result.status !== 204 && result.status !== 200 && result.status !== 404) {
      throw new Error(describeFailure(result.status, result.text, key))
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    contentType?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.send({
      method: 'PUT',
      key,
      bodyBytes: bytes,
      ...(contentType !== undefined ? { headers: { 'content-type': contentType } } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })
    if (result.status !== 200 && result.status !== 204) {
      throw new Error(describeFailure(result.status, result.text, key))
    }
  }
}

/**
 * S3's own words, not ours.
 *
 * It answers in XML with a `Code` and a `Message` saying exactly what is wrong — NoSuchBucket,
 * AccessDenied, SignatureDoesNotMatch — and a bare "request failed: 403" throws that away and
 * sends somebody to check the wrong thing. §17: name what failed and what was involved.
 */
function describeFailure(status: number, body: string, key?: string): string {
  const code = matchTag(body, 'Code')
  const message = matchTag(body, 'Message')
  const what = key === undefined ? '' : ` for "${key}"`
  if (code === undefined) return `S3 request failed${what} with status ${String(status)}.`
  return `S3 ${code}${what}: ${message ?? `status ${String(status)}`}`
}

function matchTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return match?.[1]
}

/**
 * The listing, parsed without an XML library.
 *
 * ListObjectsV2 answers in a flat, predictable shape, and adding a parser dependency to read three
 * fields is the trade §19 refused for the vector stores. Entities are decoded because a key
 * containing `&` arrives as `&amp;` and would otherwise be fetched under a name that is not its
 * own — a 404 for a file that is plainly there.
 */
export function parseListing(xml: string): S3Object[] {
  const objects: S3Object[] = []
  for (const block of xml.split('<Contents>').slice(1)) {
    const key = matchTag(block, 'Key')
    if (key === undefined) continue
    objects.push({
      key: decodeEntities(key),
      size: Number(matchTag(block, 'Size') ?? '0'),
      lastModified: matchTag(block, 'LastModified') ?? '',
    })
  }
  return objects
}

/** `&amp;` last, or `&amp;lt;` would decode to `<` instead of `&lt;`. */
function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', String.fromCharCode(39))
    .replaceAll('&amp;', '&')
}

/**
 * Whether the bucket goes in the path rather than in the host name.
 *
 * ## Why this is inferred and not just a checkbox
 *
 * Reported from real use: a listing failed with "the host could not be resolved", and the working
 * pattern in that office was `https://<endpoint>/<bucket>/<key>`. That is path style — the client
 * supported it all along, behind a checkbox nobody had a reason to suspect, while the default
 * built `<bucket>.s3.<region>.amazonaws.com` and asked the network to resolve a name it had never
 * heard of.
 *
 * So the rule follows what the endpoint *is*. An address that is not AWS is almost never set up
 * for virtual-host style: it would need a wildcard DNS entry and a wildcard certificate for every
 * bucket, which internal deployments do not have. AWS itself, including a VPC endpoint, keeps
 * virtual-host style, which is what it is built for.
 *
 * ## Why an explicit setting still wins
 *
 * "Almost never" is not never, and a rule that cannot be overridden is a guess with no escape. An
 * explicit `pathStyle` — either way — is obeyed exactly; this only decides what happens when
 * nobody said.
 */
export function usesPathStyle(configured: boolean | undefined, host: string): boolean {
  if (configured !== undefined) return configured
  return !/(^|\.)amazonaws\.com$/i.test(host)
}
