import { spawn } from 'node:child_process'
import { z } from 'zod'
import { isSecretPath, SECRET_FOLDERS } from '../fs/reach.js'
import { jsonRecords } from '../agent/truncate.js'
import { formatBytes } from './largeFile.js'
import { resolveToolPath } from './paths.js'
import { recordRead } from './readStamps.js'
import type { Tool, ToolExecutionContext, ToolResult } from './types.js'

/**
 * File tools backed by `fire-fs`, Fire Code's parallel Rust helper (`HostServices.fastFs`).
 *
 * Absent wherever the host has no helper - the VS Code extension, a plain Node host - rather than
 * present and failing. Five only **read** - `query_sqlite` among them, which never creates a database
 * and never locks one (`apps/sun/native/src/sqlite_read.rs` says how). The fifth, `transfer_files` (copy and move), is the one
 * write here: it is in `ALWAYS_ASK_TOOLS`, never available to a schedule, and its approval is the
 * plan the helper computes without touching anything - every source, destination, file count, size,
 * and each file that would be replaced.
 *
 * Every path goes through `resolveToolPath` first, so the deny list, the workspace rules and Fire Code's
 * "reach anywhere" floor (`fs/reach.ts`) apply exactly as they do to `read_file`; the helper is
 * handed only what already passed. Folders holding credentials are not even walked, and results are
 * filtered again on the way back, because a walk discovers paths nobody named.
 */

interface HelperAnswer {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

/** One request to the helper. Exported for the Node host's `@` search. */
export function runFastFs(exe: string, request: object, signal?: AbortSignal): Promise<HelperAnswer> {
  return runHelper(exe, request, signal)
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

const grepSchema = z.object({
  pattern: z.string().min(1).describe('A regular expression (or plain text with literal: true). Case-insensitive unless it has a capital letter.'),
  roots: z.array(z.string().min(1)).min(1).max(20).describe('Folders or files to search: workspace-relative, absolute, another drive, or shares like \\\\server\\share\\folder - several at once.'),
  literal: z.boolean().optional().describe('Search for the text exactly as written, not as a regular expression.'),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  names: z.array(z.string()).optional().describe('Only files whose names match these patterns (* and ?), e.g. ["*.log", "*.py"].'),
  extensions: z.array(z.string()).optional().describe('e.g. ["py", "sql"].'),
  modifiedAfter: dateSchema,
  modifiedBefore: dateSchema,
  context: z.number().int().min(0).max(10).optional().describe('Lines before and after each match.'),
  filesOnly: z.boolean().optional().describe('List the matching files with a count each, not the lines.'),
  includeHidden: z.boolean().optional(),
  respectGitignore: z.boolean().optional().describe('Skip what .gitignore excludes (default true).'),
  maxPerFile: z.number().int().min(1).max(1000).optional().describe('Matches shown per file (default 50).'),
  limit: z.number().int().min(1).max(5000).optional().describe('Matches in all (default 300).'),
})

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

const sqliteSchema = z.object({
  action: z.enum(['schema', 'query', 'scan', 'search']).describe(
    'schema: tables, views, columns, indexes and row counts - start here. query: one read-only SQL statement (SELECT/WITH/EXPLAIN). ' +
      'scan: one table filtered, grouped (count/sum/avg/min/max/distinct), sorted and paged, split across every CPU core - for big tables. ' +
      'search: find text in any column of any table.',
  ),
  path: z.string().min(1).describe('The SQLite database file (.db, .sqlite, .sqlite3, ...). It must exist - nothing is ever created.'),
  sql: z.string().optional().describe('query: the statement. Only reading statements run.'),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('query: values for ? placeholders.'),
  table: z.string().optional().describe('scan: the table or view.'),
  columns: z.array(z.string()).optional().describe('scan: columns to return, without grouping (default all).'),
  filters: tableSchema.shape.filters,
  groupBy: z.array(z.string()).optional().describe('scan: group by these columns.'),
  aggregates: tableSchema.shape.aggregates,
  sort: z.array(z.object({ column: z.string(), desc: z.boolean().optional() })).optional().describe('scan: by column, or by result column such as "sum(amount)" when grouping.'),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(5000).optional().describe('Rows to return (query default 200, scan 50, search 100).'),
  text: z.string().optional().describe('search: the text to find, case-insensitive.'),
  tables: z.array(z.string()).optional().describe('search: only these tables.'),
  counts: z.boolean().optional().describe('schema: count rows in every table (default true).'),
})

const dataframeSchema = z.object({
  action: z.enum(['describe', 'sql']).describe(
    'describe: each source\'s columns, their types, empty counts and first rows - start here. sql: query the sources ' +
      '(joins, GROUP BY, window functions, CASE...) and optionally pivot the result.',
  ),
  sources: z
    .array(
      z.object({
        name: z.string().describe('The table name to use in SQL, e.g. trades (letters, digits, _).'),
        path: z
          .string()
          .optional()
          .describe('A .csv/.tsv/.txt or other delimited file, an Excel workbook (.xlsx, .xlsm, .xlsb, .xls, .ods), a .json/.jsonl file of records, or with `sqlite` the database file.'),
        result: z
          .string()
          .optional()
          .describe('The handle of a truncated tool result holding JSON records (from its "Output truncated" note): read in full from where it was saved, never retyped.'),
        rows: z
          .array(z.record(z.string(), z.unknown()))
          .max(100_000)
          .optional()
          .describe('Records you already have - results from another tool, an API response - as a list of objects; every key becomes a column.'),
        sqlite: z
          .object({
            table: z.string().optional().describe('A whole table.'),
            sql: z.string().optional().describe('Or one read-only query, e.g. to filter before joining.'),
          })
          .optional()
          .describe('Read from the SQLite database at `path` (never created, never locked).'),
        clipboard: z.boolean().optional().describe('Read what the user copied (e.g. cells copied in Excel) instead of a file.'),
        sheet: z.string().optional().describe('Workbook sheet (default: the first).'),
        delimiter: z.string().optional().describe('Delimited text: the separator (detected when omitted; "tab" for tab).'),
        header: z.boolean().optional().describe('First row holds the column names (default true).'),
        skipRows: z.number().int().min(0).optional().describe('Rows to skip before the header, e.g. a title block.'),
      }),
    )
    .min(1)
    .max(20),
  steps: z
    .array(z.object({ name: z.string(), sql: z.string() }))
    .max(20)
    .optional()
    .describe(
      'sql: named intermediate results, run in order before `sql`; each becomes a table the later steps and `sql` can ' +
        'join and alias like a source (e.g. totals per owner, then join people). Use these instead of WITH ... AS when ' +
        'the result needs an alias - an aliased WITH step is not supported.',
    ),
  sql: z.string().optional().describe('sql: a SELECT over the source names. Quote odd column names with "double quotes".'),
  pivot: z
    .object({
      index: z.array(z.string()).optional().describe('Columns that stay as rows.'),
      columns: z.string().describe('The column whose values become new columns.'),
      values: z.string().describe('The column aggregated into each cell.'),
      agg: z.enum(['sum', 'count', 'avg', 'min', 'max', 'first', 'last']).optional().describe('Default sum.'),
    })
    .optional()
    .describe('sql: turn the result (or the first source, without sql) wide.'),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(5000).optional().describe('Rows to return (default 50).'),
})

const transferSchema = z.object({
  action: z.enum(['copy', 'move']).describe('copy leaves the source; move removes it once everything is copied.'),
  items: z
    .array(z.object({ from: z.string().min(1), to: z.string().min(1).describe('The full destination path: the new folder or file, not its parent.') }))
    .min(1)
    .max(50),
  overwrite: z
    .boolean()
    .optional()
    .describe('Replace files that already exist at the destination. Without it, nothing is changed when any exists.'),
})
type TransferParams = z.infer<typeof transferSchema>

interface PlannedItem {
  from: string
  to: string
  folder: boolean
  files: number
  bytes: number
  replaces: string[]
  replaceCount: number
  rename: boolean
}

/** Sources and destinations, each through the same rules as any read or write. */
async function transferPaths(
  context: ToolExecutionContext,
  params: TransferParams,
): Promise<{ ok: true; items: { from: string; to: string }[]; outside: boolean } | { ok: false; message: string }> {
  const items: { from: string; to: string }[] = []
  let outside = false
  for (const item of params.items) {
    // A move deletes its source, so the source is held to the write rules too.
    const from = await resolveToolPath(context, item.from, params.action === 'move' ? { write: true } : {})
    if (!from.ok) return from
    const to = await resolveToolPath(context, item.to, { write: true })
    if (!to.ok) return to
    if (isSecretPath(from.realPath) || isSecretPath(to.realPath)) {
      return { ok: false, message: `"${item.from}" → "${item.to}" touches a folder that holds keys or credentials.` }
    }
    outside ||= to.outsideWorkspace === true || from.outsideWorkspace === true
    items.push({ from: from.realPath, to: to.realPath })
  }
  return { ok: true, items, outside }
}

function describePlan(params: TransferParams, plan: PlannedItem[], outside: boolean): string {
  const verb = params.action === 'move' ? 'Move' : 'Copy'
  const files = plan.reduce((n, p) => n + p.files, 0)
  const bytes = plan.reduce((n, p) => n + p.bytes, 0)
  const replacing = plan.reduce((n, p) => n + p.replaceCount, 0)
  const lines = [`${verb} ${String(plan.length)} item${plan.length === 1 ? '' : 's'}: ${files.toLocaleString('en')} file${files === 1 ? '' : 's'}, ${formatBytes(bytes)}`, '']
  for (const p of plan) {
    lines.push(`  ${p.from}  (${p.folder ? `folder, ${p.files.toLocaleString('en')} files` : 'file'}, ${formatBytes(p.bytes)})`)
    lines.push(`    → ${p.to}${params.action === 'move' && p.rename ? '   [rename: same drive, instant]' : ''}`)
    if (p.replaceCount > 0) {
      lines.push(`    ${params.overwrite === true ? 'REPLACES' : 'already exists, so nothing will be changed'}: ${String(p.replaceCount)} file(s)`)
      for (const r of p.replaces) lines.push(`      ${r}`)
      if (p.replaceCount > p.replaces.length) lines.push(`      … and ${String(p.replaceCount - p.replaces.length)} more`)
    }
  }
  lines.push('')
  if (replacing > 0 && params.overwrite !== true) lines.push('Some destinations exist and overwrite was not asked for: approving changes nothing and says which.')
  if (params.action === 'move') lines.push('A move across drives copies everything, checks it, and only then removes the source.')
  if (outside) lines.push('Outside the codebase: Rollback cannot undo this part.')
  return lines.join('\n')
}

const archiveSchema = z.object({
  action: z.enum(['create', 'extract', 'list']).describe('create a .zip from files and folders; extract one into a folder; list what one holds.'),
  archive: z.string().min(1).describe('The .zip file.'),
  sources: z.array(z.string().min(1)).max(50).optional().describe('create: the files and folders to put in it. A folder keeps its name inside the archive.'),
  to: z.string().optional().describe('extract: the folder to extract into.'),
  overwrite: z.boolean().optional().describe('create: replace an existing .zip. extract: replace files that already exist.'),
})
type ArchiveParams = z.infer<typeof archiveSchema>

/** The tools, for a host that ships `fire-fs`. */
/** The helper's search answer as text: path:line: text, context indented, then what was not read. */
export function formatGrepAnswer(answer: HelperAnswer, allowed: ReadonlySet<string>): string {
  type Hit = { line: number; text: string; before?: string[]; after?: string[] }
  const files = ((answer.files as { path: string; matches: number; hits: Hit[] }[]) ?? []).filter((f) => allowed.has(f.path))
  const out: string[] = []
  for (const file of files) {
    if (file.hits.length === 0) {
      out.push(`${file.path}: ${String(file.matches)} match${file.matches === 1 ? '' : 'es'}`)
      continue
    }
    out.push(`${file.path} (${String(file.matches)} match${file.matches === 1 ? '' : 'es'})`)
    for (const hit of file.hits) {
      for (const [i, line] of (hit.before ?? []).entries()) out.push(`  ${String(hit.line - (hit.before ?? []).length + i)}-  ${line}`)
      out.push(`  ${String(hit.line)}:  ${hit.text}`)
      for (const [i, line] of (hit.after ?? []).entries()) out.push(`  ${String(hit.line + 1 + i)}-  ${line}`)
    }
    if (file.hits.length < file.matches) out.push(`  ... ${String(file.matches - file.hits.length)} more in this file`)
  }
  const unreadable = (answer.unreadablePaths as string[] | undefined) ?? []
  const summary =
    `${String(answer.matchedFiles)} file(s) matched of ${String(answer.searchedFiles)} searched, ${String(answer.elapsedMs)} ms.` +
    (Number(answer.skippedBinary) > 0 ? ` ${String(answer.skippedBinary)} binary file(s) skipped.` : '') +
    (Number(answer.skippedLarge) > 0 ? ` ${String(answer.skippedLarge)} file(s) over 50 MB skipped - use big_file for those.` : '') +
    (answer.limitReached === true ? ' The match limit was reached; more exist - narrow the pattern or raise limit.' : '') +
    (answer.timedOut === true ? ' Stopped at the time limit, so this is partial.' : '')
  return [
    files.length === 0 ? 'No matches.' : out.join('\n'),
    '',
    summary,
    ...(Number(answer.unreadable) > 0
      ? [`${String(answer.unreadable)} file(s) or folder(s) could not be read:`, ...unreadable.map((u) => `  ${u}`)]
      : []),
  ].join('\n')
}

/** The helper's SQLite answer as text for the model. Exported for tests. */
export function formatSqliteAnswer(params: { action: string; text?: string | undefined }, answer: HelperAnswer): string {
  const notes: string[] = []
  if (answer.consistent === false) {
    notes.push(
      'WARNING: the database was being written while this was read and stayed busy through several retries - these ' +
        'results may mix data from before and after a change. Run it again if it matters.',
    )
  }
  notes.push(`Access: ${String(answer.access)}.`)
  const cell = (v: unknown): string =>
    v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const grid = (columns: string[], rows: unknown[][]): string =>
    [`| ${columns.join(' | ')} |`, `|${columns.map(() => ' --- ').join('|')}|`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n')
  let body: string
  if (params.action === 'schema') {
    const tables =
      (answer.tables as { name: string; kind: string; rows: number | null; columns: { name: string; type: string; primaryKey: boolean }[]; indexes: { name: string }[] }[]) ?? []
    body =
      tables.length === 0
        ? 'The database has no tables.'
        : tables
            .map(
              (t) =>
                `${t.kind === 'view' ? 'VIEW' : 'TABLE'} ${t.name}${typeof t.rows === 'number' ? ` (${String(t.rows)} rows)` : ''}\n  ` +
                t.columns.map((c) => `${c.name}${c.type.length > 0 ? ` ${c.type}` : ''}${c.primaryKey ? ' PK' : ''}`).join(', ') +
                (t.indexes.length > 0 ? `\n  indexes: ${t.indexes.map((i) => i.name).join(', ')}` : ''),
            )
            .join('\n')
    notes.push(`Journal mode: ${String(answer.journalMode)}.`)
  } else if (params.action === 'search') {
    const hits = (answer.hits as { table: string; rowid: unknown; column: string; value: string }[]) ?? []
    body =
      hits.length === 0
        ? `"${params.text ?? ''}" was not found.`
        : hits.map((h) => `${h.table}${h.rowid !== null ? ` rowid ${String(h.rowid)}` : ''} . ${h.column}: ${h.value}`).join('\n') +
          `\n\n${String(answer.matchedRows)} matching rows in ${String(answer.tables)} tables searched; ${String(hits.length)} hits shown.`
  } else {
    const columns = (answer.columns as string[]) ?? []
    const rows = (answer.rows as unknown[][]) ?? []
    body = rows.length === 0 ? 'No rows.' : grid(columns, rows)
    if (params.action === 'scan') {
      const offset = (answer.offset as number) ?? 0
      body +=
        `\n\nRows ${String(offset + 1)}-${String(offset + rows.length)} of ${String(answer.resultRows)} result rows; ${String(answer.matchedRows)} table rows matched.` +
        (answer.more === true ? ` More: offset ${String(offset + rows.length)}.` : '') +
        ` Read in ${String(answer.ranges)} parallel ranges, ${String(answer.ms)} ms.`
    } else if (answer.more === true) {
      body += `\n\nMore rows exist; ${String(rows.length)} shown. Raise limit, add a WHERE, or use scan for paging.`
    }
  }
  return `${body}\n\n${notes.join(' ')}`
}

/** The helper operation each tool needs, so a host offers only what the installed helper answers. */
export const FAST_FS_TOOL_OPS: Readonly<Record<string, string>> = {
  find_files: 'find',
  grep_files: 'search',
  read_many_files: 'readMany',
  big_file: 'inspect',
  query_table: 'table',
  query_sqlite: 'sqlite',
  dataframe: 'dataframe',
  transfer_files: 'transfer',
  archive_files: 'archive',
}

/** `ops` is what the helper reported (`fastFsCapabilities`); without it every tool is offered. */
/** The helper's dataframe answer as text for the model. Exported for tests. */
export function formatDataframeAnswer(action: string, answer: HelperAnswer): string {
  const cell = (v: unknown): string =>
    v === null || v === undefined ? '' : typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const grid = (columns: string[], rows: unknown[][]): string =>
    [`| ${columns.join(' | ')} |`, `|${columns.map(() => ' --- ').join('|')}|`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n')
  type Col = { name: string; type: string; nulls: number }
  const notes = (answer.notes as string[] | undefined) ?? []
  const parts: string[] = []
  if (action === 'describe') {
    for (const t of (answer.tables as { name: string; rows: number; columns: Col[]; head: unknown[][] }[]) ?? []) {
      parts.push(`${t.name}: ${String(t.rows)} rows`)
      parts.push(t.columns.map((c) => `  ${c.name}: ${c.type}${c.nulls > 0 ? ` (${String(c.nulls)} empty)` : ''}`).join('\n'))
      if (t.head.length > 0) parts.push(grid(t.columns.map((c) => c.name), t.head))
      parts.push('')
    }
  } else {
    const columns = (answer.columns as Col[]) ?? []
    const rows = (answer.rows as unknown[][]) ?? []
    const offset = (answer.offset as number) ?? 0
    parts.push(rows.length === 0 ? 'No rows.' : grid(columns.map((c) => c.name), rows))
    parts.push(
      `\nRows ${String(offset + 1)}-${String(offset + rows.length)} of ${String(answer.resultRows)}` +
        (answer.more === true ? `; more at offset ${String(offset + rows.length)}` : '') +
        `. Types: ${columns.map((c) => `${c.name} ${c.type}`).join(', ')}. ${String(answer.ms)} ms.`,
    )
  }
  if (notes.length > 0) parts.push(`\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}`)
  return parts.join('\n')
}

export interface FastFsOptions {
  /** The full text of a truncated tool result, by handle - `dataframe`'s `result` source. */
  readResult?: (handle: string) => Promise<string | undefined>
}

export function createFastFsTools(exe: string, ops?: ReadonlySet<string>, options: FastFsOptions = {}): Tool[] {
  return allFastFsTools(exe, options).filter((tool) => ops === undefined || ops.has(FAST_FS_TOOL_OPS[tool.name] ?? tool.name))
}

function allFastFsTools(exe: string, options: FastFsOptions = {}): Tool[] {
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
        (typeof answer.unreadable === 'number' && answer.unreadable > 0
          ? `; ${String(answer.unreadable)} could not be read:\n${((answer.unreadablePaths as string[] | undefined) ?? []).map((u) => `  ${u}`).join('\n')}`
          : '.')
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
        void recordRead(context, f.path)
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

  const grepTool: Tool<z.infer<typeof grepSchema>> = {
    name: 'grep_files',
    group: 'read',
    description:
      'Search the contents of files for text or a regular expression across several folders, drives and network ' +
      'shares at once, on every CPU core - filtered by file name, extension and date first. Reads UTF-16 files too, ' +
      'and names every file or folder it could not read and why. Use for searching outside the workspace or across ' +
      'many roots; search_files is fine inside the workspace.',
    parametersSchema: grepSchema,
    async execute(params, context): Promise<ToolResult> {
      const roots: string[] = []
      for (const root of params.roots) {
        const r = await readable(context, root)
        if (!r.ok) return { content: r.message, isError: true }
        roots.push(r.path)
      }
      const answer = await runHelper(
        exe,
        {
          op: 'search',
          roots,
          skip: SECRET_FOLDERS,
          pattern: params.pattern,
          literal: params.literal,
          caseSensitive: params.caseSensitive,
          wholeWord: params.wholeWord,
          names: params.names,
          extensions: params.extensions,
          modifiedAfter: toMs(params.modifiedAfter),
          modifiedBefore: toMs(params.modifiedBefore),
          context: params.context,
          filesOnly: params.filesOnly,
          includeHidden: params.includeHidden,
          gitignore: params.respectGitignore ?? true,
          maxPerFile: params.maxPerFile,
          limit: params.limit,
        },
        context.signal,
      )
      if (answer.ok !== true) return { content: answer.error ?? 'The search failed.', isError: true }
      return { content: formatGrepAnswer(answer, await allowedResults(context, ((answer.files as { path: string }[]) ?? []).map((f) => f.path))) }
    },
  }

  const sqliteTool: Tool<z.infer<typeof sqliteSchema>> = {
    name: 'query_sqlite',
    group: 'read',
    description:
      'Read a SQLite database without creating it and without blocking the program that uses it: schema (tables, ' +
      'columns, indexes, row counts), query (one read-only SQL statement), scan (filter/group/sort a big table on ' +
      'every CPU core), search (text anywhere in the database). Use instead of python or a sqlite3 shell. A missing ' +
      'file is reported, never created; writes are refused.',
    parametersSchema: sqliteSchema,
    async execute(params, context): Promise<ToolResult> {
      const r = await readable(context, params.path)
      if (!r.ok) return { content: r.message, isError: true, path: params.path }
      const answer = await runHelper(exe, { op: 'sqlite', ...params, path: r.path }, context.signal)
      if (answer.ok !== true) return { content: answer.error ?? 'The SQLite read failed.', isError: true, path: params.path }
      return { content: formatSqliteAnswer(params, answer), path: params.path }
    },
  }

  const dataframeTool: Tool<z.infer<typeof dataframeSchema>> = {
    name: 'dataframe',
    group: 'read',
    description:
      'Data analysis with Polars (Rust, every CPU core) over CSV/delimited files, Excel sheets, the clipboard, JSON ' +
      'files, SQLite tables or queries, and records you already have (`rows`: e.g. results from another tool) - name each ' +
      'source and query them together with SQL: joins across sources, GROUP BY, window functions - and pivot. ' +
      'Reading is forgiving: every value is kept, and a column becomes numbers or dates only when all of it converts ' +
      '(the answer says which columns stayed text and why). Use instead of writing pandas or opening Excel.',
    parametersSchema: dataframeSchema,
    async execute(params, context): Promise<ToolResult> {
      const sources = []
      for (const source of params.sources) {
        if (source.path !== undefined) {
          const r = await readable(context, source.path)
          if (!r.ok) return { content: r.message, isError: true, path: source.path }
          sources.push({ ...source, path: r.path })
        } else if (source.result !== undefined) {
          // Read from where the loop saved it, so a large payload never passes back through the model.
          const saved = options.readResult === undefined ? undefined : await options.readResult(source.result)
          if (saved === undefined) return { content: `No saved tool result has the handle "${source.result}".`, isError: true }
          const records = jsonRecords(saved)
          if (records === undefined) return { content: `The tool result "${source.result}" is not a list of JSON records, so it cannot be a table.`, isError: true }
          // `result` is dropped on the way (undefined is not serialised); the helper only sees rows.
          sources.push({ ...source, result: undefined, rows: records })
        } else if (source.clipboard === true || source.rows !== undefined) {
          sources.push(source)
        } else {
          return { content: `Source "${source.name}" needs a path, rows, a saved tool result, or clipboard: true.`, isError: true }
        }
      }
      const answer = await runHelper(exe, { op: 'dataframe', ...params, sources }, context.signal)
      if (answer.ok !== true) return { content: answer.error ?? 'The dataframe operation failed.', isError: true }
      return { content: formatDataframeAnswer(params.action, answer) }
    },
  }

  const transferTool: Tool<TransferParams> = {
    name: 'transfer_files',
    group: 'edit',
    description:
      'Copy or move files and whole folders fast - every CPU core copies at once, and a move within one drive is an ' +
      'instant rename however large the folder. Always asks first, showing every source, destination, file count, ' +
      'size and anything it would replace. Give the full destination path (the new folder or file name). Prefer it ' +
      'to shell copy/move commands for anything bigger than a few files.',
    parametersSchema: transferSchema,
    async preview(params, context) {
      const paths = await transferPaths(context, params)
      if (!paths.ok) return { kind: 'text', text: paths.message }
      const answer = await runHelper(exe, { op: 'transfer', plan: true, action: params.action, overwrite: params.overwrite === true, items: paths.items })
      if (answer.ok !== true) return { kind: 'text', text: `Could not plan this: ${answer.error ?? 'unknown error'}` }
      return { kind: 'text', text: describePlan(params, answer.plan as PlannedItem[], paths.outside) }
    },
    async execute(params, context): Promise<ToolResult> {
      const paths = await transferPaths(context, params)
      if (!paths.ok) return { content: paths.message, isError: true }
      const answer = await runHelper(exe, { op: 'transfer', action: params.action, overwrite: params.overwrite === true, items: paths.items }, context.signal)
      if (answer.ok !== true && answer.files === undefined) return { content: answer.error ?? 'Nothing was copied.', isError: true }
      for (const item of paths.items) context.changedFiles?.add(item.to)
      const errors = (answer.errors as string[] | undefined) ?? []
      const verb = params.action === 'move' ? 'Moved' : 'Copied'
      return {
        content:
          `${verb} ${Number(answer.files).toLocaleString('en')} file(s), ${formatBytes(Number(answer.bytes))}, in ${(Number(answer.ms) / 1000).toFixed(1)} s` +
          (Number(answer.renamed) > 0 ? ` (${String(answer.renamed)} by rename)` : '') +
          '.' +
          (errors.length > 0 ? `\n\nProblems:\n${errors.map((e) => `- ${e}`).join('\n')}` : ''),
        ...(errors.length > 0 ? { isError: true } : {}),
      }
    },
  }

  /** Paths for an archive request, through the same rules as any read or write. */
  const archivePaths = async (
    context: ToolExecutionContext,
    params: ArchiveParams,
  ): Promise<{ ok: true; request: Record<string, unknown>; outside: boolean } | { ok: false; message: string }> => {
    const zipPath = await resolveToolPath(context, params.archive, params.action === 'create' ? { write: true } : {})
    if (!zipPath.ok) return zipPath
    if (!/\.zip$/i.test(zipPath.realPath)) return { ok: false, message: `${params.archive} is not a .zip file.` }
    let outside = zipPath.outsideWorkspace === true
    const request: Record<string, unknown> = { op: 'archive', action: params.action, archive: zipPath.realPath, overwrite: params.overwrite === true }
    if (params.action === 'create') {
      if ((params.sources ?? []).length === 0) return { ok: false, message: 'Name the files or folders to archive in sources.' }
      const sources: string[] = []
      for (const s of params.sources ?? []) {
        const r = await readable(context, s)
        if (!r.ok) return r
        sources.push(r.path)
      }
      request.sources = sources
    } else if (params.action === 'extract') {
      if (params.to === undefined) return { ok: false, message: 'Name the folder to extract into with to.' }
      const to = await resolveToolPath(context, params.to, { write: true })
      if (!to.ok) return to
      if (isSecretPath(to.realPath)) return { ok: false, message: `"${params.to}" holds keys or credentials.` }
      outside ||= to.outsideWorkspace === true
      request.to = to.realPath
    }
    return { ok: true, request, outside }
  }

  const archiveTool: Tool<ArchiveParams> = {
    name: 'archive_files',
    group: 'edit',
    description:
      'Zip files and folders, extract a .zip, or list what one holds. Creating and extracting always ask first, ' +
      'showing what goes in or comes out and anything replaced. An archive whose entries would land outside the ' +
      'destination folder is refused whole.',
    parametersSchema: archiveSchema,
    async preview(params, context) {
      const paths = await archivePaths(context, params)
      if (!paths.ok) return { kind: 'text', text: paths.message }
      if (params.action === 'list') return { kind: 'text', text: `List the contents of ${String(paths.request.archive)}` }
      const plan = await runHelper(exe, { ...paths.request, plan: true })
      if (plan.ok !== true) return { kind: 'text', text: `Could not plan this: ${plan.error ?? 'unknown error'}` }
      const lines =
        params.action === 'create'
          ? [
              `Create ${String(paths.request.archive)}${plan.exists === true ? (params.overwrite === true ? '  (REPLACES the existing file)' : '  (already exists, so nothing will be changed)') : ''}`,
              `  from ${(paths.request.sources as string[]).join(', ')}`,
              `  ${Number(plan.files).toLocaleString('en')} file(s), ${formatBytes(Number(plan.bytes))} before compression`,
              ...((plan.sample as string[]) ?? []).map((n) => `    ${n}`),
            ]
          : [
              `Extract ${String(paths.request.archive)}`,
              `  into ${String(paths.request.to)}`,
              `  ${Number(plan.files).toLocaleString('en')} file(s), ${formatBytes(Number(plan.bytes))}`,
              ...(Number(plan.replaceCount) > 0
                ? [
                    `  ${params.overwrite === true ? 'REPLACES' : 'already exists, so nothing will be changed'}: ${String(plan.replaceCount)} file(s)`,
                    ...((plan.replaces as string[]) ?? []).map((n) => `    ${n}`),
                  ]
                : []),
            ]
      if (paths.outside) lines.push('', 'Outside the codebase: Rollback cannot undo this part.')
      return { kind: 'text', text: lines.join('\n') }
    },
    async execute(params, context): Promise<ToolResult> {
      const paths = await archivePaths(context, params)
      if (!paths.ok) return { content: paths.message, isError: true }
      const answer = await runHelper(exe, paths.request, context.signal)
      if (answer.ok !== true) return { content: answer.error ?? 'The archive operation failed.', isError: true }
      if (params.action === 'list') {
        const entries = (answer.entries as { name: string; size: number; dir: boolean }[]) ?? []
        return {
          content:
            `${String(answer.count)} entries, ${formatBytes(Number(answer.bytes))} (${formatBytes(Number(answer.packed))} packed):\n` +
            entries.map((e) => (e.dir ? `  ${e.name}` : `  ${e.name}  ${formatBytes(e.size)}`)).join('\n') +
            (Number(answer.count) > entries.length ? `\n  … and ${String(Number(answer.count) - entries.length)} more` : ''),
        }
      }
      if (params.action === 'create') {
        context.changedFiles?.add(String(paths.request.archive))
        return {
          content: `Created ${String(paths.request.archive)}: ${String(answer.files)} file(s), ${formatBytes(Number(answer.bytes))} → ${formatBytes(Number(answer.archiveBytes))}, in ${(Number(answer.ms) / 1000).toFixed(1)} s.`,
        }
      }
      context.changedFiles?.add(String(paths.request.to))
      return { content: `Extracted ${String(answer.files)} file(s), ${formatBytes(Number(answer.bytes))}, into ${String(paths.request.to)} in ${(Number(answer.ms) / 1000).toFixed(1)} s.` }
    },
  }

  return [findTool, grepTool, readManyTool, bigFileTool, tableTool, sqliteTool, dataframeTool, transferTool, archiveTool] as unknown as Tool[]
}

/**
 * What the model is told when these tools exist (Fire Code), every turn.
 *
 * Reported: "light code doesn't seem to know about the rust tools given to it by default, I had to
 * remind it". They were registered and advertised all along - but a model reaches for the tools it
 * has seen most (read_file, search_files) and, in Auto mode, for the shell commands its own guidance
 * recommends. A tool's description is read when choosing between tools that look relevant; this says
 * up front which job each one is for, and that it wins over the shell for that job.
 */
export function fastFsGuidance(ops?: ReadonlySet<string>): string {
  const offered = (name: string): boolean => ops === undefined || ops.has(FAST_FS_TOOL_OPS[name] ?? name)
  const entries: [string, string][] = [
    ['find_files', '- find_files: find files by name or pattern, list a large folder tree, sizes and counts (summary), duplicates.'],
    ['grep_files', '- grep_files: search file contents across several folders, drives or shares at once (regex or text,\n  with context); it also names anything it could not read. search_files is fine inside the workspace.'],
    ['read_many_files', '- read_many_files: read several files in one call instead of read_file after read_file.'],
    ['big_file', '- big_file: any file over a few MB, logs especially - inspect (lines, size), read a line range, tail, or search it\n  with a regex. Never read_file or type a big log.'],
    ['query_table', '- query_table: CSV or Excel - filter, group, count and sum rows without writing Python or opening Excel.'],
    ['query_sqlite', '- query_sqlite: a SQLite database - schema, read-only SQL, parallel filter/group of big tables, text search.\n  It never creates the file and never locks it; use it instead of python sqlite3 or the sqlite3 shell.'],
    ['dataframe', '- dataframe: data analysis with SQL over CSV, Excel, the clipboard, JSON, SQLite and records you already\n  have (rows) - join data from different sources, group, pivot. Forgiving with messy data. Use instead of pandas.'],
    ['transfer_files', '- transfer_files: copy or move files and folders (always asks first).'],
    ['archive_files', '- archive_files: create, extract or list a .zip.'],
  ]
  return [
    '## Fast file tools (prefer these - they run on every core)',
    'This workspace has Rust-backed file tools. Use them instead of shell commands (dir /s, type, findstr, grep, cat,',
    'copy, move, tar) and instead of reading files one at a time, whenever the job matches:',
    ...entries.filter(([name]) => offered(name)).map(([, line]) => line),
    'search_files is still right for searching code across the workspace; read_file before editing a file, as always.',
  ].join('\n')
}
