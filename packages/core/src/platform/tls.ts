import fs from 'node:fs'
import tls from 'node:tls'
import type { TlsOptions } from './http.js'

/**
 * Building the CA trust list for an outbound connection.
 *
 * The trap this exists to avoid: passing `ca` to Node or undici **replaces** the bundled
 * Mozilla root store rather than adding to it. A user who supplies a corporate root so
 * their gateway works would silently lose every public CA — and the failure appears as an
 * unrelated certificate error against some other host, long after the change.
 *
 * `NODE_EXTRA_CA_CERTS` has the same problem from the other side: Node folds it into the
 * default store at startup, but an explicit `ca` bypasses the default store entirely, so
 * it must be re-read and re-added here or setting it appears to do nothing.
 */

let cachedExtraCaCerts: string[] | undefined
let cachedExtraCaPath: string | undefined

/**
 * Reads `NODE_EXTRA_CA_CERTS` if set. Cached by path, because it is read on every request
 * that builds an agent and the file does not change within a session.
 */
export function readNodeExtraCaCerts(env: NodeJS.ProcessEnv = process.env): string[] {
  const configuredPath = env.NODE_EXTRA_CA_CERTS
  if (configuredPath === undefined || configuredPath.trim().length === 0) return []
  if (cachedExtraCaPath === configuredPath && cachedExtraCaCerts !== undefined) return cachedExtraCaCerts

  try {
    const contents = fs.readFileSync(configuredPath, 'utf8')
    cachedExtraCaCerts = contents.trim().length > 0 ? [contents] : []
  } catch {
    // Node itself ignores an unreadable NODE_EXTRA_CA_CERTS with a warning rather than
    // failing to start; matching that is less surprising than refusing to connect.
    cachedExtraCaCerts = []
  }
  cachedExtraCaPath = configuredPath
  return cachedExtraCaCerts
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function clearExtraCaCache(): void {
  cachedExtraCaCerts = undefined
  cachedExtraCaPath = undefined
}

/**
 * Produces the full trust list: bundled roots + `NODE_EXTRA_CA_CERTS` + whatever the
 * profile configured. Returns `undefined` when no extras exist, so the common case leaves
 * Node's default handling untouched rather than re-specifying it.
 */
export function buildCaBundle(
  configured: Buffer[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): (string | Buffer)[] | undefined {
  const extraFromEnv = readNodeExtraCaCerts(env)
  const extraFromConfig = configured ?? []
  if (extraFromEnv.length === 0 && extraFromConfig.length === 0) return undefined

  return [...tls.rootCertificates, ...extraFromEnv, ...extraFromConfig]
}

/**
 * The shape handed to undici's `connect`. Split out from `FetchHttpClient` so the CA
 * merging above is testable without opening a socket.
 */
export interface ConnectOptions {
  cert?: Buffer
  key?: Buffer
  pfx?: Buffer
  passphrase?: string
  ca?: (string | Buffer)[]
}

export function buildConnectOptions(options: TlsOptions, env: NodeJS.ProcessEnv = process.env): ConnectOptions {
  const connect: ConnectOptions = {}
  if (options.cert !== undefined) connect.cert = options.cert
  if (options.key !== undefined) connect.key = options.key
  if (options.pfx !== undefined) connect.pfx = options.pfx
  if (options.passphrase !== undefined) connect.passphrase = options.passphrase

  const ca = buildCaBundle(options.ca, env)
  if (ca !== undefined) connect.ca = ca
  return connect
}
