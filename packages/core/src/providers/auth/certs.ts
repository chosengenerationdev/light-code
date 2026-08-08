import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeForComparison } from '../../fs/confine.js'

export interface CertConfig {
  /** Directory the filenames resolve against. Must be outside the workspace (invariant 6). */
  certDir: string
  /** Defaults to `client.crt`. Absolute paths override `certDir`. */
  certFile?: string
  /** Defaults to `client.key`. */
  keyFile?: string
  /** Corporate Windows PKI usually issues `.pfx`; supplied instead of cert/key. */
  pfxFile?: string
  /** Extra CA roots, e.g. a corporate interception root. */
  caFile?: string
  /** Resolved from `SecretStore` before reaching here — never a literal in config. */
  passphrase?: string
}

export interface LoadedCerts {
  cert?: Buffer
  key?: Buffer
  pfx?: Buffer
  ca?: Buffer[]
  passphrase?: string
  /** Expiry of the client certificate, when it could be determined. */
  notAfter?: Date
  /** Paths actually read — fed to the tool deny list (invariant 6). */
  paths: string[]
}

/**
 * Errors here are shown to the user, so they name the file and the reason. Raw OpenSSL
 * codes like `UNABLE_TO_VERIFY_LEAF_SIGNATURE` are never surfaced — CLAUDE.md §10.
 */
export class CertError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CertError'
  }
}

function resolveAgainst(certDir: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(certDir, file)
}

/**
 * `certDir` inside the workspace is rejected **at config time** (invariant 6): a repo
 * that could place its own key material where a tool might read it defeats the deny list.
 */
export function assertCertDirOutsideWorkspace(certDir: string, workspaceRoot: string | undefined): void {
  if (workspaceRoot === undefined) return
  const normalizedDir = normalizeForComparison(path.resolve(certDir))
  const normalizedRoot = normalizeForComparison(path.resolve(workspaceRoot))
  if (normalizedDir === normalizedRoot || normalizedDir.startsWith(normalizedRoot + path.sep)) {
    throw new CertError(
      `Certificate directory "${certDir}" is inside the workspace. Move it outside so a repository cannot read or replace your key material.`,
    )
  }
}

async function readFileOrThrow(filePath: string, label: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new CertError(`${label} not found at "${filePath}".`)
    if (code === 'EACCES') throw new CertError(`${label} at "${filePath}" is not readable (permission denied).`)
    throw new CertError(`Could not read ${label} at "${filePath}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Verifies the private key actually belongs to the certificate by signing with the key
 * and verifying with the certificate's public key. A mismatched pair otherwise fails
 * later as an opaque TLS handshake error, which is exactly what §10 says to avoid.
 */
function assertKeyMatchesCert(cert: Buffer, key: Buffer, passphrase: string | undefined): void {
  let publicKey: crypto.KeyObject
  let privateKey: crypto.KeyObject
  try {
    publicKey = new crypto.X509Certificate(cert).publicKey
  } catch (error) {
    throw new CertError(`The certificate could not be parsed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    privateKey = crypto.createPrivateKey(
      passphrase !== undefined ? { key, passphrase } : { key },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/bad decrypt|bad password|passphrase/i.test(message)) {
      throw new CertError('The private key is encrypted and the passphrase is missing or wrong.')
    }
    throw new CertError(`The private key could not be parsed: ${message}`)
  }

  const probe = Buffer.from('light-code-key-match-probe')
  try {
    const signature = crypto.sign(null, probe, privateKey)
    if (!crypto.verify(null, probe, publicKey, signature)) {
      throw new CertError('The private key does not match the certificate.')
    }
  } catch (error) {
    if (error instanceof CertError) throw error
    // Some key types reject `sign(null, ...)`; fall back to comparing exported public keys.
    const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    const expected = publicKey.export({ type: 'spki', format: 'der' })
    if (!derived.equals(expected)) {
      throw new CertError('The private key does not match the certificate.')
    }
  }
}

export async function loadCerts(config: CertConfig): Promise<LoadedCerts> {
  const paths: string[] = []
  const loaded: LoadedCerts = { paths }
  if (config.passphrase !== undefined) loaded.passphrase = config.passphrase

  if (config.caFile !== undefined) {
    const caPath = resolveAgainst(config.certDir, config.caFile)
    loaded.ca = [await readFileOrThrow(caPath, 'CA bundle')]
    paths.push(caPath)
  }

  if (config.pfxFile !== undefined) {
    const pfxPath = resolveAgainst(config.certDir, config.pfxFile)
    loaded.pfx = await readFileOrThrow(pfxPath, 'PFX bundle')
    paths.push(pfxPath)
    // Node validates a PFX only at handshake time, so `notAfter` is unavailable here
    // without decrypting it ourselves. Absent is honest; a wrong date would be worse.
    return loaded
  }

  const certPath = resolveAgainst(config.certDir, config.certFile ?? 'client.crt')
  const keyPath = resolveAgainst(config.certDir, config.keyFile ?? 'client.key')

  const cert = await readFileOrThrow(certPath, 'Client certificate')
  const key = await readFileOrThrow(keyPath, 'Private key')
  paths.push(certPath, keyPath)

  assertKeyMatchesCert(cert, key, config.passphrase)

  loaded.cert = cert
  loaded.key = key
  try {
    loaded.notAfter = new Date(new crypto.X509Certificate(cert).validTo)
  } catch {
    // Already parsed above; if this somehow fails, an absent expiry is not fatal.
  }
  return loaded
}

export interface ExpiryWarning {
  daysRemaining: number
  message: string
}

/** Warns at 30 and 7 days, and after expiry — CLAUDE.md §10. */
export function checkExpiry(notAfter: Date | undefined, now: Date = new Date()): ExpiryWarning | undefined {
  if (notAfter === undefined) return undefined
  const msRemaining = notAfter.getTime() - now.getTime()
  const daysRemaining = Math.floor(msRemaining / 86_400_000)

  if (msRemaining <= 0) {
    return { daysRemaining, message: `Your client certificate expired on ${notAfter.toDateString()}.` }
  }
  if (daysRemaining <= 7) {
    return { daysRemaining, message: `Your client certificate expires in ${daysRemaining} day(s), on ${notAfter.toDateString()}.` }
  }
  if (daysRemaining <= 30) {
    return { daysRemaining, message: `Your client certificate expires in ${daysRemaining} days, on ${notAfter.toDateString()}.` }
  }
  return undefined
}
