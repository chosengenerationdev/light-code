import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { S3Client, parseListing, type S3Connection } from './client.js'

/**
 * The S3 client, against a recorded HTTP layer.
 *
 * What is worth pinning here is not "does a GET work" — it is the handful of things that fail as a
 * 403 or a 404 and mention nothing useful: how the URL is built, whether errors carry S3's own
 * words, and whether a listing stops short.
 */

const CONNECTION: S3Connection = {
  bucket: 'reports',
  region: 'eu-west-1',
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
}

interface Recorded {
  url: string
  options: HttpRequestOptions
}

function fakeHttp(
  reply: (url: string) => { status: number; body: string | Uint8Array },
): { http: HttpClient; calls: Recorded[] } {
  const calls: Recorded[] = []
  const http: HttpClient = {
    request: async (url, options = {}) => {
      calls.push({ url, options })
      const answer = reply(url)
      const bytes = typeof answer.body === 'string' ? Buffer.from(answer.body) : Buffer.from(answer.body)
      const response: HttpResponse = {
        status: answer.status,
        headers: {},
        text: async () => bytes.toString('utf8'),
        json: async () => JSON.parse(bytes.toString('utf8')) as never,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes))
            controller.close()
          },
        }),
      }
      return response
    },
  }
  return { http, calls }
}

const listing = (keys: string[], next?: string): string =>
  [
    '<?xml version="1.0"?><ListBucketResult>',
    ...keys.map(
      (key) => `<Contents><Key>${key}</Key><Size>12</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>`,
    ),
    next === undefined ? '' : `<NextContinuationToken>${next}</NextContinuationToken>`,
    '</ListBucketResult>',
  ].join('')

describe('addressing a bucket', () => {
  it('uses virtual-host style by default, as AWS does', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, body: 'data' }))
    await new S3Client(http, CONNECTION).get('a/b.txt')
    expect(calls[0]?.url).toBe('https://reports.s3.eu-west-1.amazonaws.com/a/b.txt')
  })

  /* An internal or compatible endpoint usually needs the bucket in the path instead. */
  it('puts the bucket in the path when asked', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, body: 'data' }))
    await new S3Client(http, {
      ...CONNECTION,
      endpoint: 'https://s3.internal.example',
      pathStyle: true,
    }).get('a/b.txt')
    expect(calls[0]?.url).toBe('https://s3.internal.example/reports/a/b.txt')
  })

  it('keeps a key with spaces usable', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, body: 'data' }))
    await new S3Client(http, CONNECTION).get('my folder/a file.txt')
    expect(calls[0]?.url).toContain('/my%20folder/a%20file.txt')
  })

  it('signs every request', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, body: 'data' }))
    await new S3Client(http, CONNECTION).get('a.txt')
    expect(calls[0]?.options.headers?.['Authorization']).toContain('AWS4-HMAC-SHA256 Credential=AKIA/')
  })
})

describe('reading and writing', () => {
  it('returns the bytes as they arrived, not as text', async () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    const { http } = fakeHttp(() => ({ status: 200, body: binary }))
    const got = await new S3Client(http, CONNECTION).get('image.png')
    expect([...got]).toEqual([...binary])
  })

  /* A string body would be UTF-8 encoded, which corrupts anything that is not text. */
  it('uploads bytes rather than a string', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, body: '' }))
    await new S3Client(http, CONNECTION).put('image.png', new Uint8Array([0xff, 0x00]))
    expect(calls[0]?.options.bodyBytes).toBeDefined()
    expect(calls[0]?.options.body).toBeUndefined()
  })

  it('accepts 204 as a successful write, which S3 sometimes answers', async () => {
    const { http } = fakeHttp(() => ({ status: 204, body: '' }))
    await expect(new S3Client(http, CONNECTION).put('a.txt', new Uint8Array([1]))).resolves.toBeUndefined()
  })
})

/**
 * S3 says exactly what is wrong and a bare status throws it away, sending somebody to check their
 * network when the answer was "that bucket does not exist".
 */
describe('when S3 refuses', () => {
  const denied =
    '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>'

  it('reports the code S3 gave', async () => {
    const { http } = fakeHttp(() => ({ status: 403, body: denied }))
    await expect(new S3Client(http, CONNECTION).get('a.txt')).rejects.toThrow(/AccessDenied/)
  })

  it('names the key that was refused', async () => {
    const { http } = fakeHttp(() => ({ status: 403, body: denied }))
    await expect(new S3Client(http, CONNECTION).get('a.txt')).rejects.toThrow(/a\.txt/)
  })

  it('still says something useful when the body is not the expected XML', async () => {
    const { http } = fakeHttp(() => ({ status: 502, body: 'gateway problem' }))
    await expect(new S3Client(http, CONNECTION).get('a.txt')).rejects.toThrow(/502/)
  })
})

describe('listing a prefix', () => {
  it('follows the continuation token rather than stopping at the first page', async () => {
    let page = 0
    const { http, calls } = fakeHttp(() => {
      page += 1
      return page === 1
        ? { status: 200, body: listing(['a.txt', 'b.txt'], 'more') }
        : { status: 200, body: listing(['c.txt']) }
    })
    const found = await new S3Client(http, CONNECTION).list('reports/')
    expect(found.map((object) => object.key)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(calls[1]?.url).toContain('continuation-token=more')
  })

  it('never returns more than it was asked for', async () => {
    const { http } = fakeHttp(() => ({ status: 200, body: listing(['a', 'b', 'c']) }))
    expect(await new S3Client(http, CONNECTION).list('', 2)).toHaveLength(2)
  })

  it('sends the prefix', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, body: listing([]) }))
    await new S3Client(http, CONNECTION).list('skills/')
    expect(calls[0]?.url).toContain('prefix=skills%2F')
  })
})

describe('parsing a listing', () => {
  it('reads key, size and date', () => {
    expect(parseListing(listing(['a.txt']))[0]).toEqual({
      key: 'a.txt',
      size: 12,
      lastModified: '2026-01-01T00:00:00Z',
    })
  })

  /* A key with `&` arrives encoded; fetching it as written would 404 on a file plainly there. */
  it('decodes XML entities in a key', () => {
    expect(parseListing(listing(['a&amp;b.txt']))[0]?.key).toBe('a&b.txt')
  })

  it('is empty for a prefix with nothing in it', () => {
    expect(parseListing(listing([]))).toEqual([])
  })
})
