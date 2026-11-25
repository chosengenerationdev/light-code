import { z } from 'zod'

import {
  describeHidden,
  describeSearchScope,
  inSearchScope,
  resolveSearchScope,
  type DefaultSearchScope,
  type SearchScope,
} from '../sharing/scope.js'
import type { Embedder } from '../rag/embedder.js'
import { parseDocEntryId, schemaForTool, type DocEntryKind } from '../rag/toolDocs.js'
import type { SearchObserver } from '../rag/searchLog.js'
import type { VectorSearcher } from '../rag/vectorStore.js'
import type { Skill } from '../skills/index.js'
import { reorder, type Reranking } from '../rerank/rerank.js'
import type { Tool, ToolResult } from './types.js'

/**
 * Finds a tool or skill that was not described in the prompt, and returns enough to use it.
 *
 * This is the retrieval half of the dispatcher (see `tools/callTool.ts`). Tool schemas are
 * kept out of the prompt so the cache prefix does not grow with the catalogue; this is how
 * the model gets one back, as a tool *result*, mid-conversation, where it costs nothing at
 * the prefix.
 *
 * ## Two sources, deliberately
 *
 * **Matching** uses the vector index when one is configured — that is what makes "where do
 * we upload a report" reach `confluence__create_page`.
 *
 * **The schema returned always comes from the live registry.** An index is a snapshot, and a
 * server that restarted with a changed signature would otherwise hand the model arguments
 * that no longer validate, failing at a point that says nothing about the real cause.
 *
 * ## It degrades rather than disappearing
 *
 * With no vector store configured — or with one that is down, or empty — this falls back to
 * a lexical scan over the live registry. That fallback is not a nicety: without it, enabling
 * the dispatcher without an index would make every hidden tool permanently unreachable, and
 * the failure would look like the tools had vanished.
 */

const paramsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('What you need, in plain words — e.g. "upload a file to object storage" or "our deployment process".'),
  limit: z.number().int().min(1).max(15).optional().describe('How many to return. Default 5.'),
  kind: z.enum(['tool', 'skill']).optional().describe('Restrict to tools or to skills. Omit for both.'),
  project: z
    .string()
    .optional()
    .describe(
      'Which project to search. Omit for this project (plus anything with no project). Give a ' +
        'project name to search that one instead, or "all" when the user asks to look beyond this project.',
    ),
  author: z.string().optional().describe('Only skills and tools by this author. Omit unless the user names somebody.'),
})
export type SearchDocsParams = z.infer<typeof paramsSchema>

export interface SearchDocsOptions {
  /** Ground truth for schemas, and the fallback corpus. Resolved per call, never captured stale. */
  listTools: () => readonly Tool[]
  listSkills?: () => readonly Skill[]
  /** Absent when no vector store is configured — the tool still works, lexically. */
  retrieval?: {
    searcher: VectorSearcher
    embedder: Embedder
    index: string
  }
  /**
   * Records the query for the Search tab.
   *
   * This tool matters more than the others here: it silently falls back to lexical matching,
   * and the model cannot tell the difference. Without the log, an index that is configured
   * but never actually consulted looks exactly like one that is working.
   */
  observer?: SearchObserver
  /**
   * Whether the caller may actually invoke a tool it finds here.
   *
   * Absent means everything found is callable, which is the chat. A **scheduled run** is the
   * case this exists for: its tools are an allowlist, so it can find a tool it was never
   * granted — and discovering that by calling it and being refused wastes a step and produces a
   * report that reads like a failure. Told up front, it can say "this needs X, which this
   * schedule may not use" instead, which is the useful answer.
   *
   * Deliberately annotates rather than filters. A run that cannot see the tool at all cannot
   * explain what it would have needed.
   */
  accessibleTo?: (toolName: string) => boolean
  /**
   * This project's names — the configured one and the folder's — which the default search is
   * limited to. Absent or empty means every project, as before. See `sharing/scope.ts`.
   */
  currentProject?: () => readonly string[]
  /** The default chosen in Settings -> Project, for a request that names no project or author. */
  defaultScope?: () => DefaultSearchScope
  /**
   * A reranker (rerank/rerank.ts). With an index it reorders the index's candidates; without one it ranks every tool
   * and skill on its name and description, in place of the plain word match.
   */
  reranking?: Reranking
}

const DEFAULT_LIMIT = 5
/** Without an index, at most this many tools and skills are given to the reranker. */
const RERANK_ALL_LIMIT = 400

interface Candidate {
  kind: DocEntryKind
  name: string
  /** The reranker's score, when one put this in order. */
  relevance?: number
}

/**
 * Word-overlap scoring over names and descriptions.
 *
 * Deliberately crude. It is the safety net for "no index configured", not a competitor to
 * embeddings, and something obvious and predictable beats something clever that fails in
 * ways nobody can reproduce.
 */
function lexicalRank(query: string, candidates: { candidate: Candidate; haystack: string }[], limit: number): Candidate[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2)

  return candidates
    .map(({ candidate, haystack }) => {
      const text = haystack.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (text.includes(term)) score += 1
        // A hit in the name is worth more than one buried in prose.
        if (candidate.name.toLowerCase().includes(term)) score += 2
      }
      return { candidate, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.candidate)
}

function renderTool(tool: Tool, accessible: boolean): string {
  return [
    `### tool: ${tool.name}`,
    tool.description,
    '',
    'Parameters (JSON Schema):',
    '```json',
    JSON.stringify(schemaForTool(tool), null, 2),
    '```',
    accessible
      ? `Call it with: call_tool({"name": "${tool.name}", "arguments": { ... }})`
      : 'NOT AVAILABLE in this run: this schedule was not granted this tool, so calling it ' +
        'would be refused. Work around it, or report that it was needed and should be ticked.',
  ].join('\n')
}

function renderSkill(skill: Skill): string {
  return [
    `### skill: ${skill.name}`,
    skill.description,
    `Read the full text with read_file: ${skill.filePath}`,
  ].join('\n')
}

export function createSearchDocsTool(options: SearchDocsOptions): Tool<SearchDocsParams> {
  return {
    name: 'search_docs',
    group: 'read',
    description:
      'Find a tool or skill that is not described above, and get its exact parameters. ' +
      'Most tools are deliberately not listed in this prompt; search here first whenever the ' +
      'listed tools cannot do what you need, then invoke what you find with call_tool. ' +
      'Also finds skills — project knowledge written down for you.',
    parametersSchema: paramsSchema,

    async execute(params): Promise<ToolResult> {
      const startedAt = Date.now()
      try {
        const { matches, via, note, hidden, scope, reranked } = await runDocsSearch(options, params)
        const leftOut = describeHidden(hidden, scope)

        options.observer?.record({
          at: startedAt,
          source: 'search_docs',
          query: params.query,
          ...(options.retrieval !== undefined ? { collection: options.retrieval.index } : {}),
          hits: matches.length,
          elapsedMs: Date.now() - startedAt,
          via,
          ...(note !== undefined ? { error: note } : {}),
        })

        if (matches.length === 0) {
          return {
            content: [
              `Nothing matched in ${describeSearchScope(scope)}: ${params.query}`,
              note ?? '',
              leftOut,
              'Try different words, or drop the `kind` filter. The tools listed in your prompt are ' +
                'always available directly and are not returned here.',
            ]
              .filter((line) => line.length > 0)
              .join('\n'),
          }
        }

        return {
          content: [
            `${matches.length} match(es) in ${describeSearchScope(scope)} for: ${params.query}`,
            note ?? '',
            leftOut,
            // Stated because the two paths rank very differently, and a lexical result that
            // looks like a semantic one hides the fact that the index is not being used.
            via === 'lexical' && reranked !== true ? '(Matched on names and descriptions, not by meaning.)' : '',
            via === 'lexical' && reranked === true ? '(Ranked by the reranker on names and descriptions; there is no index.)' : '',
            '',
            renderDocsMatches(options, matches),
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        options.observer?.record({
          at: startedAt,
          source: 'search_docs',
          query: params.query,
          ...(options.retrieval !== undefined ? { collection: options.retrieval.index } : {}),
          hits: 0,
          elapsedMs: Date.now() - startedAt,
          error: message,
        })
        return { content: message, isError: true }
      }
    },
  }
}

/**
 * Split out from the tool so the Search tab can run exactly the query the model would, and
 * show the same ranking. A panel that approximates the real path is worse than none — it
 * proves something, just not the thing being debugged.
 */
export async function runDocsSearch(
  options: SearchDocsOptions,
  params: SearchDocsParams,
  signal?: AbortSignal,
): Promise<{ matches: Candidate[]; via: 'index' | 'lexical'; note?: string; hidden: number; scope: SearchScope; reranked?: boolean }> {
  const limit = params.limit ?? DEFAULT_LIMIT
  const tools = options.listTools()
  const skills = options.listSkills?.() ?? []
  const scope = resolveSearchScope(params, options.currentProject?.() ?? [], options.defaultScope?.())
  let hidden = 0

  const wanted = (kind: DocEntryKind): boolean => params.kind === undefined || params.kind === kind
  /*
   * Judged against the live tool or skill, not the index: the labels are in the files, so a
   * skill relabelled a minute ago is scoped correctly without waiting for a reindex.
   */
  const inScope = (candidate: Candidate): boolean => {
    if (candidate.kind === 'skill') {
      const skill = skills.find((entry) => entry.name === candidate.name)
      return skill === undefined || inSearchScope(skill, scope)
    }
    const tool = tools.find((entry) => entry.name === candidate.name)
    return tool === undefined || inSearchScope(tool, scope, tool.name.startsWith('py__'))
  }
  const filtering = scope.projects !== undefined || scope.author !== undefined
  /*
   * What the reranker reads for each candidate: what a model would read to decide whether it fits - the name, the
   * description, and for a tool its parameter names.
   */
  const docText = (candidate: Candidate): string => {
    if (candidate.kind === 'skill') {
      const skill = skills.find((entry) => entry.name === candidate.name)
      return `${candidate.name}\n${skill?.description ?? ''}`
    }
    const tool = tools.find((entry) => entry.name === candidate.name)
    let properties: Record<string, unknown> | undefined
    try {
      properties = tool === undefined ? undefined : (schemaForTool(tool) as { properties?: Record<string, unknown> } | undefined)?.properties
    } catch {
      properties = undefined
    }
    const parameters = properties !== undefined ? Object.keys(properties).join(', ') : ''
    return `${candidate.name}\n${tool?.description ?? ''}${parameters.length > 0 ? `\nParameters: ${parameters}` : ''}`
  }
  const wantedCount = options.reranking !== undefined ? Math.max(limit, options.reranking.candidates) : limit

  if (options.retrieval !== undefined) {
    try {
      const vector = await options.retrieval.embedder.embed(params.query, signal)
      const hits = await options.retrieval.searcher.searchByVector(options.retrieval.index, vector, {
        // Over-fetch: hits for tools that have since disappeared, or from another project, are
        // dropped below, and asking for exactly `limit` would quietly return fewer than requested.
        size: Math.max(wantedCount * (filtering ? 8 : 3), 10),
        ...(signal !== undefined ? { signal } : {}),
      })

      const matches: Candidate[] = []
      const seen = new Set<string>()
      for (const hit of hits) {
        const parsed = parseDocEntryId(hit.path)
        if (parsed === undefined || seen.has(hit.path) || !wanted(parsed.kind)) continue
        // Resolved against the live registry, so an entry for a tool that no longer exists
        // is dropped rather than offered and then failing at call_tool.
        const exists =
          parsed.kind === 'tool'
            ? tools.some((tool) => tool.name === parsed.name)
            : skills.some((skill) => skill.name === parsed.name)
        if (!exists) continue
        seen.add(hit.path)
        if (!inScope(parsed)) {
          hidden += 1
          continue
        }
        matches.push(parsed)
        if (matches.length >= wantedCount) break
      }

      if (matches.length > 0 && options.reranking !== undefined) {
        const ordered = await reorder(options.reranking, params.query, matches, docText, limit, signal)
        return {
          matches: ordered.items.map((entry) => (entry.score !== undefined ? { ...entry.item, relevance: entry.score } : entry.item)),
          via: 'index',
          hidden,
          scope,
          reranked: ordered.reranked,
          ...(ordered.note !== undefined ? { note: ordered.note } : ordered.dropped > 0 ? { note: `The reranker set aside ${String(ordered.dropped)} weak match(es).` } : {}),
        }
      }
      if (matches.length > 0) return { matches: matches.slice(0, limit), via: 'index', hidden, scope }
      // An empty index is indistinguishable from a genuinely unmatched query, and the
      // lexical pass is cheap, so fall through rather than reporting nothing.
    } catch (error) {
      return {
        ...lexicalResult(),
        hidden,
        scope,
        note: `The documentation index could not be searched (${error instanceof Error ? error.message : String(error)}), so this is a name and description match instead.`,
      }
    }
  }

  hidden = 0
  /*
   * No index (or nothing in it): with a reranker, every tool and skill in scope is ranked on its name and description
   * - far better than matching words. When it does not answer, the word match as before.
   */
  if (options.reranking !== undefined) {
    const all: Candidate[] = []
    if (wanted('tool')) for (const tool of tools) all.push({ kind: 'tool', name: tool.name })
    if (wanted('skill')) for (const skill of skills) all.push({ kind: 'skill', name: skill.name })
    const inside = all.filter((candidate) => inScope(candidate))
    const ordered = await reorder(options.reranking, params.query, inside.slice(0, RERANK_ALL_LIMIT), docText, limit, signal)
    if (ordered.reranked) {
      return {
        matches: ordered.items.map((entry) => ({ ...entry.item, ...(entry.score !== undefined ? { relevance: entry.score } : {}) })),
        via: 'lexical',
        hidden: all.length - inside.length,
        scope,
        reranked: true,
      }
    }
    return { ...lexicalResult(), hidden, scope, ...(ordered.note !== undefined ? { note: ordered.note } : {}) }
  }
  return { ...lexicalResult(), hidden, scope }

  function lexicalResult(): { matches: Candidate[]; via: 'lexical' } {
    const haystacks: { candidate: Candidate; haystack: string }[] = []
    if (wanted('tool')) {
      for (const tool of tools) {
        haystacks.push({ candidate: { kind: 'tool', name: tool.name }, haystack: `${tool.name} ${tool.description}` })
      }
    }
    if (wanted('skill')) {
      for (const skill of skills) {
        haystacks.push({ candidate: { kind: 'skill', name: skill.name }, haystack: `${skill.name} ${skill.description}` })
      }
    }
    const ranked = lexicalRank(params.query, haystacks, haystacks.length)
    const kept = ranked.filter((candidate) => inScope(candidate))
    hidden = ranked.length - kept.length
    return { matches: kept.slice(0, limit), via: 'lexical' }
  }
}

/** Renders matches using the live registry, so a schema is never served from a snapshot. */
export function renderDocsMatches(options: SearchDocsOptions, matches: readonly Candidate[]): string {
  const tools = new Map(options.listTools().map((tool) => [tool.name, tool]))
  const skills = new Map((options.listSkills?.() ?? []).map((skill) => [skill.name, skill]))

  return matches
    .map((match) => {
      if (match.kind === 'tool') {
        const tool = tools.get(match.name)
        if (tool === undefined) return undefined
        return withRelevance(renderTool(tool, options.accessibleTo?.(tool.name) ?? true), match.relevance)
      }
      const skill = skills.get(match.name)
      return skill !== undefined ? withRelevance(renderSkill(skill), match.relevance) : undefined
    })
    .filter((rendered): rendered is string => rendered !== undefined)
    .join('\n\n')
}

/** A match's heading with the reranker's score after it, when it has one. */
function withRelevance(rendered: string, relevance: number | undefined): string {
  if (relevance === undefined) return rendered
  const end = rendered.indexOf('\n')
  return end < 0 ? `${rendered}  (relevance ${relevance.toFixed(3)})` : `${rendered.slice(0, end)}  (relevance ${relevance.toFixed(3)})${rendered.slice(end)}`
}
