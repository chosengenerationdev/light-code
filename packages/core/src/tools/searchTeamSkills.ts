import { z } from 'zod'

import { renderTeamSkillHits, searchTeamSkills, type TeamSkillsOptions } from '../rag/teamSkills.js'
import type { SearchObserver } from '../rag/searchLog.js'
import { resolveSearchScope, type DefaultSearchScope } from '../sharing/scope.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('What you want to know, in plain words — e.g. "how do we deploy the pricing service".'),
  size: z.number().int().min(1).max(10).optional().describe('How many to return. Default 5.'),
  project: z
    .string()
    .optional()
    .describe(
      'Which project to search. Omit for this project (plus skills with no project). Give a project ' +
        'name, exactly as skills are labelled, to search that one instead, or "all" when the user asks ' +
        'to look beyond this project.',
    ),
  author: z.string().optional().describe("Only this person's skills. Omit unless the user names somebody."),
})
export type SearchTeamSkillsParams = z.infer<typeof paramsSchema>

export interface SearchTeamSkillsToolOptions extends TeamSkillsOptions {
  observer?: SearchObserver
  /** This project's names, which the default search is limited to. See `sharing/scope.ts`. */
  currentProject?: () => readonly string[]
  /** The default chosen in Settings -> Project, for a request that names no project or author. */
  defaultScope?: () => DefaultSearchScope
}

/**
 * Reads what colleagues have taught their own copy of the assistant.
 *
 * The point is the knowledge that is *not* in this repository: how another team's service is
 * called, the convention nobody wrote down, the thing a new joiner is told once. Somebody has
 * already explained it to their assistant, and this is how that explanation travels.
 *
 * Unlike `search_codebase`, the result is the whole answer rather than a pointer. A colleague's
 * skill has no file on this machine, so the body is stored in the index and returned in full —
 * affordable because a skill is a page of prose rather than a repository.
 */
export function createSearchTeamSkillsTool(
  options: SearchTeamSkillsToolOptions,
): Tool<SearchTeamSkillsParams> {
  return {
    name: 'search_team_skills',
    group: 'read',
    description:
      "Search skills written by everyone on the team, not just this workspace. Use it for how " +
      'another team does something, an internal service you have not worked with, or a convention ' +
      'that is not written down here. Returns the full text — these have no file on this machine, ' +
      'so there is nothing to read_file afterwards. Check here before writing a skill that may ' +
      'already exist. Searches this project by default; pass project "all", another project, or an author when the user asks.',
    parametersSchema: paramsSchema,

    async execute(params): Promise<ToolResult> {
      const startedAt = Date.now()
      try {
        const scope = resolveSearchScope(params, options.currentProject?.() ?? [], options.defaultScope?.())
        const found = await searchTeamSkills(options, params.query, params.size ?? 5, undefined, scope)
        options.observer?.record({
          at: startedAt,
          source: 'search_team_skills',
          // The one that answered, not the one that was asked first — the log is evidence about
          // what happened, and a widened search is exactly what somebody would want to see.
          collection: found.collection ?? found.tried.join(' → '),
          query: params.query,
          hits: found.hits.length,
          elapsedMs: Date.now() - startedAt,
          via: 'index',
        })
        return { content: renderTeamSkillHits(found, params.query, scope) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        options.observer?.record({
          at: startedAt,
          source: 'search_team_skills',
          query: params.query,
          // Every name that would have been tried: the search failed before one could answer.
          collection: options.collections.join(' → '),
          hits: 0,
          elapsedMs: Date.now() - startedAt,
          error: message,
        })
        return { content: message, isError: true }
      }
    },
  }
}
