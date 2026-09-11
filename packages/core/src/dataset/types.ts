import { z } from 'zod'

/**
 * A corpus the user collects themselves, by writing a Python tool that returns records.
 *
 * ## Why this exists rather than "index this folder"
 *
 * The data people actually want the assistant to know is rarely on disk. It is in a ticketing
 * system, a wiki, a database, an internal API — reachable, but only through a library that knows
 * the organisation's auth. Light Code cannot fetch any of that and should not try: every such
 * source would be a connector to write, maintain and secure.
 *
 * A Python tool already solves it. The user's own code reaches whatever it can reach, returns
 * records, and Light Code does the part it is good at — embedding them, keeping them current on a
 * schedule, and searching them. The integration surface is one function signature rather than one
 * adapter per system.
 *
 * ## Why the tool returns records rather than text
 *
 * An `id` is what makes a re-sync an *update* rather than a duplication, and without one every
 * run would multiply the corpus. A `timestamp` is what makes retention possible: "keep 90 days"
 * needs to know what is 90 days old. Both are things only the source knows, so the contract asks
 * for them rather than inventing them at this end.
 */
export const datasetRecordSchema = z.object({
  /**
   * Stable across syncs. The same record from the source must come back with the same id, or a
   * re-sync duplicates it rather than replacing it — which is the failure that turns a useful
   * corpus into noise a few runs in.
   */
  id: z.string().min(1),
  /** What gets embedded and what a search returns. */
  text: z.string().min(1),
  /** A heading for the search result. Falls back to the opening of `text`. */
  title: z.string().optional(),
  /** Where it came from — a ticket URL, a file path. Shown so a hit can be followed up. */
  url: z.string().optional(),
  /**
   * Epoch milliseconds. Retention and "what changed this week" both need it.
   *
   * Absent is allowed and means "no age", which retention then cannot remove. Defaulting it to
   * *now* would be worse: every record would age from whenever it was last synced, so nothing
   * would ever look old and retention would silently never fire.
   */
  timestamp: z.number().optional(),
  /** Anything else the tool wants to keep. Filterable exactly, never embedded. */
  tags: z.record(z.string(), z.string()).optional(),
})
export type DatasetRecord = z.infer<typeof datasetRecordSchema>

/**
 * What a collector tool must return.
 *
 * Two shapes are accepted — `{records: [...]}` and a bare array — because both are what someone
 * writes without reading the documentation, and refusing the second would be a rejection over
 * punctuation. Anything else is refused with the shape quoted, since a collector that returns
 * something unexpected is a bug the user can fix in one edit if they are told what was wanted.
 */
export const datasetPayloadSchema = z.union([
  z.object({ records: z.array(datasetRecordSchema) }),
  z.array(datasetRecordSchema),
])

/**
 * The wrapper keys people actually use. Order matters only in that the first hit wins.
 *
 * Accepted rather than refused because every one of them is a list of records under a different
 * noun — the author's intent is unambiguous, and rejecting over the choice of word would be a
 * rejection about punctuation. What is *not* guessed at is anything where being wrong would put
 * bad data in the corpus.
 */
const WRAPPER_KEYS = ['records', 'items', 'data', 'results', 'rows'] as const

/** Where a body might be, when it is not called `text`. */
const TEXT_KEYS = ['text', 'content', 'body', 'description', 'summary'] as const

/**
 * Milliseconds, from whatever the source had.
 *
 * A timestamp in **seconds** is the mistake worth catching: it parses fine, breaks nothing
 * loudly, and dates every record to 1970 — so retention deletes the lot and "what changed this
 * week" finds nothing, with no error anywhere. Anything below the year 2001 in milliseconds is
 * far more likely to be seconds than to be a genuine record from 1970.
 */
function toMilliseconds(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value > 0 && value < 1e11 ? Math.round(value * 1000) : Math.round(value)
}

/** One record, from whatever shape the collector produced. */
function normaliseRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>

  const id = row['id'] ?? row['key'] ?? row['_id']
  const textKey = TEXT_KEYS.find((key) => typeof row[key] === 'string' && (row[key] as string).length > 0)

  const record: Record<string, unknown> = {
    ...(typeof id === 'string' || typeof id === 'number' ? { id: String(id) } : {}),
    ...(textKey !== undefined ? { text: row[textKey] } : {}),
    ...(typeof row['title'] === 'string' ? { title: row['title'] } : {}),
    ...(typeof row['url'] === 'string' ? { url: row['url'] } : {}),
  }

  const at = toMilliseconds(row['timestamp'] ?? row['updated'] ?? row['updated_at'] ?? row['date'])
  if (at !== undefined) record['timestamp'] = at

  // Coerced to strings rather than refused: a tag whose value is a number or a boolean is an
  // ordinary thing to write, and its meaning survives the conversion intact.
  if (row['tags'] !== null && typeof row['tags'] === 'object' && !Array.isArray(row['tags'])) {
    const tags: Record<string, string> = {}
    for (const [key, tagValue] of Object.entries(row['tags'] as Record<string, unknown>)) {
      if (tagValue === null || tagValue === undefined) continue
      if (typeof tagValue === 'object') continue
      tags[key] = String(tagValue)
    }
    if (Object.keys(tags).length > 0) record['tags'] = tags
  }

  return record
}

/**
 * Reads whatever the collector returned as records, forgivingly but never by guessing.
 *
 * ## Where the line is
 *
 * Shape is forgiven; **content is not**. A list under a different noun, a lone dict, a JSON
 * string, `key` instead of `id`, a timestamp in seconds — each of those has exactly one sensible
 * reading, and refusing them means somebody edits a file to change a word. Inventing a missing
 * `id`, or treating a formatted report as a record, does not have one sensible reading, and
 * accepting it would put junk in the corpus that only shows up as bad search results weeks later.
 *
 * So the refusal quotes what actually arrived. A collector that returns the wrong thing is a bug
 * the user can fix in one edit *if they are told what was seen*, and a schema complaint about
 * `records.0.id` when the tool returned a string is not that.
 */
export function parseDatasetPayload(value: unknown): { records: DatasetRecord[] } | { error: string } {
  let candidate = value

  // A tool that returned `json.dumps(...)`, which is what somebody writes when they are thinking
  // about printing rather than about returning.
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return {
        error:
          'The collector tool returned text rather than records. It must return a list of ' +
          `{"id": ..., "text": ...} dicts. It returned: ${String(value).slice(0, 200)}`,
      }
    }
  }

  if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const wrapper = WRAPPER_KEYS.find((key) => Array.isArray((candidate as Record<string, unknown>)[key]))
    // A lone dict is one record. Sources that return a single object are common enough that
    // requiring the author to wrap it would be a rejection about brackets.
    candidate = wrapper === undefined ? [candidate] : (candidate as Record<string, unknown>)[wrapper]
  }

  if (!Array.isArray(candidate)) {
    return {
      error:
        'The collector tool did not return a list of records. Return a list of ' +
        `{"id": ..., "text": ...} dicts, or a dict with them under "records". It returned: ` +
        `${JSON.stringify(value).slice(0, 200)}`,
    }
  }

  const normalised = candidate.map((entry) => normaliseRecord(entry) ?? entry)
  const parsed = z.array(datasetRecordSchema).safeParse(normalised)
  if (parsed.success) return { records: parsed.data }

  /*
   * Named per record rather than as a schema dump.
   *
   * "records.0.id: Required" tells somebody nothing they can act on. Which record, what it had,
   * and what was missing is the difference between a one-line fix and a guessing game.
   */
  const first = parsed.error.issues[0]
  const index = typeof first?.path[0] === 'number' ? first.path[0] : 0
  const offending = candidate[index]
  const keys =
    offending !== null && typeof offending === 'object' ? Object.keys(offending as object).join(', ') : 'none'

  return {
    error:
      `The collector tool returned ${String(candidate.length)} item(s), and item ${String(index + 1)} ` +
      'is not a usable record. Each needs a stable `id` (the source\'s own identifier, so a ' +
      're-sync updates rather than duplicates) and a `text` to index. ' +
      `That item had these keys: ${keys}. ` +
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
  }
}

/** One configured corpus. */
export const datasetConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, 'Give it a name'),
  /** The Python tool that produces the records, by its bare name. */
  toolName: z.string().min(1, 'Choose a collector tool'),
  /** Passed to the tool as its arguments, so one tool can serve several datasets. */
  arguments: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  /** How often to re-run the collector. Zero or absent means only when asked. */
  syncMinutes: z.number().int().min(0).optional(),
  /** Drop records older than this. Absent means keep everything. */
  retentionDays: z.number().int().positive().optional(),
  /** Which vector store to write to. Falls back to the one named for `data`, then the active one. */
  storeId: z.string().optional(),
})
export type DatasetConfig = z.infer<typeof datasetConfigSchema>

/**
 * The prompt fragment that teaches the model to write a collector.
 *
 * Kept beside the schema it describes, so the two cannot drift — a guidance block living in the
 * prompt builder would be edited without the contract and would start describing a shape the
 * parser rejects.
 */
export const COLLECTOR_EXAMPLE = `def run(since: int | None = None) -> list[dict]:
    """Tickets assigned to the team.

    Args:
        since: Epoch milliseconds of the last successful sync, or None on the first run.
    """
    rows = my_internal_lib.search(updated_after=since)
    return [
        {
            "id": row.key,                       # stable: the source's own identifier
            "title": row.summary,
            "text": f"{row.summary}\\n\\n{row.description}",   # what gets embedded
            "url": row.browse_url,
            "timestamp": int(row.updated.timestamp() * 1000),  # epoch MILLIseconds
            "tags": {"status": row.status, "team": row.team},  # flat, strings only
        }
        for row in rows
    ]`

export const COLLECTOR_TOOL_GUIDANCE = [
  'Writing a collector for a custom dataset:',
  '- A collector is an ordinary Python tool. Its `run` returns a list of records, each a dict',
  '  with `id` and `text`, and optionally `title`, `url`, `timestamp` (epoch milliseconds) and',
  '  `tags` (a flat dict of strings).',
  '- **`id` must be stable across runs.** Use the source\'s own identifier — a ticket key, a row',
  '  id, a file path. A generated or time-based id makes every sync duplicate the whole corpus',
  '  instead of updating it, which is not obvious until the results are full of near-copies.',
  '- **`text` is what gets embedded and what a search shows.** Put the meaning in it: a subject',
  '  and a body, not an id and a status code. Roughly a paragraph to a page each works best.',
  '- Set `timestamp` wherever the source has one. Retention and any "what changed recently"',
  '  question both need it, and it cannot be recovered later.',
  '- The tool is called with whatever arguments the dataset configures, plus `since` — epoch',
  '  milliseconds of the last successful sync, or absent on the first. Use it to fetch only what',
  '  changed if the source allows; returning everything each time is correct but slower.',
  '- Return `[]` when there is nothing new. That is a successful sync, not an error.',
  '- Keep credentials out of the tool: read them from the environment or from a file the user',
  '  already has. A tool file lives in the workspace and lands in git.',
  '',
  '**Return a list of dicts. Not a string, not a dict of rows, not a formatted report.** The',
  'common mistake is returning something a person would read; a collector returns something a',
  'search can index, and anything else is refused when it runs. If the source gives you one',
  'object, return a one-element list.',
  '',
  'A collector looks like this:',
  '',
  '```python',
  COLLECTOR_EXAMPLE,
  '```',
].join('\n')
