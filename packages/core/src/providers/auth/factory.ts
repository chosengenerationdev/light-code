import type { HttpClient, TlsOptions } from '../../platform/http.js'
import type { SecretStore } from '../../platform/secrets.js'
import type { Auth, AuthStrategy, WireFormat } from '../types.js'
import { ApigeeMtlsAuthStrategy } from './apigeeMtls.js'
import { ApiKeyAuthStrategy, defaultApiKeyHeader, NoAuthStrategy } from './apiKey.js'
import { assertCertDirOutsideWorkspace, type CertConfig, checkExpiry, type ExpiryWarning, loadCerts } from './certs.js'

export interface AuthStrategyContext {
  secrets: SecretStore
  http: HttpClient
  /** The profile's inference base URL — the token URL defaults to its origin. */
  baseUrl: string
  /**
   * Decides which header an API key goes in: Anthropic wants `x-api-key`, Gemini wants
   * `x-goog-api-key`, OpenAI wants `Authorization: Bearer`. Omitted means OpenAI-style,
   * which keeps existing callers working.
   */
  wireFormat?: WireFormat
  /** Overrides the derived header name, for a gateway that fronts a provider differently. */
  apiKeyHeaderName?: string
  apiKeyHeaderPrefix?: string
  /** Top-level user-scope `certDir`, used when the auth block does not name its own. */
  defaultCertDir?: string
  /** Used to enforce invariant 6. Omit when no folder is open. */
  workspaceRoot?: string
  /** Called with cert paths actually read, so they can join the tool deny list. */
  onCertPaths?: (paths: string[]) => void
  /** Called when the client certificate is near or past expiry (§10). */
  onExpiryWarning?: (warning: ExpiryWarning) => void
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

/**
 * Reads certificate material fresh on each call. Cheap relative to a TLS handshake, and it
 * means a rotated certificate takes effect without restarting — §10 requires the cached
 * token to be dropped on cert change, and re-reading is what makes that observable.
 */
export function createCertLoader(
  auth: Extract<Auth, { type: 'apigeeMtls' }>,
  context: AuthStrategyContext,
): () => Promise<TlsOptions | undefined> {
  return async () => {
    const certDir = auth.certs.certDir ?? context.defaultCertDir
    if (certDir === undefined) {
      throw new AuthConfigError(
        'This profile uses mutual TLS but no certificate directory is set. Set certDir in Settings → Advanced.',
      )
    }
    assertCertDirOutsideWorkspace(certDir, context.workspaceRoot)

    const passphrase =
      auth.certs.passphraseRef !== undefined ? await context.secrets.get(auth.certs.passphraseRef) : undefined
    if (auth.certs.passphraseRef !== undefined && passphrase === undefined) {
      throw new AuthConfigError(
        'The certificate passphrase is missing from secure storage. Re-enter it in Settings → Advanced.',
      )
    }

    const certConfig: CertConfig = {
      certDir,
      ...(auth.certs.certFile !== undefined ? { certFile: auth.certs.certFile } : {}),
      ...(auth.certs.keyFile !== undefined ? { keyFile: auth.certs.keyFile } : {}),
      ...(auth.certs.pfxFile !== undefined ? { pfxFile: auth.certs.pfxFile } : {}),
      ...(auth.certs.caFile !== undefined ? { caFile: auth.certs.caFile } : {}),
      ...(passphrase !== undefined ? { passphrase } : {}),
    }

    const loaded = await loadCerts(certConfig)
    context.onCertPaths?.(loaded.paths)

    const warning = checkExpiry(loaded.notAfter)
    if (warning !== undefined) context.onExpiryWarning?.(warning)

    const tls: TlsOptions = {}
    if (loaded.cert !== undefined) tls.cert = loaded.cert
    if (loaded.key !== undefined) tls.key = loaded.key
    if (loaded.pfx !== undefined) tls.pfx = loaded.pfx
    if (loaded.ca !== undefined) tls.ca = loaded.ca
    if (loaded.passphrase !== undefined) tls.passphrase = loaded.passphrase
    return tls
  }
}

export function createAuthStrategy(auth: Auth, context: AuthStrategyContext): AuthStrategy {
  switch (auth.type) {
    case 'apiKey': {
      const derived = defaultApiKeyHeader(context.wireFormat ?? 'openai')
      return new ApiKeyAuthStrategy(context.secrets, auth.apiKeyRef, {
        name: context.apiKeyHeaderName ?? derived.name,
        prefix: context.apiKeyHeaderPrefix ?? derived.prefix,
      })
    }
    case 'none':
      return new NoAuthStrategy()
    case 'apigeeMtls': {
      const { clientSecretRef, ...rest } = auth.apigee
      return new ApigeeMtlsAuthStrategy(
        context.http,
        {
          ...rest,
          // Resolved per token request rather than captured here, so rotating the secret
          // in storage takes effect on the next refresh (§15: fetch at request time).
          resolveClientSecret: async () => {
            if (clientSecretRef === undefined) return undefined
            const secret = await context.secrets.get(clientSecretRef)
            if (secret === undefined) {
              throw new AuthConfigError(
                'The Apigee client secret is missing from secure storage. Re-enter it in Settings → Advanced.',
              )
            }
            return secret
          },
        },
        context.baseUrl,
        createCertLoader(auth, context),
      )
    }
  }
}
