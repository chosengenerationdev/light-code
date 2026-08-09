import type { SecretStore } from '../../platform/secrets.js'
import type { AuthStrategy, WireFormat } from '../types.js'

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
    const key = await this.secrets.get(this.apiKeyRef)
    if (key === undefined) {
      throw new Error(
        'API key missing for this provider profile. Open Settings (the icon in the Light Code header), ' +
          'edit the active profile, and enter the API key again.',
      )
    }
    return { [this.header.name]: `${this.header.prefix}${key}` }
  }
}

export class NoAuthStrategy implements AuthStrategy {
  async resolveHeaders(): Promise<Record<string, string>> {
    return {}
  }
}
