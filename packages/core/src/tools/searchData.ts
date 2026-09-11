import { z } from 'zod'

import type { Embedder } from '../rag/embedder.js'
import type { VectorSearcher } from '../rag/vectorStore.js'
import type { DatasetRecord } from '../dataset/types.js'
import type { Tool, ToolResult } from './types.js'

const searchSchema = z.object({
  dataset: z
    .string()
    .optional()
    .describe('Which dataset to search, by name. Omit to search all of them.'),
  query: z
    .string()
    .optional()
    .describe('Rank by meaning. Omit to get the most recent records in the window.'),
  withinDays: z
    .number()
    .min(0.01)
    .optional()
    .describe('Only records with a timestamp this recent. Records with no timestamp are excluded.'),
  contains: z
    .string()
    .optional()
    .describe('Only records whose title or text contains this text. Exact, case-insensitive.'),
  tag: z
    .string()
    .optional()
    .describe('Filter on a tag, as `name=value`. Exact.'),
  limit: z.number().int().min(1).max(50).optional().describe('How many to return. Default 15.'),
})
export type SearchDataParams = z.infer<typeof searchSchema>

export interface SearchDataOptions {
  /** Every configured dataset, with its records. Read fresh: a sync may have just finished. */
  load: () => Promise<{ id: string; name: string; records: DatasetRecord[] }[]>
  semantic?:
    | {
        searcher: VectorSearcher
        embedder: Embedder
        collection: string
      }
    | undefined
}

function describe(record: DatasetRecord, dataset: string): string {
  const when = record.timestamp === undefined ? '' : `${new Date(record.timestamp).toLocaleString()}  `
  const heading = record.title ?? record.text.trim().split('\n')[0]?.slice(0, 100) ?? record.id
  const body = record.text.trim().slice(0, 400)
  return (
    `${when}[${dataset}] ${heading}\n` +
    `    id: ${record.id}${record.url === undefined ? '' : `  ${record.url}`}\n` +
    `    ${body}`
  )
}

/**
 * Searching corpora the user collects themselves.
 *
 * ## Why the exact filters run before the ranking
 *
 * §12f's argument, unchanged: time and tags are **facts**, and a nearest-neighbour search answers
 * a factual question with something plausible, ranked, and wrong. So `withinDays`, `tag` and
 * `contains` narrow the set exactly, and a semantic query only *reorders* what they produced. A
 * window with nothing in it really is empty.
 *
 * ## Why a query with no embedder is matched on words
 *
 * Because dropping it silently is the failure this product has already shipped once: a query that
 * is ignored returns the newest records, which read as answers to a question nobody asked.
 */
export function createSearchDataTool(options: SearchDataOptions): Tool<SearchDataParams> {
  return {
    name: 'search_data',
    group: 'read',
    description:
      'Searches the custom datasets the user collects with their own Python tools — tickets, ' +
      'wiki pages, rows from an internal system, whatever they have set up. Use it whenever a ' +
      'question is about the organisation\'s own data rather than about this codebase. ' +
      '`dataset` picks one by name, `withinDays` and `tag` are exact filters applied before any ' +
      'ranking, and `query` ranks what is left by meaning. Call it with no arguments to see what ' +
      'is there. These are exact counts over what has been synced, not a live query against the ' +
      'source — so the answer is only as current as the last sync, which is reported.',
    parametersSchema: searchSchema,

    execute: async (params): Promise<ToolResult> => {
      try {
        const datasets = await options.load()
        if (datasets.length === 0) {
          return {
            content:
              'No custom datasets are configured, so there is nothing to search. The user sets ' +
              'these up in Settings → Custom data, by pointing at a Python tool that returns ' +
              'records. Say that rather than reporting that nothing was found.',
          }
        }

        const wanted =
          params.dataset === undefined
            ? datasets
            : datasets.filter((entry) => entry.name.toLowerCase() === params.dataset?.toLowerCase())

        if (wanted.length === 0) {
          return {
            content:
              `There is no dataset called "${params.dataset ?? ''}". Configured: ` +
              `${datasets.map((entry) => entry.name).join(', ')}.`,
            isError: true,
          }
        }

        let candidates = wanted.flatMap((entry) =>
          entry.records.map((record) => ({ dataset: entry.name, datasetId: entry.id, record })),
        )
        const narrowed: string[] = []

        if (params.withinDays !== undefined) {
          const cutoff = Date.now() - params.withinDays * 24 * 60 * 60 * 1000
          // Records with no timestamp are excluded rather than kept: "in the last 7 days" is a
          // claim about age, and something with no age cannot satisfy it.
          candidates = candidates.filter(
            (entry) => entry.record.timestamp !== undefined && entry.record.timestamp >= cutoff,
          )
          narrowed.push(`in the last ${String(params.withinDays)} day(s)`)
        }

        if (params.tag !== undefined) {
          const [name, value] = params.tag.split('=')
          candidates = candidates.filter((entry) =>
            value === undefined
              ? entry.record.tags?.[name ?? ''] !== undefined
              : entry.record.tags?.[name ?? ''] === value,
          )
          narrowed.push(`tagged ${params.tag}`)
        }

        if (params.contains !== undefined) {
          const needle = params.contains.toLowerCase()
          candidates = candidates.filter((entry) =>
            `${entry.record.title ?? ''}\n${entry.record.text}`.toLowerCase().includes(needle),
          )
          narrowed.push(`containing "${params.contains}"`)
        }

        const criteria = narrowed.length === 0 ? '' : `, ${narrowed.join(', ')}`
        if (candidates.length === 0) {
          return {
            content:
              `Nothing in ${wanted.map((entry) => entry.name).join(', ')}${criteria}. This is an ` +
              'exact answer over what has been synced — but it is only as current as the last sync.',
          }
        }

        const limit = params.limit ?? 15
        let ordered = candidates.sort(
          (a, b) => (b.record.timestamp ?? 0) - (a.record.timestamp ?? 0),
        )
        let how = ''

        const asked = params.query?.trim() ?? ''
        if (asked.length > 0 && options.semantic === undefined) {
          /*
           * Matched on words when there is no embedder, never ignored. A dropped query returns the
           * newest records, which the assistant then reports as matches — a confident wrong answer
           * that looks exactly like a right one.
           */
          const words = asked.toLowerCase().split(/\s+/).filter((word) => word.length > 2)
          const needle = asked.toLowerCase()
          candidates = candidates.filter((entry) => {
            const haystack = `${entry.record.title ?? ''}\n${entry.record.text}`.toLowerCase()
            return words.length === 0 ? haystack.includes(needle) : words.some((word) => haystack.includes(word))
          })
          if (candidates.length === 0) {
            return {
              content:
                `Nothing in ${wanted.map((entry) => entry.name).join(', ')}${criteria} mentions ` +
                `"${asked}". No embedding model is configured, so this was matched on words rather ` +
                'than meaning — something saying the same thing differently would not be found.',
            }
          }
          ordered = candidates
          how = ' matched on words, not meaning — no embedding model is configured'
        }

        if (asked.length > 0 && options.semantic !== undefined) {
          const vector = await options.semantic.embedder.embed(asked)
          const hits = await options.semantic.searcher.searchByVector(options.semantic.collection, vector, {
            size: Math.min(100, Math.max(limit * 4, 40)),
          })
          const rank = new Map<string, number>()
          hits.forEach((hit, position) => {
            if (!rank.has(hit.path)) rank.set(hit.path, position)
          })
          // Ranking, not filtering: anything the embedding missed stays, at the end, in time
          // order. A record the vector search happened to skip is still a record that matched.
          ordered = [...candidates].sort((a, b) => {
            const left = rank.get(`data:${a.datasetId}:${a.record.id}`)
            const right = rank.get(`data:${b.datasetId}:${b.record.id}`)
            if (left !== undefined && right !== undefined) return left - right
            if (left !== undefined) return -1
            if (right !== undefined) return 1
            return (b.record.timestamp ?? 0) - (a.record.timestamp ?? 0)
          })
          how = ' ranked by meaning'
        }

        const shown = ordered.slice(0, limit)
        return {
          content: [
            `${String(candidates.length)} record(s) in ` +
              `${wanted.map((entry) => entry.name).join(', ')}${criteria}${how}` +
              `${candidates.length > shown.length ? `, showing ${String(shown.length)}` : ''}:`,
            '',
            ...shown.map((entry) => describe(entry.record, entry.dataset)),
            '',
            'This is what has been synced, not a live query against the source. If the answer ' +
              'depends on something very recent, say when the dataset was last synced rather than ' +
              'implying it is current.',
          ].join('\n'),
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}
