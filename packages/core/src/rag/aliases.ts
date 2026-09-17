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

/** The most aliases one index may carry. Matches the schema's own cap. */
export const MAX_ALIASES = 8

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

/**
 * Splits a list of names back into the two config keys that hold them.
 *
 * The counterpart of `merge` below, and deliberately in the same file. The singular key is what
 * earlier versions wrote and still read, so the first name goes there and the rest to the plural
 * one: a config saved by a newer build keeps working if somebody rolls back, and `codebaseAliases`
 * reassembles exactly the list that was typed, in order.
 *
 * That is the whole reason both spellings survive, and why writing them is one function rather
 * than something each caller works out — the shape this project has paid for more than any other
 * is one fact spelled two ways in two places. Here the split and the merge are four lines apart.
 *
 * An empty list clears both, which is how a name is removed.
 */
export function aliasFields(names: readonly string[]): {
  primary: string | undefined
  rest: string[] | undefined
} {
  const cleaned = merge(undefined, names)
  const [primary, ...rest] = cleaned
  return {
    primary,
    rest: rest.length > 0 ? rest : undefined,
  }
}

/**
 * The text of an alias list, for a one-line text field.
 *
 * Commas, matching `ask_user_form`'s `list` field — the one list-in-a-box convention this product
 * already has, so the two do not disagree about what a user is expected to type.
 */
export function formatAliases(names: readonly string[] | undefined): string {
  /*
   * Takes undefined on purpose. `SettingsNavigation.test.tsx` renders every tab with nothing
   * configured, and that path has now broken four times on a missing array — it is the state a
   * fresh install is actually in. An absent list and an empty one mean the same thing to a text
   * field, so there is nothing to distinguish and no reason to throw.
   */
  return (names ?? []).join(', ')
}

/** What somebody typed into that field. Split on commas *or* newlines, as `list` does. */
export function parseAliases(text: string): string[] {
  return merge(
    undefined,
    text.split(/[,\n]/).map((part) => part.trim()),
  )
}
