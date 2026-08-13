import type { HttpClient } from '../platform/http.js'
import { describeTlsError } from '../providers/auth/apigeeMtls.js'
import type { AuthStrategy, ProviderProfile } from '../providers/types.js'

/**
 * Embeddings over an existing provider profile.
 *
 * The profile supplies the base URL, the auth strategy, the client certificate and the CA.
 * A gateway already proven for chat — including mutual TLS, which took a phase to get right
 * — is therefore proven for embeddings, and there is only one place to configure it rather
 * than two that can drift.
 *
 * Requests go through `HttpClient` like everything else (invariant 2).
 */

export interface EmbedderConfig {
  /** The profile whose URL and credentials to borrow. */
  profile: ProviderProfile
  auth: AuthStrategy
  model: string
  /**
   * Vector width. Required, because the OpenSearch `knn_vector` mapping fixes it at index
   * creation — discovering it from the first response would mean creating the index only
   * after embedding something, and getting it wrong means every later write is rejected.
   */
  dimensions: number
}

export class EmbedderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmbedderError'
  }
}

/**
 * How many texts go in one request.
 *
 * Deliberately modest: a gateway that accepts 2048 inputs from OpenAI may cap far lower,
 * and a rejected batch of 500 wastes far more than a rejected batch of 32. Tuning up is a
 * later optimisation with a measurable payoff; guessing high now just produces failures at
 * a customer site.
 */
const DEFAULT_BATCH_SIZE = 32

export class Embedder {
  constructor(
    private readonly http: HttpClient,
    private readonly config: EmbedderConfig,
    private readonly batchSize = DEFAULT_BATCH_SIZE,
  ) {}

  get dimensions(): number {
    return this.config.dimensions
  }

  /** Recorded in the index manifest: a different model makes every stored vector stale. */
  get model(): string {
    return this.config.model
  }

  /** Embeds one text. Convenience over `embedBatch` for the query side. */
  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const [vector] = await this.embedBatch([text], signal)
    if (vector === undefined) throw new EmbedderError('The embedding endpoint returned no vector.')
    return vector
  }

  /**
   * Embeds several texts, in batches.
   *
   * Order is preserved and asserted: the response is sorted by its own `index` field rather
   * than trusted to arrive in order. A silently reordered batch would attach every chunk's
   * vector to the wrong chunk, which produces a corpus that returns confident nonsense and
   * gives no clue where the fault is.
   */
  async embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const vectors: number[][] = []

    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize)
      vectors.push(...(await this.embedOneBatch(batch, signal)))
    }
    return vectors
  }

  private async embedOneBatch(batch: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const url = `${this.config.profile.baseUrl.replace(/\/+$/, '')}/embeddings`

    let response
    try {
      const headers = await this.config.auth.resolveHeaders()
      const tls = await this.config.auth.tls?.()
      response = await this.http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers, ...this.config.profile.headers },
        body: JSON.stringify({ model: this.config.model, input: batch }),
        ...(signal !== undefined ? { signal } : {}),
        ...(tls !== undefined ? { tls } : {}),
      })
    } catch (error) {
      throw new EmbedderError(`Could not reach the embedding endpoint at ${url}: ${describeTlsError(error)}`)
    }

    if (response.status < 200 || response.status >= 300) {
      const body = await response.text().catch(() => '')
      throw new EmbedderError(
        `The embedding endpoint at ${url} returned HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
      )
    }

    const payload = (await response.json()) as { data?: unknown }
    if (!Array.isArray(payload.data)) {
      throw new EmbedderError(`The embedding endpoint at ${url} returned no "data" array.`)
    }

    const entries = payload.data
      .map((raw, position) => {
        const entry = raw as { index?: unknown; embedding?: unknown }
        return {
          index: typeof entry.index === 'number' ? entry.index : position,
          embedding: Array.isArray(entry.embedding) ? (entry.embedding as number[]) : undefined,
        }
      })
      .sort((a, b) => a.index - b.index)

    if (entries.length !== batch.length) {
      throw new EmbedderError(
        `Asked the embedding endpoint for ${batch.length} vectors and got ${entries.length}. ` +
          'Refusing to continue rather than risk pairing vectors with the wrong text.',
      )
    }

    return entries.map((entry, position) => {
      if (entry.embedding === undefined) {
        throw new EmbedderError(`The embedding endpoint returned no vector for input ${position}.`)
      }
      /*
       * Every element must be a finite number, not merely present.
       *
       * `JSON.stringify([1, NaN, 3])` yields `[1,null,3]`, so a single NaN — or a null the
       * endpoint returned inside the array — reaches OpenSearch as a null and is rejected
       * with "failed to parse field [vector] of type [knn_vector] ... preview of field's
       * value: null". That message points at the mapping, which is the wrong place to look,
       * and the actual culprit is one bad float among a thousand good ones.
       */
      const badAt = entry.embedding.findIndex((value) => typeof value !== 'number' || !Number.isFinite(value))
      if (badAt !== -1) {
        throw new EmbedderError(
          `"${this.config.model}" returned a vector containing ${String(entry.embedding[badAt])} at position ${badAt}. ` +
            'A non-numeric value becomes null once serialised and the index rejects the whole document. ' +
            'This usually means the embedding endpoint failed for that input rather than erroring outright — ' +
            'check the gateway logs for the batch it was in.',
        )
      }
      if (entry.embedding.length !== this.config.dimensions) {
        // Caught here rather than at write time: OpenSearch rejects a wrong-width vector
        // with a message about the mapping, which sends people to the wrong problem.
        throw new EmbedderError(
          `"${this.config.model}" returned ${entry.embedding.length}-dimensional vectors, but the index ` +
            `is configured for ${this.config.dimensions}. Correct the dimensions in Settings → Search, ` +
            'then re-index — an existing index cannot change its vector width.',
        )
      }
      return entry.embedding
    })
  }
}
