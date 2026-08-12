import { z } from 'zod'
import type { OpenSearchClient } from '../rag/opensearch/client.js'
import type { Embedder } from '../rag/embedder.js'
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
  client: OpenSearchClient
  embedder: Embedder
  index: string
  /** Shown in the "nothing indexed yet" message so the user knows where to look. */
  connectionLabel: string
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
      try {
        const size = params.size ?? DEFAULT_SIZE
        const vector = await options.embedder.embed(params.query)

        /*
         * k is the number of neighbours the engine considers per shard, and it must be at
         * least the number of hits wanted or the filter can leave fewer than requested.
         * `_source` excludes the vector: returning a 1024-float array per hit is many times
         * the size of the code it describes and is of no use to the model.
         */
        const knn: Record<string, unknown> = {
          _source: { excludes: ['vector'] },
          query: {
            knn: {
              vector: {
                vector,
                k: Math.max(size, 10),
                ...(params.pathPrefix !== undefined && params.pathPrefix.trim().length > 0
                  ? { filter: { prefix: { path: params.pathPrefix.trim() } } }
                  : {}),
              },
            },
          },
        }

        const result = await options.client.search(options.index, knn, { size })

        if (result.hits.length === 0) {
          return {
            content:
              `No indexed matches for: ${params.query}\n\n` +
              `The index "${options.index}" on ${options.connectionLabel} may be empty or out of date — ` +
              'indexing is started by the user from Settings → Search, not by you. ' +
              'Use search_files or list_files instead.',
          }
        }

        const rendered = result.hits
          .map((hit, position) => {
            const source = hit.source as { path?: unknown; startLine?: unknown; endLine?: unknown; text?: unknown }
            const where =
              typeof source.path === 'string'
                ? `${source.path}:${String(source.startLine ?? '?')}-${String(source.endLine ?? '?')}`
                : hit.id
            return `[${position + 1}] ${where}  (score ${hit.score.toFixed(3)})\n${String(source.text ?? '')}`
          })
          .join('\n\n---\n\n')

        return {
          content: [
            `${result.hits.length} match(es) by meaning for: ${params.query}`,
            // Said every time, because the failure mode is the model treating a weak
            // semantic hit as authoritative and never opening the file.
            'These are approximate. Read the files before relying on them, and use search_files if you know the exact term.',
            '',
            rendered,
          ].join('\n'),
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}
