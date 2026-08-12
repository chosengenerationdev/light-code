import { z } from 'zod'
import {
  buildSearchQuery,
  checkIndexBreadth,
  resolveQueryLimits,
  summariseHit,
  type QueryLimits,
} from '../rag/opensearch/query.js'
import type { OpenSearchClient } from '../rag/opensearch/client.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  query: z.string().min(1).describe('What to search for, in plain words.'),
  index: z.string().optional().describe('Which index to search. Omit to use the connection default.'),
  filters: z
    .record(z.string(), z.string())
    .optional()
    .describe('Exact-match field filters, e.g. {"level":"ERROR"}. Only for fields you know exist.'),
  after: z.string().optional().describe('ISO timestamp; only documents newer than this.'),
  before: z.string().optional().describe('ISO timestamp; only documents older than this.'),
  size: z.number().int().min(1).max(100).optional().describe('How many results. Capped by the connection limit.'),
})
export type SearchOpensearchParams = z.infer<typeof paramsSchema>

export interface SearchOpensearchOptions {
  client: OpenSearchClient
  /** Label of the active connection, so previews and errors name it. */
  connectionLabel: string
  defaultIndex?: string
  /** Index names the model may search. Empty means any. */
  availableIndexes?: string[]
  /** Guard rails against a query that could hurt a production cluster. */
  limits?: QueryLimits | undefined
}

/**
 * Searches an OpenSearch index the organisation already runs — logs, tickets, documentation.
 *
 * Read-only: this tool can only run `_search`. Indexing goes through a separate path the
 * user starts, so no model action can create, modify or delete an index.
 *
 * The mapping is fetched before querying rather than guessed. A free-text query against an
 * index we did not design otherwise matches nothing useful, because the fields that exist
 * and their types are unknowable from the query alone.
 */
export function createSearchOpensearchTool(options: SearchOpensearchOptions): Tool<SearchOpensearchParams> {
  const describeIndexes =
    options.availableIndexes !== undefined && options.availableIndexes.length > 0
      ? ` Available indexes: ${options.availableIndexes.slice(0, 20).join(', ')}.`
      : ''

  return {
    name: 'search_opensearch',
    group: 'read',
    description:
      `Search the "${options.connectionLabel}" OpenSearch cluster for existing data — logs, ` +
      'tickets, documentation, or anything else indexed there. Not for searching this ' +
      `codebase; use search_files or search_codebase for that.` +
      (options.defaultIndex !== undefined ? ` Defaults to the "${options.defaultIndex}" index.` : '') +
      describeIndexes,
    parametersSchema: paramsSchema,
    async preview(params) {
      const index = params.index ?? options.defaultIndex ?? '(no index selected)'
      return {
        kind: 'text' as const,
        text: `Search ${options.connectionLabel} / ${index}\n\n${params.query}${
          params.filters !== undefined ? `\n\nFilters: ${JSON.stringify(params.filters)}` : ''
        }`,
      }
    },
    async execute(params, context): Promise<ToolResult> {
      const limits = resolveQueryLimits(options.limits)
      const index = params.index ?? options.defaultIndex
      if (index === undefined) {
        return {
          content:
            'No index was given and this connection has no default. Name an index, or set a default in Settings → Search.',
          isError: true,
        }
      }

      try {
        // Mapping first: it decides which fields are worth querying. A failure here is not
        // fatal — the query still runs, just less precisely.
        let mapping: Record<string, string> = {}
        try {
          mapping = await options.client.getMapping(index, context.signal)
        } catch {
          // Commonly a permissions issue on _mapping while _search is allowed.
        }

        const breadth = checkIndexBreadth(index, options.availableIndexes ?? [], limits.maxIndexes)
        if (!breadth.ok) return { content: breadth.reason, isError: true }

        const { body, guards } = buildSearchQuery(params.query, {
          limits,
          mapping,
          ...(params.filters !== undefined ? { filters: params.filters } : {}),
          ...(params.after !== undefined ? { after: params.after } : {}),
          ...(params.before !== undefined ? { before: params.before } : {}),
        })

        const result = await options.client.search(index, body, {
          // The model's request is a ceiling request, not a grant: the connection's cap wins.
          size: Math.min(params.size ?? limits.maxHits, limits.maxHits),
          ...(context.signal !== undefined ? { signal: context.signal } : {}),
        })

        if (result.hits.length === 0) {
          return {
            content: `No matches in "${index}" for: ${params.query}${
              Object.keys(mapping).length === 0 ? '\n\n(The index mapping could not be read, so the query may have been imprecise.)' : ''
            }`,
          }
        }

        const rendered = result.hits
          .map((hit, position) => `[${position + 1}] score ${hit.score.toFixed(2)}  id=${hit.id}\n${summariseHit(hit.source)}`)
          .join('\n\n---\n\n')

        // Guards are reported, never silent. A document that exists but falls outside an
        // imposed lookback would otherwise look like missing data rather than a bounded
        // search, and the model would confidently tell the user it is not there.
        const notes: string[] = []
        if (guards.lookbackHours !== undefined) {
          notes.push(
            `Only the last ${guards.lookbackHours}h were searched, because no time range was given. ` +
              'Ask for a specific range to look further back.',
          )
        }
        if (result.total >= 1000) notes.push('The match count is capped at 1000; the real total may be higher.')

        return {
          content: [
            `${result.hits.length} of ${result.total >= 1000 ? '1000+' : result.total} matches in "${index}" (${result.tookMs}ms):`,
            ...(notes.length > 0 ? notes.map((note) => `Note: ${note}`) : []),
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
