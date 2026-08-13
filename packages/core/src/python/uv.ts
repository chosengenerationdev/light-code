import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Locating `uv`, and the virtualenv layout it produces.
 *
 * `uv` is used rather than pip because it reads PEP 723 inline dependency blocks natively —
 * which is what lets a tool file be the single source of truth for its own dependencies
 * (§13). No metadata to hand-maintain, so none to drift.
 */

export class UvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UvError'
  }
}

export interface UvInfo {
  /** Absolute path, or a bare command found on PATH. */
  path: string
  version: string
}

/**
 * The interpreter inside a virtualenv.
 *
 * Windows puts it in `Scripts\python.exe`, everything else in `bin/python`. Behind a helper
 * from day one per §16 — getting it wrong produces "file not found" naming a path the user
 * never typed, which is a miserable thing to debug.
 */
export function venvPythonPath(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python')
}

function run(command: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new UvError(`${command} failed: ${stderr.trim() || error.message}`))
      else resolve(stdout.trim())
    })
  })
}

/**
 * Finds `uv`, preferring an explicitly configured path.
 *
 * Returns `undefined` rather than throwing when it is simply absent: Python tools are
 * opt-in and off by default, so a machine without `uv` is the normal case, not an error.
 */
export async function detectUv(configuredPath?: string): Promise<UvInfo | undefined> {
  const candidates = configuredPath !== undefined && configuredPath.trim().length > 0 ? [configuredPath.trim()] : ['uv']
  for (const candidate of candidates) {
    try {
      const output = await run(candidate, ['--version'])
      // `uv 0.5.11 (abc1234 2025-01-01)` — take the first version-shaped token.
      const version = /\d+\.\d+\.\d+/.exec(output)?.[0] ?? output
      return { path: candidate, version }
    } catch {
      // Try the next candidate; absence is reported as undefined, not thrown.
    }
  }
  return undefined
}

export interface EnsureVenvOptions {
  uv: UvInfo
  venvDir: string
  /**
   * Where PyPI is fetched from. §3 treats `uv` resolving PyPI as *our* egress, since it is
   * machinery Light Code chose — so this is configurable to point at an internal index, and
   * `offline` refuses the network entirely.
   */
  indexUrl?: string | undefined
  offline?: boolean
  /**
   * The environment for the child. Deliberately required and deliberately minimal: §13
   * forbids provider API keys reaching Python, and an inherited `process.env` carries every
   * one of them.
   */
  env: NodeJS.ProcessEnv
}

/** Creates the shared virtualenv if it is not already there. */
export async function ensureVenv(options: EnsureVenvOptions): Promise<string> {
  const python = venvPythonPath(options.venvDir)
  try {
    await fs.stat(python)
    return python
  } catch {
    // Not created yet.
  }

  await fs.mkdir(path.dirname(options.venvDir), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    execFile(
      options.uv.path,
      ['venv', options.venvDir],
      { timeout: 120_000, windowsHide: true, env: options.env },
      (error, _stdout, stderr) => {
        if (error) reject(new UvError(`Could not create the Python environment: ${stderr.trim() || error.message}`))
        else resolve()
      },
    )
  })
  return python
}

/**
 * The environment a Python child is allowed to see.
 *
 * An allowlist, never `process.env`. §13 is explicit that provider API keys must never
 * reach the Python environment, and network egress from tool code is uncontrollable without
 * a real sandbox — so the one thing that *is* controllable is what secrets are in scope.
 *
 * A denylist would be the wrong shape here: it has to be updated every time a new provider
 * or credential appears, and the failure is silent exfiltration.
 */
export function minimalPythonEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    // Windows needs these to resolve DLLs and the user profile at all.
    'WINDIR',
    'PATHEXT',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  // Unbuffered, or stdout framing arrives in chunks whenever Python feels like flushing.
  env.PYTHONUNBUFFERED = '1'
  // Keeps __pycache__ out of the user's workspace, which is checked into git.
  env.PYTHONDONTWRITEBYTECODE = '1'
  return { ...env, ...extra }
}

/** Folder names conventionally holding a virtualenv, in the order they are preferred. */
export const WORKSPACE_VENV_NAMES = ['.venv', 'venv', '.env', 'env'] as const

export interface DiscoveredVenv {
  /** The virtualenv root. */
  path: string
  interpreter: string
  /** `uv` records itself in `pyvenv.cfg`; anything else was made by `python -m venv` or poetry. */
  uvManaged: boolean
  pythonVersion?: string | undefined
}

/**
 * Finds a virtualenv the project already has.
 *
 * Strongly preferred over creating our own, because the project's environment is where the
 * user's **internal libraries are already installed**. A private venv would be empty, and a
 * tool importing an internal package would fail for a reason that looks like a bug in Light
 * Code rather than a missing install.
 *
 * The tradeoff is real and the UI states it: reusing the project venv means a tool's declared
 * dependencies are installed *into the project's environment*, not a sandbox of ours.
 */
export async function discoverWorkspaceVenv(workspaceRoot: string): Promise<DiscoveredVenv | undefined> {
  for (const name of WORKSPACE_VENV_NAMES) {
    const candidate = path.join(workspaceRoot, name)
    const interpreter = venvPythonPath(candidate)
    try {
      await fs.stat(interpreter)
    } catch {
      continue
    }

    // `pyvenv.cfg` is written by every venv creator. uv adds a `uv = <version>` key, which
    // is the only reliable marker that this environment is one uv can manage cleanly.
    let uvManaged = false
    let pythonVersion: string | undefined
    try {
      const config = await fs.readFile(path.join(candidate, 'pyvenv.cfg'), 'utf8')
      uvManaged = /^\s*uv\s*=/m.test(config)
      pythonVersion = /^\s*version(?:_info)?\s*=\s*(.+)$/m.exec(config)?.[1]?.trim()
    } catch {
      // A venv without pyvenv.cfg is unusual but still usable; it is simply not uv-managed.
    }

    return {
      path: candidate,
      interpreter,
      uvManaged,
      ...(pythonVersion !== undefined ? { pythonVersion } : {}),
    }
  }
  return undefined
}
