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
  folder: z.string().optional().describe('Restrict to a folder path, e.g. "Inbox/Alerts".'),
  query: z
    .string()
    .optional()
    .describe('Rank what is left by meaning. Omit to get everything in the window, newest first.'),
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
      'Search indexed Outlook mail. Use withinHours for "anything in the last N hours", status ' +
      'for [ALERT]/[OK] messages, and query to rank by meaning. Time and status are exact ' +
      'filters applied before any ranking, so a window with nothing in it really is empty. ' +
      'Returns message ids that open_email can display.',
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
          const wanted = params.folder.toLowerCase()
          candidates = candidates.filter((r) => r.folder.toLowerCase().startsWith(wanted))
        }

        const limit = params.limit ?? 20
        const windowNote =
          params.withinHours === undefined ? '' : ` in the last ${String(params.withinHours)} hour(s)`

        if (candidates.length === 0) {
          return {
            content:
              `Nothing indexed matches${windowNote}` +
              `${params.status === undefined ? '' : ` with status ${params.status}`}.\n` +
              'This is an exact answer over what has been indexed, not an approximate one — but ' +
              'it is only as current as the last sync.',
          }
        }

        let ordered = candidates.sort((a, b) => b.receivedAt - a.receivedAt)

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
        }

        const shown = ordered.slice(0, limit)
        const alerts = shown.filter((record) => record.status === 'alert').length

        return {
          content: [
            `${String(candidates.length)} indexed message(s)${windowNote}` +
              `${candidates.length > shown.length ? `, showing ${String(shown.length)}` : ''}` +
              `${alerts > 0 ? ` — ${String(alerts)} marked ALERT` : ''}:`,
            '',
            ...shown.map((record) => describe(record)),
            '',
            'Use mail_patterns to find out whether any of these recur. Use open_email with an id ' +
              'to show one to the user in Outlook.',
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
      'Open a message in Outlook so the user can read it, using an id from search_mail. Shows ' +
      'the real message on their screen; changes nothing and sends nothing.',
    parametersSchema: openSchema,

    async preview(params) {
      return {
        kind: 'text',
        text: `Open message ${params.id} in Outlook.\n\nIt will appear on screen. Nothing is changed or sent.`,
      }
    },

    async execute(params): Promise<ToolResult> {
      try {
        const opened = await options.display(params.id)
        return { content: `Opened "${opened.subject}" in Outlook.` }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}
