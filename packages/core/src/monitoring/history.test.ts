import { describe, expect, it } from 'vitest'

import type { HttpClient } from '../platform/http.js'
import { MonitorHistoryStore, type MonitorRevision } from './history.js'

/**
 * The team's monitoring index as a fake cluster: `_create` succeeds once per id and is a 409 after, which is
 * the only OpenSearch rule the claims and the change record rely on.
 */
function cluster(): { http: HttpClient; created: Map<string, Record<string, unknown>>; bodies: { method: string; url: string; body: Record<string, unknown> }[] } {
  const created = new Map<string, Record<string, unknown>>()
  const bodies: { method: string; url: string; body: Record<string, unknown> }[] = []
  const reply = (status: number, json: unknown) => ({ status, ok: status < 300, headers: {}, text: async () => JSON.stringify(json) })
  const http = {
    async request(url: string, options: { method?: string; body?: string } = {}) {
      const body = options.body !== undefined ? (JSON.parse(options.body) as Record<string, unknown>) : {}
      bodies.push({ method: options.method ?? 'GET', url, body })
      const create = /\/_create\/([^?]+)/.exec(url)
      if (create !== null) {
        const id = decodeURIComponent(create[1] ?? '')
        if (created.has(id)) return reply(409, { error: { type: 'version_conflict_engine_exception' } })
        created.set(id, body)
        return reply(201, { result: 'created' })
      }
      if (url.endsWith('/_search')) {
        const hits = [...created.values()].filter((d) => d['kind'] === 'revision').map((d) => ({ _source: d }))
        return reply(200, { hits: { hits } })
      }
      return reply(200, {})
    },
  } as unknown as HttpClient
  return { http, created, bodies }
}

const store = (http: HttpClient, by: string) => new MonitorHistoryStore(http, { url: 'https://search.example.test' }, 'fire-code-monitoring', by)

describe('the team monitoring index', () => {
  it('lets one member take over a window whose winner never reported, and only one', async () => {
    const { http } = cluster()
    const [ana, bo, chen] = [store(http, 'ana'), store(http, 'bo'), store(http, 'chen')]
    expect(await ana.claim('disks', 42)).toBe(true)
    expect(await bo.claim('disks', 42)).toBe(false)
    // Ana's check never arrives: the takeover is a claim of its own, so of bo and chen, one runs it.
    expect(await bo.claim('disks', 42, 2)).toBe(true)
    expect(await chen.claim('disks', 42, 2)).toBe(false)
  })

  it('records each change once, however many members saw it, and keeps it when history is cleaned up', async () => {
    const { http, created, bodies } = cluster()
    const revision: MonitorRevision = { at: 1_800_000_000, by: 'bo', author: 'ana', version: 3, hash: 'c'.repeat(64), change: 'Schedule changed (every)', block: '{"every":"10m"}' }
    await store(http, 'ana').writeRevision('disks', revision)
    await store(http, 'chen').writeRevision('disks', revision)
    expect([...created.values()].filter((d) => d['kind'] === 'revision')).toHaveLength(1)
    expect(await store(http, 'ana').revisions('disks')).toEqual([revision])

    await store(http, 'ana').prune(2_000_000_000, 'disks')
    const prune = bodies.filter((b) => b.url.includes('_delete_by_query')).at(-1)?.body as { query: { bool: { must_not?: unknown[] } } }
    expect(prune.query.bool.must_not).toEqual([{ term: { kind: 'revision' } }])
    // Deleting the monitor itself takes this person's record of it too.
    await store(http, 'ana').prune(2_000_000_000, 'disks', true)
    const gone = bodies.filter((b) => b.url.includes('_delete_by_query')).at(-1)?.body as { query: { bool: { must_not?: unknown[] } } }
    expect(gone.query.bool.must_not).toBeUndefined()
  })
})
