import type { SecretStore } from '../../platform/secrets.js'
import type { AuthStrategy } from '../types.js'
import { describeMissingSecret, resolveSecretRef } from './secretRef.js'

export interface HeaderCredential {
  name: string
  /** A secret-store key, or `env:NAME`. Never the value itself — see below. */
  valueRef: string
  prefix?: string | undefined
}

/**
 * Authentication by a fixed header the gateway expects.
 *
 * ## Why this is not "an API key with a different header name"
 *
 * It nearly is, and that was the first design. Two things make it worth its own type. A gateway
 * of this shape often wants *more than one* header — a key and a tenant, a token and a product id
 * — and `apiKey` has room for exactly one. And the existing `apiKeyHeaderName` hook was never
 * wired to anything, so "just set the header name" was not actually reachable from config; a type
 * that names what it does is better than a field somebody has to discover is inert.
 *
 * ## Why the value is a reference and never a literal
 *
 * `ProviderProfile.headers` already exists and would technically work — but it is part of the
 * config file, and §15 is explicit that a credential never goes there. It would be exported, read
 * by anything that can read the workspace, and printed by anything that logs config. So each
 * value is a *reference*: a secret-store key, or `env:API_TOKEN` for a gateway whose credential
 * the launching process already holds.
 *
 * ## Why nothing here is resolved once and cached
 *
 * §15's rule: fetch at request time. A credential rotated in the store, or an environment
 * variable a wrapper re-exports, takes effect on the next request rather than on the next restart.
 */
export class HeaderAuthStrategy implements AuthStrategy {
  constructor(
    private readonly secrets: SecretStore,
    private readonly credentials: readonly HeaderCredential[],
  ) {}

  async resolveHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {}
    for (const credential of this.credentials) {
      const value = await resolveSecretRef(credential.valueRef, { secrets: this.secrets })
      if (value === undefined) {
        // Names the header as well as the reference. With several configured, "a credential is
        // missing" leaves the user checking each one by hand.
        throw new Error(
          `${describeMissingSecret(credential.valueRef, `the value for header "${credential.name}"`)}`,
        )
      }
      headers[credential.name] = `${credential.prefix ?? ''}${value}`
    }
    return headers
  }
}
