import type { VectorStoreKind } from '../config/schema.js'
import type { HttpClient } from '../platform/http.js'
import { OpenSearchClient } from './opensearch/client.js'
import { RestTransport } from './restTransport.js'
import { VectorStoreError, type VectorStoreConnection } from './vectorStore.js'

/**
 * Which backend actually answered, judged from what it sent back.
 *
 * Reported from real use: a connection saved as Qdrant (the form's default type) with the team's
 * OpenSearch address. Test connection always spoke OpenSearch, so it passed; indexing then asked the
 * cluster for `/collections/<name>`, OpenSearch answered an address it does not know with HTTP 400,
 * and the message - "Could not read collection ... (HTTP 400)" - pointed at the index name. Changing
 * the project name, the obvious next step, changed nothing.
 *
 * So the server is recognised from its own answers, and a mismatch is named in those terms. Each
 * signature is something only that server sends; anything unrecognised is `undefined`, never a guess.
 */
export function identifyServer(body: unknown): VectorStoreKind | undefined {
  if (typeof body === 'string') {
    // OpenSearch and Elasticsearch answer an unknown address with this text, as JSON or plain.
    return /no handler found for uri/i.test(body) ? 'opensearch' : undefined
  }
  if (body === null || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  const version = record.version as Record<string, unknown> | string | undefined
  if (typeof record.cluster_name === 'string' && typeof version === 'object' && typeof version?.number === 'string') {
    return 'opensearch'
  }
  if (typeof record.title === 'string' && /qdrant/i.test(record.title)) return 'qdrant'
  if ('nanosecond heartbeat' in record) return 'chroma'
  const error = record.error
  if (typeof error === 'string') return identifyServer(error)
  // `error.root_cause` is OpenSearch's error envelope and nobody else's.
  if (error !== null && typeof error === 'object' && Array.isArray((error as Record<string, unknown>).root_cause)) {
    return 'opensearch'
  }
  return undefined
}

const NAMES: Record<VectorStoreKind, string> = { opensearch: 'OpenSearch', qdrant: 'Qdrant', chroma: 'Chroma' }

export function storeKindName(kind: VectorStoreKind): string {
  return NAMES[kind]
}

/** The sentence telling somebody the connection's type does not match the server, or undefined. */
export function wrongServerMessage(expected: VectorStoreKind, body: unknown, label: string): string | undefined {
  const actual = identifyServer(body)
  if (actual === undefined || actual === expected) return undefined
  return (
    `${label} answers like ${NAMES[actual]}, but this connection's type is ${NAMES[expected]}. ` +
    `In Settings → Search, edit the connection and set Type to ${NAMES[actual]}` +
    (actual === 'opensearch' ? '' : `, or enter your ${NAMES[expected]} server's address`) +
    '.'
  )
}

/** ` <sentence>` to append to a failure, or an empty string. */
export function wrongServerHint(expected: VectorStoreKind, body: unknown, label: string): string {
  const message = wrongServerMessage(expected, body, label)
  return message === undefined ? '' : ` ${message}`
}

/**
 * Test connection, speaking the backend the connection is set to.
 *
 * It used to ping as OpenSearch whatever the type said, which is how the mismatch above passed. The
 * root address is read first, for every type, because a server that answers it plainly says what it
 * is; then the type's own check runs, so a wrong credential still fails here rather than at indexing.
 */
export async function probeVectorStore(
  http: HttpClient,
  kind: VectorStoreKind,
  connection: VectorStoreConnection,
  signal?: AbortSignal,
): Promise<string> {
  const rest = new RestTransport(http, connection, () => qdrantKeyHeader(kind, connection))
  const label = rest.label
  const root = await rest.send<unknown>('/', 'GET', undefined, signal)
  const mismatch = wrongServerMessage(kind, root.body, label)
  if (mismatch !== undefined) throw new VectorStoreError(mismatch, root.status)

  if (kind === 'opensearch') {
    const info = await new OpenSearchClient(http, connection).ping(signal)
    return `Connected to ${info.clusterName ?? 'the cluster'}${info.version !== undefined ? ` (OpenSearch ${info.version})` : ''}.`
  }

  if (kind === 'qdrant') {
    const listed = await rest.send<{ result?: { collections?: unknown[] } }>('/collections', 'GET', undefined, signal)
    if (listed.status === 401 || listed.status === 403) {
      throw new VectorStoreError(
        `${label} refused the credentials (HTTP ${String(listed.status)}). Qdrant takes its API key in the Password box, with Username left empty.`,
        listed.status,
      )
    }
    if (listed.status < 200 || listed.status >= 300 || !Array.isArray(listed.body?.result?.collections)) {
      throw new VectorStoreError(
        `${label} did not answer as Qdrant (GET /collections returned HTTP ${String(listed.status)}).` +
          wrongServerHint('qdrant', listed.body, label),
        listed.status,
      )
    }
    const version = (root.body as { version?: unknown } | undefined)?.version
    const count = listed.body.result.collections.length
    return `Connected to Qdrant${typeof version === 'string' ? ` ${version}` : ''} - ${String(count)} collection${count === 1 ? '' : 's'}.`
  }

  const beat = await rest.send<unknown>('/api/v2/heartbeat', 'GET', undefined, signal)
  if (beat.status === 404 || beat.status === 410) {
    throw new VectorStoreError(
      `${label} does not speak the Chroma v2 API. Light Code needs Chroma 1.0 or newer.` +
        wrongServerHint('chroma', beat.body, label),
      beat.status,
    )
  }
  if (beat.status < 200 || beat.status >= 300 || identifyServer(beat.body) !== 'chroma') {
    throw new VectorStoreError(
      `${label} did not answer as Chroma (GET /api/v2/heartbeat returned HTTP ${String(beat.status)}).` +
        wrongServerHint('chroma', beat.body, label),
      beat.status,
    )
  }
  const version = await rest.send<unknown>('/api/v2/version', 'GET', undefined, signal)
  return `Connected to Chroma${typeof version.body === 'string' && version.status === 200 ? ` ${version.body}` : ''}.`
}

/** Qdrant's `api-key` header, matching `qdrant.ts`: only when there is a password and no user name. */
function qdrantKeyHeader(kind: VectorStoreKind, connection: VectorStoreConnection): Record<string, string> {
  if (kind !== 'qdrant') return {}
  const { username, password } = connection
  if ((username === undefined || username.length === 0) && password !== undefined && password.length > 0) {
    return { 'api-key': password }
  }
  return {}
}
