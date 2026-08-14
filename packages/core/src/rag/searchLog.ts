/**
 * A record of every search the model ran against an index.
 *
 * Retrieval is the one part of the product whose failures are *quiet*. A tool that errors says
 * so; a vector search that returns confident neighbours for a query it did not understand
 * looks exactly like a search that worked. The only way to judge it is to see the queries and
 * what came back, which is what this exists for.
 *
 * It also answers the question that is otherwise unanswerable from the transcript: whether a
 * result came from the index at all, or from the lexical fallback because the store was
 * unreachable. Those read identically in the chat.
 */

export type SearchLogSource = 'search_codebase' | 'search_docs' | 'search_opensearch'

export interface SearchLogEntry {
  at: number
  source: SearchLogSource
  /** What was asked, in the model's own words. */
  query: string
  /** The index or collection queried, where one applies. */
  collection?: string
  hits: number
  elapsedMs: number
  /**
   * Whether the vector index actually served this.
   *
   * `search_docs` falls back to matching names and descriptions when no store is configured
   * or the store failed, and the model cannot tell the difference — so this is the only place
   * a silently unused index becomes visible.
   */
  via?: 'index' | 'lexical'
  error?: string
}

export interface SearchObserver {
  record(entry: SearchLogEntry): void
}

/**
 * Bounded, and deliberately small.
 *
 * This is a diagnostic surface, not an audit log — §15's audit log is the durable record of
 * what was *executed*. Keeping searches in memory means they cost nothing on disk and vanish
 * with the session, which is the right lifetime for "why did that search miss?".
 */
export class SearchLog implements SearchObserver {
  private entries: SearchLogEntry[] = []

  constructor(
    private readonly limit = 50,
    private readonly onChanged?: () => void,
  ) {}

  record(entry: SearchLogEntry): void {
    // Newest first: the interesting query is almost always the last one.
    this.entries = [entry, ...this.entries].slice(0, this.limit)
    this.onChanged?.()
  }

  list(): readonly SearchLogEntry[] {
    return this.entries
  }

  clear(): void {
    this.entries = []
    this.onChanged?.()
  }
}
