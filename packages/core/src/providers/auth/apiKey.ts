import type { SecretStore } from '../../platform/secrets.js'
import type { Auth, AuthStrategy } from '../types.js'

export class ApiKeyAuthStrategy implements AuthStrategy {
  constructor(
    private readonly secrets: SecretStore,
    private readonly apiKeyRef: string,
  ) {}

  async resolveHeaders(): Promise<Record<string, string>> {
    const key = await this.secrets.get(this.apiKeyRef)
    if (key === undefined) {
      throw new Error(`Credential missing for profile — no secret found at "${this.apiKeyRef}". Reconfigure the provider.`)
    }
    return { Authorization: `Bearer ${key}` }
  }
}

export class NoAuthStrategy implements AuthStrategy {
  async resolveHeaders(): Promise<Record<string, string>> {
    return {}
  }
}

export function createAuthStrategy(auth: Auth, secrets: SecretStore): AuthStrategy {
  switch (auth.type) {
    case 'apiKey':
      return new ApiKeyAuthStrategy(secrets, auth.apiKeyRef)
    case 'none':
      return new NoAuthStrategy()
  }
}
