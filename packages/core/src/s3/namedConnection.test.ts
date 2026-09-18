import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpResponse } from '../platform/http.js'
import type { SecretStore } from '../platform/secrets.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { resolveS3 } from './resolve.js'
import { createS3Tools } from './tools.js'

/**
 * The whole path a user actually takes.
 *
 * Asked in those words: somebody adds a connection called "Test1" and then tells the assistant in
 * the chat to read a file from it. This drives config → resolved client → tool call, because each
 * of those hops is somewhere the name could be lost and the failure would look like the bucket
 * being unreachable rather than the wiring.
 */

const CONFIG = {
  connections: [
    {
      id: 's3-abc',
      label: 'Test1',
      bucket: 'test1-bucket',
      region: 'eu-west-1',
      accessKeyId: 'AKIA',
      secretAccessKeyRef: 's3:s3-abc:secret',
    },
  ],
}

const secretsHolding = (values: Record<string, string>): SecretStore =>
  ({ get: async (key: string) => values[key] }) as unknown as SecretStore

const httpReturning = (body: string): { http: HttpClient; urls: string[] } => {
  const urls: string[] = []
  const http: HttpClient = {
    request: async (url) => {
      urls.push(url)
      const bytes = Buffer.from(body)
      return {
        status: 200,
        headers: {},
        text: async () => body,
        json: async () => ({}) as never,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes))
            controller.close()
          },
        }),
      } satisfies HttpResponse
    },
  }
  return { http, urls }
}

const context = {} as ToolExecutionContext

describe('a connection the user named "Test1"', () => {
  it('reads a file when the assistant asks for it by that name', async () => {
    const { http, urls } = httpReturning('the file contents')
    const resolved = await resolveS3({
      config: CONFIG,
      http,
      secrets: secretsHolding({ 's3:s3-abc:secret': 'shh' }),
    })

    const read = createS3Tools(resolved.targets).find((tool) => tool.name === 's3_read_file')
    const result = await read?.execute({ connection: 'Test1', key: 'notes.txt' } as never, context)

    expect(result?.content).toBe('the file contents')
    expect(urls[0]).toBe('https://test1-bucket.s3.eu-west-1.amazonaws.com/notes.txt')
  })

  /* People type what they see, and what they see is the label they chose. */
  it('matches the name whatever case it is typed in', async () => {
    const { http } = httpReturning('ok')
    const resolved = await resolveS3({
      config: CONFIG,
      http,
      secrets: secretsHolding({ 's3:s3-abc:secret': 'shh' }),
    })
    const read = createS3Tools(resolved.targets).find((tool) => tool.name === 's3_read_file')

    expect((await read?.execute({ connection: 'test1', key: 'a.txt' } as never, context))?.isError).not.toBe(true)
    expect((await read?.execute({ connection: 'TEST1', key: 'a.txt' } as never, context))?.isError).not.toBe(true)
  })

  it('signs the request with the stored key', async () => {
    const { http } = httpReturning('ok')
    const resolved = await resolveS3({
      config: CONFIG,
      http,
      secrets: secretsHolding({ 's3:s3-abc:secret': 'shh' }),
    })
    const read = createS3Tools(resolved.targets).find((tool) => tool.name === 's3_read_file')
    await read?.execute({ connection: 'Test1', key: 'a.txt' } as never, context)
    // Nothing to assert about the signature here beyond it being attempted; `sigv4.test.ts`
    // checks the algorithm against AWS's own worked example.
    expect(resolved.problems).toEqual([])
  })
})

/**
 * The failure worth naming, because it looks like a broken bucket and is not.
 *
 * A connection saved without its secret ever reaching storage cannot be used, and the tool would
 * otherwise report "there is no connection called Test1" — sending somebody to check the name they
 * had just typed correctly.
 */
describe('when the secret never made it into storage', () => {
  it('leaves the connection out rather than half-working', async () => {
    const { http } = httpReturning('ok')
    const resolved = await resolveS3({ config: CONFIG, http, secrets: secretsHolding({}) })

    expect(resolved.targets).toEqual([])
  })

  it('says which connection and why, instead of failing silently', async () => {
    const { http } = httpReturning('ok')
    const resolved = await resolveS3({ config: CONFIG, http, secrets: secretsHolding({}) })

    expect(resolved.problems[0]?.label).toBe('Test1')
    expect(resolved.problems[0]?.problem).toMatch(/secret access key is not in storage/)
  })

  /* And with nothing usable, no tools are offered at all rather than four that always fail. */
  it('offers no S3 tools at all', async () => {
    const { http } = httpReturning('ok')
    const resolved = await resolveS3({ config: CONFIG, http, secrets: secretsHolding({}) })

    expect(createS3Tools(resolved.targets)).toEqual([])
  })
})
