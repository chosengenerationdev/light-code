import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { OpenSearchIndexWriter } from './opensearch/writer.js'

/**
 * Joining an existing index to a team alias without re-embedding it.
 *
 * User-requested: "for the existing users of light code where things being indexed in
 * opensearch, user should be able to attach alias to it too". Their index is complete and
 * correct; it simply predates aliases and attribution. Re-indexing to acquire a label would
 * mean paying the embedding cost for a whole repository again.
 */

const OWNED = { mappings: { _meta: { createdBy: 'light-code' } } }

function recordingHttp(reply: (url: string) => unknown): {
  http: HttpClient
  calls: { url: string; method: string; body?: unknown }[]
} {
  const calls: { url: string; method: string; body?: unknown }[] = []
  const http: HttpClient = {
    async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
      calls.push({
        url,
        method: options.method ?? 'GET',
        ...(options.body !== undefined ? { body: JSON.parse(options.body) as unknown } : {}),
      })
      const payload = reply(url)
      return {
        status: 200,
        headers: {},
        text: async () => JSON.stringify(payload),
        json: async <T>() => payload as T,
        body: null,
      }
    },
  }
  return { http, calls }
}

const connection = { url: 'https://cluster.example:9200', label: 'cluster' }

describe('attaching an alias to an existing index', () => {
  it('adds the alias without touching any document', async () => {
    const { http, calls } = recordingHttp((path) => (path.includes('_mapping') ? { 'lc-mine': OWNED } : {}))
    await new OpenSearchIndexWriter(http, connection).ensureAlias('lc-mine', 'team-code')

    const aliasCall = calls.find((call) => call.url.endsWith('/_aliases'))
    expect(aliasCall?.body).toEqual({ actions: [{ add: { index: 'lc-mine', alias: 'team-code' } }] })
    expect(calls.some((call) => call.url.includes('_bulk'))).toBe(false)
  })

  /** An alias is a write-adjacent name. Pointing one at somebody else's index is not ours to do. */
  it('refuses an index Light Code does not own', async () => {
    const { http } = recordingHttp((path) =>
      path.includes('_mapping') ? { 'someone-elses': { mappings: {} } } : {},
    )
    await expect(
      new OpenSearchIndexWriter(http, connection).ensureAlias('someone-elses', 'team-code'),
    ).rejects.toThrow()
  })

  it('refuses a wildcard, which would alias more than one index', async () => {
    const { http } = recordingHttp(() => ({ 'lc-mine': OWNED }))
    await expect(new OpenSearchIndexWriter(http, connection).ensureAlias('lc-mine', 'team-*')).rejects.toThrow(
      /wildcard/i,
    )
  })
})

describe('labelling chunks that were indexed before attribution existed', () => {
  /**
   * The safety property, and the reason the script is written the way it is. On an index
   * several people write to, a backfill that overwrote `owner` would relabel a colleague's
   * code as yours — and nothing downstream could tell, because the field is the only evidence.
   */
  it('only fills the field in where it is missing', async () => {
    const { http, calls } = recordingHttp((path) =>
      path.includes('_mapping') ? { 'lc-mine': OWNED } : { updated: 12 },
    )
    const updated = await new OpenSearchIndexWriter(http, connection).attributeUnowned('lc-mine', {
      owner: 'me',
      project: 'app',
    })

    const call = calls.find((entry) => entry.url.includes('_update_by_query'))
    const body = call?.body as { query?: unknown; script?: { source?: string } }

    expect(body.query).toEqual({ bool: { must_not: [{ exists: { field: 'owner' } }] } })
    expect(body.script?.source).toContain('ctx._source.owner == null')
    expect(updated).toBe(12)
  })

  /** A long run against a live index will meet a concurrent write; skipping it is right. */
  it('proceeds past version conflicts rather than aborting the run', async () => {
    const { http, calls } = recordingHttp((path) =>
      path.includes('_mapping') ? { 'lc-mine': OWNED } : { updated: 0 },
    )
    await new OpenSearchIndexWriter(http, connection).attributeUnowned('lc-mine', { owner: 'me' })

    expect(calls.some((entry) => entry.url.includes('conflicts=proceed'))).toBe(true)
  })

  it('reports zero as a real answer rather than a failure', async () => {
    const { http } = recordingHttp((path) => (path.includes('_mapping') ? { 'lc-mine': OWNED } : { updated: 0 }))
    await expect(
      new OpenSearchIndexWriter(http, connection).attributeUnowned('lc-mine', { owner: 'me' }),
    ).resolves.toBe(0)
  })
})
