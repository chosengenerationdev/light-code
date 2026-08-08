import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertCertDirOutsideWorkspace, CertError, checkExpiry, loadCerts } from './certs.js'

/**
 * Certificates are generated with real OpenSSL rather than hard-coded, so the key/cert
 * matching and `notAfter` parsing are exercised against genuine X.509 material. Node
 * cannot mint a certificate itself, so where OpenSSL is unavailable those specific tests
 * skip rather than silently passing against a fixture that never parses.
 */
function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const OPENSSL = hasOpenssl()

function generateCertPair(dir: string, certName: string, keyName: string): void {
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', path.join(dir, keyName),
      '-out', path.join(dir, certName),
      '-days', '3650', '-nodes',
      // Leading `/` is doubled so MSYS/Git-Bash on Windows does not rewrite it as a path.
      '-subj', process.platform === 'win32' ? '//CN=light-code-test' : '/CN=light-code-test',
    ],
    { stdio: 'ignore' },
  )
}

describe('assertCertDirOutsideWorkspace', () => {
  const workspace = path.join(os.tmpdir(), 'lc-ws')

  it('rejects a cert directory inside the workspace', () => {
    expect(() => assertCertDirOutsideWorkspace(path.join(workspace, 'certs'), workspace)).toThrow(CertError)
  })

  it('rejects the workspace root itself', () => {
    expect(() => assertCertDirOutsideWorkspace(workspace, workspace)).toThrow(CertError)
  })

  it('allows a directory outside the workspace', () => {
    expect(() => assertCertDirOutsideWorkspace(path.join(os.tmpdir(), 'lc-certs'), workspace)).not.toThrow()
  })

  it('allows anything when no workspace is open', () => {
    expect(() => assertCertDirOutsideWorkspace('/anywhere', undefined)).not.toThrow()
  })

  it('is case-insensitive on Windows, where a differently-cased path is the same directory', () => {
    if (process.platform !== 'win32') return
    expect(() => assertCertDirOutsideWorkspace(path.join(workspace.toUpperCase(), 'certs'), workspace)).toThrow(CertError)
  })
})

describe('checkExpiry', () => {
  const now = new Date('2026-01-01T00:00:00Z')

  it('says nothing when expiry is far away', () => {
    expect(checkExpiry(new Date('2027-01-01T00:00:00Z'), now)).toBeUndefined()
  })

  it('warns at 30 days', () => {
    const warning = checkExpiry(new Date('2026-01-20T00:00:00Z'), now)
    expect(warning?.message).toMatch(/expires in 19 days/)
  })

  it('warns at 7 days', () => {
    const warning = checkExpiry(new Date('2026-01-05T00:00:00Z'), now)
    expect(warning?.message).toMatch(/expires in 4 day/)
  })

  it('reports an already-expired certificate', () => {
    const warning = checkExpiry(new Date('2025-12-01T00:00:00Z'), now)
    expect(warning?.message).toMatch(/expired on/)
  })

  it('says nothing when expiry is unknown', () => {
    expect(checkExpiry(undefined, now)).toBeUndefined()
  })
})

describe('loadCerts', () => {
  let dir: string

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-certs-'))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('names the missing file rather than failing opaquely', async () => {
    await expect(loadCerts({ certDir: dir })).rejects.toThrow(/Client certificate not found/)
  })

  it('names the missing key when only the certificate exists', async () => {
    const certDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-certs-partial-'))
    await fs.writeFile(path.join(certDir, 'client.crt'), 'placeholder')
    await expect(loadCerts({ certDir })).rejects.toThrow(/Private key not found/)
    await fs.rm(certDir, { recursive: true, force: true })
  })

  it('reports an unparseable certificate clearly', async () => {
    const certDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-certs-bad-'))
    await fs.writeFile(path.join(certDir, 'client.crt'), 'not a certificate')
    await fs.writeFile(path.join(certDir, 'client.key'), 'not a key')
    await expect(loadCerts({ certDir })).rejects.toThrow(/certificate could not be parsed/i)
    await fs.rm(certDir, { recursive: true, force: true })
  })

  it('loads a CA bundle when configured', async () => {
    const certDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-certs-ca-'))
    await fs.writeFile(path.join(certDir, 'corp-root.pem'), 'ca-bytes')
    // Fails later on the missing client cert, but the CA read is what is under test.
    await expect(loadCerts({ certDir, caFile: 'corp-root.pem' })).rejects.toThrow(/Client certificate not found/)
    await fs.rm(certDir, { recursive: true, force: true })
  })

  it('loads a PFX without requiring cert/key, and reports no expiry for it', async () => {
    const certDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-certs-pfx-'))
    await fs.writeFile(path.join(certDir, 'client.pfx'), Buffer.from([0x30, 0x82]))
    const loaded = await loadCerts({ certDir, pfxFile: 'client.pfx' })

    expect(loaded.pfx).toBeInstanceOf(Buffer)
    expect(loaded.cert).toBeUndefined()
    // Absent rather than guessed — Node only validates a PFX at handshake time.
    expect(loaded.notAfter).toBeUndefined()
    expect(loaded.paths).toEqual([path.join(certDir, 'client.pfx')])
    await fs.rm(certDir, { recursive: true, force: true })
  })

  it('resolves an absolute path in preference to certDir', async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-certs-abs-'))
    const pfxPath = path.join(elsewhere, 'other.pfx')
    await fs.writeFile(pfxPath, Buffer.from([0x30]))

    const loaded = await loadCerts({ certDir: dir, pfxFile: pfxPath })
    expect(loaded.paths).toEqual([pfxPath])
    await fs.rm(elsewhere, { recursive: true, force: true })
  })
})

describe.skipIf(!OPENSSL)('key/cert matching against real X.509 material', () => {
  let dir: string

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-certs-match-'))
    generateCertPair(dir, 'client.crt', 'client.key')
    // A second, independent pair — its key is definitively not the first cert's.
    generateCertPair(dir, 'other.crt', 'other.key')
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('accepts a genuine matching cert/key pair and reports its expiry', async () => {
    const loaded = await loadCerts({ certDir: dir })

    expect(loaded.cert).toBeInstanceOf(Buffer)
    expect(loaded.key).toBeInstanceOf(Buffer)
    expect(loaded.notAfter).toBeInstanceOf(Date)
    // Generated with -days 3650, so it must be comfortably in the future.
    expect(loaded.notAfter!.getTime()).toBeGreaterThan(Date.now())
    expect(loaded.paths).toEqual([path.join(dir, 'client.crt'), path.join(dir, 'client.key')])
  })

  it('rejects a key belonging to a different certificate, naming the reason', async () => {
    await expect(loadCerts({ certDir: dir, keyFile: 'other.key' })).rejects.toThrow(
      /private key does not match the certificate/i,
    )
  })

  it('reports a mismatch as a CertError rather than a raw OpenSSL failure', async () => {
    await expect(loadCerts({ certDir: dir, keyFile: 'other.key' })).rejects.toBeInstanceOf(CertError)
  })
})
