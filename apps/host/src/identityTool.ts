import { spawn } from 'node:child_process'
import path from 'node:path'

import type { IdentityProvider, Principal } from './identity.js'

/**
 * Who the current user is, according to a Python function the operator wrote.
 *
 * ## Why a Python function and not a header
 *
 * Requested: the environment this runs in already has libraries that know who is logged in, and
 * the one honest answer to "who is this" lives inside them. A header would mean a reverse proxy
 * that may not be in front, and an OS user name would be the service account. So identity is
 * whatever a small function says it is — an import and a return.
 *
 * ## Why it runs before anything else, and not as a registered tool
 *
 * Registered Python tools live behind `python.toolsDir`, which is read from config, which is
 * stored **per user** — so resolving the user through the tool registry means reading the config
 * of a user you have not identified yet. That circularity has no good end.
 *
 * This runs once at startup, from operator-supplied settings, before any session exists. It is
 * the same file the Python tab writes and can run, so there is one function and one answer; only
 * the caller differs.
 *
 * ## Why the result is cached for the process
 *
 * It answers "who is this server running as", which cannot change while it runs. Re-running it
 * per request would spawn an interpreter per HTTP call for an answer that is already known.
 */
export interface IdentityToolOptions {
  /** The interpreter to run it with. */
  interpreter: string
  /** The file defining `run()`. */
  file: string
  /** How long the function may take before it is given up on. */
  timeoutMs?: number
}

export interface IdentityResolution {
  principal?: Principal
  /** Why it could not be resolved, phrased for whoever has to fix it. */
  problem?: string
}

/**
 * The wrapper that loads the file and prints what `run()` returned.
 *
 * Loaded by path rather than by name, because the file lives wherever the operator put it and
 * adding its folder to `sys.path` would put every neighbouring file on the import path too.
 *
 * The result is printed as JSON on the last line, after a marker. A function that imports a
 * chatty library — and internal libraries are often chatty — would otherwise have its banner
 * mistaken for the answer, which would key somebody's whole configuration to a log line.
 */
const WRAPPER = [
  'import importlib.util, json, sys',
  'spec = importlib.util.spec_from_file_location("light_code_identity", sys.argv[1])',
  'module = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(module)',
  'value = module.run()',
  'sys.stdout.write("\\n__LIGHT_CODE_IDENTITY__" + json.dumps(value) + "\\n")',
].join('\n')

const MARKER = '__LIGHT_CODE_IDENTITY__'

/** Runs the function and returns what it said, or why it could not. */
export async function resolveIdentity(options: IdentityToolOptions): Promise<IdentityResolution> {
  const budget = options.timeoutMs ?? 30_000

  const run = await new Promise<{
    code: number | null
    stdout: string
    stderr: string
    timedOut: boolean
  }>((resolve) => {
    const child = spawn(options.interpreter, ['-c', WRAPPER, path.resolve(options.file)], {
      windowsHide: true,
      // Inherited deliberately, unlike a Python *tool*: this runs the operator's own bootstrap
      // before any model exists, and the libraries that know who you are are usually configured
      // through the environment the server was started in. §13's minimal environment protects
      // model-authored code from credentials; nothing here is model-authored.
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, budget)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: error.message, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })

  if (run.timedOut) {
    return {
      problem:
        `The identity function did not finish within ${String(Math.round(budget / 1000))}s. ` +
        'If it reaches a network service, it may be waiting on something unreachable from here.',
    }
  }

  if (run.code !== 0) {
    // The traceback, not a summary of it: the person fixing this wrote the function.
    const detail = (run.stderr.trim() || run.stdout.trim() || 'no output')
      .split('\n')
      .slice(-12)
      .join('\n')
    return { problem: `The identity function failed:\n\n${detail}` }
  }

  const at = run.stdout.lastIndexOf(MARKER)
  if (at === -1) {
    return {
      problem:
        'The identity function ran but returned nothing this could read. It must define `run()` ' +
        'and return the user id as a string.',
    }
  }

  let value: unknown
  try {
    value = JSON.parse(run.stdout.slice(at + MARKER.length).trim())
  } catch {
    return { problem: 'The identity function returned something that is not JSON-serialisable.' }
  }

  /*
   * A string, and nothing else coerced into one.
   *
   * `str(None)` is `"None"`, and a function that fell through its branches would otherwise key a
   * whole configuration directory to the word None — silently, and identically for everybody it
   * happened to, which is worse than failing.
   */
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      problem:
        `The identity function returned ${value === null ? 'None' : `a ${typeof value}`} rather than ` +
        'a user id. It must return a non-empty string.',
    }
  }

  const id = value.trim()
  return { principal: { id, displayName: id } }
}

/**
 * An `IdentityProvider` backed by that function.
 *
 * Note what it does *not* do: authenticate. There is one user here and this says which one, so
 * that storage, config and history are keyed to them. Whether a request is allowed in is still
 * the bearer token's job, exactly as in `SingleUserIdentity` — conflating the two would mean a
 * function returning a name became a way past the door.
 */
export class PythonToolIdentity implements IdentityProvider {
  readonly describe: string

  constructor(
    private readonly principal: Principal,
    file: string,
  ) {
    this.describe = `identity from ${path.basename(file)} — ${principal.id}`
  }

  /*
   * The request is deliberately not a parameter. There is nothing in it to read: this answers
   * "who is this server running as", which the process settled before it started listening.
   */
  async authenticate(): Promise<Principal | undefined> {
    return this.principal
  }
}
