import { spawn } from 'node:child_process'
import { z } from 'zod'
import { normalizeForComparison } from '../fs/confine.js'
import { isSecretPath, SECRET_FOLDERS } from '../fs/reach.js'
import { formatBytes } from './largeFile.js'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolExecutionContext, ToolResult } from './types.js'

/**
 * File tools backed by `sun-fs`, Sun Light Code's parallel Rust helper (`HostServices.fastFs`).
 *
 * Absent wherever the host has no helper - the VS Code extension, a plain Node host - rather than
 * present and failing. All four only **read**: the helper has no write operation at all, and every
 * change an agent makes still goes through `write_to_file` / `apply_diff`, which show a diff and ask.
 *
 * Every path goes through `resolveToolPath` first, so the deny list, the workspace rules and Sun's
 * "reach anywhere" floor (`fs/reach.ts`) apply exactly as they do to `read_file`; the helper is
 * handed only what already passed. Folders holding credentials are not even walked, and results are
 * filtered again on the way back, because a walk discovers paths nobody named.
 */

interface HelperAnswer {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

function runHelper(exe: string, request: object, signal?: AbortSignal): Promise<HelperAnswer> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    const abort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
    child.on('error', (error) => reject(new Error(`The file helper could not start (${exe}): ${error.message}`)))
    child.on('close', () => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted === true) return reject(new Error('Stopped.'))
      try {
        resolve(JSON.parse(out) as HelperAnswer)
      } catch {
        reject(new Error(`The file helper gave no answer${err.length > 0 ? `: ${err.slice(0, 300)}` : '.'}`))
      }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

const when = (ms: unknown): string =>
  typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '?'

/** Resolves a folder or file for reading, the way `read_file` does. */
async function readable(context: ToolExecutionContext, target: string): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const resolved = await resolveToolPath(context, target)
  if (!resolved.ok) return resolved
  if (isSecretPath(resolved.realPath)) return { ok: false, message: `Access to "${target}" is denied — it holds keys or credentials.` }
  return { ok: true, path: resolved.realPath }
}

async function allowedResults(context: ToolExecutionContext, paths: string[]): Promise<Set<string>> {
  const keep = new Set<string>()
  await Promise.all(
    paths.map(async (p) => {
      if (!isSecretPath(p) && !(await context.denylist.isDenied(p))) keep.add(p)
    }),
  )
  return keep
}

const dateSchema = z.string().optional().describe('ISO date or date-time, e.g. 2026-10-01.')
const toMs = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

const findSchema = z.object({
  action: z.enum(['find', 'summary', 'duplicates']).default('find').describe(
    'find: list matching files (newest first). summary: totals, sizes by type, largest and newest files. duplicates: identical files, by content.',
  ),
  roots: z.array(z.string().min(1)).min(1).max(20).describe('Folders to look in: workspace-relative, absolute, another drive, or a share like \\\\server\\share\\folder.'),
  names: z.array(z.string()).optional().describe('File-name patterns (* and ?) or plain text the name contains. Case-insensitive.'),
  extensions: z.array(z.string()).optional().describe('e.g. ["xlsx", "csv"].'),
  minSizeBytes: z.number().int().min(0).optional(),
  maxSizeBytes: z.number().int().min(0).optional(),
  modifiedAfter: dateSchema,
  modifiedBefore: dateSchema,
  directories: z.boolean().optional().describe('find: list folders instead of files.'),
  includeHidden: z.boolean().optional(),
  respectGitignore: z.boolean().optional().describe('Skip what .gitignore excludes (inside repositories).'),
  maxDepth: z.number().int().min(0).max(64).optional(),
  limit: z.number().int().min(1).max(2000).optional().describe('find: default 200. duplicates: groups, default 30.'),
})

const readManySchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        fromLine: z.number().int().min(1).optional(),
        lines: z.number().int().min(1).optional(),
      }),
    )
    .min(1)
    .max(50)
    .describe('Up to 50 files, each optionally a window of lines. Read in parallel.'),
})

const bigFileSchema = z.object({
  action: z.enum(['inspect', 'lines', 'tail', 'search']).describe(
    'inspect: size, line count, first lines, and for CSV/Excel the columns and their types. lines: a window (fromLine, count). tail: the last lines. search: a regular expression across the whole file, with context lines.',
  ),
  path: z.string().min(1),
  fromLine: z.number().int().min(1).optional(),
  count: z.number().int().min(1).max(5000).optional().describe('lines/tail: how many (default 200 / 100).'),
  pattern: z.string().optional().describe('search: a regular expression (case-insensitive unless caseSensitive).'),
  caseSensitive: z.boolean().optional(),
  context: z.number().int().min(0).max(10).optional().describe('search: lines before and after each match.'),
  limit: z.number().int().min(1).max(500).optional().describe('search: matches to return (default 100).'),
})

const tableSchema = z.object({
  path: z.string().min(1).describe('A .csv, .tsv or delimited text file, or an Excel workbook (.xlsx, .xlsm, .xls) or .ods.'),
  sheet: z.string().optional().describe('Workbook sheet; the first when omitted.'),
  delimiter: z.string().max(1).optional(),
  header: z.boolean().optional().describe('First row is the header (default true).'),
  columns: z.array(z.string()).optional().describe('Columns to return, without grouping.'),
  filters: z
    .array(
      z.object({
        column: z.string(),
        op: z.enum(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'startsWith', 'empty', 'notEmpty']),
        value: z.string().optional(),
      }),
    )
    .optional()
    .describe('All must match. Numbers compare as numbers.'),
  groupBy: z.array(z.string()).optional(),
  aggregates: z
    .array(z.object({ fn: z.enum(['count', 'sum', 'avg', 'min', 'max', 'distinct']), column: z.string().optional() }))
    .optional(),
  sort: z.array(z.object({ column: z.string(), desc: z.boolean().optional() })).optional().describe('By result column name, e.g. "sum(amount)".'),
  offset: z.number().int().min(0).optional().describe('Page through results.'),
  limit: z.number().int().min(1).max(500).optional().describe('Rows to return (default 50).'),
})

/** The four tools, for a host that ships `sun-fs`. */
export function createFastFsTools(exe: string): Tool[] {
  const findTool: Tool<z.infer<typeof findSchema>> = {
    name: 'find_files',
    group: 'read',
    description:
      'Find files fast across whole folders, drives and network shares, using every CPU core: by name pattern, ' +
      'extension, size and modified date (action "find"); summarise a folder tree — total size, size by file type, ' +
      'largest and newest files ("summary"); or find identical files by content ("duplicates"). Read-only. ' +
      'Prefer this to list_files for anything larger than one folder.',
    parametersSchema: findSchema,
    async execute(input, context): Promise<ToolResult> {
      const params = { ...input, action: input.action ?? 'find' }
      const roots: string[] = []
      for (const root of params.roots) {
        const r = await readable(context, root)
        if (!r.ok) return { content: r.message, isError: true }
        roots.push(r.path)
      }
      const answer = await runHelper(
        exe,
        {
          op: params.action,
          roots,
          skip: SECRET_FOLDERS,
          names: params.names,
          extensions: params.extensions,
          minSize: params.minSizeBytes,
          maxSize: params.maxSizeBytes,
          modifiedAfter: toMs(params.modifiedAfter),
          modifiedBefore: toMs(params.modifiedBefore),
          directories: params.directories,
          includeHidden: params.includeHidden,
          gitignore: params.respectGitignore,
          maxDepth: params.maxDepth,
          limit: params.limit ?? (params.action === 'duplicates' ? 30 : 200),
        },
        context.signal,
      )
      if (answer.ok !== true) return { content: answer.error ?? 'The search failed.', isError: true }
      const scanned = `Looked at ${String(answer.scanned)} entries in ${String(answer.elapsedMs)} ms` +
        (answer.timedOut === true ? ' — stopped at the time limit, so this is partial; narrow the folders or filters' : '') +
        (typeof answer.unreadable === 'number' && answer.unreadable > 0 ? `; ${String(answer.unreadable)} could not be read` : '') + '.'
      if (params.action === 'find') {
        const matches = (answer.matches as { path: string; size: number; modified: number; directory: boolean }[]) ?? []
        const keep = await allowedResults(context, matches.map((m) => m.path))
        const lines = matches.filter((m) => keep.has(m.path)).map((m) => `${m.path}\t${m.directory ? 'folder' : formatBytes(m.size)}\t${when(m.modified)}`)
        return { content: `${lines.length === 0 ? 'Nothing matched.' : lines.join('\n')}\n\n${scanned}${answer.limitReached === true ? ' The limit was reached; more match.' : ''}` }
      }
      if (params.action === 'summary') {
        const ext = (answer.byExtension as { extension: string; files: number; bytes: number }[]) ?? []
        const list = (key: string): string => {
          const items = (answer[key] as { path: string; size: number; modified: number }[]) ?? []
          return items.filter((i) => !isSecretPath(i.path)).map((i) => `  ${formatBytes(i.size)}\t${when(i.modified)}\t${i.path}`).join('\n')
        }
        return {
          content:
            `${String(answer.files)} files in ${String(answer.folders)} folders, ${formatBytes(answer.bytes as number)} in total.\n\n` +
            `By type:\n${ext.map((e) => `  .${e.extension}\t${String(e.files)} files\t${formatBytes(e.bytes)}`).join('\n')}\n\n` +
            `Largest:\n${list('largest')}\n\nNewest:\n${list('newest')}\n\n${scanned}`,
        }
      }
      const groups = (answer.groups as { size: number; copies: number; wastedBytes: number; paths: string[] }[]) ?? []
      const text = groups
        .map((g) => `${String(g.copies)} copies of ${formatBytes(g.size)} (${formatBytes(g.wastedBytes)} duplicated):\n${g.paths.filter((p) => !isSecretPath(p)).map((p) => `  ${p}`).join('\n')}`)
        .join('\n\n')
      return { content: `${groups.length === 0 ? 'No identical files found.' : text}\n\n${String(answer.totalGroups)} duplicate groups in all; ${String(answer.hashedFiles)} files compared by content. ${scanned}` }
    },
  }

  const readManyTool: Tool<z.infer<typeof readManySchema>> = {
    name: 'read_many_files',
    group: 'read',
    description:
      'Read up to 50 files at once, in parallel, each whole or as a window of lines (fromLine, lines). Faster than ' +
      'many read_file calls when several files are needed. Output is line-numbered; files read here count as read ' +
      'for editing.',
    parametersSchema: readManySchema,
    async execute(params, context): Promise<ToolResult> {
      const refused: string[] = []
      const files: { path: string; fromLine?: number; lines?: number; asked: string }[] = []
      for (const f of params.files) {
        const r = await readable(context, f.path)
        if (!r.ok) refused.push(`${f.path}: ${r.message}`)
        else files.push({ path: r.path, asked: f.path, ...(f.fromLine !== undefined ? { fromLine: f.fromLine } : {}), ...(f.lines !== undefined ? { lines: f.lines } : {}) })
      }
      const answer = files.length === 0 ? { ok: true, files: [] } : await runHelper(exe, { op: 'readMany', files, maxBytesEach: 60_000 }, context.signal)
      if (answer.ok !== true) return { content: answer.error ?? 'Reading failed.', isError: true }
      const parts = ((answer.files as { path: string; lines?: string[]; startLine?: number; more?: boolean; binary?: boolean; error?: string; size?: number }[]) ?? []).map((f, i) => {
        const asked = files[i]?.asked ?? f.path
        if (f.error !== undefined) return `## ${asked}\nCould not read: ${f.error}`
        if (f.binary === true) return `## ${asked}\nBinary file (${formatBytes(f.size ?? 0)}) — not shown. Use big_file inspect or query_table for spreadsheets.`
        context.readFiles.add(normalizeForComparison(f.path))
        const start = f.startLine ?? 1
        const body = (f.lines ?? []).map((line, n) => `${String(start + n).padStart(6)}\t${line}`).join('\n')
        return `## ${asked}\n${body}${f.more === true ? `\n… more follows; read on with fromLine ${String(start + (f.lines?.length ?? 0))}.` : ''}`
      })
      return { content: [...parts, ...(refused.length > 0 ? [`## Not read\n${refused.join('\n')}`] : [])].join('\n\n') }
    },
  }

  const bigFileTool: Tool<z.infer<typeof bigFileSchema>> = {
    name: 'big_file',
    group: 'read',
    description:
      'Work through a large file — a log, a data export, a CSV of millions of rows — without loading it: "inspect" ' +
      'gives size, line count, the first lines and (for CSV/Excel) the columns and types; "lines" reads any window; ' +
      '"tail" reads the end; "search" runs a regular expression over the whole file on every CPU core and returns ' +
      'matching lines with numbers and context. Start with inspect, then read or search part by part.',
    parametersSchema: bigFileSchema,
    async execute(params, context): Promise<ToolResult> {
      const r = await readable(context, params.path)
      if (!r.ok) return { content: r.message, isError: true, path: params.path }
      if (params.action === 'search' && (params.pattern ?? '').length === 0) {
        return { content: 'search needs a pattern.', isError: true, path: params.path }
      }
      const request =
        params.action === 'inspect'
          ? { op: 'inspect', path: r.path }
          : params.action === 'lines'
            ? { op: 'lines', path: r.path, from: params.fromLine ?? 1, count: params.count ?? 200 }
            : params.action === 'tail'
              ? { op: 'tail', path: r.path, count: params.count ?? 100 }
              : { op: 'grep', path: r.path, pattern: params.pattern, caseSensitive: params.caseSensitive, context: params.context ?? 0, limit: params.limit ?? 100 }
      const answer = await runHelper(exe, request, context.signal)
      if (answer.ok !== true) return { content: answer.error ?? 'Failed.', isError: true, path: params.path }
      if (params.action === 'inspect') {
        const table = answer.table as { delimiter: string; columns: string[]; types: string[] } | undefined
        const sheets = answer.sheets as { sheet: string; rows: number; columns: number; header: string[] }[] | undefined
        const lines = [
          `${params.path}: ${formatBytes(answer.size as number)}, modified ${when(answer.modified)}${answer.kind === 'text' ? `, ${String(answer.lines)} lines` : ''} (${String(answer.kind)}).`,
        ]
        if (Array.isArray(answer.firstLines)) lines.push('', 'First lines:', ...(answer.firstLines as string[]).map((l) => `  ${l}`))
        if (table !== undefined) lines.push('', `Table (delimiter "${table.delimiter}"): ${table.columns.map((c, i) => `${c} [${table.types[i] ?? '?'}]`).join(', ')}`, 'Query it with query_table.')
        if (sheets !== undefined) lines.push('', ...sheets.map((s) => `Sheet "${s.sheet}": ${String(s.rows)} rows × ${String(s.columns)} columns; header: ${s.header.join(', ')}`), 'Query a sheet with query_table.')
        return { content: lines.join('\n'), path: params.path }
      }
      if (params.action === 'search') {
        const matches = (answer.matches as { line: number; text: string; before: string[]; after: string[] }[]) ?? []
        const text = matches
          .map((m) => [...m.before.map((b, i) => `${String(m.line - m.before.length + i).padStart(8)}  ${b}`), `${String(m.line).padStart(8)}> ${m.text}`, ...m.after.map((a, i) => `${String(m.line + 1 + i).padStart(8)}  ${a}`)].join('\n'))
          .join('\n--\n')
        return { content: `${matches.length === 0 ? 'No matches.' : text}\n\n${answer.limitReached === true ? `At least ${String(answer.matchCount)} matches` : `${String(answer.matchCount)} matches`} in ${String(answer.lines)} lines.`, path: params.path }
      }
      const lines = (answer.lines as string[]) ?? []
      if (params.action === 'tail') return { content: lines.join('\n'), path: params.path }
      const start = (answer.startLine as number | undefined) ?? 1
      return {
        content: `${lines.map((l, n) => `${String(start + n).padStart(8)}\t${l}`).join('\n')}${answer.more === true ? `\n… continue with fromLine ${String(start + lines.length)}.` : ''}`,
        path: params.path,
      }
    },
  }

  const tableTool: Tool<z.infer<typeof tableSchema>> = {
    name: 'query_table',
    group: 'read',
    description:
      'Query a CSV/TSV file or an Excel sheet of any size without reading it all: choose columns, filter rows, group ' +
      'with count/sum/avg/min/max/distinct, sort, and page with offset/limit. Runs on every CPU core and returns only ' +
      'the small result. Use big_file inspect first to learn the column names.',
    parametersSchema: tableSchema,
    async execute(params, context): Promise<ToolResult> {
      const r = await readable(context, params.path)
      if (!r.ok) return { content: r.message, isError: true, path: params.path }
      const answer = await runHelper(exe, { op: 'table', ...params, path: r.path }, context.signal)
      if (answer.ok !== true) return { content: answer.error ?? 'The query failed.', isError: true, path: params.path }
      const columns = (answer.columns as string[]) ?? []
      const rows = (answer.rows as unknown[][]) ?? []
      const cell = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v).replace(/\|/g, '\\|'))
      const table = [`| ${columns.join(' | ')} |`, `|${columns.map(() => ' --- ').join('|')}|`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n')
      const offset = (answer.offset as number) ?? 0
      return {
        content:
          `${rows.length === 0 ? 'No rows matched.' : table}\n\n` +
          `Rows ${String(offset + 1)}–${String(offset + rows.length)} of ${String(answer.resultRows)} result rows; ` +
          `${String(answer.matchedRows)} of ${String(answer.scannedRows)} data rows matched the filters.` +
          (answer.more === true ? ` More: offset ${String(offset + rows.length)}.` : ''),
        path: params.path,
      }
    },
  }

  return [findTool, readManyTool, bigFileTool, tableTool] as unknown as Tool[]
}
