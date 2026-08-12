/**
 * Turning a natural-language query into something an index we did not design will match.
 *
 * The naive approach — `{ query_string: { query: userText } }` — fails in two ways that
 * both look like "search is broken": it throws on punctuation the Lucene syntax reserves
 * (a colon, a slash, an unbalanced quote — all common in a real question), and it searches
 * every field including numeric and keyword ones where a free-text term never matches.
 *
 * So the mapping decides. Text fields are searched; everything else is left alone.
 */

/** Field types worth running a free-text query against. */
const TEXT_TYPES = new Set(['text', 'match_only_text', 'search_as_you_type', 'wildcard'])

/** Keyword fields are exact-match, but still useful for a short query with no spaces. */
const KEYWORD_TYPES = new Set(['keyword', 'constant_keyword'])

/**
 * Fields that are almost never what a human means, and which drown the results when
 * included. Matched on the leaf name so nesting does not matter.
 */
const NOISE_FIELDS = new Set(['@version', 'ecs', 'tags', 'stream', 'input', 'agent', 'host', 'event'])

function leafName(path: string): string {
  const parts = path.split('.')
  return parts[parts.length - 1] ?? path
}

export interface QueryFields {
  text: string[]
  keyword: string[]
}

/**
 * Picks searchable fields out of a mapping.
 *
 * A `text` field with a `.keyword` sub-field is extremely common; the parent is kept and
 * the sub-field dropped, since matching the analysed parent is what a free-text query wants.
 */
export function selectQueryFields(mapping: Record<string, string>, limit = 25): QueryFields {
  const text: string[] = []
  const keyword: string[] = []

  for (const [path, type] of Object.entries(mapping)) {
    if (NOISE_FIELDS.has(leafName(path)) || NOISE_FIELDS.has(path.split('.')[0] ?? '')) continue

    if (TEXT_TYPES.has(type)) {
      text.push(path)
    } else if (KEYWORD_TYPES.has(type)) {
      // Skip `title.keyword` when `title` is already a text field being searched.
      const parent = path.replace(/\.keyword$/, '')
      if (path.endsWith('.keyword') && TEXT_TYPES.has(mapping[parent] ?? '')) continue
      keyword.push(path)
    }
  }

  // Shorter paths first: top-level fields are usually the meaningful ones, and a mapping
  // with hundreds of fields would otherwise blow past the limit on nested detail.
  const byDepth = (a: string, b: string): number => a.split('.').length - b.split('.').length || a.localeCompare(b)
  return { text: text.sort(byDepth).slice(0, limit), keyword: keyword.sort(byDepth).slice(0, limit) }
}

/**
 * Defaults chosen to be safe on a large production cluster, not maximally capable.
 * Every one is raiseable per connection by someone who knows their own cluster.
 */
export const DEFAULT_QUERY_LIMITS = {
  maxHits: 10,
  timeoutSeconds: 10,
  terminateAfter: 10_000,
  maxIndexes: 5,
  defaultLookbackHours: 24,
  /**
   * Per *field* clip inside a hit. Separate from the whole-result cap the agent loop
   * applies: that one spills to disk and hands the model a re-read handle, whereas this
   * clip is unrecoverable, so it is the one worth raising for a log index whose messages
   * carry stack traces.
   */
  maxFieldChars: 500,
} as const

export type ResolvedQueryLimits = { -readonly [K in keyof typeof DEFAULT_QUERY_LIMITS]: number }

/**
 * Fills in the defaults, ignoring explicitly-undefined entries.
 *
 * A plain spread will not do: these come from a zod `.partial()` schema, so an absent field
 * is present-and-undefined and would overwrite the default with nothing.
 */
export function resolveQueryLimits(limits: QueryLimits | undefined): ResolvedQueryLimits {
  const resolved = { ...DEFAULT_QUERY_LIMITS } as ResolvedQueryLimits
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (typeof value === 'number') resolved[key as keyof ResolvedQueryLimits] = value
  }
  return resolved
}

/** Optional fields are explicitly `| undefined`: these come from a zod `.partial()` schema. */
export interface QueryLimits {
  maxHits?: number | undefined
  timeoutSeconds?: number | undefined
  terminateAfter?: number | undefined
  maxIndexes?: number | undefined
  defaultLookbackHours?: number | undefined
  maxFieldChars?: number | undefined
}

export interface BuildQueryOptions {
  /** Restricts the search to these fields, overriding what the mapping suggests. */
  fields?: string[]
  /** Extra term filters, e.g. `{ level: 'ERROR' }`. Applied as `filter`, so they do not score. */
  filters?: Record<string, string>
  /** ISO timestamps, applied to the first date field found. */
  after?: string
  before?: string
  mapping?: Record<string, string>
  limits?: QueryLimits
}

/** What the guards actually did, so the tool result can say so rather than hide it. */
export interface AppliedGuards {
  /** A lookback the user did not ask for, applied because the query was unbounded. */
  lookbackHours?: number
  timeoutSeconds: number
  terminateAfter: number
}

/**
 * Builds a `bool` query.
 *
 * `multi_match` rather than `query_string`: it treats the input as terms rather than as
 * Lucene syntax, so a question containing a colon or a quote searches instead of erroring.
 */
export function buildSearchQuery(
  text: string,
  options: BuildQueryOptions = {},
): { body: Record<string, unknown>; guards: AppliedGuards } {
  const mapping = options.mapping ?? {}
  const selected = options.fields !== undefined && options.fields.length > 0 ? options.fields : undefined

  const fields =
    selected ??
    (() => {
      const { text: textFields, keyword: keywordFields } = selectQueryFields(mapping)
      // A short query with no spaces is often an id or a status, where a keyword field is
      // exactly what matches. A sentence is not.
      const looksLikeToken = !text.includes(' ') && text.length <= 40
      return textFields.length > 0 ? [...textFields, ...(looksLikeToken ? keywordFields : [])] : keywordFields
    })()

  const must: Record<string, unknown>[] =
    text.trim().length === 0
      ? [{ match_all: {} }]
      : [
          fields.length > 0
            ? { multi_match: { query: text, fields, type: 'best_fields', operator: 'or', lenient: true } }
            : // No mapping available — `*` is a last resort, but `lenient` keeps a numeric
              // field from turning a text term into a hard error.
              { multi_match: { query: text, fields: ['*'], lenient: true } },
        ]

  const filter: Record<string, unknown>[] = []
  for (const [field, value] of Object.entries(options.filters ?? {})) {
    filter.push({ term: { [field]: value } })
  }

  if (options.after !== undefined || options.before !== undefined) {
    const dateField = Object.entries(mapping).find(([, type]) => type === 'date')?.[0]
    if (dateField !== undefined) {
      const range: Record<string, string> = {}
      if (options.after !== undefined) range.gte = options.after
      if (options.before !== undefined) range.lte = options.before
      filter.push({ range: { [dateField]: range } })
    }
  }

  const limits = resolveQueryLimits(options.limits)
  const guards: AppliedGuards = {
    timeoutSeconds: limits.timeoutSeconds,
    terminateAfter: limits.terminateAfter,
  }

  // An unbounded query over a log index is the expensive case, and the model will not
  // think to bound it. If the index has a date field and nothing constrained it, a
  // lookback is imposed — and reported, so a missing old document has a visible reason.
  const alreadyBounded = options.after !== undefined || options.before !== undefined
  if (!alreadyBounded && limits.defaultLookbackHours > 0) {
    const dateField = Object.entries(mapping).find(([, type]) => type === 'date')?.[0]
    if (dateField !== undefined) {
      filter.push({ range: { [dateField]: { gte: `now-${limits.defaultLookbackHours}h` } } })
      guards.lookbackHours = limits.defaultLookbackHours
    }
  }

  return {
    guards,
    body: {
      query: { bool: { must, ...(filter.length > 0 ? { filter } : {}) } },
      // Per-shard budget. A query that cannot finish in time returns what it has rather
      // than occupying the cluster indefinitely.
      timeout: `${limits.timeoutSeconds}s`,
      ...(limits.terminateAfter > 0 ? { terminate_after: limits.terminateAfter } : {}),
      // Counting every match forces a full traversal on a large index, and nobody needs an
      // exact figure. A bounded count reports "1000+" and stops there.
      track_total_hits: 1000,
    },
  }
}

/**
 * Refuses a pattern that would fan out across the cluster.
 *
 * A bare `*` or a broad prefix hits every shard of every matching index at once, which is
 * the read most likely to cause real trouble. Resolved against the known index list so the
 * refusal names the actual number rather than guessing from the string.
 */
export function checkIndexBreadth(
  pattern: string,
  knownIndexes: readonly string[],
  maxIndexes: number = DEFAULT_QUERY_LIMITS.maxIndexes,
): { ok: true; matched: string[] } | { ok: false; reason: string } {
  // Checked before the wildcard shortcut: `_all` contains no `*` and would otherwise slip
  // straight through as if it named a single index.
  if (maxIndexes > 0 && (pattern.trim() === '*' || pattern.trim() === '_all')) {
    return { ok: false, reason: 'Refusing to search every index at once. Name an index, or use a narrower pattern.' }
  }

  if (!pattern.includes('*')) return { ok: true, matched: [pattern] }
  if (maxIndexes === 0) return { ok: true, matched: [pattern] }

  const matcher = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)
  const matched = knownIndexes.filter((name) => matcher.test(name))

  // Unknown breadth: the index list could not be read, so the pattern is allowed through
  // rather than blocked on a guess. The other guards still bound the cost.
  if (knownIndexes.length === 0) return { ok: true, matched: [pattern] }

  if (matched.length > maxIndexes) {
    return {
      ok: false,
      reason:
        `"${pattern}" matches ${matched.length} indexes, over the limit of ${maxIndexes}. ` +
        `Narrow it, or raise the limit in Settings → Search. Matches include: ${matched.slice(0, 5).join(', ')}.`,
    }
  }
  return { ok: true, matched }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[]\]/g, String.raw`$&`)
}

/**
 * Condenses a hit for the model.
 *
 * A raw document can be hundreds of fields of infrastructure metadata. Sending them whole
 * burns the context window on noise the model did not ask for and cannot use, so long
 * values are clipped and empty ones dropped.
 */
export function summariseHit(
  source: Record<string, unknown>,
  maxFieldChars: number = DEFAULT_QUERY_LIMITS.maxFieldChars,
  onClip?: (field: string, fullLength: number) => void,
): string {
  const parts: string[] = []
  for (const [field, value] of Object.entries(source)) {
    if (value === null || value === undefined || value === '') continue
    const rendered = typeof value === 'string' ? value : JSON.stringify(value)
    if (rendered.length > maxFieldChars) {
      // Named, not a bare ellipsis. A clipped stack trace looks like a short one, and the
      // model cannot tell "the log says this" from "the log says this and 8KB more" —
      // which is how it ends up reporting a truncation it has no way to undo.
      onClip?.(field, rendered.length)
      parts.push(`${field}: ${rendered.slice(0, maxFieldChars)}… [clipped, ${rendered.length} chars total]`)
    } else {
      parts.push(`${field}: ${rendered}`)
    }
  }
  return parts.join('\n')
}
