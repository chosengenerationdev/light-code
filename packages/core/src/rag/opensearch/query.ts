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

export interface BuildQueryOptions {
  /** Restricts the search to these fields, overriding what the mapping suggests. */
  fields?: string[]
  /** Extra term filters, e.g. `{ level: 'ERROR' }`. Applied as `filter`, so they do not score. */
  filters?: Record<string, string>
  /** ISO timestamps, applied to the first date field found. */
  after?: string
  before?: string
  mapping?: Record<string, string>
}

/**
 * Builds a `bool` query.
 *
 * `multi_match` rather than `query_string`: it treats the input as terms rather than as
 * Lucene syntax, so a question containing a colon or a quote searches instead of erroring.
 */
export function buildSearchQuery(text: string, options: BuildQueryOptions = {}): Record<string, unknown> {
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

  return { query: { bool: { must, ...(filter.length > 0 ? { filter } : {}) } } }
}

/**
 * Condenses a hit for the model.
 *
 * A raw document can be hundreds of fields of infrastructure metadata. Sending them whole
 * burns the context window on noise the model did not ask for and cannot use, so long
 * values are clipped and empty ones dropped.
 */
export function summariseHit(source: Record<string, unknown>, maxFieldChars = 500): string {
  const parts: string[] = []
  for (const [field, value] of Object.entries(source)) {
    if (value === null || value === undefined || value === '') continue
    const rendered = typeof value === 'string' ? value : JSON.stringify(value)
    parts.push(`${field}: ${rendered.length > maxFieldChars ? `${rendered.slice(0, maxFieldChars)}…` : rendered}`)
  }
  return parts.join('\n')
}
