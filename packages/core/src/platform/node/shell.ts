import fs from 'node:fs'
import path from 'node:path'

/**
 * Which shell `execute_command` actually runs in, and which command-line tools are really there.
 *
 * ## Why this exists
 *
 * Auto mode's guidance told the model *"On Windows that is PowerShell unless it has been
 * configured otherwise"*. It is not. `NodeTerminal` spawns with `shell: true`, which on Windows
 * is `%ComSpec%` — **cmd.exe** — and nothing had ever configured it otherwise, because there was
 * no setting to do so. Measured on a real Windows machine: `Get-ChildItem` comes back
 * *"is not recognized as an internal or external command"*.
 *
 * So the mode's own instructions produced commands that could not run, on the platform this
 * product is primarily used on. That is the shape of bug §19 keeps recording — a claim in a
 * document about the software, contradicted by the software — except here the document is the
 * prompt, and the reader is the model.
 *
 * ## Why the guidance is generated from this rather than asserting it
 *
 * The fix is not to swap one hard-coded sentence for another. A prompt that *states* the
 * environment is a second copy of a fact the host already knows, and it will drift again the
 * first time somebody configures a different shell. `buildAutoGuidance` takes what this module
 * measured. Invariant 8's habit — report ground truth, never a description of it — applied to
 * the system prompt.
 *
 * ## Why the default is still cmd.exe
 *
 * §16 specifies "pwsh if present, else cmd, configurable", and only the last word of that was
 * ever true. Making PowerShell the default now would be a silent behaviour change for every
 * existing user, and a sharp one: PowerShell's aliases **shadow** the GNU tools people reach
 * for. `ls -la`, `head -5 file`, `sort file`, `diff a b` and `where x` all resolve to
 * `Get-ChildItem`, `Select-Object`, `Sort-Object`, `Compare-Object` and `Where-Object`, and
 * every one of them fails on arguments that work today. So the shell becomes *configurable*,
 * which is what was missing, and the default stays what already runs.
 */

export type ShellKind = 'cmd' | 'powershell' | 'pwsh' | 'posix'

export interface ResolvedShell {
  /** What is spawned. `undefined` means Node's own `shell: true` default. */
  command: string | undefined
  kind: ShellKind
  /** How to name it to the model — "cmd.exe", "PowerShell 5.1", "bash". */
  label: string
}

/** Executable extensions to try on Windows, from PATHEXT. */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD'
  return raw.split(';').filter((entry) => entry.length > 0)
}

/**
 * Whether a bare program name resolves on PATH.
 *
 * A filesystem lookup rather than spawning `where`/`which`: this is asked about a dozen names at
 * once, and a dozen process spawns to build a prompt is a cost somebody would feel on a slow
 * corporate machine. It is also the same thing the shell itself will do.
 */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathValue = env['PATH'] ?? env['Path'] ?? ''
  const separator = process.platform === 'win32' ? ';' : ':'
  const extensions = process.platform === 'win32' ? ['', ...windowsExtensions(env)] : ['']

  for (const directory of pathValue.split(separator)) {
    if (directory.length === 0) continue
    for (const extension of extensions) {
      try {
        const candidate = path.join(directory, name + extension)
        // `statSync` rather than `existsSync` so a directory of that name is not mistaken for a
        // program — `C:\tools\git\` would otherwise answer for `git`.
        if (fs.statSync(candidate).isFile()) return true
      } catch {
        continue
      }
    }
  }
  return false
}

/**
 * The shell commands will run in.
 *
 * `configured` is the user's choice (§16's missing half). Anything else is what Node would do on
 * its own, which is `%ComSpec%` on Windows and `/bin/sh` elsewhere — reported rather than
 * guessed, because being wrong about this is what started all of it.
 */
export function resolveShell(
  configured?: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedShell {
  const explicit = configured?.trim()
  if (explicit !== undefined && explicit.length > 0) {
    return { command: explicit, kind: kindOf(explicit), label: labelFor(explicit) }
  }

  if (process.platform === 'win32') {
    const comspec = env['ComSpec'] ?? env['COMSPEC']
    // `undefined`, not the resolved path: passing `shell: true` is what runs today, and naming
    // the same thing explicitly would be a second way of saying it.
    return { command: undefined, kind: 'cmd', label: comspec ?? 'cmd.exe' }
  }
  return { command: undefined, kind: 'posix', label: env['SHELL'] ?? '/bin/sh' }
}

function kindOf(command: string): ShellKind {
  const base = path.basename(command).toLowerCase().replace(/\.exe$/, '')
  if (base === 'pwsh') return 'pwsh'
  if (base === 'powershell') return 'powershell'
  if (base === 'cmd') return 'cmd'
  return 'posix'
}

function labelFor(command: string): string {
  const base = path.basename(command).toLowerCase().replace(/\.exe$/, '')
  if (base === 'pwsh') return 'PowerShell 7 (pwsh)'
  if (base === 'powershell') return 'Windows PowerShell 5.1'
  if (base === 'cmd') return 'cmd.exe'
  return command
}

/**
 * The command-line tools this machine actually has.
 *
 * **This is the half that matters most on Windows.** A developer machine with Git for Windows on
 * PATH has `grep`, `sed`, `head` and `find` and they work in cmd; a locked-down corporate build
 * has none of them, and guidance naming them produces a run of "not recognized" errors that
 * reads as the assistant being broken. Measured once per session and put in the prompt, so the
 * model reaches for what is there.
 */
export interface CommandToolset {
  /** Names found on PATH, in the order asked about. */
  present: string[]
  /** Names not found. */
  missing: string[]
}

/** The tools worth telling the model about. Reading, searching and mechanical edits. */
export const PROBED_TOOLS: readonly string[] = [
  'rg',
  'grep',
  'findstr',
  'sed',
  'head',
  'tail',
  'cat',
  'type',
  'ls',
  'awk',
  'jq',
  'git',
]

export function detectCommandTools(env: NodeJS.ProcessEnv = process.env): CommandToolset {
  const present: string[] = []
  const missing: string[] = []
  for (const name of PROBED_TOOLS) {
    /*
     * `type` and `ls` are shell builtins in the places that have them, so PATH says nothing.
     * cmd.exe always has `type`; a POSIX shell always has `ls`. Asserting otherwise would report
     * the commonest tool on each platform as absent.
     */
    if (name === 'type' && process.platform === 'win32') {
      present.push(name)
      continue
    }
    if (name === 'ls' && process.platform !== 'win32') {
      present.push(name)
      continue
    }
    ;(onPath(name, env) ? present : missing).push(name)
  }
  return { present, missing }
}
