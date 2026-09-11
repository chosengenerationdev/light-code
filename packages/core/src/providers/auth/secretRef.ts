import type { SecretStore } from '../../platform/secrets.js'

/**
 * Where a credential actually comes from.
 *
 * ## Why a reference can name the environment
 *
 * The Node host is increasingly launched *by* something else — a Streamlit app, a wrapper script,
 * a container entrypoint — and that parent often already holds the credential: it has an internal
 * library that does the gateway's auth dance and has a token in hand before Light Code starts. The
 * only thing it can hand a child process is the environment, so `env:API_TOKEN` says "the key is
 * already there, under that name".
 *
 * Without it the user's only option is to paste a token into Settings that their launcher already
 * knows — typed by hand, stale the moment it rotates, and stored twice.
 *
 * ## Why this is not a hole
 *
 * The whole `profiles` list is user-scope only (invariant 5), so a hostile repository cannot add a
 * profile that reads `env:AWS_SECRET_ACCESS_KEY` and posts it to a gateway of its choosing. The
 * person naming the variable is the person who owns the process.
 *
 * **On a shared Node host that reasoning is weaker**, because one user's profile would read the
 * *service account's* environment rather than their own. §14 already says hosting is only
 * appropriate where every user is trusted with everything every other user can reach, and this
 * sits inside that — but it is the kind of thing to state rather than discover.
 *
 * ## Why it is resolved here rather than at each call site
 *
 * One owner. There are three places that turn a reference into a value — the auth strategy, the
 * "is a key set?" summary the UI renders, and the redaction list — and a reference form understood
 * by two of them produces a product that authenticates fine while reporting the key as missing and
 * printing it into a log.
 */
export const ENV_REF_PREFIX = 'env:'

export interface SecretRefDescription {
  kind: 'store' | 'env'
  /** The environment variable's name, for an `env:` reference. */
  envVar?: string
}

export function describeSecretRef(ref: string): SecretRefDescription {
  if (!ref.startsWith(ENV_REF_PREFIX)) return { kind: 'store' }
  const envVar = ref.slice(ENV_REF_PREFIX.length).trim()
  // `env:` with nothing after it is a typo, not a request for an unnamed variable. Treated as an
  // ordinary store reference so it fails as "not set" rather than reading `process.env['']`.
  return envVar.length === 0 ? { kind: 'store' } : { kind: 'env', envVar }
}

export interface ResolveSecretRefOptions {
  secrets: SecretStore
  /** Injectable so a test never depends on the runner's own environment. */
  env?: NodeJS.ProcessEnv
}

/**
 * The value behind a reference, or `undefined` if there is none.
 *
 * An empty environment variable is treated as unset. A variable that exists but is blank is
 * overwhelmingly a launcher whose own lookup failed, and sending an empty bearer token produces a
 * 401 that reads as a bad key rather than as a missing one.
 */
export async function resolveSecretRef(
  ref: string,
  options: ResolveSecretRefOptions,
): Promise<string | undefined> {
  const described = describeSecretRef(ref)
  if (described.kind === 'env') {
    const value = (options.env ?? process.env)[described.envVar as string]
    return value === undefined || value.trim().length === 0 ? undefined : value
  }
  return options.secrets.get(ref)
}

/**
 * What to tell someone when a reference resolves to nothing.
 *
 * Split out because the two cases need completely different advice and the generic message was
 * actively misleading for the new one: telling somebody to "enter the API key again in Settings"
 * when they deliberately pointed at an environment variable sends them to fix the one thing that
 * is not broken. §17 — name what failed and what to do next.
 */
export function describeMissingSecret(ref: string, what = 'API key'): string {
  const described = describeSecretRef(ref)
  if (described.kind === 'env') {
    return (
      `The ${what} is configured to come from the environment variable ` +
      `${String(described.envVar)}, which is not set in this process. Set it before starting ` +
      'Light Code — a variable exported after the process began is not visible to it. If a ' +
      'launcher sets it, check that it is exported rather than assigned only in its own shell.'
    )
  }
  return (
    `${what.charAt(0).toUpperCase()}${what.slice(1)} missing for this provider profile. Open ` +
    'Settings (the icon in the Light Code header), edit the active profile, and enter it again.'
  )
}
