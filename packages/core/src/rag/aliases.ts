import type { LightCodeConfig } from '../config/schema.js'

/**
 * Which names an index answers to, and therefore which scopes exist.
 *
 * ## Why more than one
 *
 * An alias is a label on an index, and an index may carry several. That is what makes *levels* of
 * sharing possible rather than one shared pool: the same codebase index can be reachable as
 * `my-squad`, as `platform-team` and as `everyone`, and a colleague searching `my-squad` sees only
 * the people who attached that label. Without this there is exactly one circle and everybody is
 * either in it or out of it.
 *
 * ## Why the old singular key is still read
 *
 * Because it is what earlier versions wrote, and what a hand-edited config may still carry. It is
 * read *through here* and nowhere else — one owner, so the two spellings cannot drift, which is
 * the same arrangement `expert/assessments.ts` uses for the assessment it replaced.
 *
 * ## Why order is kept
 *
 * The first is the default. A model asking for "team" without naming a scope gets it, and a
 * configuration that lists `my-squad` before `everyone` is saying which is the ordinary one.
 */

/** Every name the codebase index answers to, most specific first, deduplicated. */
export function codebaseAliases(config: LightCodeConfig | undefined): string[] {
  return merge(config?.embedder?.indexAlias, config?.embedder?.indexAliases)
}

/** Every name the skills collection answers to. */
export function skillAliases(config: LightCodeConfig | undefined): string[] {
  return merge(config?.embedder?.skillsAlias, config?.embedder?.skillsAliases)
}

/**
 * The alias a requested scope means, or undefined when the scope is not one of them.
 *
 * `team` is accepted as a synonym for the first, so a configuration with one alias behaves exactly
 * as it did before this existed and nothing that already worked has to be retyped. Matching is
 * exact otherwise: a near-miss resolving to the wrong circle would show somebody a group they were
 * not in, which is the one failure this must not have.
 */
export function aliasForScope(scope: string, aliases: readonly string[]): string | undefined {
  const wanted = scope.trim().toLowerCase()
  if (wanted.length === 0 || wanted === 'mine') return undefined
  if (wanted === 'team') return aliases[0]
  return aliases.find((alias) => alias.toLowerCase() === wanted)
}

function merge(single: string | undefined, many: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const value of [single, ...(many ?? [])]) {
    const trimmed = value?.trim()
    if (trimmed === undefined || trimmed.length === 0) continue
    if (!out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) out.push(trimmed)
  }
  return out
}
