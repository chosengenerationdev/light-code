import type { SecretStore } from '../../platform/secrets.js'
import type { AuthStrategy } from '../types.js'

export class ApiKeyAuthStrategy implements AuthStrategy {
  constructor(
    private readonly secrets: SecretStore,
    private readonly apiKeyRef: string,
  ) {}

  async resolveHeaders(): Promise<Record<string, string>> {
    const key = await this.secrets.get(this.apiKeyRef)
    if (key === undefined) {
      throw new Error(
        'API key missing for this provider profile. Open Settings (the icon in the Light Code header), ' +
          'edit the active profile, and enter the API key again.',
      )
    }
    return { Authorization: `Bearer ${key}` }
  }
}

export class NoAuthStrategy implements AuthStrategy {
  async resolveHeaders(): Promise<Record<string, string>> {
    return {}
  }
}
