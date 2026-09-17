import path from 'node:path'
import { z } from 'zod'
import { aliasForScope } from '../rag/aliases.js'
import type { Embedder } from '../rag/embedder.js'
import type { SearchObserver } from '../rag/searchLog.js'
import type { VectorSearcher } from '../rag/vectorStore.js'
import type { Tool, ToolExecutionContext, ToolResult } from './types.js'

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
  /*
   * A free string rather than an enum, because the scopes are whatever the user configured.
   *
   * An index may carry several aliases — a squad, a department, everyone — and each is a level of
   * sharing. The *description* names the ones that exist here, which is §12's carve-out: it varies
   * with a setting rather than with the turn, so the tool block stays byte-stable for a session
   * exactly as `ask_expert`'s does.
   */
  scope: z
    .string()
    .optional()
    .describe(
      'Whose code to search. "mine" (default) is this workspace only. Anything else names a ' +
        'shared scope — use it for "how did anyone solve X", never for questions about the code ' +
        'in front of you. Shared results are NOT on this machine and cannot be opened or edited.',
    ),
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
  /**
   * The name covering every team member's index, when one is configured.
   *
   * Absent means team scope is simply unavailable — on a backend with no alias concept, or an
   * install where nobody set one up. The tool says so rather than pretending.
   */
  /**
   * Every shared name this install can search, most specific first.
   *
   * Empty means shared scope is simply unavailable — a backend with no alias concept, or an
   * install where nobody set one up. The tool says so rather than pretending.
   */
  teamAliases?: readonly string[]
  /** Who this machine is, so "mine" stays "mine" even when the index is shared. */
  owner?: string
}

const DEFAULT_SIZE = 8

/**
 * What the model must be told about a hit it cannot open.
 *
 * The reported problem: searching a team index returns code that is not on this machine, and
 * the model then tries to read it, fails, and gets confused about what exists. So a result that
 * cannot be opened is marked as such and accompanied by this, every time.
 *
 * Note what it does *not* say: it does not tell the model to ignore those hits. They are the
 * entire point of a team search — they just have to be read as quotations rather than as files.
 */
const REMOTE_GUIDANCE = [
  'Some matches are from other people\'s indexed projects and are NOT on this machine.',
  'For anything marked NOT IN THIS WORKSPACE:',
  '- Do not call read_file, apply_diff or write_to_file on that path. It does not exist here,',
  '  and a failure to open it does not mean the code is missing or wrong.',
  '- The snippet shown is the whole of what you know about that file. Do not infer the rest.',
  '- If it is relevant, say which project and person it came from so the user can go and look.',
]

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
/**
 * Whether a hit names a file that actually exists in this workspace.
 *
 * **Asked of the filesystem, never inferred from the owner field.** Attribution is metadata: it
 * is absent on anything indexed before it existed, and wrong the moment two people configure
 * the same index name. Whether `read_file` will succeed is a fact about this disk, and twenty-
 * five stat calls is nothing.
 *
 * Three answers, not two. `undefined` means *could not check* — the Search tab runs this tool
 * with no filesystem, and marking every hit "NOT IN THIS WORKSPACE" there would be a confident
 * false statement of exactly the kind this function exists to prevent. Only a definite `false`
 * produces a warning.
 */
async function isPresentHere(
  relativePath: string,
  context: ToolExecutionContext | undefined,
): Promise<boolean | undefined> {
  // An indexed path is workspace-relative by construction, so anything else did not come from
  // a workspace walk and cannot be resolved against this one.
  if (path.isAbsolute(relativePath) || relativePath.includes('..')) return false
  const fileSystem = context?.fs
  const root = context?.workspaceRoot
  if (root === undefined || fileSystem === undefined || typeof fileSystem.exists !== 'function') {
    return undefined
  }
  try {
    return await fileSystem.exists(path.join(root, relativePath))
  } catch {
    return undefined
  }
}

/**
 * How a hit is labelled with where it came from.
 *
 * Says nothing at all for your own work, which is the overwhelming majority — a label on every
 * line would be noise that trains the model to stop reading them. An unattributed chunk is
 * reported as unknown rather than assumed to be yours: it predates attribution, and quietly
 * claiming it is the same class of mistake this is meant to prevent.
 */
export function describeOrigin(
  owner: string | undefined,
  project: string | undefined,
  self: string | undefined,
): string {
  if (owner === undefined && project === undefined) return ''
  if (owner !== undefined && self !== undefined && owner === self) {
    // Own work: the project still distinguishes two checkouts of yours from each other.
    return project === undefined ? '' : `  [${project}]`
  }
  const who = owner ?? 'unknown owner'
  return project === undefined ? `  [${who}]` : `  [${who} / ${project}]`
}

export function createSearchCodebaseTool(options: SearchCodebaseOptions): Tool<SearchCodebaseParams> {
  return {
    name: 'search_codebase',
    group: 'read',
    description:
      'Search the indexed codebase by meaning, for when you do not know the exact name. ' +
      'Returns file paths with line ranges and the matching text; follow up with read_file for full context. ' +
      'Prefer search_files when you know the literal string — this finds things that are similar, ' +
      'so an empty or weak result does not prove something is absent. ' +
      'scope:"team" also searches colleagues\' projects; those files are not on this machine ' +
      'and results say so — never try to open or edit them.',
    parametersSchema: paramsSchema,

    async execute(params, context): Promise<ToolResult> {
      const startedAt = Date.now()
      try {
        const size = params.size ?? DEFAULT_SIZE
        const requested = params.scope?.trim() ?? 'mine'
        const wantsTeam = requested.length > 0 && requested.toLowerCase() !== 'mine'
        /*
         * Which shared index the requested scope names. `team` means the first, so a single-alias
         * install behaves exactly as it did before scopes could be named.
         *
         * An unrecognised name resolves to nothing and is reported rather than guessed at: a
         * near-miss landing on a different circle would show somebody a group they are not in,
         * which is the one failure this must not have.
         */
        const alias = aliasForScope(requested, options.teamAliases ?? [])
        /*
         * A shared scope needs somewhere to look. Rather than fail, it degrades to this workspace
         * and *says so* — a dead end would leave the model with nothing, and silently searching
         * less than was asked is the version that produces a confident wrong "nobody has done
         * this before".
         */
        const teamUnavailable = wantsTeam && alias === undefined
        const searchingTeam = wantsTeam && alias !== undefined
        const collection = searchingTeam ? alias : options.index

        const vector = await options.embedder.embed(params.query)

        // The request shape is the backend's business, not this tool's — see `VectorSearcher`.
        const hits = await options.searcher.searchByVector(collection, vector, {
          size,
          ...(params.pathPrefix !== undefined && params.pathPrefix.trim().length > 0
            ? { pathPrefix: params.pathPrefix.trim() }
            : {}),
          /*
           * Narrowed to this machine's owner whenever we are not deliberately searching the
           * team. Applied even against our own index, because two checkouts can be configured
           * to share one — and "mine" that quietly includes a colleague's is the exact
           * confusion this whole change exists to remove.
           */
          ...(!searchingTeam && options.owner !== undefined ? { owner: options.owner } : {}),
        })

        options.observer?.record({
          at: startedAt,
          source: 'search_codebase',
          query: params.query,
          collection,
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

        /*
         * Whether each hit is a file that actually exists here.
         *
         * **Checked on disk, never inferred from the owner field.** Attribution is metadata and
         * can be stale, absent on anything indexed before it existed, or simply wrong if two
         * people configured the same index name. Whether `read_file` will work is a fact about
         * this filesystem, and it is cheap to just ask — twenty-five stats at the very most.
         *
         * This is invariant 8's habit applied to a search result: report the ground truth, not
         * the description of it.
         */
        const local = await Promise.all(hits.map(async (hit) => isPresentHere(hit.path, context)))

        const rendered = hits
          .map((hit, position) => {
            const where = `${hit.path}:${hit.startLine ?? '?'}-${hit.endLine ?? '?'}`
            const attribution = describeOrigin(hit.owner, hit.project, options.owner)
            // Only when it is *known* absent. Unknown says nothing — see `isPresentHere`.
            const marker = local[position] === false ? '  — NOT IN THIS WORKSPACE' : ''
            return `[${position + 1}] ${where}  (score ${hit.score.toFixed(3)})${attribution}${marker}\n${hit.text}`
          })
          .join('\n\n---\n\n')

        const anyRemote = local.some((present) => present === false)

        return {
          content: [
            `${hits.length} match(es) by meaning for: ${params.query}` +
              (searchingTeam ? ` (searched the whole team's indexes)` : ''),
            // Said every time, because the failure mode is the model treating a weak
            // semantic hit as authoritative and never opening the file.
            'These are approximate. Read the files before relying on them, and use search_files if you know the exact term.',
            ...(teamUnavailable
              ? [
                  '',
                  /*
                   * Which it was matters: nothing configured is a different thing to fix from a
                   * scope that was misspelled, and naming the ones that exist turns a dead end
                   * into a retry the model can get right.
                   */
                  (options.teamAliases ?? []).length === 0
                    ? 'A shared scope was asked for but none is configured, so only this ' +
                      'workspace was searched. Do not conclude from this that no colleague has ' +
                      'solved it — their work was not looked at.'
                    : `There is no shared scope called "${requested}". The ones configured here ` +
                      `are: ${(options.teamAliases ?? []).join(', ')}. Only this workspace was ` +
                      'searched, so do not conclude that no colleague has solved it.',
                ]
              : []),
            ...(anyRemote ? ['', ...REMOTE_GUIDANCE] : []),
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
