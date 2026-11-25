import type { HttpClient } from '../platform/http.js'
import type { AuthStrategy, ProviderProfile } from '../providers/types.js'

/**
 * A reranker (a cross-encoder such as BAAI's bge-reranker-v2-m3): given a query and texts, a relevance score for each,
 * read from the pair together - sharper than comparing two embeddings made apart. Asked for to improve finding skills,
 * tools, team skills and code; set up as an OpenAI-compatible provider profile, like the decision model.
 *
 * Rerankers do not serve chat completions. Servers expose them in a few shapes, all tried in order, and the one that
 * answered is remembered per base URL:
 * - `/v1/rerank` and `/rerank` (vLLM, Infinity, Jina and Cohere style): `{ model, query, documents, top_n }` →
 *   `{ results: [{ index, relevance_score }] }`.
 * - `/rerank` (Hugging Face TEI): `{ query, texts }` → `[{ index, score }]`.
 * - `/v1/score` (vLLM): `{ model, text_1: query, text_2: [texts] }` → `{ data: [{ index, score }] }`.
 * A path in config (`reranker.endpoint`) is used alone, in whichever body shape it accepts.
 *
 * Never throws and never blocks a search for long: on any failure the caller keeps its own order and says so.
 */

export interface RerankerModel {
  profile: ProviderProfile
  http: HttpClient
  auth: AuthStrategy
  /** A path on the profile's base URL; undefined tries the usual ones. */
  endpoint?: string | undefined
}

export interface RerankResult {
  ok: boolean
  /** One per text, in the order given; 0 to 1 where the server says so (relevance scores), otherwise as it answered. */
  scores?: number[]
  /** Where it answered, for the Test button and the search log. */
  endpoint?: string
  error?: string
  ms: number
}

/** Each text is cut to this many characters: a description, not a document, is what is being judged. */
export const RERANK_TEXT_LIMIT = 2000
/** Texts sent in one request; more are sent in several, at most four at a time. */
const BATCH = 64

type Shape = 'documents' | 'texts' | 'score'
const WORKED = new Map<string, { path: string; shape: Shape }>()

/** Why an endpoint setting cannot be used, or undefined: a path on the profile's own base URL. */
export function rerankEndpointProblem(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined || endpoint.trim() === '') return undefined
  if (!endpoint.startsWith('/')) return 'The endpoint is a path on the base URL of the provider, starting with /.'
  if (/:\/\/|\.\.|\s|\\|#|\?/.test(endpoint)) return 'The endpoint path may not hold "://", "..", spaces, a backslash, "?" or "#".'
  return undefined
}

function bodyFor(shape: Shape, model: string, query: string, texts: string[]): Record<string, unknown> {
  if (shape === 'texts') return { query, texts, raw_scores: false, truncate: true }
  if (shape === 'score') return { model, text_1: query, text_2: texts }
  return { model, query, documents: texts, top_n: texts.length }
}

/** Scores by index from any of the answer shapes above; undefined when it is none of them. */
export function readScores(text: string, count: number): number[] | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  const list = Array.isArray(body)
    ? body
    : body !== null && typeof body === 'object'
      ? ((body as Record<string, unknown>)['results'] ?? (body as Record<string, unknown>)['data'] ?? (body as Record<string, unknown>)['scores'])
      : undefined
  if (!Array.isArray(list) || list.length === 0) return undefined
  // A bare list of numbers, in order.
  if (list.every((value) => typeof value === 'number')) return list.length === count ? (list as number[]) : undefined
  const scores = new Array<number>(count).fill(Number.NaN)
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') return undefined
    const record = entry as Record<string, unknown>
    const index = record['index']
    const score = record['relevance_score'] ?? record['score'] ?? record['relevance']
    if (typeof index !== 'number' || typeof score !== 'number' || index < 0 || index >= count) return undefined
    scores[index] = score
  }
  return scores.every((score) => Number.isFinite(score)) ? scores : undefined
}

export async function rerank(
  model: RerankerModel,
  query: string,
  texts: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RerankResult> {
  const started = Date.now()
  const base = model.profile.baseUrl.replace(/\/+$/, '')
  /*
   * The automatic paths are the server's own, from its root: an OpenAI-compatible base URL usually ends in /v1, and
   * /v1 + /v1/rerank is nothing (found by the end-to-end test). A configured path is added to the base URL as typed.
   */
  const root = base.replace(/\/v1$/, '')
  const configured = model.endpoint?.trim()
  const target = configured !== undefined && configured !== '' ? base : root
  const problem = rerankEndpointProblem(configured)
  if (problem !== undefined) return { ok: false, error: problem, ms: 0 }
  if (texts.length === 0) return { ok: true, scores: [], ms: 0 }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort)
  const clipped = texts.map((text) => (text.length > RERANK_TEXT_LIMIT ? text.slice(0, RERANK_TEXT_LIMIT) : text))

  const send = async (path: string, shape: Shape, batch: string[]): Promise<{ status: number; scores?: number[]; text: string }> => {
    const post = async (): Promise<{ status: number; text: string }> => {
      const headers = await model.auth.resolveHeaders()
      const tls = await model.auth.tls?.()
      const response = await model.http.request(`${target}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers, ...model.profile.headers },
        body: JSON.stringify(bodyFor(shape, model.profile.model, query, batch)),
        signal: controller.signal,
        ...(tls !== undefined ? { tls } : {}),
      })
      return { status: response.status, text: await response.text() }
    }
    let answer = await post()
    if (answer.status === 401 && model.auth.onUnauthorized !== undefined && (await model.auth.onUnauthorized())) answer = await post()
    const scores = answer.status < 300 ? readScores(answer.text, batch.length) : undefined
    return { status: answer.status, text: answer.text, ...(scores !== undefined ? { scores } : {}) }
  }

  try {
    // Find a path and body that answer, with the first batch.
    const first = clipped.slice(0, BATCH)
    const remembered = WORKED.get(`${base}|${configured ?? ''}`)
    const tries: { path: string; shape: Shape }[] = remembered !== undefined
      ? [remembered]
      : configured !== undefined && configured !== ''
        ? [{ path: configured, shape: 'documents' }, { path: configured, shape: 'texts' }, { path: configured, shape: 'score' }]
        : [
            { path: '/v1/rerank', shape: 'documents' },
            { path: '/rerank', shape: 'documents' },
            { path: '/rerank', shape: 'texts' },
            { path: '/v1/score', shape: 'score' },
          ]
    let chosen: { path: string; shape: Shape } | undefined
    let firstScores: number[] | undefined
    const failures: string[] = []
    for (const attempt of tries) {
      const answer = await send(attempt.path, attempt.shape, first)
      if (answer.scores !== undefined) {
        chosen = attempt
        firstScores = answer.scores
        break
      }
      failures.push(`${attempt.path} answered ${answer.status < 300 ? 'in a shape that is not a reranker\'s' : `HTTP ${String(answer.status)}`}`)
      if (answer.status === 401 || answer.status === 403) break
    }
    if (chosen === undefined || firstScores === undefined) {
      WORKED.delete(`${base}|${configured ?? ''}`)
      return { ok: false, error: `No reranker answered at ${target}: ${failures.join('; ')}.`, ms: Date.now() - started }
    }
    WORKED.set(`${base}|${configured ?? ''}`, chosen)

    const scores = [...firstScores]
    const rest: { at: number; batch: string[] }[] = []
    for (let at = BATCH; at < clipped.length; at += BATCH) rest.push({ at, batch: clipped.slice(at, at + BATCH) })
    for (let i = 0; i < rest.length; i += 4) {
      const group = rest.slice(i, i + 4)
      const answers = await Promise.all(group.map((part) => send(chosen.path, chosen.shape, part.batch)))
      answers.forEach((answer, n) => {
        const part = group[n]
        if (part === undefined) return
        if (answer.scores === undefined) throw new Error(`${chosen.path} answered HTTP ${String(answer.status)} for texts ${String(part.at + 1)}-${String(part.at + part.batch.length)}`)
        scores.push(...answer.scores)
      })
    }
    return { ok: true, scores, endpoint: `${chosen.path} (${chosen.shape})`, ms: Date.now() - started }
  } catch (error) {
    const aborted = controller.signal.aborted && options.signal?.aborted !== true
    return { ok: false, error: aborted ? `The reranker took longer than ${String(Math.round((options.timeoutMs ?? 5_000) / 1000))} seconds.` : error instanceof Error ? error.message : String(error), ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * What a search tool is given when a reranker is set up: how to score, the least score kept, and how many candidates
 * to fetch for it to reorder.
 */
export interface Reranking {
  scores: (query: string, texts: readonly string[], signal?: AbortSignal) => Promise<RerankResult>
  minScore: number
  candidates: number
  /** What each reordering did, for the Auditor's record: the first few kept with their scores, or why it did not answer. */
  report?: (outcome: RerankOutcome) => void
}

export interface RerankOutcome {
  query: string
  candidates: number
  /** The first few kept: a short label (the text's first line) and the score. */
  first: { label: string; score: number }[]
  kept: number
  dropped: number
  ok: boolean
  error?: string
  ms: number
}

/** The least score kept by default: bge rerankers give unrelated texts well under this. */
export const DEFAULT_MIN_SCORE = 0.05
export const DEFAULT_CANDIDATES = 30

/**
 * The best `limit` items in reranker order, each with its score, dropping those under `minScore`. When the reranker
 * does not answer, the items keep the search's own order and `note` says so - a search never fails for it.
 */
export async function reorder<T>(
  reranking: Reranking,
  query: string,
  items: readonly T[],
  text: (item: T) => string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ items: { item: T; score?: number }[]; reranked: boolean; dropped: number; note?: string; ms: number }> {
  if (items.length === 0) return { items: [], reranked: false, dropped: 0, ms: 0 }
  const result = await reranking.scores(query, items.map(text), signal)
  const label = (item: T): string => (text(item).split('\n')[0] ?? '').slice(0, 80)
  if (!result.ok || result.scores === undefined) {
    reranking.report?.({ query, candidates: items.length, first: [], kept: Math.min(limit, items.length), dropped: 0, ok: false, error: result.error ?? 'no scores', ms: result.ms })
    return {
      items: items.slice(0, limit).map((item) => ({ item })),
      reranked: false,
      dropped: 0,
      note: `The reranker did not answer (${result.error ?? 'no scores'}), so these are in the search's own order.`,
      ms: result.ms,
    }
  }
  const scored = items.map((item, index) => ({ item, score: result.scores?.[index] ?? 0 }))
  scored.sort((a, b) => b.score - a.score)
  const kept = scored.filter((entry) => entry.score >= reranking.minScore)
  reranking.report?.({
    query,
    candidates: items.length,
    first: kept.slice(0, 5).map((entry) => ({ label: label(entry.item), score: entry.score })),
    kept: Math.min(limit, kept.length),
    dropped: scored.length - kept.length,
    ok: true,
    ms: result.ms,
  })
  return { items: kept.slice(0, limit), reranked: true, dropped: scored.length - kept.length, ms: result.ms }
}
