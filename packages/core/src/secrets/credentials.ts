import type { SecretStore } from '../platform/secrets.js'

/**
 * Saved credentials: named values kept once and used from any setting that takes a secret.
 *
 * Fire Code's credential manager stores each credential's value(s) in the shared secret store
 * under `credential:<id>#<field>`. A setting that should use one does not get a copy - its secret
 * slot holds a **pointer**, the string `credential:<id>#<field>`, which this store resolves on
 * read. So replacing a password in the manager changes every codebase and setting using it at once,
 * and deleting one shows up as the ordinary "credential missing" error rather than a stale copy.
 *
 * A pointer is not a secret - it names a credential, it does not contain one - which is why the
 * picker in the settings UI can set it like any typed value without breaking invariant 7.
 */

export const CREDENTIAL_PREFIX = 'credential:'

export type CredentialKind = 'secret' | 'login'

/** What the settings UI is told about a saved credential: never a value. */
export interface CredentialSummary {
  id: string
  label: string
  kind: CredentialKind
  note?: string
}

/** One selectable entry in a picker: a pointer and the words to show for it. */
export interface CredentialChoice {
  pointer: string
  label: string
}

/** The fields a credential of each kind stores. */
export function credentialFields(kind: CredentialKind): readonly string[] {
  return kind === 'login' ? ['username', 'password'] : ['value']
}

export function credentialPointer(id: string, field: string): string {
  return `${CREDENTIAL_PREFIX}${id}#${field}`
}

export function isCredentialPointer(value: string | undefined): value is string {
  return value !== undefined && value.startsWith(CREDENTIAL_PREFIX) && value.includes('#')
}

/**
 * Every pointer a picker can offer: a plain secret once, a login as its username and its password
 * separately - a password field wants the password, a username field the username.
 */
export function credentialChoices(credentials: readonly CredentialSummary[]): CredentialChoice[] {
  const choices: CredentialChoice[] = []
  for (const credential of [...credentials].sort((a, b) => a.label.localeCompare(b.label))) {
    if (credential.kind === 'login') {
      choices.push({ pointer: credentialPointer(credential.id, 'password'), label: `${credential.label} — password` })
      choices.push({ pointer: credentialPointer(credential.id, 'username'), label: `${credential.label} — username` })
    } else {
      choices.push({ pointer: credentialPointer(credential.id, 'value'), label: credential.label })
    }
  }
  return choices
}

/** The label a pointer stands for, for showing "Uses Corp LDAP — password" instead of the pointer. */
export function describePointer(pointer: string, credentials: readonly CredentialSummary[]): string | undefined {
  return credentialChoices(credentials).find((choice) => choice.pointer === pointer)?.label
}

/**
 * A secret store that follows pointers to saved credentials.
 *
 * - Reading a key that is itself a pointer (`${secret:credential:abc#password}` in an MCP header)
 *   returns that credential's value.
 * - Reading an ordinary slot whose stored value is a pointer returns what it points at. **One hop
 *   only**: a credential's own value is never treated as a pointer, so a password that happens to
 *   start with `credential:` cannot send the lookup somewhere else, and nothing can loop.
 * - Writes are passed through untouched, pointers included: choosing a credential stores the
 *   pointer, which is the point.
 */
export class CredentialPointerStore implements SecretStore {
  constructor(private readonly inner: SecretStore) {}

  async get(key: string): Promise<string | undefined> {
    if (isCredentialPointer(key)) return this.inner.get(key)
    const stored = await this.inner.get(key)
    return isCredentialPointer(stored) ? this.inner.get(stored) : stored
  }

  set(key: string, value: string): Promise<void> {
    return this.inner.set(key, value)
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key)
  }

  clear(): Promise<void> {
    return this.inner.clear()
  }

  backendName(): string {
    return this.inner.backendName()
  }
}
