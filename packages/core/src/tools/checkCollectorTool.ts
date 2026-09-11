import { z } from 'zod'

import { parseDatasetPayload } from '../dataset/types.js'
import type { Tool, ToolResult } from './types.js'

const schema = z.object({
  name: z.string().min(1).describe('The Python tool to examine, with or without the `py__` prefix.'),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Arguments to call it with, if it needs any. `since` is supplied automatically by a sync.'),
})
export type CheckCollectorParams = z.infer<typeof schema>

/** What came back, described in the terms the contract is written in. */
function describeShape(value: unknown): string {
  if (value === null) return 'None'
  if (Array.isArray(value)) {
    if (value.length === 0) return 'an empty list'
    const first = value[0]
    const keys =
      first !== null && typeof first === 'object' && !Array.isArray(first)
        ? Object.keys(first as object).join(', ')
        : typeof first
    return `a list of ${String(value.length)}, whose first item is ${
      typeof first === 'object' ? `a dict with keys: ${keys}` : `a ${typeof first}`
    }`
  }
  if (typeof value === 'object') {
    return `a dict with keys: ${Object.keys(value as object).join(', ')}`
  }
  if (typeof value === 'string') {
    return `a string of ${String(value.length)} characters, starting "${value.slice(0, 60)}"`
  }
  return `a ${typeof value}`
}

/**
 * Diagnoses a Python tool that is meant to feed a dataset, and says how to fix it.
 *
 * ## Why a separate tool rather than only checking at creation
 *
 * Because the tools that need it most already exist. `create_collector_tool` checks a *new* one,
 * which does nothing for somebody whose collector was written before that existed — or written by
 * the generic tool, which is precisely the reported case. A sync failure names the shape problem,
 * but it names it in a scheduled run, at the dataset, long after the file was last looked at.
 *
 * ## Why it changes nothing
 *
 * It is `read`: it runs the tool and describes what came back. Fixing means editing the source,
 * which goes through `update_python_tool` and the approval prompt like every other change to code
 * that will later run. A doctor that prescribes and operates in one step is one nobody can check.
 */
export function createCheckCollectorTool(options: {
  /** Runs a registered tool by name. Supplied by the host, which owns the registry. */
  run: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** Whether a tool of that name exists, so "no such tool" is distinguishable from "it failed". */
  has: (name: string) => boolean
}): Tool<CheckCollectorParams> {
  return {
    name: 'check_collector',
    group: 'read',
    description:
      'Runs a Python tool and says whether its output can be indexed as a custom dataset, and if ' +
      'not, exactly what to change. Use it when a dataset sync reports that records are not ' +
      'usable, when adapting an existing tool into a collector, or after writing one to confirm ' +
      'it before the user configures a dataset around it. Changes nothing — it reports; fixing is ' +
      'an ordinary update_python_tool edit.',
    parametersSchema: schema,

    execute: async (params): Promise<ToolResult> => {
      const bare = params.name.replace(/^py__/, '')
      const full = `py__${bare}`
      if (!options.has(full) && !options.has(params.name)) {
        return {
          content:
            `There is no Python tool called "${bare}". Settings → Tools lists what exists; ` +
            'a collector has to be a registered tool before a dataset can use it.',
          isError: true,
        }
      }

      let output: unknown
      try {
        output = await options.run(options.has(full) ? full : params.name, params.arguments ?? {})
      } catch (error) {
        return {
          content:
            `It could not be run: ${error instanceof Error ? error.message : String(error)}\n\n` +
            'That is a fault in the tool itself, or the source is unreachable from here. Fix that ' +
            'before worrying about the record shape — a sync would fail the same way.',
          isError: true,
        }
      }

      /*
       * Parsed through the same function a sync uses.
       *
       * A second opinion about what counts as valid is the one thing this tool must not have: it
       * would either bless something a sync then rejects, or reject something a sync accepts, and
       * both make it worse than useless.
       */
      const parsed = parseDatasetPayload(output)

      if ('error' in parsed) {
        return {
          content: [
            'This tool cannot feed a dataset yet.',
            '',
            `What it returned: ${describeShape(output)}.`,
            '',
            `Why that will not index: ${parsed.error}`,
            '',
            'What it needs to return instead — a list of dicts, one per thing to make searchable:',
            '',
            '  [{"id": "<the source\'s own id, stable across runs>",',
            '    "text": "<the words to search — a subject and a body, not a status code>",',
            '    "title": "<optional heading>",',
            '    "url": "<optional link back>",',
            '    "timestamp": <optional epoch MILLIseconds>,',
            '    "tags": {"<name>": "<value>"}}]',
            '',
            'The two that are not optional are `id` and `text`. `id` must come from the source and ' +
              'be the same every run, or each sync duplicates the corpus instead of updating it.',
            '',
            'Edit it with update_python_tool, then run this again.',
          ].join('\n'),
          isError: true,
        }
      }

      if (parsed.records.length === 0) {
        return {
          content:
            'It ran and returned no records. That is a valid empty sync, so nothing is wrong — but ' +
            'the record shape could not be checked against anything. Run it again when the source ' +
            'has something, or call it with arguments that produce a row.',
        }
      }

      const first = parsed.records[0]
      const withTime = parsed.records.filter((record) => record.timestamp !== undefined).length
      return {
        content: [
          `Usable. ${String(parsed.records.length)} record(s), and they will index.`,
          '',
          `First record: id="${first?.id ?? ''}", ${String((first?.text ?? '').length)} characters of text` +
            `${first?.title === undefined ? '' : `, title "${first.title}"`}.`,
          withTime === parsed.records.length
            ? 'Every record has a timestamp, so retention and "what changed recently" both work.'
            : `${String(parsed.records.length - withTime)} record(s) have no timestamp. Those can never ` +
              'be aged out by retention and will not appear in a `withinDays` search. Add one if the ' +
              'source has a date.',
          '',
          'Configure the dataset in Settings → Custom data and point it at this tool.',
        ].join('\n'),
      }
    },
  }
}
