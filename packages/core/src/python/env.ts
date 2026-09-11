import type { SecretStore } from '../platform/secrets.js'

/** One variable as config holds it, before anything has been read out of secret storage. */
export interface PythonEnvEntry {
  name: string
  /** The literal value, when it is not a secret. */
  value?: string | undefined
  /** True when the value lives in secret storage rather than in config. */
  secret: boolean
}

/**
 * What a variable name may be.
 *
 * Not decoration: a name with an `=` or a space in it is not a variable at all on either
 * platform, and the failure is a child process that starts with a mangled environment rather
 * than an error anybody sees. Refused at the edge instead.
 */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidEnvName(name: string): boolean {
  return VALID_NAME.test(name)
}

/**
 * Where a secret-valued variable is stored.
 *
 * Namespaced so deleting the variable can delete its secret \u2014 \u00a715's rule about orphans, which
 * otherwise accumulate invisibly because nothing ever lists them.
 */
export function pythonEnvSecretRef(name: string): string {
  return `python:env:${name}`
}

/**
 * The one reading of the config shape.
 *
 * Config accepts a bare string as shorthand for a literal value, because the file is hand-edited
 * as often as it is written by the UI. Everything downstream \u2014 the UI, the resolver, the save
 * handler \u2014 works from this, so "what does an entry mean" is answered once.
 */
export function pythonEnvEntries(
  saved:
    | Record<string, string | { value?: string | undefined; secret?: boolean | undefined }>
    | undefined,
): PythonEnvEntry[] {
  if (saved === undefined) return []
  return Object.entries(saved)
    .filter(([name]) => isValidEnvName(name))
    .map(([name, raw]) =>
      typeof raw === 'string'
        ? { name, value: raw, secret: false }
        : {
            name,
            ...(raw.value !== undefined ? { value: raw.value } : {}),
            secret: raw.secret === true,
          },
    )
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** What a resolution produced, and what it could not find. */
export interface ResolvedPythonEnv {
  env: Record<string, string>
  /** Names marked secret whose value is not in storage. Reported, never guessed at. */
  missing: string[]
}

/**
 * Reads the values, secrets included, at the moment a child is about to be spawned.
 *
 * Read here rather than held, per \u00a715: the manager keeps the *declaration* \u2014 names, and which
 * are secret \u2014 which is not sensitive, and fetches the values when it needs them. A rotated
 * secret then reaches the next worker without anything having to invalidate a cache.
 *
 * A missing secret is reported rather than substituted. Passing an empty string would produce an
 * authentication failure inside somebody's tool, which points at the tool; naming the variable
 * points at the thing that is actually wrong.
 */
export async function resolvePythonEnv(
  entries: readonly PythonEnvEntry[],
  secrets: SecretStore | undefined,
): Promise<ResolvedPythonEnv> {
  const env: Record<string, string> = {}
  const missing: string[] = []
  for (const entry of entries) {
    if (!entry.secret) {
      if (entry.value !== undefined) env[entry.name] = entry.value
      continue
    }
    const value =
      secrets === undefined ? undefined : await secrets.get(pythonEnvSecretRef(entry.name))
    if (value === undefined) missing.push(entry.name)
    else env[entry.name] = value
  }
  return { env, missing }
}
