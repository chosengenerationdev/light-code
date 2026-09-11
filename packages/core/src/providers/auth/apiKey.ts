import type { SecretStore } from '../../platform/secrets.js'
import type { AuthStrategy, WireFormat } from '../types.js'
import { describeMissingSecret, resolveSecretRef } from './secretRef.js'

/**
 * How each wire format expects an API key. Getting this wrong is a 401 that looks like a
 * bad key rather than a bad header, so it is derived from the profile rather than left to
 * the user to discover — but it stays overridable, because a gateway fronting Anthropic
 * often wants `Authorization` regardless of the wire format behind it.
 */
export function defaultApiKeyHeader(wireFormat: WireFormat): { name: string; prefix: string } {
  switch (wireFormat) {
    case 'anthropic':
      return { name: 'x-api-key', prefix: '' }
    case 'gemini':
      return { name: 'x-goog-api-key', prefix: '' }
    case 'openai':
      return { name: 'Authorization', prefix: 'Bearer ' }
  }
}

export class ApiKeyAuthStrategy implements AuthStrategy {
  constructor(
    private readonly secrets: SecretStore,
    private readonly apiKeyRef: string,
    private readonly header: { name: string; prefix: string } = { name: 'Authorization', prefix: 'Bearer ' },
  ) {}

  async resolveHeaders(): Promise<Record<string, string>> {
    /*
     * Resolved through the shared reference reader, so `env:API_TOKEN` works here exactly as it
     * does in the "is a key set?" summary and in the redaction list. A reference form understood
     * by only some of those produces a product that authenticates while reporting the key as
     * missing — and prints it into a log.
     */
    const key = await resolveSecretRef(this.apiKeyRef, { secrets: this.secrets })
    if (key === undefined) {
      // Names the environment variable when that is where it was meant to come from. Telling
      // somebody to re-enter a key in Settings when they deliberately pointed at the environment
      // sends them to fix the one thing that is not broken.
      throw new Error(describeMissingSecret(this.apiKeyRef))
    }
    return { [this.header.name]: `${this.header.prefix}${key}` }
  }
}

export class NoAuthStrategy implements AuthStrategy {
  async resolveHeaders(): Promise<Record<string, string>> {
    return {}
  }
}
