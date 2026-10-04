import { spawn } from 'node:child_process'
import { z } from 'zod'
import { isSecretPath, SECRET_FOLDERS } from '../fs/reach.js'
import { formatBytes } from './largeFile.js'
import { resolveToolPath } from './paths.js'
import { recordRead } from './readStamps.js'
import type { Tool, ToolExecutionContext, ToolResult } from './types.js'

/**
 * File tools backed by `sun-fs`, Sun Code's parallel Rust helper (`HostServices.fastFs`).
 *
 * Absent wherever the host has no helper - the VS Code extension, a plain Node host - rather than
 * present and failing. Four only **read**. The fifth, `transfer_files` (copy and move), is the one
 * write here: it is in `ALWAYS_ASK_TOOLS`, never available to a schedule, and its approval is the
 * plan the helper computes without touching anything - every source, destination, file count, size,
 * and each file that would be replaced.
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

/** The tools, for a host that ships `sun-fs`. */
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

  return [findTool, readManyTool, bigFileTool, tableTool, transferTool, archiveTool] as unknown as Tool[]
}
