import fs from 'node:fs/promises'
import path from 'node:path'
import type { TlsOptions } from './http.js'

/**
 * One place that decides the TLS material for any outbound connection.
 *
 * There were four: the top-level `certDir`, a provider profile's `tls`, the Apigee auth
 * block's `certs`, and an OpenSearch connection's `caFile`. In practice an organisation has
 * **one** intercepting root and often **one** machine certificate, so configuring them four
 * times is not flexibility — it is three chances to miss one and get an
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` from whichever you forgot.
 *
 * ## Merge rules, chosen deliberately
 *
 * - **CAs accumulate.** Global *plus* connection, never one replacing the other. The real
 *   case is a corporate root everywhere and an extra self-signed cert for one internal
 *   service; replacing would break the first to add the second.
 * - **Client material is all-or-nothing per connection.** A certificate and its key are a
 *   pair, so a connection that names its own `certFile` supplies the whole identity rather
 *   than inheriting a key that does not match it. Naming nothing inherits the global pair
 *   intact.
 * - **`rejectUnauthorized` is most-specific-wins**, including a connection re-enabling
 *   verification that was disabled globally.
 *
 * ## On sharing one client certificate
 *
 * A client certificate is a credential: presenting it identifies you to whatever you
 * connect to. Sharing one across hosts is therefore a real decision, not a free
 * convenience — but in a corporate deployment there genuinely is one machine certificate
 * for all internal services, and every host here is one the user configured themselves.
 * So it is offered globally, and any connection can override it or opt out with
 * `useGlobalClientCertificate: false`.
 */

export interface TlsFileSettings {
  /** Absolute, or relative to `certDir`. */
  caFile?: string | undefined
  certFile?: string | undefined
  keyFile?: string | undefined
  /** Corporate Windows PKI usually issues a `.pfx`, supplied instead of cert + key. */
  pfxFile?: string | undefined
  /**
   * A `SecretStore` reference. Resolved by the caller and passed back as `passphrase` —
   * this module reads files, never secrets.
   */
  passphraseRef?: string | undefined
  rejectUnauthorized?: boolean | undefined
  /**
   * Set `false` so a connection presents no client certificate even when one is configured
   * globally — for an endpoint that should not see your identity.
   */
  useGlobalClientCertificate?: boolean | undefined
}

export interface ResolveTlsOptions {
  global?: TlsFileSettings | undefined
  connection?: TlsFileSettings | undefined
  /** Directory that relative filenames resolve against. */
  certDir?: string | undefined
  /** Resolved passphrase for the client key, from `SecretStore` — never a literal (§15). */
  passphrase?: string | undefined
  /**
   * Called with every path actually read, so they can join the tool deny list (invariant 6).
   * A globally-configured key is exactly as readable as a per-profile one, and the denylist
   * is what stops a tool from handing it to the model.
   */
  onPaths?: ((paths: string[]) => void) | undefined
}

export class TlsConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TlsConfigError'
  }
}

async function readFile(
  file: string,
  certDir: string | undefined,
  label: string,
  seen: string[],
): Promise<Buffer> {
  const resolved = path.isAbsolute(file) ? file : certDir !== undefined ? path.join(certDir, file) : file
  seen.push(resolved)
  try {
    return await fs.readFile(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new TlsConfigError(
      code === 'ENOENT'
        ? `${label} not found at "${resolved}". Check the path in Settings → Network, or set a certificate directory there.`
        : `Could not read ${label.toLowerCase()} at "${resolved}": ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function hasClientMaterial(settings: TlsFileSettings | undefined): boolean {
  return (
    (settings?.certFile !== undefined && settings.certFile.trim().length > 0) ||
    (settings?.pfxFile !== undefined && settings.pfxFile.trim().length > 0)
  )
}

/**
 * Produces the `TlsOptions` for a connection, or `undefined` when nothing special applies —
 * which leaves Node's default trust store in play rather than re-specifying it.
 */
export async function resolveConnectionTls(options: ResolveTlsOptions): Promise<TlsOptions | undefined> {
  const paths: string[] = []

  try {
    return await build(options, paths)
  } finally {
    // Reported even on failure: a path that was attempted is a path that exists in config,
    // and the denylist should cover it either way.
    if (paths.length > 0) options.onPaths?.(paths)
  }
}

async function build(options: ResolveTlsOptions, paths: string[]): Promise<TlsOptions | undefined> {
  const { global, connection, certDir } = options

  // CAs accumulate.
  const cas: Buffer[] = []
  for (const file of [global?.caFile, connection?.caFile]) {
    if (file !== undefined && file.trim().length > 0) {
      cas.push(await readFile(file.trim(), certDir, 'CA certificate', paths))
    }
  }

  // Client identity is taken as a unit. A connection naming its own certificate supplies
  // the whole pair, so it can never end up with one side's cert and the other's key.
  const clientSource = hasClientMaterial(connection)
    ? connection
    : connection?.useGlobalClientCertificate === false
      ? undefined
      : hasClientMaterial(global)
        ? global
        : undefined

  const rejectUnauthorized = connection?.rejectUnauthorized ?? global?.rejectUnauthorized

  if (cas.length === 0 && clientSource === undefined && rejectUnauthorized !== false) return undefined

  const tls: TlsOptions = {}
  if (cas.length > 0) tls.ca = cas
  if (rejectUnauthorized === false) tls.rejectUnauthorized = false

  if (clientSource !== undefined) {
    if (clientSource.pfxFile !== undefined && clientSource.pfxFile.trim().length > 0) {
      tls.pfx = await readFile(clientSource.pfxFile.trim(), certDir, 'PFX bundle', paths)
    } else {
      const certFile = clientSource.certFile?.trim() ?? ''
      const keyFile = clientSource.keyFile?.trim() ?? ''
      if (keyFile.length === 0) {
        throw new TlsConfigError(
          'A client certificate is configured but no private key. Set the key file in Settings → Network, or use a PFX bundle.',
        )
      }
      tls.cert = await readFile(certFile, certDir, 'Client certificate', paths)
      tls.key = await readFile(keyFile, certDir, 'Private key', paths)
    }
    if (options.passphrase !== undefined) tls.passphrase = options.passphrase
  }

  return tls
}
