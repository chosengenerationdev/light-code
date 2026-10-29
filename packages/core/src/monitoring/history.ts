import { createHash, randomBytes } from 'node:crypto'

import type { HttpClient, HttpRequestOptions } from '../platform/http.js'
import { describeTlsError } from '../providers/auth/apigeeMtls.js'
import type { OpenSearchConnection } from '../rag/opensearch/client.js'
import { isSafeIndexName } from '../rag/opensearch/client.js'

/**
 * A team's monitoring history in one shared OpenSearch index - Fire Code's team monitors (asked for:
 * "if opensearch is configured ... keep it as mandatory for team level monitoring", and "as team will be
 * using same opensearch index, please handle the race condition properly").
 *
 * ## Many writers, no lost or doubled work
 *
 * - **Nothing is ever updated in place.** A check is a new document under an id nobody else can make
 *   (monitor, who, when, random), written with `_create`. Two people's checks cannot overwrite each other.
 * - **One run per monitor per interval, without a lock.** Before a team check, a Fire Code creates
 *   `claim:<monitor>:<slot>` (slot = the interval number) with `_create`. OpenSearch accepts exactly one;
 *   everybody else gets 409 and reads the winner's check instead. A winner that crashes holds nothing:
 *   the next slot is claimed afresh, and the tile goes purple only if nobody manages it.
 * - **The index is created by whoever is first**, with a fixed mapping; the others' attempts end in
 *   "already exists", which is success. **`dynamic: false`**: rows are kept as an unindexed object, so one
 *   person's number field can never clash with another's text field and break everybody's writes.
 * - **Cleanup deletes only the caller's own documents** (`by`), with `conflicts=proceed`: two of one
 *   person's machines pruning at once do not fail each other, and one person's retention cannot empty the
 *   team's history.
 *
 * A writer, so not `OpenSearchClient`, which is read-only by construction and stays so (§19): this class
 * can create, search and delete-by-query in **this one index** and nothing else.
 */

export interface StoredAlert {
  id: string
  level: string
  key: string
  column?: string | undefined
  message: string
  /** The row it fired on - only alerted rows are kept (the user's choice). */
  row: Record<string, unknown>
}

/** One check - the same shape as Fire Code's `CheckRecord` (monitor.rs), with the monitor's name. */
export interface CheckDocument {
  monitor: string
  /** Who ran it - the attribution name, filled here. */
  by: string
  /** Epoch seconds. */
  at: number
  level: string
  headline: string
  error?: string | undefined
  rowCount: number
  durationMs: number
  /** Open alerts in the check. */
  alerts: number
  /** Every alert, with the row it fired on. */
  found: StoredAlert[]
}

const MAPPING = {
  mappings: {
    dynamic: false,
    properties: {
      kind: { type: 'keyword' },
      monitor: { type: 'keyword' },
      by: { type: 'keyword' },
      at: { type: 'long' },
      slot: { type: 'long' },
      level: { type: 'keyword' },
      alertIds: { type: 'keyword' },
      alertKeys: { type: 'keyword' },
      /** A shared grid's content hash (Fire Code 0.65.0). */
      hash: { type: 'keyword' },
      payload: { type: 'object', enabled: false },
    },
  },
}

/** One saved version of a monitor skill, as Fire Code saw it arrive (`monitor.rs` `Revision`). */
export interface MonitorRevision {
  /** When it was saved: the skill's `updated` label, else when it was first seen. Epoch seconds. */
  at: number
  /** Who saved it: `updated_by`, else the author, else unknown. */
  by?: string | undefined
  author?: string | undefined
  version?: number | undefined
  /** The monitor block's hash - its approval key. */
  hash: string
  /** What changed, in words: created, schedule, the monitor, the text around it. */
  change: string
  block?: string | undefined
}

export class MonitorHistoryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'MonitorHistoryError'
  }
}

/** A document id from parts that may hold anything: readable where it can be, never a path. */
function docId(...parts: (string | number)[]): string {
  return parts
    .map((p) => String(p))
    .map((p) => (/^[A-Za-z0-9._-]{1,80}$/.test(p) ? p : createHash('sha256').update(p).digest('hex').slice(0, 16)))
    .join(':')
}

export class MonitorHistoryStore {
  private ensured = false

  constructor(
    private readonly http: HttpClient,
    private readonly connection: OpenSearchConnection,
    readonly index: string,
    /** This person, as the team sees them: whose documents cleanup may remove. */
    readonly by: string,
  ) {
    if (!isSafeIndexName(index)) throw new MonitorHistoryError(`"${index}" is not a usable index name (lowercase letters, digits, - and _).`)
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
      throw new MonitorHistoryError(`Could not reach ${this.connection.url}: ${describeTlsError(error)}`)
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
    const hint = status === 401 ? ' - the sign-in was refused' : status === 403 ? ' - this account may not write to that index; ask whoever runs the cluster' : ''
    throw new MonitorHistoryError(`OpenSearch refused ${doing} (${String(status)}${hint}): ${reason}`, status)
  }

  /** Creates the index with its mapping, once; "already exists" - another member won - is success. */
  async ensureIndex(): Promise<void> {
    if (this.ensured) return
    const { status, json } = await this.send('PUT', '', MAPPING)
    const type = (json['error'] as { type?: string } | undefined)?.type
    if (status >= 300 && type !== 'resource_already_exists_exception') this.fail('creating the monitoring index', status, json)
    if (type === 'resource_already_exists_exception') {
      // An index made by an earlier Fire Code lacks the fields added since: adding a field is allowed, and the same
      // again is a no-op, so every member may do it. Until it is there, shared grids cannot be found by hash.
      const added = await this.send('PUT', '/_mapping', { properties: { hash: MAPPING.mappings.properties.hash } })
      if (added.status >= 300) this.fail('updating the monitoring index', added.status, added.json)
    }
    this.ensured = true
  }

  /** True when this Fire Code may run `monitor` for interval `slot`; false when a team member already is. */
  /**
   * A check's whole grid, shared once per distinct grid and day (asked: every member must see the same rows, not
   * only the alerted ones). Named by the grid's content hash, so unchanged data adds nothing; created once - a
   * second writer the same day gets "already there", which is success.
   */
  async writeGrid(monitor: string, hash: string, evaluation: unknown): Promise<void> {
    await this.ensureIndex()
    const day = Math.floor(Date.now() / 86_400_000)
    const { status, json } = await this.send('PUT', `/_create/${encodeURIComponent(docId('grid', monitor, hash, day))}`, {
      kind: 'grid',
      monitor,
      by: this.by,
      at: Math.floor(Date.now() / 1000),
      hash,
      payload: { evaluation },
    })
    if (status === 409) return
    if (status >= 300) this.fail(`sharing the grid of ${monitor}`, status, json)
  }

  /** A shared grid by its hash: the newest copy, or undefined when no member shared it (or it was cleaned up). */
  async grid(monitor: string, hash: string): Promise<unknown> {
    const json = await this.search({
      size: 1,
      sort: [{ at: 'desc' }],
      _source: ['payload'],
      query: { bool: { filter: [{ term: { kind: 'grid' } }, { term: { monitor } }, { term: { hash } }] } },
    })
    const hits = ((json['hits'] as { hits?: unknown[] } | undefined)?.hits ?? []) as { _source: { payload: { evaluation: unknown } } }[]
    return hits[0]?._source.payload.evaluation
  }

  /**
   * `attempt` 2 is the one takeover of a window whose winner's check never arrived: a claim of its own, so of the
   * members taking it over, one does.
   */
  async claim(monitor: string, slot: number, attempt = 1): Promise<boolean> {
    await this.ensureIndex()
    const id = attempt > 1 ? docId('claim', monitor, `${slot}-r${attempt}`) : docId('claim', monitor, slot)
    const { status, json } = await this.send('PUT', `/_create/${encodeURIComponent(id)}`, {
      kind: 'claim',
      monitor,
      slot,
      ...(attempt > 1 ? { attempt } : {}),
      by: this.by,
      at: Math.floor(Date.now() / 1000),
    })
    if (status === 409) return false
    if (status >= 300) this.fail(`claiming ${monitor}`, status, json)
    return true
  }

  async write(check: Omit<CheckDocument, 'by'>): Promise<void> {
    await this.ensureIndex()
    const record: CheckDocument = { ...check, by: this.by }
    const id = docId('check', record.monitor, record.by, record.at, randomBytes(4).toString('hex'))
    const { status, json } = await this.send('PUT', `/_create/${encodeURIComponent(id)}`, {
      kind: 'check',
      monitor: record.monitor,
      by: record.by,
      at: record.at,
      level: record.level,
      alertIds: (record.found ?? []).map((a) => a.id),
      alertKeys: [...new Set((record.found ?? []).map((a) => a.key))],
      payload: record,
    })
    if (status >= 300) this.fail(`recording a check of ${record.monitor}`, status, json)
  }

  private async search(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureIndex()
    const { status, json } = await this.send('POST', '/_search', body)
    if (status >= 300) this.fail('reading monitoring history', status, json)
    return json
  }

  /** The newest check of each monitor, by anyone. */
  async latest(monitors: readonly string[]): Promise<Record<string, CheckDocument>> {
    if (monitors.length === 0) return {}
    const json = await this.search({
      size: 0,
      query: { bool: { filter: [{ term: { kind: 'check' } }, { terms: { monitor: monitors } }] } },
      aggs: { m: { terms: { field: 'monitor', size: monitors.length }, aggs: { top: { top_hits: { size: 1, sort: [{ at: 'desc' }], _source: ['payload'] } } } } },
    })
    const out: Record<string, CheckDocument> = {}
    const buckets = ((json['aggregations'] as { m?: { buckets?: unknown[] } } | undefined)?.m?.buckets ?? []) as { key: string; top: { hits: { hits: { _source: { payload: CheckDocument } }[] } } }[]
    for (const bucket of buckets) {
      const hit = bucket.top.hits.hits[0]?._source.payload
      if (hit !== undefined) out[bucket.key] = hit
    }
    return out
  }

  /** A monitor's checks since `since` (epoch seconds), newest first, by anyone. */
  /** Checks from `since`, newest first; with `until`, only before then (one day's, from the History view). */
  async history(monitor: string, since: number, limit = 500, until?: number): Promise<CheckDocument[]> {
    const json = await this.search({
      size: Math.min(Math.max(limit, 1), 2000),
      sort: [{ at: 'desc' }],
      _source: ['payload'],
      query: { bool: { filter: [{ term: { kind: 'check' } }, { term: { monitor } }, { range: { at: { gte: since, ...(until !== undefined ? { lt: until } : {}) } } }] } },
    })
    const hits = ((json['hits'] as { hits?: unknown[] } | undefined)?.hits ?? []) as { _source: { payload: CheckDocument } }[]
    return hits.map((h) => h._source.payload)
  }

  /** Removes one check of this person's - the History view's "Delete this check". A colleague's stays theirs. */
  async deleteCheck(monitor: string, at: number): Promise<number> {
    await this.ensureIndex()
    const filter = [{ term: { kind: 'check' } }, { term: { monitor } }, { term: { at } }, { term: { by: this.by } }]
    const { status, json } = await this.send('POST', '/_delete_by_query?conflicts=proceed', { query: { bool: { filter } } })
    if (status >= 300) this.fail('deleting a check', status, json)
    return Number(json['deleted'] ?? 0)
  }

  /**
   * One change to a monitor - who saved which version, when, with its block - created once per version and block:
   * every member who sees it arrive offers it, and the first one stands. The audit the grid window's Changes shows.
   */
  async writeRevision(monitor: string, revision: MonitorRevision): Promise<void> {
    await this.ensureIndex()
    const id = docId('rev', monitor, revision.version ?? 0, revision.hash.slice(0, 16))
    const { status, json } = await this.send('PUT', `/_create/${encodeURIComponent(id)}`, {
      kind: 'revision',
      monitor,
      // `by` is who offered it, so prune and delete stay to each person's own; the saver is in the payload.
      by: this.by,
      at: revision.at,
      hash: revision.hash,
      payload: { revision },
    })
    if (status === 409) return
    if (status >= 300) this.fail(`recording a change to ${monitor}`, status, json)
  }

  /** A monitor's changes, newest first, by anyone. */
  async revisions(monitor: string, limit = 200): Promise<MonitorRevision[]> {
    const json = await this.search({
      size: Math.min(Math.max(limit, 1), 1000),
      sort: [{ at: 'desc' }],
      _source: ['payload'],
      query: { bool: { filter: [{ term: { kind: 'revision' } }, { term: { monitor } }] } },
    })
    const hits = ((json['hits'] as { hits?: unknown[] } | undefined)?.hits ?? []) as { _source: { payload: { revision: MonitorRevision } } }[]
    return hits.map((h) => h._source.payload.revision)
  }

  /**
   * Removes this person's checks and claims older than `before` - only theirs. How many went. A monitor's change
   * record is its audit, not its history, so it stays - unless `revisions` (the monitor itself is being deleted).
   */
  async prune(before: number, monitor?: string, revisions = false): Promise<number> {
    await this.ensureIndex()
    const filter: unknown[] = [{ term: { by: this.by } }, { range: { at: { lt: before } } }]
    if (monitor !== undefined) filter.push({ term: { monitor } })
    const query = { bool: { filter, ...(revisions ? {} : { must_not: [{ term: { kind: 'revision' } }] }) } }
    const { status, json } = await this.send('POST', '/_delete_by_query?conflicts=proceed', { query })
    if (status >= 300) this.fail('cleaning up monitoring history', status, json)
    return Number(json['deleted'] ?? 0)
  }
}
