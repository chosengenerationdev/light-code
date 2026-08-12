import { resolveConnectionTls, type TlsFileSettings } from '../../platform/connectionTls.js'
import type { HttpClient, TlsOptions } from '../../platform/http.js'
import type { SecretStore } from '../../platform/secrets.js'
import type { Auth, AuthStrategy, ProviderProfile, WireFormat } from '../types.js'
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
  /** The profile's `tls` block: an extra CA, and whether to verify the server certificate. */
  connectionTls?: ProviderProfile['tls']
  /** The global `tls` block, applied to every connection. */
  globalTls?: TlsFileSettings
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

/**
 * Loads the profile's connection-trust settings: an extra CA, and whether to verify the
 * server certificate at all.
 *
 * Applies to every auth type. A client certificate answers "who am I"; this answers "do I
 * trust the other end", and a corporate user behind a TLS-intercepting proxy needs the
 * second whether or not they need the first.
 */
export function createConnectionTlsLoader(
  connection: ProviderProfile['tls'],
  context: AuthStrategyContext,
): (() => Promise<TlsOptions | undefined>) | undefined {
  // Global settings alone are reason enough to build a loader, even with nothing set on
  // the profile — reuse without touching each profile is the whole point of the block.
  if (connection === undefined && context.globalTls === undefined) return undefined

  return async () => {
    if (context.defaultCertDir !== undefined) {
      assertCertDirOutsideWorkspace(context.defaultCertDir, context.workspaceRoot)
    }
    const passphraseRef = connection?.passphraseRef ?? context.globalTls?.passphraseRef
    const passphrase = passphraseRef !== undefined ? await context.secrets.get(passphraseRef) : undefined
    if (passphraseRef !== undefined && passphrase === undefined) {
      throw new AuthConfigError(
        'The certificate passphrase is missing from secure storage. Re-enter it in Settings → Network.',
      )
    }

    return resolveConnectionTls({
      ...(context.globalTls !== undefined ? { global: context.globalTls } : {}),
      ...(connection !== undefined ? { connection } : {}),
      ...(context.defaultCertDir !== undefined ? { certDir: context.defaultCertDir } : {}),
      ...(passphrase !== undefined ? { passphrase } : {}),
      ...(context.onCertPaths !== undefined ? { onPaths: context.onCertPaths } : {}),
    })
  }
}

/** Merges profile-level connection trust into whatever TLS the auth strategy supplies. */
function withConnectionTls(
  strategy: AuthStrategy,
  loadConnectionTls: (() => Promise<TlsOptions | undefined>) | undefined,
): AuthStrategy {
  if (loadConnectionTls === undefined) return strategy

  const wrapped: AuthStrategy = {
    resolveHeaders: () => strategy.resolveHeaders(),
    async tls() {
      const connection = await loadConnectionTls()
      const fromAuth = await strategy.tls?.()
      if (connection === undefined) return fromAuth
      if (fromAuth === undefined) return connection
      // The auth strategy's client material wins: an Apigee profile names its certificates
      // explicitly, and that is more specific than anything inherited. Trust settings come
      // from the connection, and the two `ca` lists merge rather than one replacing the
      // other — the same accumulation rule `resolveConnectionTls` applies one level down.
      return {
        ...connection,
        ...fromAuth,
        ...(connection.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
        ...(connection.ca !== undefined || fromAuth.ca !== undefined
          ? { ca: [...(fromAuth.ca ?? []), ...(connection.ca ?? [])] }
          : {}),
      }
    },
  }
  if (strategy.onUnauthorized !== undefined) wrapped.onUnauthorized = () => strategy.onUnauthorized!()
  if (strategy.ensureTokenForStream !== undefined) wrapped.ensureTokenForStream = () => strategy.ensureTokenForStream!()
  return wrapped
}

export function createAuthStrategy(auth: Auth, context: AuthStrategyContext): AuthStrategy {
  return withConnectionTls(createBaseAuthStrategy(auth, context), createConnectionTlsLoader(context.connectionTls, context))
}

function createBaseAuthStrategy(auth: Auth, context: AuthStrategyContext): AuthStrategy {
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
