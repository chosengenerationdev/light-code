import type { JupyterClient } from './client.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { resolveToolPath } from '../tools/paths.js'
import type { Tool, ToolExecutionContext, ToolResult } from '../tools/types.js'
import type { KernelSession, RunOutput } from './kernel.js'
import type { HubMirror, PullResult } from './mirror.js'
import type { JupyterHubSpec } from './spec.js'

/**
 * The tools a JupyterHub codebase adds: run on the hub, look up the hub's libraries, and sync.
 *
 * `hub_run` and `hub_inspect` are `command`: they execute code on the hub, as the user, in its
 * environment - the reason they exist, since some libraries live only there. Every run is approved
 * (or allowed exactly as typed, like a shell command), and the approval shows the code that will run
 * (invariant 8): for a script, the script itself. `hub_sync` is `edit`: it changes files here or there.
 */

export interface HubRuntime {
  spec: JupyterHubSpec
  /** The REST client, for `hub_browse` - which looks beyond the copied folders. */
  client: JupyterClient
  mirror: HubMirror
  kernel: KernelSession
  /** Where the hub is, for messages. */
  label: string
}

const RUN_DEFAULT_SECONDS = 300
const SCRIPT_PREVIEW_CHARS = 6000

const runSchema = z.object({
  code: z.string().optional().describe('Python to run in the hub kernel. Variables persist between calls.'),
  file: z.string().optional().describe('A script in the workspace (one of the hub folders) to run on the hub, from its own folder.'),
  args: z.array(z.string()).optional().describe('Command-line arguments for file (sys.argv[1:]).'),
  shell: z.string().optional().describe('A shell command to run on the hub server, from the folder given in cwd or the top folder.'),
  cwd: z.string().optional().describe('For shell: a workspace folder (inside the hub folders) to run it in.'),
  timeoutSeconds: z.number().int().min(5).max(3600).optional(),
})
type RunParams = z.infer<typeof runSchema>

const inspectSchema = z.object({
  name: z.string().optional().describe('A module, class or function on the hub, e.g. "pandas.read_csv" or "acme_risk.pricing".'),
  source: z.boolean().optional().describe('Include the source code when available.'),
  packages: z.string().optional().describe('Instead of name: list installed packages whose name contains this ("" for all).'),
})
type InspectParams = z.infer<typeof inspectSchema>

const syncSchema = z.object({
  action: z.enum(['pull', 'push', 'status', 'hub_version', 'use_hub_version']),
  path: z.string().optional().describe('For push, hub_version, use_hub_version: one workspace file. push without it saves every local change.'),
})
type SyncParams = z.infer<typeof syncSchema>

/** Python literals for values the model chose, so nothing it writes can become code. */
const py = (value: unknown): string => JSON.stringify(value)

/** The code `hub_run` will send for these parameters - shown in the approval and then run as is. */
async function plan(
  runtime: HubRuntime,
  context: ToolExecutionContext,
  params: RunParams,
): Promise<{ ok: true; code: string; shown: string; where: string; local?: string } | { ok: false; message: string }> {
  const given = [params.code, params.file, params.shell].filter((v) => v !== undefined).length
  if (given !== 1) return { ok: false, message: 'Give exactly one of code, file or shell.' }
  if (params.code !== undefined) return { ok: true, code: params.code, shown: params.code, where: 'the hub kernel' }

  const locate = async (target: string): Promise<{ ok: true; local: string; remote: string } | { ok: false; message: string }> => {
    const resolved = await resolveToolPath(context, target)
    if (!resolved.ok) return resolved
    const remote = runtime.mirror.remoteOf(resolved.realPath)
    if (remote === undefined) return { ok: false, message: `${target} is not inside one of the JupyterHub folders, so it is not on the hub.` }
    return { ok: true, local: resolved.realPath, remote }
  }

  if (params.file !== undefined) {
    const where = await locate(params.file)
    if (!where.ok) return where
    const folder = where.remote.split('/').slice(0, -1).join('/')
    const argv = [where.remote.split('/').pop() ?? where.remote, ...(params.args ?? [])]
    const code = [
      'import os as _lc_os, sys as _lc_sys, runpy as _lc_runpy',
      `_lc_home = globals().setdefault('_lc_home', _lc_os.getcwd())`,
      `_lc_os.chdir(_lc_os.path.join(_lc_home, ${py(folder)}))`,
      `_lc_sys.argv = ${py(argv)}`,
      `_lc_runpy.run_path(${py(argv[0])}, run_name='__main__')`,
    ].join('\n')
    let script: string
    try {
      script = await fs.readFile(where.local, 'utf8')
    } catch {
      return { ok: false, message: `${params.file} does not exist.` }
    }
    const excerpt = script.length > SCRIPT_PREVIEW_CHARS ? `${script.slice(0, SCRIPT_PREVIEW_CHARS)}\n… (${String(script.length)} characters in all)` : script
    return {
      ok: true,
      code,
      shown: `python ${[where.remote, ...(params.args ?? [])].join(' ')}\n\n--- ${where.remote} ---\n${excerpt}`,
      where: `the hub, in ${folder || 'the top folder'}`,
      local: where.local,
    }
  }

  let folder = ''
  if (params.cwd !== undefined) {
    const where = await locate(params.cwd)
    if (!where.ok) return where
    folder = where.remote
  }
  const code = [
    'import os as _lc_os, subprocess as _lc_sp, sys as _lc_sys',
    `_lc_home = globals().setdefault('_lc_home', _lc_os.getcwd())`,
    `_lc_r = _lc_sp.run(${py(params.shell)}, shell=True, cwd=_lc_os.path.join(_lc_home, ${py(folder)}), capture_output=True, text=True)`,
    'print(_lc_r.stdout, end="")',
    'print(_lc_r.stderr, end="", file=_lc_sys.stderr)',
    'print(f"\\n[exit code {_lc_r.returncode}]")',
  ].join('\n')
  return { ok: true, code, shown: params.shell ?? '', where: `the hub, in ${folder || 'the top folder'}` }
}

function describeRun(runtime: HubRuntime, output: RunOutput, where: string): string {
  const parts: string[] = []
  if (output.freshKernel) parts.push(`(A new ${output.kernelName} kernel was started on ${runtime.label}; variables from earlier runs are gone.)`)
  parts.push(output.text.trim().length > 0 ? output.text.replace(/\s+$/, '') : '(no output)')
  if (output.error !== undefined) parts.push(`${output.error.name}: ${output.error.value}\n${output.error.traceback}`.trim())
  if (output.timedOut === true) parts.push('Stopped: it ran past the time limit, so the kernel was interrupted. Raise timeoutSeconds if it needs longer.')
  if (output.stopped === true) parts.push('Stopped by the user.')
  return `Ran on ${where} (${output.kernelName}):\n${parts.join('\n\n')}`
}

export function describePull(result: PullResult): string {
  const lines: string[] = []
  if (result.fetched.length > 0) lines.push(`Fetched ${String(result.fetched.length)} changed file(s) from the hub: ${result.fetched.slice(0, 20).join(', ')}${result.fetched.length > 20 ? ', …' : ''}`)
  if (result.removed.length > 0) lines.push(`Removed ${String(result.removed.length)} file(s) deleted on the hub: ${result.removed.slice(0, 20).join(', ')}`)
  if (result.conflicts.length > 0)
    lines.push(`Changed both here and on the hub - kept as they are here, NOT replaced: ${result.conflicts.join(', ')}. Compare with hub_sync "hub_version".`)
  if (result.skipped.length > 0) lines.push(`Too large to copy: ${result.skipped.join(', ')}`)
  for (const failure of result.failed) lines.push(`Could not fetch ${failure.path}: ${failure.problem}`)
  if (lines.length === 0) lines.push(`Up to date (${String(result.unchanged)} file(s) unchanged).`)
  return lines.join('\n')
}

export function createHubTools(runtime: HubRuntime): Tool[] {
  const runTool: Tool<RunParams> = {
    name: 'hub_run',
    group: 'command',
    description:
      `Run Python, a script or a shell command ON THE JUPYTERHUB SERVER (${runtime.label}), in its environment - use this, ` +
      'not execute_command, for anything that needs the hub\'s libraries or data. `code` runs in one kernel kept for the ' +
      'session (variables persist); `file` runs a workspace script from its own folder on the hub (saved there first if ' +
      'edited); `shell` runs a command on the hub. Files it writes on the hub are fetched into the workspace afterwards.',
    parametersSchema: runSchema,
    async preview(params, context) {
      const planned = await plan(runtime, context, params)
      if (!planned.ok) return { kind: 'text', text: planned.message }
      return { kind: 'command', command: planned.shown, cwd: `JupyterHub: ${planned.where}` }
    },
    async execute(params, context): Promise<ToolResult> {
      const planned = await plan(runtime, context, params)
      if (!planned.ok) return { content: planned.message, isError: true }
      const notes: string[] = []
      if (planned.local !== undefined) {
        const saved = await runtime.mirror.push(planned.local, context.signal)
        if (!saved.saved) return { content: `Not run: ${params.file ?? ''} could not be saved to the hub first - ${saved.message}`, isError: true }
      }
      const output = await runtime.kernel.run(planned.code, {
        timeoutMs: (params.timeoutSeconds ?? RUN_DEFAULT_SECONDS) * 1000,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      })
      try {
        const pulled = await runtime.mirror.pull(context.signal)
        if (pulled.fetched.length + pulled.removed.length + pulled.conflicts.length > 0) notes.push(describePull(pulled))
      } catch (error) {
        notes.push(`(Could not fetch changes from the hub afterwards: ${error instanceof Error ? error.message : String(error)})`)
      }
      return {
        content: [describeRun(runtime, output, planned.where), ...notes].join('\n\n'),
        ...(output.error !== undefined || output.timedOut === true ? { isError: true } : {}),
      }
    },
  }

  const inspectTool: Tool<InspectParams> = {
    name: 'hub_inspect',
    group: 'command',
    description:
      'Look up a library that exists on the JupyterHub server - its signature, documentation, members and (with source) ' +
      'its code - or list the packages installed there. Use it instead of guessing at an API the local machine cannot see. ' +
      'Importing a module runs its top-level code, which is why this asks first.',
    parametersSchema: inspectSchema,
    async preview(params) {
      if (params.packages !== undefined) return { kind: 'command', command: `list installed packages matching ${py(params.packages)}`, cwd: 'JupyterHub kernel' }
      return { kind: 'command', command: `inspect ${params.name ?? '?'}${params.source === true ? ' (with source)' : ''}`, cwd: 'JupyterHub kernel (imports the module)' }
    },
    async execute(params, context): Promise<ToolResult> {
      let code: string
      if (params.packages !== undefined) {
        code = [
          'import importlib.metadata as _lc_md',
          `_lc_f = ${py(params.packages.toLowerCase())}`,
          '_lc_rows = sorted({(d.metadata["Name"] or "", d.version) for d in _lc_md.distributions()})',
          'print("\\n".join(f"{n}=={v}" for n, v in _lc_rows if _lc_f in n.lower()) or "(none match)")',
        ].join('\n')
      } else if (params.name !== undefined && /^[A-Za-z_][\w.]*$/.test(params.name)) {
        code = INSPECTOR.split('__NAME__').join(py(params.name)).split('__SOURCE__').join(params.source === true ? 'True' : 'False')
      } else {
        return { content: 'Give name (a dotted module path, e.g. "pkg.module.func") or packages.', isError: true }
      }
      const output = await runtime.kernel.run(code, { timeoutMs: 120_000, ...(context.signal !== undefined ? { signal: context.signal } : {}) })
      return { content: describeRun(runtime, output, 'the hub kernel'), ...(output.error !== undefined ? { isError: true } : {}) }
    },
  }

  const syncTool: Tool<SyncParams> = {
    name: 'hub_sync',
    group: 'edit',
    description:
      'Keep the workspace and the JupyterHub folders in step. Edits are saved to the hub automatically and changes there ' +
      'are fetched every few minutes; use this to fetch now ("pull"), save local changes made another way, such as by a ' +
      'shell command ("push", optionally one path), list what is not saved ("status"), read the hub\'s copy of a file after ' +
      'a refused save ("hub_version"), or replace the local file with the hub\'s copy ("use_hub_version" - discards the ' +
      'local edit; ask the user first). Never overwrites anything changed on the other side.',
    parametersSchema: syncSchema,
    async preview(params, context) {
      if (params.action === 'push') {
        const pending = await pendingFor(runtime, context, params.path)
        if (!pending.ok) return { kind: 'text', text: pending.message }
        return { kind: 'text', text: pending.changes.length === 0 ? 'Nothing to save.' : `Save to ${runtime.label}:\n${pending.changes.map((c) => `- ${c}`).join('\n')}` }
      }
      if (params.action === 'use_hub_version') {
        return { kind: 'text', text: `Replace ${params.path ?? '?'} here with the hub's copy, DISCARDING the local changes to it.` }
      }
      return { kind: 'text', text: params.action === 'pull' ? `Fetch what changed on ${runtime.label} (never replaces a local change).` : `hub_sync ${params.action}` }
    },
    async execute(params, context): Promise<ToolResult> {
      try {
        switch (params.action) {
          case 'pull':
            return { content: describePull(await runtime.mirror.pull(context.signal)) }
          case 'status': {
            const pending = await runtime.mirror.pending()
            if (pending.length === 0) return { content: 'Everything here is saved on the hub.' }
            return { content: `Not on the hub yet:\n${pending.map((p) => `- ${p.local} (${p.kind}${p.kind === 'deleted' ? ' here; still on the hub' : ''})`).join('\n')}` }
          }
          case 'push': {
            const pending = await pendingFor(runtime, context, params.path)
            if (!pending.ok) return { content: pending.message, isError: true }
            const lines: string[] = []
            let failed = false
            for (const file of pending.files) {
              const result = await runtime.mirror.push(file, context.signal)
              failed ||= !result.saved
              lines.push(`- ${path.relative(runtime.mirror.root, file).split(path.sep).join('/')}: ${result.message}`)
            }
            return { content: lines.length > 0 ? lines.join('\n') : 'Nothing to save.', ...(failed ? { isError: true } : {}) }
          }
          case 'hub_version':
          case 'use_hub_version': {
            if (params.path === undefined) return { content: 'Name the file with path.', isError: true }
            const resolved = await resolveToolPath(context, params.path)
            if (!resolved.ok) return { content: resolved.message, isError: true }
            if (params.action === 'hub_version') {
              const hub = await runtime.mirror.hubVersion(resolved.realPath, context.signal)
              return { content: `The hub's ${hub.remote} (last changed ${hub.lastModified}):\n\n${hub.text}` }
            }
            const remote = await runtime.mirror.useHubVersion(resolved.realPath, context.signal)
            context.readFiles.delete(resolved.realPath)
            return { content: `${params.path} now matches the hub's ${remote}. Read it again before editing.` }
          }
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }

  return [runTool, inspectTool, syncTool]
}

async function pendingFor(
  runtime: HubRuntime,
  context: ToolExecutionContext,
  target: string | undefined,
): Promise<{ ok: true; files: string[]; changes: string[] } | { ok: false; message: string }> {
  if (target !== undefined) {
    const resolved = await resolveToolPath(context, target)
    if (!resolved.ok) return resolved
    return { ok: true, files: [resolved.realPath], changes: [target] }
  }
  const pending = (await runtime.mirror.pending()).filter((p) => p.kind !== 'deleted')
  return {
    ok: true,
    files: pending.map((p) => path.join(runtime.mirror.root, ...p.local.split('/'))),
    changes: pending.map((p) => `${p.local} → ${p.remote} (${p.kind})`),
  }
}

/** Run in the hub kernel by `hub_inspect`. The name is a JSON literal, so it cannot become code. */
const INSPECTOR = `
import importlib as _lc_il, inspect as _lc_in
def _lc_find(_n):
    _parts = _n.split('.')
    for _i in range(len(_parts), 0, -1):
        try:
            _obj = _lc_il.import_module('.'.join(_parts[:_i]))
        except ImportError:
            continue
        for _p in _parts[_i:]:
            _obj = getattr(_obj, _p)
        return _obj
    raise ImportError('No module named ' + repr(_parts[0]) + ' on the hub')
_lc_obj = _lc_find(__NAME__)
print('Name:', __NAME__)
print('Kind:', type(_lc_obj).__name__)
try:
    print('Defined in:', _lc_in.getsourcefile(_lc_obj) or _lc_in.getfile(_lc_obj))
except TypeError:
    pass
try:
    print('Signature:', __NAME__.split('.')[-1] + str(_lc_in.signature(_lc_obj)))
except (TypeError, ValueError):
    pass
_lc_doc = _lc_in.getdoc(_lc_obj)
if _lc_doc:
    print('\\nDocumentation:\\n' + _lc_doc[:4000])
if _lc_in.ismodule(_lc_obj) or _lc_in.isclass(_lc_obj):
    _lc_members = [m for m in dir(_lc_obj) if not m.startswith('_')]
    print('\\nMembers (' + str(len(_lc_members)) + '):')
    for _m in _lc_members[:200]:
        try:
            _v = getattr(_lc_obj, _m)
            _sig = str(_lc_in.signature(_v)) if callable(_v) else ''
        except Exception:
            _sig = ''
        print('  ' + _m + _sig)
if __SOURCE__:
    try:
        _lc_src = _lc_in.getsource(_lc_obj)
        print('\\nSource:\\n' + _lc_src[:20000] + ('\\n… (truncated)' if len(_lc_src) > 20000 else ''))
    except (TypeError, OSError):
        print('\\n(No source available: compiled or built in.)')
`
