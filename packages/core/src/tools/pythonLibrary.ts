import { z } from 'zod'

import { runFastFs } from './fastFs.js'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolPreview, ToolResult } from './types.js'

/**
 * `python_library`: list, describe and call the functions of an installed Python library - the
 * quants' pricing modules, whose DLLs sit in a folder that has to be on the path - many calls at once.
 *
 * Asked for because of the GIL: threads in one interpreter take turns. Fire Code's Rust helper runs a
 * **pool of Python processes** instead (`apps/sun/native/src/pypool.rs`), each with its own interpreter
 * and GIL, each importing the library once and taking calls from a shared queue - so N workers really
 * run N calls at the same moment, whatever the library does with the GIL, without changing it.
 *
 * Running a library runs its code (and its DLLs) on this machine as the user, so every call is
 * `command` and asks first, showing the interpreter, the folders, the module, the function and every
 * argument set (invariant 8). Folders go through `resolveToolPath`, so the deny list applies.
 */

const callSchema = z.object({
  args: z.array(z.unknown()).optional().describe('Positional arguments.'),
  kwargs: z.record(z.string(), z.unknown()).optional().describe('Keyword arguments.'),
})

const schema = z.object({
  action: z.enum(['list', 'describe', 'call']).describe(
    'list: the functions, classes and submodules of a module (filter narrows by name). describe: one function\'s signature and documentation. ' +
      'call: run a function - once (args/kwargs) or many times in parallel worker processes (calls).',
  ),
  module: z.string().min(1).describe('The module to import, e.g. "pricinglib" or "pricinglib.bonds".'),
  folders: z.array(z.string().min(1)).max(20).optional().describe('Folders holding the library and its DLLs; added to sys.path and the DLL search path.'),
  function: z.string().optional().describe('describe/call: the function, e.g. "price_bond" or "Curve.zero" (a class\'s static method).'),
  filter: z.string().optional().describe('list: only names containing this.'),
  args: z.array(z.unknown()).optional().describe('call, once: positional arguments.'),
  kwargs: z.record(z.string(), z.unknown()).optional().describe('call, once: keyword arguments.'),
  calls: z.array(callSchema).max(200_000).optional().describe('call, many: one entry per call; run across worker processes, results in the same order.'),
  workers: z.number().int().min(1).max(64).optional().describe('Worker processes (default: one per CPU core, never more than calls).'),
  timeoutSec: z.number().min(0.1).max(3600).optional().describe('Per call (default 300). A call over it is stopped and its worker restarted.'),
  python: z.string().optional().describe('The Python interpreter the library is installed for, when it is not the default one.'),
})
type Params = z.infer<typeof schema>

export interface PythonLibraryOptions {
  exe: string
  launch: (requested?: string) => Promise<{ interpreter: string; env: NodeJS.ProcessEnv } | { problem: string }>
  /** Settings → Python → Library folders, used when a request names none. */
  savedFolders?: () => readonly string[]
}

const shown = (value: unknown): string => {
  const text = JSON.stringify(value)
  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}...` : text
}

export function createPythonLibraryTool(options: PythonLibraryOptions): Tool<Params> {
  const named = (params: Params): boolean => params.folders !== undefined && params.folders.length > 0
  const foldersFor = (params: Params): readonly string[] => (named(params) ? (params.folders ?? []) : (options.savedFolders?.() ?? []))
  return {
    name: 'python_library',
    group: 'command',
    description:
      'Use an installed Python library (e.g. pricing libraries whose DLLs are in a folder): list its functions, describe ' +
      'one, or call one - once, or many times at once in parallel worker processes (each its own interpreter, so the ' +
      'GIL does not serialise them). Give the folder with the library/DLLs when it is not installed in Python. Prefer ' +
      'one call with `calls` over many separate calls. If the module will not import and the user has not said where it ' +
      'is, ASK the user for the folder holding the library and its DLLs - never search drives for it. Asks before ' +
      'running, as the library\'s code runs on this machine.',
    parametersSchema: schema,

    async preview(params): Promise<ToolPreview> {
      const launch = await options.launch(params.python)
      const lines = [
        params.action === 'call'
          ? `RUN ${params.module}.${params.function ?? '?'} ${params.calls !== undefined ? `${String(params.calls.length)} times, in parallel worker processes` : 'once'}`
          : `${params.action === 'list' ? 'List' : 'Describe'} ${params.module}${params.function !== undefined ? `.${params.function}` : ''} (importing it runs its start-up code)`,
        `Python: ${'problem' in launch ? `(none found: ${launch.problem})` : launch.interpreter}`,
        `Folders: ${foldersFor(params).length > 0 ? `${foldersFor(params).join('; ')}${named(params) ? '' : ' (saved in Settings → Python)'}` : '(none - the library must be installed in that Python)'}`,
      ]
      if (params.action === 'call') {
        const calls = params.calls ?? [{ args: params.args, kwargs: params.kwargs }]
        lines.push('', 'Arguments:')
        calls.slice(0, 25).forEach((call, index) => {
          lines.push(`  ${String(index + 1)}. ${shown(call.args ?? [])}${call.kwargs !== undefined && Object.keys(call.kwargs).length > 0 ? ` ${shown(call.kwargs)}` : ''}`)
        })
        if (calls.length > 25) lines.push(`  ... and ${String(calls.length - 25)} more`)
      }
      return { kind: 'text', text: lines.join('\n') }
    },

    async execute(params, context): Promise<ToolResult> {
      const launch = await options.launch(params.python)
      if ('problem' in launch) return { content: launch.problem, isError: true }
      const folders: string[] = []
      for (const folder of foldersFor(params)) {
        const resolved = await resolveToolPath(context, folder)
        if (!resolved.ok) return { content: resolved.message, isError: true }
        folders.push(resolved.realPath)
      }
      if (params.action !== 'list' && (params.function === undefined || params.function.length === 0)) {
        return { content: 'Which function? Give `function`.', isError: true }
      }
      const env = Object.fromEntries(Object.entries(launch.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      const answer = await runFastFs(
        options.exe,
        {
          op: 'pypool',
          action: params.action,
          python: launch.interpreter,
          env,
          paths: folders,
          module: params.module,
          ...(params.function !== undefined ? { function: params.function } : {}),
          ...(params.filter !== undefined ? { filter: params.filter } : {}),
          ...(params.calls !== undefined ? { calls: params.calls } : { args: params.args ?? [], kwargs: params.kwargs ?? {} }),
          ...(params.workers !== undefined ? { workers: params.workers } : {}),
          ...(params.timeoutSec !== undefined ? { timeoutSec: params.timeoutSec } : {}),
          ...(context.workspaceRoot !== undefined ? { cwd: context.workspaceRoot } : {}),
        },
        context.signal,
      )
      if (answer.ok !== true) {
        const error = answer.error ?? 'The library call failed.'
        // The likeliest cause of a failed import is the folder, and the user knows where it is; the model does not.
        const where = !/ModuleNotFoundError|ImportError|DLL load failed/.test(error)
          ? ''
          : folders.length === 0
            ? '\n\nNo folder was given. Ask the user which folder holds this library and its DLLs (or to save it under Settings → Python → Library folders); do not search for it.'
            : `\n\nSearched: ${folders.join('; ')}. If that is not where the library and all of its DLLs are, ask the user for the right folder.`
        return { content: `${error}${where}`, isError: true }
      }
      return { content: formatLibraryAnswer(params, answer) }
    },
  }
}

/**
 * One result as text. Pricing functions return numbers, strings, or lists of lists - the grid an Excel
 * array formula would fill - so a rectangular list of rows is shown as a table (its first row as the
 * header when that row is all text and the rest is not), and a scalar as itself.
 */
export function renderValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return 'None'
  const rows = Array.isArray(value) && value.length > 0 && value.every((row) => Array.isArray(row)) ? (value as unknown[][]) : undefined
  const scalar = (v: unknown): boolean => v === null || ['number', 'string', 'boolean'].includes(typeof v)
  if (rows !== undefined && rows.every((row) => row.every(scalar))) {
    const width = Math.max(...rows.map((row) => row.length))
    const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).replace(/\|/g, '\\|'))
    const first = rows[0] ?? []
    const titled = rows.length > 1 && first.length > 0 && first.every((v) => typeof v === 'string') && rows.slice(1).some((row) => row.some((v) => typeof v === 'number'))
    const header = titled ? first.map(text) : Array.from({ length: width }, (_, i) => String(i + 1))
    const body = (titled ? rows.slice(1) : rows).map((row) => `| ${Array.from({ length: width }, (_, i) => text(row[i])).join(' | ')} |`)
    return [`| ${header.join(' | ')} |`, `|${header.map(() => ' --- ').join('|')}|`, ...body, '', `(${String(rows.length)} rows x ${String(width)} columns)`].join('\n')
  }
  return JSON.stringify(value, null, 2)
}

/** The helper's answer as text for the model. Exported for tests. */
export function formatLibraryAnswer(params: { action: string; module: string; function?: string | undefined }, answer: Record<string, unknown>): string {
  if (params.action === 'list') {
    const members = (answer.members as { name: string; kind: string; signature?: string; doc?: string }[]) ?? []
    return (
      `${params.module} (imported in ${String(answer.importMs)} ms, Python ${String(answer.python)}):\n` +
      (members.length === 0
        ? '(nothing public)'
        : members.map((m) => `- ${m.kind === 'module' ? `${m.name} (module)` : `${m.name}${m.signature ?? ''}`}${m.kind === 'class' ? ' [class]' : ''}${m.doc !== undefined && m.doc.length > 0 ? ` - ${m.doc}` : ''}`).join('\n'))
    )
  }
  if (params.action === 'describe') {
    const d = answer.described as { name: string; signature: string; doc: string; methods?: { name: string; signature: string; doc: string }[] }
    return [
      `${params.module}.${d.name}${d.signature}`,
      '',
      d.doc.length > 0 ? d.doc : '(no documentation)',
      ...(d.methods !== undefined && d.methods.length > 0 ? ['', 'Methods:', ...d.methods.map((m) => `- ${m.name}${m.signature}${m.doc.length > 0 ? ` - ${m.doc}` : ''}`)] : []),
    ].join('\n')
  }
  const results = (answer.results as { ok?: boolean; value?: unknown; error?: string; ms?: number }[]) ?? []
  const header =
    `${params.module}.${params.function ?? ''}: ${String(answer.calls)} call(s), ${String(answer.failed)} failed, ` +
    `${String(answer.workers)} worker process(es), ${String(answer.totalMs)} ms in all (import ${String(answer.importMs)} ms per worker)` +
    (Number(answer.restarts) > 0 ? `, ${String(answer.restarts)} worker restart(s)` : '') +
    '.'
  if (results.length === 1) {
    const only = results[0]
    return `${header}\n\n${only?.ok === true ? renderValue(only.value) : `Error: ${only?.error ?? 'unknown'}`}`
  }
  const body = results
    .map((r, i) => `${String(i + 1)}. ${r.ok === true ? JSON.stringify(r.value) : `ERROR ${r.error ?? ''}`}`)
    .join('\n')
  return `${header}\nResults in call order:\n${body}`
}
