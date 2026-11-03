import { createHash } from 'node:crypto'

import type { HttpClient, HttpRequestOptions } from '../platform/http.js'
import { describeTlsError } from '../providers/auth/apigeeMtls.js'
import type { OpenSearchConnection } from '../rag/opensearch/client.js'
import { isSafeIndexName } from '../rag/opensearch/client.js'
import { ownerSlug } from '../rag/indexNaming.js'
import type { AuditQuery, AuditRecord } from './journal.js'

/**
 * The Auditor's record in OpenSearch, when OpenSearch is configured: **one index per user**
 * (`light-code-audit-<user>`), asked for as "a separate user dedicated index".
 *
 * A writer, so not `OpenSearchClient`, which is read-only by construction (§19). It can create this one
 * index, add documents with `_create` under ids derived from the record (so a retry adds nothing twice),
 * and search it - nothing else. `dynamic: false`: the record is kept whole in an unindexed `payload`, and
 * only the fields searched on are mapped, so no record's shape can break another's write.
 */

const MAPPING = {
  mappings: {
    dynamic: false,
    properties: {
      at: { type: 'date', format: 'epoch_millis' },
      type: { type: 'keyword' },
      session: { type: 'keyword' },
      workspace: { type: 'keyword' },
      project: { type: 'keyword' },
      user: { type: 'keyword' },
      kind: { type: 'keyword' },
      tool: { type: 'keyword' },
      level: { type: 'keyword' },
      text: { type: 'text' },
      payload: { type: 'object', enabled: false },
    },
  },
}

export function auditIndexName(user: string): string {
  return `light-code-audit-${ownerSlug(user) ?? 'unknown'}`
}

/** The searchable text of a record: what a person would look for in it. */
function recordText(record: AuditRecord): string {
  const parts: string[] = []
  const e = record.event
  if (e !== undefined) {
    if ('text' in e) parts.push(e.text)
    if ('args' in e) parts.push(e.args)
    if ('preview' in e) parts.push(e.preview)
    if ('reason' in e) parts.push(e.reason)
    if ('error' in e && e.error !== undefined) parts.push(e.error)
  }
  if (record.finding !== undefined) parts.push(record.finding.summary, ...record.finding.concerns, record.finding.alert ?? '')
  if (record.alert !== undefined) parts.push(record.alert.message)
  if (record.note !== undefined) parts.push(record.note.note)
  if (record.status !== undefined) parts.push(record.status)
  return parts.join('\n').slice(0, 20_000)
}

export function recordId(record: AuditRecord): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 32)
}

export class AuditIndex {
  private ensured = false

  constructor(
    private readonly http: HttpClient,
    private readonly connection: OpenSearchConnection,
    readonly index: string,
  ) {
    if (!isSafeIndexName(index)) throw new Error(`"${index}" is not a usable index name (lowercase letters, digits, - and _).`)
  }

  private async send(method: string, path: string, body?: string, contentType = 'application/json'): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'Content-Type': contentType }
    const { username, password } = this.connection
    if (username !== undefined && username.length > 0) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
    }
    const url = `${this.connection.url.replace(/\/+$/, '')}/${encodeURIComponent(this.index)}${path}`
    const request: HttpRequestOptions = { method, headers }
    if (body !== undefined) request.body = body
    if (this.connection.tls !== undefined) request.tls = this.connection.tls
    let response
    try {
      response = await this.http.request(url, request)
    } catch (error) {
      throw new Error(`Could not reach ${this.connection.url}: ${describeTlsError(error)}`, { cause: error })
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
    const hint = status === 401 ? ' - the sign-in was refused' : status === 403 ? ' - this account may not create or write that index; ask whoever runs the cluster' : ''
    throw new Error(`OpenSearch refused ${doing} on ${this.index} (${String(status)}${hint}): ${reason}`)
  }

  async ensureIndex(): Promise<void> {
    if (this.ensured) return
    const { status, json } = await this.send('PUT', '', JSON.stringify(MAPPING))
    const type = (json['error'] as { type?: string } | undefined)?.type
    if (status >= 300 && type !== 'resource_already_exists_exception') this.fail('creating the audit index', status, json)
    this.ensured = true
  }

  /** Adds records; one already there (a retry) is not an error. Returns how many were new. */
  async write(records: readonly AuditRecord[]): Promise<number> {
    if (records.length === 0) return 0
    await this.ensureIndex()
    const lines: string[] = []
    for (const record of records) {
      const e = record.event
      lines.push(JSON.stringify({ create: { _id: recordId(record) } }))
      lines.push(
        JSON.stringify({
          at: record.at,
          type: record.type,
          session: record.session,
          workspace: record.workspace,
          project: record.project,
          user: record.user,
          ...(e !== undefined ? { kind: e.kind } : {}),
          ...(e !== undefined && 'tool' in e ? { tool: e.tool } : {}),
          ...(record.alert !== undefined ? { level: record.alert.level } : record.finding !== undefined ? { level: record.finding.risk } : {}),
          text: recordText(record),
          payload: record,
        }),
      )
    }
    const { status, json } = await this.send('POST', '/_bulk', `${lines.join('\n')}\n`, 'application/x-ndjson')
    if (status >= 300) this.fail('adding audit records', status, json)
    const items = Array.isArray(json['items']) ? (json['items'] as { create?: { status?: number; error?: { reason?: string } } }[]) : []
    const failed = items.filter((item) => (item.create?.status ?? 200) >= 300 && item.create?.status !== 409)
    if (failed.length > 0) throw new Error(`OpenSearch did not take ${String(failed.length)} audit record(s): ${failed[0]?.create?.error?.reason ?? 'no reason given'}`)
    return items.filter((item) => item.create?.status === 201).length
  }

  async search(query: AuditQuery, workspace: string | undefined): Promise<{ records: AuditRecord[]; total: number }> {
    const filter: unknown[] = []
    if (query.from !== undefined || query.until !== undefined) {
      filter.push({ range: { at: { ...(query.from !== undefined ? { gte: query.from } : {}), ...(query.until !== undefined ? { lte: query.until } : {}) } } })
    }
    if (query.types !== undefined && query.types.length > 0) filter.push({ terms: { type: query.types } })
    if (query.tool !== undefined) filter.push({ term: { tool: query.tool } })
    if (query.session !== undefined) filter.push({ term: { session: query.session } })
    if (query.allWorkspaces !== true && workspace !== undefined) filter.push({ term: { workspace } })
    const must = query.contains !== undefined ? [{ match: { text: { query: query.contains, operator: 'and' } } }] : []
    const size = Math.max(1, Math.min(query.limit ?? 200, 2_000))
    const { status, json } = await this.send('POST', '/_search', JSON.stringify({ size, sort: [{ at: 'desc' }], _source: ['payload'], track_total_hits: true, query: { bool: { filter, must } } }))
    if (status === 404) return { records: [], total: 0 }
    if (status >= 300) this.fail('searching the audit index', status, json)
    const hits = (json['hits'] as { hits?: { _source?: { payload?: AuditRecord } }[]; total?: { value?: number } } | undefined) ?? {}
    const records = (hits.hits ?? []).map((hit) => hit._source?.payload).filter((r): r is AuditRecord => r !== undefined)
    return { records, total: hits.total?.value ?? records.length }
  }
}
