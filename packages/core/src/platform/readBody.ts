import type { HttpResponse } from './http.js'

/**
 * Reads a response body whole, as bytes, whether it arrived as a stream or not.
 *
 * One owner: the S3 client had this privately, and Confluence attachments needed the same thing.
 * A second copy is how one of them would come to decode a PNG as text.
 */
export async function readBody(response: HttpResponse): Promise<Buffer> {
  if (response.body === null) return Buffer.from(await response.text(), 'utf8')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) chunks.push(value)
  }
  return Buffer.concat(chunks)
}
