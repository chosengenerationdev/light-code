import { randomUUID } from 'node:crypto'
import os from 'node:os'

import type { HttpClient, HttpRequestOptions } from '../platform/http.js'
import { describeTlsError } from '../providers/auth/apigeeMtls.js'
import type { OpenSearchConnection } from '../rag/opensearch/client.js'
import { isSafeIndexName } from '../rag/opensearch/client.js'

/**
 * Team admins, owners of skills and tools, and changes waiting for an owner's approval - kept in one
 * OpenSearch index the team shares (the user's choice of store), `light-code-team-<project>`.
 *
 * Asked for: "whoever first adds the user id for the admin becomes an admin ... it should automatically
 * reflect for other users ... the field should become readonly for them if they are not the admin", and "if
 * an user creates a skill or tool, he becomes the original owner ... any other user who modifies it should go
 * back for owner's approval ... admins should be able to approve too". And: until it is approved, everybody -
 * the person who changed it included - uses the approved version.
 *
 * ## Many writers, one answer
 *
 * - **The first admin list is created once** (`_create admins`): two people saving at the same moment get one
 *   list, and the other is told whose won. After that it changes only by an admin, with `if_seq_no`, so two
 *   admins editing at once cannot silently overwrite each other.
 * - **An owner is recorded once** (`_create owner:<kind>:<name>`), from the author label when the skill or tool
 *   is first seen. Editing the `author:` line later does not move ownership; an admin can.
 * - **A decision is made once**: approving or rejecting checks `if_seq_no`, so two approvers cannot both
 *   publish one change.
 *
 * ## What this is not
 *
 * The checks run in Light Code. Somebody with write access to the cluster, or to the bucket or repository the
 * files live in, can change either by hand. It keeps honest colleagues from overwriting each other's work and
 * makes every change reviewable; it is not access control, and the help text says so.
 */

/** The Windows user id: the signed-in account, never a name typed in settings. Lower case, no domain. */
export function windowsUserId(): string {
  return normaliseUserId(os.userInfo().username)
}

/** `CORP\\JSmith`, ` jsmith ` and `JSMITH` are one id. Empty for nothing usable. */
export function normaliseUserId(raw: string): string {
  const trimmed = raw.trim()
  const afterDomain = trimmed.includes('\\') ? trimmed.slice(trimmed.lastIndexOf('\\') + 1) : trimmed
  return afterDomain.toLowerCase()
}

/** Ids typed into the field: comma, semicolon, space or line separated, de-duplicated, in order. */
export function parseUserIds(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/[\s,;]+/)) {
    const id = normaliseUserId(part)
    if (id.length > 0 && /^[a-z0-9._$-]{1,64}$/.test(id) && !out.includes(id)) out.push(id)
  }
  return out
}

export function teamIndexName(projectSlug: string | undefined): string {
  return `light-code-team-${projectSlug ?? 'default'}`
}

export type TeamKind = 'skill' | 'tool'

export interface AdminList {
  ids: string[]
  by: string
  at: number
  seqNo: number
  primaryTerm: number
}

export interface TeamReview {
  id: string
  kind: TeamKind
  name: string
  owner: string
  by: string
  /** Epoch ms submitted. */
  at: number
  status: 'pending' | 'approved' | 'rejected'
  content: string
  existingContent: string
  decidedBy?: string
  decidedAt?: number
  reason?: string
  seqNo: number
  primaryTerm: number
}

/** Who may change the admin list: anybody while there is none, otherwise only an admin. */
export function mayEditAdmins(list: AdminList | undefined, me: string): boolean {
  return list === undefined || list.ids.length === 0 || list.ids.includes(me)
}

/**
 * Whether a change by `me` to something owned by `owner` must wait for approval. Never while the team has no
 * admins (the feature is off until a list exists); never for the owner or an admin. An unknown owner means only
 * an admin may change it directly.
 */
export function reviewNeeded(admins: AdminList | undefined, owner: string | undefined, me: string): boolean {
  if (admins === undefined || admins.ids.length === 0) return false
  if (admins.ids.includes(me)) return false
  return owner === undefined || normaliseUserId(owner) !== me
}

/** Who may approve a review: its owner, or any admin. */
export function mayDecide(review: Pick<TeamReview, 'owner'>, admins: AdminList | undefined, me: string): boolean {
  return normaliseUserId(review.owner) === me || (admins?.ids.includes(me) ?? false)
}

const MAPPING = {
  mappings: {
    dynamic: false,
    properties: {
      type: { type: 'keyword' },
      kind: { type: 'keyword' },
      name: { type: 'keyword' },
      owner: { type: 'keyword' },
      by: { type: 'keyword' },
      status: { type: 'keyword' },
      at: { type: 'long' },
      payload: { type: 'object', enabled: false },
    },
  },
}

export class TeamStoreError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'TeamStoreError'
  }
}

export class TeamStore {
  private ensured = false

  constructor(
    private readonly http: HttpClient,
    private readonly connection: OpenSearchConnection,
    readonly index: string,
  ) {
    if (!isSafeIndexName(index)) throw new TeamStoreError(`"${index}" is not a usable index name (lowercase letters, digits, - and _).`)
  }

  private async send(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const { username, password } = this.connection
    if (username !== undefined && username.length > 0) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
    }
    const url = `${this.connection.url.replace(/\/+$/, '')}/${encodeURIComponent(this.index)}${path}`
    const request: HttpRequestOptions = { method, headers }
    if (body !== undefined) request.body = JSON.stringify(body)
    if (this.connection.tls !== undefined) request.tls = this.connection.tls
    let response
    try {
      response = await this.http.request(url, request)
    } catch (error) {
      throw new TeamStoreError(`Could not reach ${this.connection.url}: ${describeTlsError(error)}`)
    }
    const text = await response.text().catch(() => '')
    let json: Record<string, unknown> = {}
    try {
      json = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      // A proxy's HTML page; the status says enough.
    }
    return { status: response.status, json }
  }

  private fail(doing: string, status: number, json: Record<string, unknown>): never {
    const reason = (json['error'] as { reason?: string } | undefined)?.reason ?? JSON.stringify(json).slice(0, 300)
    const hint = status === 401 ? ' - the sign-in was refused' : status === 403 ? ' - this account may not write that index; ask whoever runs the cluster' : ''
    throw new TeamStoreError(`OpenSearch refused ${doing} on ${this.index} (${String(status)}${hint}): ${reason}`, status)
  }

  async ensureIndex(): Promise<void> {
    if (this.ensured) return
    const { status, json } = await this.send('PUT', '', MAPPING)
    const type = (json['error'] as { type?: string } | undefined)?.type
    if (status >= 300 && type !== 'resource_already_exists_exception') this.fail('creating the team index', status, json)
    this.ensured = true
  }

  private async get(id: string): Promise<{ source: Record<string, unknown>; seqNo: number; primaryTerm: number } | undefined> {
    const { status, json } = await this.send('GET', `/_doc/${encodeURIComponent(id)}`)
    if (status === 404) return undefined
    if (status >= 300) this.fail(`reading ${id}`, status, json)
    if (json['found'] !== true) return undefined
    return { source: (json['_source'] as Record<string, unknown>) ?? {}, seqNo: Number(json['_seq_no']), primaryTerm: Number(json['_primary_term']) }
  }

  async admins(): Promise<AdminList | undefined> {
    const doc = await this.get('admins')
    if (doc === undefined) return undefined
    const ids = Array.isArray(doc.source['ids']) ? (doc.source['ids'] as unknown[]).filter((id): id is string => typeof id === 'string') : []
    return { ids, by: String(doc.source['by'] ?? ''), at: Number(doc.source['at'] ?? 0), seqNo: doc.seqNo, primaryTerm: doc.primaryTerm }
  }

  /**
   * Saves the admin list as `me`. The first list is created once; a later one only by an admin of the list read,
   * and only if nobody changed it since (`expected`). Returns the list as stored, which may be somebody else's.
   */
  async saveAdmins(ids: readonly string[], me: string, expected: AdminList | undefined): Promise<{ saved: boolean; list: AdminList | undefined; message: string }> {
    await this.ensureIndex()
    const body = { type: 'admins', ids, by: me, at: Date.now() }
    if (expected === undefined) {
      const { status, json } = await this.send('PUT', '/_create/admins?refresh=true', body)
      if (status === 409) {
        const list = await this.admins()
        return { saved: false, list, message: `${list?.by ?? 'Someone'} saved the team's admins first; their list is shown.` }
      }
      if (status >= 300) this.fail('saving the admins', status, json)
      return { saved: true, list: await this.admins(), message: 'Saved. The team sees these admins from now on.' }
    }
    if (!mayEditAdmins(expected, me)) return { saved: false, list: expected, message: 'Only an admin can change the team\'s admins.' }
    const { status, json } = await this.send('PUT', `/_doc/admins?if_seq_no=${String(expected.seqNo)}&if_primary_term=${String(expected.primaryTerm)}&refresh=true`, body)
    if (status === 409) {
      const list = await this.admins()
      return { saved: false, list, message: `${list?.by ?? 'Another admin'} changed the admins just now; their list is shown - change it again if needed.` }
    }
    if (status >= 300) this.fail('saving the admins', status, json)
    return { saved: true, list: await this.admins(), message: 'Saved. The team sees these admins from now on.' }
  }

  async owner(kind: TeamKind, name: string): Promise<string | undefined> {
    const doc = await this.get(`owner:${kind}:${name}`)
    const owner = doc?.source['owner']
    return typeof owner === 'string' && owner.length > 0 ? owner : undefined
  }

  /** Records the owner once; an existing record wins and is returned. */
  async registerOwner(kind: TeamKind, name: string, owner: string): Promise<string> {
    await this.ensureIndex()
    const id = encodeURIComponent(`owner:${kind}:${name}`)
    const { status, json } = await this.send('PUT', `/_create/${id}`, { type: 'owner', kind, name, owner: normaliseUserId(owner), by: windowsUserId(), at: Date.now() })
    if (status === 409) return (await this.owner(kind, name)) ?? owner
    if (status >= 300) this.fail(`recording the owner of ${name}`, status, json)
    return normaliseUserId(owner)
  }

  /** An admin hands a skill or tool to someone else. */
  async setOwner(kind: TeamKind, name: string, owner: string, me: string): Promise<void> {
    await this.ensureIndex()
    const { status, json } = await this.send('PUT', `/_doc/${encodeURIComponent(`owner:${kind}:${name}`)}?refresh=true`, { type: 'owner', kind, name, owner: normaliseUserId(owner), by: me, at: Date.now() })
    if (status >= 300) this.fail(`changing the owner of ${name}`, status, json)
  }

  async submit(review: Omit<TeamReview, 'id' | 'status' | 'seqNo' | 'primaryTerm' | 'at'>): Promise<string> {
    await this.ensureIndex()
    const id = `review:${randomUUID()}`
    const { status, json } = await this.send('PUT', `/_create/${encodeURIComponent(id)}?refresh=true`, {
      type: 'review',
      kind: review.kind,
      name: review.name,
      owner: normaliseUserId(review.owner),
      by: review.by,
      status: 'pending',
      at: Date.now(),
      payload: { content: review.content, existingContent: review.existingContent },
    })
    if (status >= 300) this.fail(`submitting the change to ${review.name}`, status, json)
    return id
  }

  /** Pending first, then decided in the last 30 days; newest first within each. At most 200. */
  async reviews(): Promise<TeamReview[]> {
    const { status, json } = await this.send('POST', '/_search?seq_no_primary_term=true', {
      size: 200,
      sort: [{ at: 'desc' }],
      query: {
        bool: {
          filter: [{ term: { type: 'review' } }],
          should: [{ term: { status: 'pending' } }, { range: { at: { gte: Date.now() - 30 * 86_400_000 } } }],
          minimum_should_match: 1,
        },
      },
    })
    if (status === 404) return []
    if (status >= 300) this.fail('reading the reviews', status, json)
    const hits = ((json['hits'] as { hits?: { _id: string; _source?: Record<string, unknown>; _seq_no?: number; _primary_term?: number }[] } | undefined)?.hits ?? [])
    const out: TeamReview[] = []
    for (const hit of hits) {
      const s = hit._source ?? {}
      const payload = (s['payload'] as { content?: string; existingContent?: string; decidedBy?: string; decidedAt?: number; reason?: string } | undefined) ?? {}
      out.push({
        id: hit._id,
        kind: s['kind'] === 'tool' ? 'tool' : 'skill',
        name: String(s['name'] ?? ''),
        owner: String(s['owner'] ?? ''),
        by: String(s['by'] ?? ''),
        at: Number(s['at'] ?? 0),
        status: s['status'] === 'approved' || s['status'] === 'rejected' ? s['status'] : 'pending',
        content: payload.content ?? '',
        existingContent: payload.existingContent ?? '',
        ...(payload.decidedBy !== undefined ? { decidedBy: payload.decidedBy } : {}),
        ...(payload.decidedAt !== undefined ? { decidedAt: payload.decidedAt } : {}),
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        seqNo: hit._seq_no ?? 0,
        primaryTerm: hit._primary_term ?? 0,
      })
    }
    return out.sort((a, b) => (a.status === 'pending') === (b.status === 'pending') ? b.at - a.at : a.status === 'pending' ? -1 : 1)
  }

  /** Records a decision once. False when somebody decided it first. */
  async decide(review: TeamReview, decision: 'approved' | 'rejected', me: string, reason: string | undefined): Promise<boolean> {
    const { status, json } = await this.send('PUT', `/_doc/${encodeURIComponent(review.id)}?if_seq_no=${String(review.seqNo)}&if_primary_term=${String(review.primaryTerm)}&refresh=true`, {
      type: 'review',
      kind: review.kind,
      name: review.name,
      owner: review.owner,
      by: review.by,
      status: decision,
      at: review.at,
      payload: { content: review.content, existingContent: review.existingContent, decidedBy: me, decidedAt: Date.now(), ...(reason !== undefined && reason.length > 0 ? { reason } : {}) },
    })
    if (status === 409) return false
    if (status >= 300) this.fail(`recording the decision on ${review.name}`, status, json)
    return true
  }
}
