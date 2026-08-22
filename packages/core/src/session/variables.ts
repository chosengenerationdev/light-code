import { z } from 'zod'

/**
 * Values a session makes visible to what it runs — shell commands, Python tools, MCP servers.
 *
 * ## They are not secrets, and the UI must say so
 *
 * Everything a session spawns runs as the *service account*, so one user's agent can read
 * another user's files or simply run `env`. Separating variables per user answers "whose value
 * applies", which is a real question. It does not answer "who can read it", and §14's gap — one
 * OS account per session — is what would.
 *
 * Storing an API key here would therefore be a mistake, and the field that accepts one has to say
 * that where it is typed rather than in a document nobody opens. Provider credentials have a
 * different home: `SecretStore`, never in config, never in an export (§15).
 */
export const sessionVariableSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  /** Shown beside the value. For "which one of these is the staging URL". */
  description: z.string().optional(),
})
export type SessionVariable = z.infer<typeof sessionVariableSchema>

export const sessionVariablesSchema = z.array(sessionVariableSchema)

/** Which scope a value came from, once precedence has been applied. */
export type VariableScope = 'admin' | 'user'

export interface ResolvedVariable extends SessionVariable {
  scope: VariableScope
  /**
   * The user's own value, when an administrator's has displaced it.
   *
   * Carried rather than dropped so the UI can say "yours is overridden" and show what it was.
   * Silently rendering the winning value under the user's own edit box is how someone spends an
   * afternoon on a variable that was never going to take effect.
   */
  overriddenUserValue?: string
}

/**
 * An environment variable name that a shell will actually accept.
 *
 * Deliberately strict. A name with a space or an `=` is not something the platform can express,
 * and the failure is a process that starts with a *silently different* environment rather than an
 * error — so it is refused at the point someone types it.
 */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidVariableName(name: string): boolean {
  return VALID_NAME.test(name)
}

/**
 * Merges the administrator's variables over the user's.
 *
 * **Admin wins**, as specified. The reasoning is that an administrator sets a variable for
 * everyone precisely when it must be the same everywhere — an internal registry, a proxy, a
 * compliance flag — and a per-user value silently winning would defeat the only reason to set one
 * centrally. The cost is that a user can be overridden without noticing, which is exactly why the
 * loser is reported rather than discarded.
 *
 * Case: names are compared exactly. Windows environment variables are case-insensitive and POSIX
 * ones are not, and picking either behaviour here would be wrong on the other platform. Exact
 * comparison at least means what the user typed is what is compared, and `PATH` versus `Path` on
 * Windows is a collision the platform resolves for us at spawn time.
 */
export function resolveSessionVariables(
  adminVariables: readonly SessionVariable[],
  userVariables: readonly SessionVariable[],
): ResolvedVariable[] {
  const byName = new Map<string, ResolvedVariable>()
  for (const variable of userVariables) {
    byName.set(variable.name, { ...variable, scope: 'user' })
  }
  for (const variable of adminVariables) {
    const displaced = byName.get(variable.name)
    byName.set(variable.name, {
      ...variable,
      scope: 'admin',
      ...(displaced !== undefined ? { overriddenUserValue: displaced.value } : {}),
    })
  }
  // Sorted so a diff of what a session was given is stable between runs.
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The plain map handed to a spawned process.
 *
 * Invalid names are dropped rather than passed through: they cannot be set, and a process that
 * starts with a quietly different environment is worse than one that never gets the variable.
 */
export function toEnvironment(variables: readonly ResolvedVariable[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const variable of variables) {
    if (!isValidVariableName(variable.name)) continue
    env[variable.name] = variable.value
  }
  return env
}
