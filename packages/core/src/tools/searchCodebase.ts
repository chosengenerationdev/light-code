import { z } from 'zod'
import type { Embedder } from '../rag/embedder.js'
import type { SearchObserver } from '../rag/searchLog.js'
import type { VectorSearcher } from '../rag/vectorStore.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('What you are looking for, described in plain words — e.g. "where the retry backoff is calculated".'),
  size: z.number().int().min(1).max(25).optional().describe('How many results to return. Default 8.'),
  pathPrefix: z
    .string()
    .optional()
    .describe('Restrict to a subtree, e.g. "packages/core/src". Omit to search everything indexed.'),
})
export type SearchCodebaseParams = z.infer<typeof paramsSchema>

export interface SearchCodebaseOptions {
  /**
   * The read half of whichever backend is active. This tool is handed a searcher rather than
   * a client precisely because a searcher has no write method to call.
   */
  searcher: VectorSearcher
  embedder: Embedder
  index: string
  /** Shown in the "nothing indexed yet" message so the user knows where to look. */
  connectionLabel: string
  /** Records the query for the Search tab. A semantic miss is invisible without it. */
  observer?: SearchObserver
}

const DEFAULT_SIZE = 8

/**
 * Finds code by meaning rather than by name, over the index the user built.
 *
 * The point is the query `search_files` cannot answer: "where do we decide to retry" matches
 * nothing by regex when the code says `shouldAttemptAgain`. Ripgrep remains better whenever
 * the literal string is known, which is most of the time — this **supplements `read_file`
 * and `search_files`, it does not replace them.** A vector search misses silently, returning
 * plausible neighbours rather than nothing, so it must never be the only thing consulted
 * before concluding something does not exist.
 */
export function createSearchCodebaseTool(options: SearchCodebaseOptions): Tool<SearchCodebaseParams> {
  return {
    name: 'search_codebase',
    group: 'read',
    description:
      'Search the indexed codebase by meaning, for when you do not know the exact name. ' +
      'Returns file paths with line ranges and the matching text; follow up with read_file for full context. ' +
      'Prefer search_files when you know the literal string — this finds things that are similar, ' +
      'so an empty or weak result does not prove something is absent.',
    parametersSchema: paramsSchema,

    async execute(params): Promise<ToolResult> {
      const startedAt = Date.now()
      try {
        const size = params.size ?? DEFAULT_SIZE
        const vector = await options.embedder.embed(params.query)

        // The request shape is the backend's business, not this tool's — see `VectorSearcher`.
        const hits = await options.searcher.searchByVector(options.index, vector, {
          size,
          ...(params.pathPrefix !== undefined && params.pathPrefix.trim().length > 0
            ? { pathPrefix: params.pathPrefix.trim() }
            : {}),
        })

        options.observer?.record({
          at: startedAt,
          source: 'search_codebase',
          query: params.query,
          collection: options.index,
          hits: hits.length,
          elapsedMs: Date.now() - startedAt,
          via: 'index',
        })

        if (hits.length === 0) {
          return {
            content:
              `No indexed matches for: ${params.query}\n\n` +
              `The index "${options.index}" on ${options.connectionLabel} may be empty or out of date — ` +
              'indexing is started by the user from Settings → Search, not by you. ' +
              'Use search_files or list_files instead.',
          }
        }

        const rendered = hits
          .map((hit, position) => {
            const where = `${hit.path}:${hit.startLine ?? '?'}-${hit.endLine ?? '?'}`
            return `[${position + 1}] ${where}  (score ${hit.score.toFixed(3)})\n${hit.text}`
          })
          .join('\n\n---\n\n')

        return {
          content: [
            `${hits.length} match(es) by meaning for: ${params.query}`,
            // Said every time, because the failure mode is the model treating a weak
            // semantic hit as authoritative and never opening the file.
            'These are approximate. Read the files before relying on them, and use search_files if you know the exact term.',
            '',
            rendered,
          ].join('\n'),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Logged too: a search that failed is exactly the one worth seeing in the panel, and
        // the transcript only shows the model's reaction to it.
        options.observer?.record({
          at: startedAt,
          source: 'search_codebase',
          query: params.query,
          collection: options.index,
          hits: 0,
          elapsedMs: Date.now() - startedAt,
          error: message,
        })
        return { content: message, isError: true }
      }
    },
  }
}
