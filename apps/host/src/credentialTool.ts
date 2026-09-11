import { spawn } from 'node:child_process'
import path from 'node:path'

import type { SecretStore } from '@light-code/core'

/**
 * Credentials fetched from a Python function the operator wrote.
 *
 * ## Why this is a *secret store*, not a tool the model calls
 *
 * The question people ask for is "get me the password for X", and the places that need one are
 * the gateway's API key, a search cluster's username and password, a certificate passphrase and
 * an MCP server's environment. Every one of those already resolves through `SecretStore`. Making
 * this another source behind that interface means it works for all of them at once and nothing
 * downstream learns a new concept.
 *
 * The alternative — a tool the assistant calls — would put the password in the transcript, the
 * task history and whatever the model said next. §15 is explicit that secrets never reach the
 * model's environment, and a credential lookup is the last place to make an exception.
 *
 * ## How it is reached
 *
 * A stored value of `tool:<name>` is a **pointer, not a secret**. The secrets file then holds no
 * passwords at all — only the names of things to go and ask for — which is a stronger position
 * than the file store on its own can offer, whatever its permissions are.
 *
 *     tool:gateway                 the whole secret, where the function returns one value
 *     tool:opensearch#username     one field of it
 *     tool:opensearch#password
 *
 * ## What the function must return
 *
 * A string, or a dict. A dict is read for `password` first and then `secret`, `token`, `value` and
 * `key`, so the common shapes all work without anybody having to look up which word this expects.
 * `#field` takes that field exactly, and a missing one is an error rather than an empty string —
 * an empty password reaches the gateway and comes back as "your credentials are wrong", which
 * sends the user to the wrong place entirely.
 */
export interface CredentialToolOptions {
  interpreter: string
  file: string
  timeoutMs?: number
}

/** The prefix that marks a stored value as a pointer rather than a secret. */
export const CREDENTIAL_PREFIX = 'tool:'

const WRAPPER = [
  'import importlib.util, json, sys',
  'spec = importlib.util.spec_from_file_location("light_code_credentials", sys.argv[1])',
  'module = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(module)',
  'value = module.run(sys.argv[2])',
  'sys.stdout.write("\\n__LIGHT_CODE_CREDENTIAL__" + json.dumps(value) + "\\n")',
].join('\n')

const MARKER = '__LIGHT_CODE_CREDENTIAL__'

/** Field names checked in order, so the usual shapes work without consulting documentation. */
const FIELDS = ['password', 'secret', 'token', 'value', 'key'] as const

export interface CredentialResult {
  value?: string
  problem?: string
}

/** Runs the function for one credential name and returns the field asked for. */
export async function fetchCredential(
  options: CredentialToolOptions,
  reference: string,
): Promise<CredentialResult> {
  const withoutPrefix = reference.slice(CREDENTIAL_PREFIX.length)
  const hash = withoutPrefix.indexOf('#')
  const name = hash === -1 ? withoutPrefix : withoutPrefix.slice(0, hash)
  const field = hash === -1 ? undefined : withoutPrefix.slice(hash + 1)

  if (name.length === 0) return { problem: 'A credential reference needs a name: tool:<name>.' }

  const budget = options.timeoutMs ?? 30_000
  const run = await new Promise<{
    code: number | null
    stdout: string
    stderr: string
    timedOut: boolean
  }>((resolve) => {
    const child = spawn(options.interpreter, ['-c', WRAPPER, path.resolve(options.file), name], {
      windowsHide: true,
      // The environment this was started in, as with the identity function: the libraries that
      // hold credentials are configured through it, and nothing here is model-authored.
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
      problem: `Looking up "${name}" did not finish within ${String(Math.round(budget / 1000))}s.`,
    }
  }
  if (run.code !== 0) {
    /*
     * The traceback is *not* passed through here, unlike the identity function's.
     *
     * A credential lookup that fails often does so with the value in its hands — a library
     * echoing what it received, an assertion printing a comparison — and this string is on its
     * way to a user interface and a log. The name is enough to find the problem; the operator can
     * run the function themselves to see the rest.
     */
    return {
      problem: `Looking up "${name}" failed. Run the credential function yourself to see why.`,
    }
  }

  const at = run.stdout.lastIndexOf(MARKER)
  if (at === -1) return { problem: `Looking up "${name}" returned nothing this could read.` }

  let parsed: unknown
  try {
    parsed = JSON.parse(run.stdout.slice(at + MARKER.length).trim())
  } catch {
    return { problem: `Looking up "${name}" returned something that is not JSON-serialisable.` }
  }

  if (typeof parsed === 'string') {
    if (field !== undefined) {
      return {
        problem: `"${name}" is a single value, so it has no "${field}" field. Use tool:${name}.`,
      }
    }
    return parsed.length > 0 ? { value: parsed } : { problem: `"${name}" came back empty.` }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      problem: `"${name}" returned a ${parsed === null ? 'None' : typeof parsed}, not a string or a dict.`,
    }
  }

  const record = parsed as Record<string, unknown>
  if (field !== undefined) {
    const picked = record[field]
    if (typeof picked !== 'string' || picked.length === 0) {
      /*
       * Named rather than answered with an empty string. An empty password reaches the gateway and
       * comes back as "your credentials are wrong", which sends somebody to check a password that
       * was never sent — the most expensive kind of wrong answer.
       */
      const available = Object.keys(record).join(', ')
      return {
        problem: `"${name}" has no "${field}". It returned: ${available.length > 0 ? available : 'nothing'}.`,
      }
    }
    return { value: picked }
  }

  for (const candidate of FIELDS) {
    const picked = record[candidate]
    if (typeof picked === 'string' && picked.length > 0) return { value: picked }
  }
  return {
    problem:
      `"${name}" returned a dict with none of ${FIELDS.join(', ')} in it. ` +
      `Name the field you want: tool:${name}#<field>.`,
  }
}

/**
 * A `SecretStore` that resolves `tool:` pointers through the credential function.
 *
 * Wrapping rather than replacing: everything that is genuinely stored still is, and only a value
 * that *says* it is a pointer goes anywhere near Python. So a deployment can mix the two — an API
 * key typed into the interface beside a database password that comes from the vault.
 */
export class ToolBackedSecretStore implements SecretStore {
  /**
   * Very short-lived, and the shortness is the point.
   *
   * §15 says fetch at request time, cache within a request, drop after. One turn resolves the same
   * credential several times — the auth strategy, a refresh, a retry — and spawning an interpreter
   * for each would be slow enough to be noticed. A few seconds covers a turn and expires long
   * before a rotation would matter, which is what keeps "fetch at request time" honest.
   */
  private readonly cache = new Map<string, { value: string; until: number }>()
  private static readonly TTL_MS = 5_000

  constructor(
    private readonly inner: SecretStore,
    private readonly options: CredentialToolOptions,
    private readonly onProblem?: (problem: string) => void,
  ) {}

  async get(key: string): Promise<string | undefined> {
    const stored = await this.inner.get(key)
    if (stored === undefined || !stored.startsWith(CREDENTIAL_PREFIX)) return stored

    const cached = this.cache.get(stored)
    if (cached !== undefined && cached.until > Date.now()) return cached.value

    const result = await fetchCredential(this.options, stored)
    if (result.value === undefined) {
      // Reported, and then undefined — which the rest of the product already handles as
      // "credential missing for profile X, reconfigure" rather than sending an empty one.
      if (result.problem !== undefined) this.onProblem?.(result.problem)
      return undefined
    }
    this.cache.set(stored, {
      value: result.value,
      until: Date.now() + ToolBackedSecretStore.TTL_MS,
    })
    return result.value
  }

  async set(key: string, value: string): Promise<void> {
    // A pointer is stored verbatim; that is the whole mechanism. Anything else is an ordinary
    // secret and goes where ordinary secrets go.
    this.cache.delete(value)
    return this.inner.set(key, value)
  }

  async delete(key: string): Promise<void> {
    return this.inner.delete(key)
  }

  async clear(): Promise<void> {
    this.cache.clear()
    return this.inner.clear()
  }

  backendName(): string {
    // Said plainly, because §15 requires the interface to state which backend is active and
    // "a file" and "a file holding pointers into your vault" are different promises.
    return `${this.inner.backendName()} + credential function`
  }
}
