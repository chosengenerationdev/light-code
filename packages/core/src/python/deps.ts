import { execFile } from 'node:child_process'
import { UvError, type UvInfo } from './uv.js'

/**
 * PEP 723 inline dependencies, and installing them into the shared virtualenv.
 *
 * A tool file declares what it needs in its own header, so the file stays the single source
 * of truth (§13) — nothing to hand-maintain, so nothing to drift:
 *
 * ```python
 * # /// script
 * # dependencies = ["httpx", "acme-internal-sdk>=2.1"]
 * # ///
 * ```
 *
 * Installation targets the **shared** venv, so all tools live in one environment and
 * cross-tool dependency conflicts are possible. That is the documented, accepted tradeoff
 * from §13 — a venv per tool would cost an interpreter start per call, which is the thing
 * the persistent worker exists to avoid.
 */

/**
 * Extracts the dependency list from a PEP 723 block.
 *
 * Deliberately not a TOML parser. The block is line-commented TOML, but the only field that
 * matters here is `dependencies`, which the spec defines as an array of PEP 508 strings — so
 * a targeted extraction avoids a dependency and cannot mis-handle the rest of the block.
 * `requires-python` is ignored: the venv's interpreter is already chosen.
 */
export function parseInlineDependencies(source: string): string[] {
  const block = /^#\s*\/\/\/\s*script\s*$([\s\S]*?)^#\s*\/\/\/\s*$/m.exec(source)
  if (block === null) return []

  // Strip the leading `# ` from each line to recover the TOML underneath.
  const body = (block[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/^#\s?/, ''))
    .join('\n')

  const array = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(body)
  if (array === null) return []

  return [...(array[1] ?? '').matchAll(/["']([^"']+)["']/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((entry) => entry.length > 0)
}

export interface InstallOptions {
  uv: UvInfo
  /** Interpreter inside the shared venv — the install target. */
  pythonPath: string
  packages: readonly string[]
  /**
   * An internal package index, when PyPI is not reachable or not allowed.
   *
   * §3 treats `uv` resolving PyPI as *our* egress, since it is machinery Light Code chose
   * rather than something the user configured. Pointing it at an internal mirror is
   * therefore the expected configuration in a managed environment, not an edge case.
   */
  indexUrl?: string | undefined
  extraIndexUrls?: readonly string[] | undefined
  /** Refuses the network entirely. Only already-cached packages will resolve. */
  offline?: boolean
  env: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface InstallResult {
  installed: string[]
  /** Present when the install failed; the model gets this back so it can adapt. */
  error?: string
}

/**
 * Installs a tool's declared dependencies.
 *
 * Never throws: a failed install is reported to the model as text, because the useful
 * response is usually for it to pick a different library or drop the dependency — not for
 * the turn to blow up.
 */
export async function installDependencies(options: InstallOptions): Promise<InstallResult> {
  if (options.packages.length === 0) return { installed: [] }

  const args = ['pip', 'install', '--python', options.pythonPath]
  if (options.indexUrl !== undefined && options.indexUrl.trim().length > 0) {
    args.push('--index-url', options.indexUrl.trim())
  }
  for (const extra of options.extraIndexUrls ?? []) {
    if (extra.trim().length > 0) args.push('--extra-index-url', extra.trim())
  }
  if (options.offline === true) args.push('--offline')
  args.push(...options.packages)

  return new Promise<InstallResult>((resolve) => {
    execFile(
      options.uv.path,
      args,
      { timeout: options.timeoutMs ?? 180_000, windowsHide: true, env: options.env, maxBuffer: 8 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ installed: [...options.packages] })
          return
        }
        const detail = stderr.trim() || error.message
        resolve({
          installed: [],
          // Names the index actually used: "could not find package X" is baffling until you
          // know it was looked for on PyPI rather than on the internal mirror.
          error:
            `Could not install ${options.packages.join(', ')} from ` +
            `${options.indexUrl ?? 'the default index'}:\n${detail}`,
        })
      },
    )
  })
}

/** Turns a failed install into something the model can act on rather than just retry. */
export function describeInstallFailure(result: InstallResult): string {
  return (
    `${result.error ?? 'The dependencies could not be installed.'}\n\n` +
    'Either use only the standard library, or ask the user whether this package is available ' +
    'on their configured index. Do not retry the same dependency unchanged.'
  )
}

export { UvError }
