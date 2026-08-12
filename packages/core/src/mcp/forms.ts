import { isStdioServer, type McpServerConfig } from './types.js'

/**
 * Translation between the form the user fills in and the `mcpServers` entry stored on disk.
 *
 * The stored shape stays the standard one (§11) — a config from another client must paste in
 * unchanged, and ours must paste out. So the form is a *view* over `command`/`args`, never a
 * competing format: everything here derives one from the other, and `custom` is the escape
 * hatch that always round-trips whatever it was given.
 *
 * Two kinds exist because they are what people actually run: a FastMCP script inside a
 * virtualenv, and an npm package through `npx`. Both are fiddly to hand-write and easy to
 * get subtly wrong — the venv interpreter path differs per platform, and `npx` without `-y`
 * hangs on a confirmation prompt that nobody can answer inside an extension host.
 */

export type McpServerKind = 'python' | 'npx' | 'custom' | 'http'

export interface McpServerForm {
  kind: McpServerKind
  /**
   * `python`: the virtualenv root. Only an input to finding the interpreter — the host
   * probes it and writes the result into `interpreter`, which is what actually runs.
   */
  venvDir: string
  /**
   * `python`: the interpreter that gets spawned. Authoritative, so an unusual layout, a
   * system Python, or a conda environment all work by typing the path directly.
   */
  interpreter: string
  /** `python`: the server script. */
  script: string
  /** `npx`: the package, e.g. `@modelcontextprotocol/server-filesystem`. */
  packageName: string
  /** `custom`: the executable. */
  command: string
  /** Extra arguments for every stdio kind. One per line in the UI. */
  args: string[]
  /** `http`: the endpoint. */
  url: string
  headers: Record<string, string>
  env: Record<string, string>
  cwd: string
}

export const BLANK_MCP_FORM: McpServerForm = {
  kind: 'python',
  venvDir: '',
  interpreter: '',
  script: '',
  packageName: '',
  command: '',
  args: [],
  url: '',
  headers: {},
  env: {},
  cwd: '',
}

export type McpPlatform = 'win32' | 'posix'

/**
 * The interpreter inside a virtualenv. Windows puts it in `Scripts\python.exe`; everything
 * else uses `bin/python`. CLAUDE.md §16 calls for this behind a helper from day one —
 * getting it wrong produces "file not found" naming a path the user never typed.
 */
export function venvPython(venvDir: string, platform: McpPlatform): string {
  const trimmed = venvDir.replace(/[\\/]+$/, '')
  return platform === 'win32' ? `${trimmed}\\Scripts\\python.exe` : `${trimmed}/bin/python`
}

/**
 * Every interpreter path a virtualenv might use, best guess first.
 *
 * Both layouts are offered on both platforms because the layout follows the tool that
 * created the environment, not the machine reading it: a venv on a shared drive, one made
 * under WSL or msys, or a conda environment can all put the interpreter where the local
 * platform would not. The host probes these in order and uses the one that exists, which
 * turns "no such file" — naming a path the user never typed — into a correct answer.
 */
export function venvPythonCandidates(venvDir: string): string[] {
  const trimmed = venvDir.replace(/[\\/]+$/, '')
  return [
    `${trimmed}\\Scripts\\python.exe`,
    `${trimmed}/bin/python`,
    `${trimmed}\\python.exe`,
    `${trimmed}/bin/python3`,
    `${trimmed}/python`,
  ]
}

/** Folder names conventionally holding a virtualenv, checked beside the server script. */
export const VENV_DIR_NAMES = ['.venv', 'venv', 'env', '.env'] as const

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** Strips `Scripts\python.exe` / `bin/python` back to the virtualenv root. */
function venvRootFrom(interpreter: string): string | undefined {
  const parts = interpreter.split(/[\\/]/)
  if (parts.length < 3) return undefined
  const dir = parts[parts.length - 2]?.toLowerCase()
  if (dir !== 'scripts' && dir !== 'bin') return undefined
  // Preserve the original separator so the round-tripped value looks like what was typed.
  const separator = interpreter.includes('\\') ? '\\' : '/'
  return parts.slice(0, -2).join(separator)
}

function isPythonInterpreter(command: string): boolean {
  return /^python(3(\.\d+)?)?(\.exe)?$/i.test(basename(command))
}

function isNpx(command: string): boolean {
  return /^npx(\.cmd|\.exe)?$/i.test(basename(command))
}

/**
 * Reads an existing entry back into form fields.
 *
 * The rule is **never rewrite what it did not understand.** Anything it cannot confidently
 * classify becomes `custom`, showing the raw command and arguments. Guessing wrong would
 * silently change a working server on the next save, so the failure mode is "you see the
 * raw fields", never "your config changed underneath you".
 *
 * Python is the exception that proves it: the interpreter is kept verbatim in
 * `form.interpreter` rather than re-derived from the venv folder, so even a layout this
 * module has never heard of round-trips byte for byte while still getting the friendly
 * script, environment and working-directory fields.
 */
export function toMcpServerForm(config: McpServerConfig): McpServerForm {
  if (!isStdioServer(config)) {
    return {
      ...BLANK_MCP_FORM,
      kind: 'http',
      url: config.url,
      headers: config.headers ?? {},
    }
  }

  const base: McpServerForm = {
    ...BLANK_MCP_FORM,
    kind: 'custom',
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
    cwd: config.cwd ?? '',
  }

  if (isNpx(config.command)) {
    // `-y` is ours, added on save; keeping it here would show it as a user argument and
    // then double it. Anything before the package that is not `-y` stays a raw custom
    // command rather than being quietly dropped.
    const args = [...(config.args ?? [])]
    const leading: string[] = []
    while (args.length > 0 && args[0]?.startsWith('-') === true) {
      leading.push(args.shift() as string)
    }
    const packageName = args.shift()
    if (packageName !== undefined && leading.every((flag) => flag === '-y' || flag === '--yes')) {
      return { ...base, kind: 'npx', packageName, args }
    }
    return base
  }

  if (isPythonInterpreter(config.command)) {
    const args = [...(config.args ?? [])]
    const script = args.shift()
    // `interpreter` carries the command verbatim, so this round-trips exactly whatever was
    // stored — including a system Python or a layout `venvRootFrom` does not recognise.
    // `venvDir` is a convenience for re-running detection and may legitimately be blank.
    if (script !== undefined) {
      return { ...base, kind: 'python', interpreter: config.command, venvDir: venvRootFrom(config.command) ?? '', script, args }
    }
  }

  return base
}

/** Builds the stored entry. Empty optional fields are omitted rather than written as blanks. */
export function fromMcpServerForm(
  form: McpServerForm,
  platform: McpPlatform,
  existing?: McpServerConfig,
): McpServerConfig {
  // Carried across a save because they are set from the server list, not this form —
  // rebuilding without them would silently re-enable a disabled server and un-hide its tools.
  const preserved = {
    ...(existing?.disabled !== undefined ? { disabled: existing.disabled } : {}),
    ...(existing?.disabledTools !== undefined ? { disabledTools: existing.disabledTools } : {}),
  }

  if (form.kind === 'http') {
    return {
      url: form.url.trim(),
      ...(Object.keys(form.headers).length > 0 ? { headers: form.headers } : {}),
      ...preserved,
    }
  }

  const extra = form.args.filter((arg) => arg.trim().length > 0)
  let command: string
  let args: string[]

  if (form.kind === 'python') {
    // The interpreter wins when set. Deriving it from the venv folder is only the fallback,
    // for a form that was filled in before detection had a chance to run.
    command =
      form.interpreter.trim().length > 0 ? form.interpreter.trim() : venvPython(form.venvDir.trim(), platform)
    args = [form.script.trim(), ...extra]
  } else if (form.kind === 'npx') {
    // `-y` is not optional. Without it `npx` prompts before installing a package it has
    // not seen, and there is no terminal attached to answer — the server just never starts.
    command = 'npx'
    args = ['-y', form.packageName.trim(), ...extra]
  } else {
    command = form.command.trim()
    args = extra
  }

  return {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(form.env).length > 0 ? { env: form.env } : {}),
    ...(form.cwd.trim().length > 0 ? { cwd: form.cwd.trim() } : {}),
    ...preserved,
  }
}

/** Field-level validation, so the form can point at the problem instead of failing on save. */
export function validateMcpServerForm(name: string, form: McpServerForm): Record<string, string> {
  const errors: Record<string, string> = {}
  if (name.trim().length === 0) errors.name = 'Give the server a name.'
  else if (/[^\w.-]/.test(name.trim())) {
    // The name prefixes every tool the server exposes (`filesystem__read_file`), and a
    // space or separator there produces a tool name the model cannot reliably call.
    errors.name = 'Use letters, numbers, dots, dashes and underscores — the name prefixes every tool.'
  }

  switch (form.kind) {
    case 'python':
      // Either identifies an interpreter, so requiring both would block a system Python or
      // any layout detection does not know about.
      if (form.interpreter.trim().length === 0 && form.venvDir.trim().length === 0) {
        errors.venvDir = 'Point at the virtualenv folder, or set the interpreter directly.'
      }
      if (form.script.trim().length === 0) errors.script = 'Point at the server script.'
      break
    case 'npx':
      if (form.packageName.trim().length === 0) errors.packageName = 'Name the npm package.'
      break
    case 'custom':
      if (form.command.trim().length === 0) errors.command = 'Name the executable to run.'
      break
    case 'http':
      if (form.url.trim().length === 0) errors.url = 'Enter the server URL.'
      else {
        try {
          new URL(form.url.trim())
        } catch {
          errors.url = 'Must be a valid URL.'
        }
      }
      break
  }
  return errors
}
