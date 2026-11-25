import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCaBundle, buildConnectOptions, clearExtraCaCache, readNodeExtraCaCerts, systemCertificates } from './tls.js'

/** The bundle as these tests describe it: without the operating system's store, which varies by machine. */
const NO_SYSTEM = { LIGHT_CODE_SYSTEM_CA: '0' } as NodeJS.ProcessEnv

describe('buildCaBundle', () => {
  beforeEach(clearExtraCaCache)
  afterEach(clearExtraCaCache)

  it('leaves Node\'s default handling alone when nothing extra is configured', () => {
    expect(buildCaBundle(undefined, NO_SYSTEM)).toBeUndefined()
    expect(buildCaBundle([], NO_SYSTEM)).toBeUndefined()
  })

  /**
   * The bug this guards: passing `ca` to Node or undici *replaces* the bundled Mozilla
   * root store. Adding one corporate root would otherwise silently break every public CA,
   * and the symptom would surface against some unrelated host much later.
   */
  it('appends a configured CA to the bundled roots rather than replacing them', () => {
    const corporate = Buffer.from('-----BEGIN CERTIFICATE-----corp-----END CERTIFICATE-----')
    const bundle = buildCaBundle([corporate], NO_SYSTEM)

    expect(bundle).toBeDefined()
    expect(bundle!.length).toBe(tls.rootCertificates.length + 1)
    expect(bundle!.at(-1)).toBe(corporate)
    // A well-known public root must still be present.
    expect(bundle!.slice(0, tls.rootCertificates.length)).toEqual(tls.rootCertificates)
  })

  it('includes NODE_EXTRA_CA_CERTS, which an explicit ca would otherwise bypass', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-extra-ca-'))
    const caPath = path.join(dir, 'extra.pem')
    await fs.writeFile(caPath, 'extra-root-pem')

    const bundle = buildCaBundle(undefined, { ...NO_SYSTEM, NODE_EXTRA_CA_CERTS: caPath })

    expect(bundle).toBeDefined()
    expect(bundle).toContain('extra-root-pem')
    expect(bundle!.length).toBe(tls.rootCertificates.length + 1)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('combines NODE_EXTRA_CA_CERTS and a configured CA', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-extra-ca-both-'))
    const caPath = path.join(dir, 'extra.pem')
    await fs.writeFile(caPath, 'extra-root-pem')
    const corporate = Buffer.from('corp-pem')

    const bundle = buildCaBundle([corporate], { ...NO_SYSTEM, NODE_EXTRA_CA_CERTS: caPath })

    expect(bundle!.length).toBe(tls.rootCertificates.length + 2)
    expect(bundle).toContain('extra-root-pem')
    expect(bundle).toContain(corporate)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('readNodeExtraCaCerts', () => {
  beforeEach(clearExtraCaCache)
  afterEach(clearExtraCaCache)

  it('returns nothing when unset or empty', () => {
    expect(readNodeExtraCaCerts({})).toEqual([])
    expect(readNodeExtraCaCerts({ NODE_EXTRA_CA_CERTS: '   ' })).toEqual([])
  })

  it('ignores an unreadable path rather than refusing to connect, as Node itself does', () => {
    expect(readNodeExtraCaCerts({ NODE_EXTRA_CA_CERTS: path.join(os.tmpdir(), 'lc-absent-ca.pem') })).toEqual([])
  })
})

describe('buildConnectOptions', () => {
  beforeEach(clearExtraCaCache)
  afterEach(clearExtraCaCache)

  it('passes client material straight through', () => {
    const cert = Buffer.from('cert')
    const key = Buffer.from('key')
    const connect = buildConnectOptions({ cert, key, passphrase: 'pw' }, NO_SYSTEM)

    expect(connect).toEqual({ cert, key, passphrase: 'pw' })
    // No `ca` key at all, so undici keeps Node's default trust store.
    expect('ca' in connect).toBe(false)
  })

  it('carries a PFX bundle', () => {
    const pfx = Buffer.from('pfx')
    expect(buildConnectOptions({ pfx, passphrase: 'pw' }, NO_SYSTEM)).toEqual({ pfx, passphrase: 'pw' })
  })
})

describe('rejectUnauthorized', () => {
  beforeEach(clearExtraCaCache)
  afterEach(clearExtraCaCache)

  /**
   * Only an explicit `false` is written. Emitting `rejectUnauthorized: true` would make an
   * accidental `undefined` indistinguishable from a deliberate opt-out at the call site.
   */
  it('is absent unless explicitly disabled', () => {
    expect('rejectUnauthorized' in buildConnectOptions({}, NO_SYSTEM)).toBe(false)
    expect('rejectUnauthorized' in buildConnectOptions({ rejectUnauthorized: true }, NO_SYSTEM)).toBe(false)
  })

  it('is passed through when disabled', () => {
    expect(buildConnectOptions({ rejectUnauthorized: false }, NO_SYSTEM).rejectUnauthorized).toBe(false)
  })

  /** Turning verification off must not also throw away a configured corporate root. */
  it('composes with a configured CA', () => {
    const corporate = Buffer.from('corp-pem')
    const connect = buildConnectOptions({ rejectUnauthorized: false, ca: [corporate] }, NO_SYSTEM)

    expect(connect.rejectUnauthorized).toBe(false)
    expect(connect.ca).toContain(corporate)
  })
})

// Reported: "unable to verify the first certificate" in Fire Code for a server that worked in VS Code - VS Code trusts
// the Windows certificate store, plain Node does not. Where this Node can read the store, it is part of the bundle.
describe('the operating system certificate store', () => {
  it('is trusted as well, where it can be read', () => {
    const system = systemCertificates({})
    if (system.length === 0) return
    const bundle = buildCaBundle(undefined, {})
    expect(bundle).toBeDefined()
    expect(bundle).toEqual(expect.arrayContaining([system[0]]))
  })
})
