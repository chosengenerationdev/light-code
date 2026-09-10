import { z } from 'zod'

import {
  findNearAnniversaries,
  findRecurrence,
  normaliseSubject,
  since,
  type MailRecord,
} from '../office/mailIndex.js'
import type { Embedder } from '../rag/embedder.js'
import type { VectorSearcher } from '../rag/vectorStore.js'
import type { Tool, ToolResult } from './types.js'

/**
 * Investigating indexed mail.
 *
 * ## Two tools, because there are two kinds of question
 *
 * `search_mail` answers *what happened*: everything in a window, optionally narrowed to alerts,
 * optionally ranked by meaning. `mail_patterns` answers *whether this keeps happening*, which is
 * arithmetic over the whole index rather than a search at all.
 *
 * Splitting them is what keeps the second honest. Folded into one tool the model would reach for
 * a semantic search and eyeball the timestamps, which is exactly how "yes, this happens every
 * day at three" gets said about four messages spread across a fortnight.
 *
 * ## Why time is filtered before meaning, never after
 *
 * "Any alerts in the last six hours" is an exact question. Asking a vector store for the ten
 * nearest neighbours and then discarding the ones outside the window returns however many of
 * those ten happened to be recent — frequently none, which reads as "no alerts" and is the worst
 * possible wrong answer here. So the window is applied to the facts first, and meaning only
 * ranks what survives.
 */

export interface MailToolOptions {
  /** Loads the fact index. Cheap: a JSONL read of the user's own mail metadata. */
  loadRecords: () => Promise<MailRecord[]>
  /**
   * Which folders have been read all the way back, when the caller can say.
   *
   * Optional because only the host has it; a test or another caller passing just the records
   * gets a coverage report that declines to claim completeness rather than guessing at it.
   */
  loadBackfill?: () => Promise<Record<string, boolean>>
  /** Present only when a vector store and embedder are configured. */
  semantic?: {
    searcher: VectorSearcher
    embedder: Embedder
    collection: string
  }
}

const searchSchema = z.object({
  withinHours: z
    .number()
    .min(0.1)
    .max(24 * 90)
    .optional()
    .describe('Only mail received in this many hours. Use it for "any alerts today" questions.'),
  status: z
    .enum(['alert', 'ok'])
    .optional()
    .describe('Narrow to messages whose subject carries [ALERT] or [OK].'),
  folder: z.string().optional().describe('Restrict to a folder path, e.g. "Inbox\\Alerts".'),
  query: z
    .string()
    .optional()
    .describe('Rank what is left by meaning. Omit to get everything in the window, newest first.'),
  /*
   * The narrowing criteria, and `within` is the one that makes the rest recursive.
   *
   * A single search is rarely the answer to a real question: you find forty messages that mention
   * a thing, then want the six of those from one sender, then the two of those in a window. Doing
   * that by re-running one broad search with more filters is not the same operation — the
   * semantic ranking changes underneath you, so the second search is over a different forty.
   *
   * `within` fixes the population. Everything else applies inside it, so a refinement is a
   * genuine subset of what was just shown, and refining a refinement terminates.
   */
  within: z
    .array(z.string().min(1))
    .max(200)
    .optional()
    .describe(
      'Search only these message ids, from an earlier search_mail result. This is how to narrow ' +
        'a result set: search broadly, then pass the ids you got back with tighter criteria. ' +
        'Repeatable until the list is what you want.',
    ),
  subject: z
    .string()
    .optional()
    .describe('Only messages whose subject contains this text. Exact, case-insensitive, not semantic.'),
  sender: z
    .string()
    .optional()
    .describe('Only messages from a sender containing this text, e.g. a name or a domain.'),
  contains: z
    .string()
    .optional()
    .describe('Only messages whose subject, sender or indexed opening contains this text. Exact, not semantic.'),
  exclude: z
    .string()
    .optional()
    .describe('Drop messages containing this text in the subject, sender or opening. For paring a set down.'),
  before: z
    .string()
    .optional()
    .describe('Only mail received before this date, as YYYY-MM-DD or any ISO timestamp.'),
  after: z
    .string()
    .optional()
    .describe('Only mail received on or after this date, as YYYY-MM-DD or any ISO timestamp.'),
  idsOnly: z
    .boolean()
    .optional()
    .describe('Return just the ids and count. Use when narrowing in steps, to keep the working set cheap.'),
  limit: z.number().int().min(1).max(50).optional().describe('How many to return. Default 20.'),
})
export type SearchMailParams = z.infer<typeof searchSchema>

function describe(record: MailRecord): string {
  const when = new Date(record.receivedAt).toLocaleString()
  const tag = record.status === undefined ? '' : `[${record.status.toUpperCase()}] `
  const preview = record.preview.trim().length === 0 ? '' : `\n    ${record.preview.trim().slice(0, 220)}`
  return `${when}  ${tag}${record.subject}\n    from ${record.sender} in ${record.folder}\n    id: ${record.id}${preview}`
}

export function createSearchMailTool(options: MailToolOptions): Tool<SearchMailParams> {
  return {
    name: 'search_mail',
    group: 'read',
    description:
      'THE DEFAULT WAY TO ANSWER ANY QUESTION ABOUT EMAIL. Searches the indexed copy of the ' +
      'mail. Use withinHours for "anything in the last N hours", status for ' +
      '[ALERT]/[OK] messages, and query to rank by meaning. Time and status are exact filters ' +
      'applied before any ranking, so a window with nothing in it really is empty. Returns ' +
      'message ids that open_email can display. Prefer this over outlook_search every time: it ' +
      'is far faster, it does not disturb the running Outlook, and it can answer questions ' +
      'about time and recurrence that a live search cannot. Only reach for outlook_search if ' +
      'the user has explicitly asked you to look at Outlook itself. ' +
      'TO NARROW A RESULT SET, pass the ids you got back as `within` together with tighter ' +
      'criteria (subject, sender, contains, exclude, before, after) rather than re-running a ' +
      'broader search: `within` fixes the population, so the answer is a genuine subset of what ' +
      'you already saw, and it can be repeated until the list is right. Add idsOnly while ' +
      'narrowing to keep each step cheap.',
    parametersSchema: searchSchema,

    async execute(params): Promise<ToolResult> {
      try {
        const all = await options.loadRecords()
        if (all.length === 0) {
          return {
            content:
              'No mail is indexed yet. The user starts indexing from Settings → Mail; you cannot. ' +
              'This says nothing about what is in their mailbox.',
          }
        }

        // Exact filters first. See the note at the top of the file for why the order matters.
        let candidates = params.withinHours === undefined ? [...all] : since(all, params.withinHours)
        if (params.status !== undefined) candidates = candidates.filter((r) => r.status === params.status)
        if (params.folder !== undefined) {
          /*
           * Either separator, because Outlook uses one and everybody types the other.
           *
           * Folder paths come back from Outlook spelled with backslashes - `mailbox\\Inbox\\Alerts` -
           * and a model or a person writing `Inbox/Alerts` matched nothing at all, silently, which
           * reads exactly like an empty folder. The worker's own path splitter already accepts
           * both; this filter was the one place that did not.
           */
          const wanted = normaliseFolder(params.folder)
          candidates = candidates.filter((r) => normaliseFolder(r.folder).startsWith(wanted))
        }

        /*
         * Narrowing, and `within` comes first because it fixes the population.
         *
         * Refining by re-running a broad search with more filters is not the same operation: the
         * semantic ranking shifts underneath, so the second search is over a different set and the
         * "narrowed" answer can contain things the first pass never showed. Pinning the ids first
         * makes a refinement a genuine subset of what was just seen, and makes refining a
         * refinement terminate.
         */
        const narrowed: string[] = []
        if (params.within !== undefined && params.within.length > 0) {
          const keep = new Set(params.within)
          candidates = candidates.filter((r) => keep.has(r.id))
          narrowed.push(`within ${String(params.within.length)} given message(s)`)
        }
        if (params.subject !== undefined) {
          const needle = params.subject.toLowerCase()
          candidates = candidates.filter((r) => r.subject.toLowerCase().includes(needle))
          narrowed.push(`subject containing "${params.subject}"`)
        }
        if (params.sender !== undefined) {
          const needle = params.sender.toLowerCase()
          candidates = candidates.filter((r) => r.sender.toLowerCase().includes(needle))
          narrowed.push(`from "${params.sender}"`)
        }
        if (params.contains !== undefined) {
          const needle = params.contains.toLowerCase()
          candidates = candidates.filter((r) => haystackOf(r).includes(needle))
          narrowed.push(`containing "${params.contains}"`)
        }
        if (params.exclude !== undefined) {
          const needle = params.exclude.toLowerCase()
          candidates = candidates.filter((r) => !haystackOf(r).includes(needle))
          narrowed.push(`excluding "${params.exclude}"`)
        }

        /*
         * A date that will not parse is refused rather than ignored.
         *
         * Silently dropping it would widen the search to everything and report the result as if
         * the bound had been applied - the same class of quiet wrongness as the dropped query.
         */
        for (const [name, value] of [
          ['after', params.after],
          ['before', params.before],
        ] as const) {
          if (value === undefined) continue
          const at = Date.parse(value)
          if (Number.isNaN(at)) {
            return {
              content: `Could not read "${value}" as a date for ${name}. Use YYYY-MM-DD, or a full ISO timestamp.`,
              isError: true,
            }
          }
          candidates =
            name === 'after'
              ? candidates.filter((r) => r.receivedAt >= at)
              : candidates.filter((r) => r.receivedAt < at)
          narrowed.push(`${name} ${new Date(at).toLocaleString()}`)
        }

        const limit = params.limit ?? 20
        const windowNote =
          params.withinHours === undefined ? '' : ` in the last ${String(params.withinHours)} hour(s)`

        if (candidates.length === 0) {
          return {
            content:
              `Nothing indexed matches${windowNote}` +
              `${params.status === undefined ? '' : ` with status ${params.status}`}` +
              `${narrowed.length === 0 ? '' : `, ${narrowed.join(', ')}`}.\n` +
              'This is an exact answer over what has been indexed, not an approximate one — but ' +
              'it is only as current as the last sync.',
          }
        }

        let ordered = candidates.sort((a, b) => b.receivedAt - a.receivedAt)
        const asked = params.query?.trim() ?? ''
        let how = ''

        /*
         * A query with no embedder is matched on words, and never ignored.
         *
         * It used to be dropped silently: the condition below requires `options.semantic`, so
         * without an embedding model "has this book been mentioned before" returned the newest
         * twenty messages in the index - a well-formed answer, in time order, containing nothing
         * to do with the question. The assistant would then report those as matches.
         *
         * Degrading to a substring match is the same choice `search_docs` makes, and for the same
         * reason: worse recall is survivable, a confident wrong answer is not. Unlike the semantic
         * path this one *filters*, because a word that appears nowhere is a real absence and
         * saying so is the useful answer.
         */
        if (asked.length > 0 && options.semantic === undefined) {
          const needle = asked.toLowerCase()
          const words = needle.split(/\s+/).filter((word) => word.length > 2)
          candidates = candidates.filter((record) => {
            const haystack = `${record.subject}\n${record.sender}\n${record.preview}`.toLowerCase()
            return words.length === 0
              ? haystack.includes(needle)
              : words.some((word) => haystack.includes(word))
          })
          if (candidates.length === 0) {
            return {
              content:
                `Nothing indexed mentions "${asked}"${windowNote}. No embedding model is configured, ` +
                'so this was matched on words rather than meaning — a message saying the same ' +
                'thing in different words would not have been found. Only each subject, sender ' +
                'and the opening of each message is indexed.',
            }
          }
          ordered = candidates
          how =
            ' matched on words, not meaning - no embedding model is configured, so a message that ' +
            'says the same thing in different words was not found'
        }

        if (params.query !== undefined && params.query.trim().length > 0 && options.semantic !== undefined) {
          /*
           * Ranking, not filtering. The vector store is asked for a generous number of
           * neighbours and used only to *order* what the exact filters already produced —
           * anything it did not rank stays, at the end, in time order. A message the embedding
           * happened to miss is still a message that arrived in the window.
           */
          const vector = await options.semantic.embedder.embed(params.query)
          const hits = await options.semantic.searcher.searchByVector(options.semantic.collection, vector, {
            size: Math.min(100, Math.max(limit * 4, 40)),
          })
          const rank = new Map<string, number>()
          hits.forEach((hit, position) => {
            const id = hit.path.startsWith('mail:') ? hit.path.slice('mail:'.length) : hit.path
            if (!rank.has(id)) rank.set(id, position)
          })
          ordered = [...candidates].sort((a, b) => {
            const left = rank.get(a.id)
            const right = rank.get(b.id)
            if (left !== undefined && right !== undefined) return left - right
            if (left !== undefined) return -1
            if (right !== undefined) return 1
            return b.receivedAt - a.receivedAt
          })
          how = ' ranked by meaning'
        }

        const shown = ordered.slice(0, limit)
        const alerts = shown.filter((record) => record.status === 'alert').length
        const criteria = narrowed.length === 0 ? '' : `, ${narrowed.join(', ')}`

        if (params.idsOnly === true) {
          /*
           * Ids and nothing else, for narrowing in steps.
           *
           * A refinement that is three searches deep does not need forty previews on the way
           * through - it needs the population to pass to the next call. Returning the full
           * description each time is how a working set eats the context it was narrowing for.
           */
          return {
            content: [
              `${String(candidates.length)} message(s)${windowNote}${criteria}.`,
              ...candidates.slice(0, 200).map((record) => record.id),
              '',
              'Pass these back as `within` with tighter criteria to narrow further, or search ' +
                'again without idsOnly to see them.',
            ].join('\n'),
          }
        }

        return {
          content: [
            `${String(candidates.length)} indexed message(s)${windowNote}${criteria}${how}` +
              `${candidates.length > shown.length ? `, showing ${String(shown.length)}` : ''}` +
              `${alerts > 0 ? ` — ${String(alerts)} marked ALERT` : ''}:`,
            '',
            ...shown.map((record) => describe(record)),
            '',
            'Use mail_patterns to find out whether any of these recur. Use open_email with an id ' +
              'to show one to the user in Outlook. To narrow this set rather than search again, ' +
              'pass these ids back as `within` with tighter criteria - the population stays fixed, ' +
              'so the result is a genuine subset of what you just saw.',
            /*
             * Said on every search, because the index is a *preview* and the difference matters.
             * "It is not in the index" and "it is not in the mail" are different statements, and
             * only the first one is true here.
             */
            /*
             * The three limits of the index, stated on every search.
             *
             * "It is not in the index" and "it is not in the mail" are different statements and
             * only the first is true here. The colour line matters most: the index holds the
             * plain-text rendering, which drops formatting entirely - and in an alerting mailbox
             * the red line often *is* the message. Saying a message looks fine because the
             * indexed text looks fine would be a confident wrong answer.
             */
            'Limits of the index, worth stating if the answer matters: only each subject, sender ' +
              'and the opening of each message is indexed, so something mentioned deep in a long ' +
              'message is not here; it holds the plain-text rendering, so colours, highlighting ' +
              'and images are NOT here; and it is only as current as the last sync. When colour ' +
              'or formatting could carry meaning, use outlook_read_email with the id - that ' +
              'reads the live message and reports the colours.',
          ].join('\n'),
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

const patternsSchema = z.object({
  subject: z
    .string()
    .optional()
    .describe('Look only at messages like this one. Omit to report every repeating subject.'),
  lookbackDays: z.number().int().min(1).max(400).optional().describe('How far back to look. Default 30.'),
  minimumOccurrences: z.number().int().min(2).max(50).optional().describe('Default 2.'),
})
export type MailPatternsParams = z.infer<typeof patternsSchema>

export function createMailPatternsTool(options: MailToolOptions): Tool<MailPatternsParams> {
  return {
    name: 'mail_patterns',
    group: 'read',
    description:
      'Find out whether a message keeps arriving, and when. Answers "does this alert happen ' +
      'every day around the same time" and "was a similar one sent last week on the same day". ' +
      'Counts exactly over the indexed mail rather than estimating from a search — the spread it ' +
      'reports is what tells a genuine schedule from a coincidence.',
    parametersSchema: patternsSchema,

    async execute(params): Promise<ToolResult> {
      try {
        const all = await options.loadRecords()
        if (all.length === 0) {
          return { content: 'No mail is indexed yet, so there is nothing to find a pattern in.' }
        }

        const lookback = params.lookbackDays ?? 30
        const earliest = Date.now() - lookback * 24 * 60 * 60 * 1000
        let records = all.filter((record) => record.receivedAt >= earliest)

        let anniversaries: MailRecord[] = []
        if (params.subject !== undefined && params.subject.trim().length > 0) {
          const shape = normaliseSubject(params.subject)
          records = records.filter((record) => normaliseSubject(record.subject) === shape)
          const newest = records.reduce<MailRecord | undefined>(
            (best, record) => (best === undefined || record.receivedAt > best.receivedAt ? record : best),
            undefined,
          )
          if (newest !== undefined) {
            anniversaries = findNearAnniversaries(all, newest, { sameWeekdayOnly: true, lookbackDays: lookback })
          }
        }

        const patterns = findRecurrence(records, {
          ...(params.minimumOccurrences !== undefined ? { minimumOccurrences: params.minimumOccurrences } : {}),
        })

        if (patterns.length === 0) {
          return {
            content:
              `Nothing repeats in the last ${String(lookback)} day(s)` +
              `${params.subject === undefined ? '' : ' matching that subject'}. ` +
              'Either it is a one-off, or it arrived before the index starts.',
          }
        }

        const lines = patterns.slice(0, 12).map((pattern) => {
          /*
           * The spread is stated in words as well as minutes. "spread 4 min" is a number the
           * model may or may not interpret; "consistently" and "at no consistent time" are the
           * conclusion, and stating it here is what stops it being guessed at.
           */
          const consistency =
            pattern.spreadMinutes <= 15
              ? 'consistently'
              : pattern.spreadMinutes <= 60
                ? 'roughly'
                : 'at no consistent time'
          return (
            `${pattern.example}\n` +
            `    ${String(pattern.occurrences)} times across ${String(pattern.days)} day(s), ` +
            `${consistency} around ${pattern.typicalTime} (spread ${String(pattern.spreadMinutes)} min)\n` +
            `    last seen ${new Date(pattern.lastSeen).toLocaleString()}`
          )
        })

        return {
          content: [
            `Repeating messages in the last ${String(lookback)} day(s):`,
            '',
            ...lines,
            ...(anniversaries.length > 0
              ? [
                  '',
                  `The same message arrived on the same weekday at a similar time ${String(anniversaries.length)} time(s) before:`,
                  ...anniversaries.slice(0, 6).map((record) => `    ${new Date(record.receivedAt).toLocaleString()}`),
                ]
              : []),
            '',
            'A small spread means a schedule. A large one means it is not on a timer, whatever ' +
              'the count suggests.',
          ].join('\n'),
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

const openSchema = z.object({
  id: z.string().min(1).describe('The message id from search_mail.'),
})
export type OpenEmailParams = z.infer<typeof openSchema>

/**
 * Shows a message to the user in Outlook.
 *
 * Requested directly: *"agent should be able to open and show me the email if i ask it too"*.
 *
 * It is `command` rather than `read` and always asks, because it does something on the screen in
 * front of a person — a window appears. That is small, but it is not nothing, and a tool that
 * makes the user's applications do things unprompted is exactly the sort that should be asked
 * about. It opens the message for reading and changes nothing.
 */
export function createOpenEmailTool(options: {
  display: (id: string) => Promise<{ subject: string }>
}): Tool<OpenEmailParams> {
  return {
    name: 'open_email',
    group: 'command',
    description:
      'Open one or more messages in Outlook so the user can read them, using ids from ' +
      'search_mail. Pass an array to open several at once - comparing this week and last week ' +
      'means having both on screen. Shows the real messages; changes nothing and sends nothing.',
    parametersSchema: openSchema,

    async preview(params) {
      const ids = idsOf(params)
      return {
        kind: 'text',
        text:
          ids.length === 1
            ? `Open message ${String(ids[0])} in Outlook.\n\nIt will appear on screen. Nothing is changed or sent.`
            : /*
               * Every id listed, never a count. Invariant 8: the approval shows ground truth, and
               * "open 12 messages" hides which twelve.
               */
              `Open ${String(ids.length)} messages in Outlook:\n\n` +
              `${ids.map((id) => `  ${id}`).join('\n')}\n\n` +
              'Each appears in its own window. Nothing is changed or sent.',
      }
    },

    async execute(params): Promise<ToolResult> {
      const ids = idsOf(params)
      const opened: string[] = []
      const failed: string[] = []

      /*
       * Sequential, and one failure does not stop the rest.
       *
       * Outlook is single-threaded through COM, so firing these off in parallel gets them
       * rejected with RPC_E_CALL_REJECTED rather than opening any faster. And one dead id - a
       * message moved or deleted since it was indexed - must not cost the other eleven. Partial
       * success is the ordinary case here, so it is reported as such rather than thrown.
       */
      for (const id of ids) {
        try {
          opened.push((await options.display(id)).subject)
        } catch (error) {
          failed.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (opened.length === 0) {
        return { content: `Could not open any of them.\n${failed.join('\n')}`, isError: true }
      }
      return {
        content: [
          `Opened ${String(opened.length)} message(s) in Outlook:`,
          ...opened.map((subject) => `  "${subject}"`),
          ...(failed.length === 0
            ? []
            : [
                '',
                `${String(failed.length)} could not be opened - moved or deleted since indexing:`,
                ...failed.map((line) => `  ${line}`),
              ]),
        ].join('\n'),
      }
    },
  }
}

/** One id or many, as one list. The single place that difference is resolved. */
function idsOf(params: OpenEmailParams): string[] {
  return typeof params.id === 'string' ? [params.id] : [...params.id]
}

/**
 * What the index actually holds, per folder.
 *
 * ## Why this is a tool and not a line in the settings panel
 *
 * Without it the assistant cannot distinguish "there is no such email" from "that folder was
 * never indexed", and it will state the first when the second is true - confidently, with a
 * search result to back it up. That is the failure §12e was written about, arriving through a
 * different door: a search over a partial corpus reads exactly like a search over a complete one.
 *
 * So the honest answer to "is there anything about X" often begins with what is covered, and the
 * assistant needs to be able to look that up rather than infer it from what a search happened to
 * return.
 *
 * Every figure here is exact. Nothing in this tool goes near an embedding.
 */
export function createMailCoverageTool(options: MailToolOptions): Tool<Record<string, never>> {
  return {
    name: 'mail_coverage',
    group: 'read',
    description:
      'Reports which mail folders are indexed and how far back each one goes. Use it before ' +
      'concluding that something is not in the mail: an empty search over a folder that was ' +
      'never indexed looks identical to an empty search over one that was. Also use it when the ' +
      'user asks what is indexed. Exact counts and dates, no embedding involved.',
    parametersSchema: z.object({}),
    execute: async () => {
      try {
        const records = await options.loadRecords()
        if (records.length === 0) {
          return {
            content:
              'Nothing is indexed yet. Any question about mail cannot be answered from the ' +
              'index - say so rather than reporting that nothing was found.',
          }
        }

        const done = (await options.loadBackfill?.()) ?? {}
        const byFolder = new Map<string, { count: number; oldest: number; newest: number }>()
        for (const record of records) {
          const existing = byFolder.get(record.folder)
          if (existing === undefined) {
            byFolder.set(record.folder, { count: 1, oldest: record.receivedAt, newest: record.receivedAt })
            continue
          }
          existing.count += 1
          if (record.receivedAt < existing.oldest) existing.oldest = record.receivedAt
          if (record.receivedAt > existing.newest) existing.newest = record.receivedAt
        }

        const rows = [...byFolder.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .map(([folder, span]) => {
            /*
             * "Still catching up" is said rather than left to be inferred. A folder mid-backfill
             * has a real oldest date that is not the oldest message in it, and quoting that date
             * alone would invite exactly the wrong conclusion about what is missing.
             */
            const complete =
              done[folder] === true ? 'back to the start' : 'still reading further back'
            return (
              `- ${folder}: ${String(span.count)} message(s), ` +
              `${new Date(span.oldest).toLocaleDateString()} to ${new Date(span.newest).toLocaleDateString()} ` +
              `(${complete})`
            )
          })

        const newest = Math.max(...records.map((record) => record.receivedAt))
        return {
          content: [
            `${String(records.length)} message(s) indexed across ${String(byFolder.size)} folder(s).`,
            ...rows,
            '',
            `Most recent indexed message: ${new Date(newest).toLocaleString()}. Anything that ` +
              'arrived after that is not here yet.',
            'Folders absent from this list have never been indexed. A search finding nothing in ' +
              'one of those means nothing at all - say that rather than reporting an absence.',
            'Only each subject, sender and the opening of each message is indexed, as plain ' +
              'text - colours, highlighting and images are not. Use outlook_read_email on an id ' +
              'when the formatting matters.',
          ].join('\n'),
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

/** Lower-cased with either separator folded to one, so `Inbox/Alerts` finds `Inbox\\Alerts`. */
function normaliseFolder(path: string): string {
  return path.toLowerCase().replace(/[\\/]+/g, '\\')
}

/** Subject, sender and the indexed opening, lower-cased. What an exact text filter searches. */
function haystackOf(record: MailRecord): string {
  return `${record.subject}\n${record.sender}\n${record.preview}`.toLowerCase()
}
