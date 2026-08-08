import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse, TlsOptions } from '../../platform/http.js'
import type { SecretStore } from '../../platform/secrets.js'
import { ApigeeMtlsAuthStrategy } from './apigeeMtls.js'
import { ApiKeyAuthStrategy, NoAuthStrategy } from './apiKey.js'
import { CertError } from './certs.js'
import { AuthConfigError, type AuthStrategyContext, createAuthStrategy, createCertLoader } from './factory.js'

class FakeSecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.values.set(key, value)
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key)
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
  async clear(): Promise<void> {
    this.values.clear()
  }
  backendName(): string {
    return 'fake'
  }
}

class RecordingHttp implements HttpClient {
  public bodies: string[] = []

  async request(_url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.bodies.push(options.body ?? '')
    const payload = { access_token: 'tok', expires_in: 3600 }
    return {
      status: 200,
      headers: {},
      text: async () => JSON.stringify(payload),
      json: async <T>() => payload as T,
      body: null,
    }
  }
}

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const OPENSSL = hasOpenssl()

function baseContext(overrides: Partial<AuthStrategyContext> = {}): AuthStrategyContext {
  return {
    secrets: new FakeSecretStore(),
    http: new RecordingHttp(),
    baseUrl: 'https://gw.example.com/v1',
    ...overrides,
  }
}

describe('createAuthStrategy', () => {
  /** A stub PFX: `loadCerts` reads it without parsing, so no OpenSSL is needed here. */
  let pfxDir: string

  beforeAll(async () => {
    pfxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-factory-pfx-'))
    await fs.writeFile(path.join(pfxDir, 'client.pfx'), Buffer.from([0x30, 0x82]))
  })

  afterAll(async () => {
    await fs.rm(pfxDir, { recursive: true, force: true })
  })

  it('builds an ApiKeyAuthStrategy for type "apiKey"', async () => {
    const context = baseContext({ secrets: new FakeSecretStore({ ref: 'sk-x' }) })
    const strategy = createAuthStrategy({ type: 'apiKey', apiKeyRef: 'ref' }, context)

    expect(strategy).toBeInstanceOf(ApiKeyAuthStrategy)
    await expect(strategy.resolveHeaders()).resolves.toEqual({ Authorization: 'Bearer sk-x' })
  })

  it('builds a NoAuthStrategy for type "none"', () => {
    expect(createAuthStrategy({ type: 'none' }, baseContext())).toBeInstanceOf(NoAuthStrategy)
  })

  it('builds an ApigeeMtlsAuthStrategy for type "apigeeMtls"', () => {
    const strategy = createAuthStrategy(
      { type: 'apigeeMtls', certs: { certDir: os.tmpdir() }, apigee: {} },
      baseContext(),
    )
    expect(strategy).toBeInstanceOf(ApigeeMtlsAuthStrategy)
  })

  it('resolves the client secret from storage at request time, not at construction', async () => {
    const secrets = new FakeSecretStore()
    const http = new RecordingHttp()
    const strategy = createAuthStrategy(
      {
        type: 'apigeeMtls',
        certs: { certDir: pfxDir, pfxFile: 'client.pfx' },
        apigee: { clientId: 'id', clientSecretRef: 'profile:gw:clientSecret' },
      },
      baseContext({ secrets, http }),
    )

    // Stored only *after* the strategy exists — a strategy that captured it eagerly would
    // send nothing here.
    await secrets.set('profile:gw:clientSecret', 'shhh')
    await strategy.resolveHeaders()

    expect(new URLSearchParams(http.bodies[0]).get('client_secret')).toBe('shhh')
  })

  it('says the secret is missing rather than requesting a token without one', async () => {
    const strategy = createAuthStrategy(
      { type: 'apigeeMtls', certs: { certDir: os.tmpdir() }, apigee: { clientSecretRef: 'absent' } },
      baseContext(),
    )

    await expect(strategy.resolveHeaders()).rejects.toThrow(/client secret is missing/i)
  })
})

describe('createCertLoader', () => {
  it('demands a certificate directory when neither the profile nor config supplies one', async () => {
    const load = createCertLoader({ type: 'apigeeMtls', certs: {}, apigee: {} }, baseContext())
    await expect(load()).rejects.toBeInstanceOf(AuthConfigError)
  })

  it('inherits the top-level certDir when the auth block omits one', async () => {
    const load = createCertLoader(
      { type: 'apigeeMtls', certs: {}, apigee: {} },
      baseContext({ defaultCertDir: path.join(os.tmpdir(), 'lc-absent-certs') }),
    )
    // Gets far enough to attempt a read, which is what proves the directory was inherited.
    await expect(load()).rejects.toThrow(/Client certificate not found/)
  })

  it('refuses a certificate directory inside the workspace (invariant 6)', async () => {
    const workspaceRoot = path.join(os.tmpdir(), 'lc-ws-certs')
    const load = createCertLoader(
      { type: 'apigeeMtls', certs: { certDir: path.join(workspaceRoot, 'certs') }, apigee: {} },
      baseContext({ workspaceRoot }),
    )
    await expect(load()).rejects.toBeInstanceOf(CertError)
  })

  it('reports a missing passphrase instead of failing later in the handshake', async () => {
    const load = createCertLoader(
      { type: 'apigeeMtls', certs: { certDir: os.tmpdir(), pfxFile: 'x.pfx', passphraseRef: 'absent' }, apigee: {} },
      baseContext(),
    )
    await expect(load()).rejects.toThrow(/passphrase is missing/i)
  })
})

describe.skipIf(!OPENSSL)('createCertLoader against real certificates', () => {
  let dir: string

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-factory-certs-'))
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', path.join(dir, 'client.key'),
        '-out', path.join(dir, 'client.crt'),
        '-days', '3650', '-nodes',
        '-subj', process.platform === 'win32' ? '//CN=light-code-factory' : '/CN=light-code-factory',
      ],
      { stdio: 'ignore' },
    )
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns TLS material and reports the paths read, for the tool deny list', async () => {
    const seen: string[][] = []
    const load = createCertLoader(
      { type: 'apigeeMtls', certs: { certDir: dir }, apigee: {} },
      baseContext({ onCertPaths: (paths) => seen.push(paths) }),
    )

    const tls = (await load()) as TlsOptions
    expect(tls.cert).toBeInstanceOf(Buffer)
    expect(tls.key).toBeInstanceOf(Buffer)
    expect(seen[0]).toEqual([path.join(dir, 'client.crt'), path.join(dir, 'client.key')])
  })

  it('does not warn about expiry for a certificate valid for ten years', async () => {
    const warnings: string[] = []
    const load = createCertLoader(
      { type: 'apigeeMtls', certs: { certDir: dir }, apigee: {} },
      baseContext({ onExpiryWarning: (warning) => warnings.push(warning.message) }),
    )

    await load()
    expect(warnings).toEqual([])
  })

  it('re-reads the certificate on each call, so rotation takes effect without a restart', async () => {
    const seen: string[][] = []
    const load = createCertLoader(
      { type: 'apigeeMtls', certs: { certDir: dir }, apigee: {} },
      baseContext({ onCertPaths: (paths) => seen.push(paths) }),
    )

    await load()
    await load()
    expect(seen).toHaveLength(2)
  })
})
