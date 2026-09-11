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

export function parseDatasetPayload(value: unknown): { records: DatasetRecord[] } | { error: string } {
  const parsed = datasetPayloadSchema.safeParse(value)
  if (parsed.success) {
    return { records: Array.isArray(parsed.data) ? parsed.data : parsed.data.records }
  }
  return {
    error:
      'The collector tool did not return records in the expected shape. Return a list of ' +
      '{"id": ..., "text": ...} objects, or {"records": [...]}. Each id must be stable across ' +
      'runs so a re-sync updates rather than duplicates. ' +
      parsed.error.issues
        .slice(0, 5)
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
].join('\n')
