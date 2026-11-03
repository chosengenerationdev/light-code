import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { mayDecide, mayEditAdmins, normaliseUserId, parseUserIds, reviewNeeded, TeamStore, type AdminList } from './admins.js'

/**
 * A stand-in OpenSearch with the two rules the team store depends on: `_create` refuses an id that exists
 * (409), and a write naming `if_seq_no` refuses when the document moved on (409). Everything else is
 * plain storage. Ingress only, through the HttpClient interface - no socket.
 */
class FakeOpenSearch implements HttpClient {
  readonly docs = new Map<string, { source: Record<string, unknown>; seqNo: number }>()
  private seq = 0
  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const parsed = new URL(url)
    const [, , ...rest] = parsed.pathname.split('/')
    const op = rest[0] ?? ''
    const id = rest.length > 1 ? decodeURIComponent(rest.slice(1).join('/')) : ''
    const body = options.body !== undefined ? (JSON.parse(options.body as string) as Record<string, unknown>) : {}
    const answer = (status: number, json: unknown): HttpResponse => ({
      status,
      headers: {},
      text: () => Promise.resolve(JSON.stringify(json)),
      json: <T>() => Promise.resolve(json as T),
      body: null,
    })
    if (options.method === 'PUT' && op === '') return answer(200, { acknowledged: true })
    if (options.method === 'GET' && op === '_doc') {
      const doc = this.docs.get(id)
      return doc === undefined ? answer(404, { found: false }) : answer(200, { found: true, _source: doc.source, _seq_no: doc.seqNo, _primary_term: 1 })
    }
    if (options.method === 'PUT' && op === '_create') {
      if (this.docs.has(id)) return answer(409, { error: { type: 'version_conflict_engine_exception' } })
      this.docs.set(id, { source: body, seqNo: ++this.seq })
      return answer(201, { result: 'created' })
    }
    if (options.method === 'PUT' && op === '_doc') {
      const expected = parsed.searchParams.get('if_seq_no')
      const current = this.docs.get(id)
      if (expected !== null && current?.seqNo !== Number(expected)) return answer(409, { error: { type: 'version_conflict_engine_exception' } })
      this.docs.set(id, { source: body, seqNo: ++this.seq })
      return answer(200, { result: 'updated' })
    }
    if (options.method === 'POST' && op === '_search') {
      const hits = [...this.docs.entries()].filter(([, doc]) => doc.source['type'] === 'review').map(([key, doc]) => ({ _id: key, _source: doc.source, _seq_no: doc.seqNo, _primary_term: 1 }))
      return answer(200, { hits: { hits } })
    }
    return answer(400, { error: { reason: `unexpected ${String(options.method)} ${parsed.pathname}` } })
  }
}

const connection = { url: 'https://os.example:9200' }

describe('user ids', () => {
  it('are Windows logins, whatever the case or domain', () => {
    expect(normaliseUserId('CORP\\JSmith ')).toBe('jsmith')
    expect(parseUserIds('jsmith, CORP\\a123;  JSMITH\nb.k')).toEqual(['jsmith', 'a123', 'b.k'])
    expect(parseUserIds('no spaces allowed! <x>')).toEqual(['no', 'spaces'])
  })
})

describe('who decides', () => {
  const admins: AdminList = { ids: ['boss'], by: 'boss', at: 0, seqNo: 1, primaryTerm: 1 }
  it('needs nothing reviewed until the team has admins', () => {
    expect(reviewNeeded(undefined, 'alice', 'bob')).toBe(false)
    expect(reviewNeeded({ ...admins, ids: [] }, 'alice', 'bob')).toBe(false)
  })
  it("sends a change to somebody else's work for review, and not the owner's or an admin's", () => {
    expect(reviewNeeded(admins, 'alice', 'bob')).toBe(true)
    expect(reviewNeeded(admins, 'CORP\\Alice', 'alice')).toBe(false)
    expect(reviewNeeded(admins, 'alice', 'boss')).toBe(false)
    expect(reviewNeeded(admins, undefined, 'bob')).toBe(true)
  })
  it('lets the owner or any admin decide, and lets anyone edit the admins only while there are none', () => {
    expect(mayDecide({ owner: 'alice' }, admins, 'alice')).toBe(true)
    expect(mayDecide({ owner: 'alice' }, admins, 'boss')).toBe(true)
    expect(mayDecide({ owner: 'alice' }, admins, 'bob')).toBe(false)
    expect(mayDecide({ owner: '' }, admins, 'bob')).toBe(false)
    expect(mayEditAdmins(undefined, 'bob')).toBe(true)
    expect(mayEditAdmins(admins, 'bob')).toBe(false)
    expect(mayEditAdmins(admins, 'boss')).toBe(true)
  })
})

describe('the team store', () => {
  it('keeps the first admin list saved, and tells the second person whose won', async () => {
    const os = new FakeOpenSearch()
    const alice = new TeamStore(os, connection, 'light-code-team-payments')
    const bob = new TeamStore(os, connection, 'light-code-team-payments')
    const first = await alice.saveAdmins(['alice'], 'alice', undefined)
    const second = await bob.saveAdmins(['bob'], 'bob', undefined)
    expect(first.saved).toBe(true)
    expect(second.saved).toBe(false)
    expect(second.list?.ids).toEqual(['alice'])
    expect(second.message).toContain('alice saved')
  })

  it('lets only an admin change the list, and refuses an edit made on a stale copy', async () => {
    const os = new FakeOpenSearch()
    const store = new TeamStore(os, connection, 'light-code-team-p')
    await store.saveAdmins(['alice'], 'alice', undefined)
    const read = await store.admins()
    expect((await store.saveAdmins(['bob'], 'bob', read)).saved).toBe(false)
    expect((await store.saveAdmins(['alice', 'carol'], 'alice', read)).saved).toBe(true)
    // `read` is now stale: a second admin edit from it must not overwrite the first.
    const stale = await store.saveAdmins(['alice'], 'alice', read)
    expect(stale.saved).toBe(false)
    expect((await store.admins())?.ids).toEqual(['alice', 'carol'])
  })

  it('records an owner once', async () => {
    const store = new TeamStore(new FakeOpenSearch(), connection, 'light-code-team-p')
    expect(await store.registerOwner('skill', 'deploy', 'CORP\\Alice')).toBe('alice')
    expect(await store.registerOwner('skill', 'deploy', 'bob')).toBe('alice')
    expect(await store.owner('skill', 'deploy')).toBe('alice')
    expect(await store.owner('tool', 'deploy')).toBeUndefined()
  })

  it('decides a review once, so two approvers cannot both publish it', async () => {
    const store = new TeamStore(new FakeOpenSearch(), connection, 'light-code-team-p')
    await store.submit({ kind: 'skill', name: 'deploy', owner: 'alice', by: 'bob', content: 'new', existingContent: 'old' })
    const [review] = await store.reviews()
    expect(review).toMatchObject({ name: 'deploy', owner: 'alice', by: 'bob', status: 'pending', content: 'new', existingContent: 'old' })
    expect(await store.decide(review!, 'approved', 'alice', undefined)).toBe(true)
    expect(await store.decide(review!, 'rejected', 'boss', 'no')).toBe(false)
    const [after] = await store.reviews()
    expect(after).toMatchObject({ status: 'approved', decidedBy: 'alice' })
  })

  it('refuses an index name OpenSearch would reject', () => {
    expect(() => new TeamStore(new FakeOpenSearch(), connection, 'Team Index')).toThrow(/not a usable index name/)
  })
})
