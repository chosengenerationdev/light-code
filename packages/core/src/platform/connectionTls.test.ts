import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveConnectionTls, TlsConfigError } from './connectionTls.js'

let dir: string

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-tls-'))
  await Promise.all([
    fs.writeFile(path.join(dir, 'corp-root.pem'), 'CORP'),
    fs.writeFile(path.join(dir, 'extra.pem'), 'EXTRA'),
    fs.writeFile(path.join(dir, 'client.crt'), 'CERT'),
    fs.writeFile(path.join(dir, 'client.key'), 'KEY'),
    fs.writeFile(path.join(dir, 'other.crt'), 'OTHER-CERT'),
    fs.writeFile(path.join(dir, 'other.key'), 'OTHER-KEY'),
    fs.writeFile(path.join(dir, 'client.pfx'), 'PFX'),
  ])
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const text = (buffers: (string | Buffer)[] | undefined): string[] => (buffers ?? []).map((b) => String(b))

describe('resolveConnectionTls', () => {
  it('leaves Node defaults alone when nothing is configured', async () => {
    expect(await resolveConnectionTls({ certDir: dir })).toBeUndefined()
    expect(await resolveConnectionTls({ global: {}, connection: {}, certDir: dir })).toBeUndefined()
  })

  /**
   * The point of the global block. A CA set on one connection must not cost the user the
   * corporate root that makes every *other* connection work.
   */
  it('accumulates CAs rather than letting the connection replace the global one', async () => {
    const tls = await resolveConnectionTls({
      global: { caFile: 'corp-root.pem' },
      connection: { caFile: 'extra.pem' },
      certDir: dir,
    })

    expect(text(tls?.ca)).toEqual(['CORP', 'EXTRA'])
  })

  it('applies the global CA to a connection that sets nothing', async () => {
    const tls = await resolveConnectionTls({ global: { caFile: 'corp-root.pem' }, certDir: dir })
    expect(text(tls?.ca)).toEqual(['CORP'])
  })

  it('inherits the global client certificate', async () => {
    const tls = await resolveConnectionTls({
      global: { certFile: 'client.crt', keyFile: 'client.key' },
      connection: { caFile: 'extra.pem' },
      certDir: dir,
    })

    expect(String(tls?.cert)).toBe('CERT')
    expect(String(tls?.key)).toBe('KEY')
  })

  /**
   * A certificate and its key are a pair. Inheriting the global key alongside a
   * connection's own certificate would produce a handshake failure whose message points
   * at neither of the two files the user actually edited.
   */
  it('takes client identity as a unit, never mixing one side with the other', async () => {
    const tls = await resolveConnectionTls({
      global: { certFile: 'client.crt', keyFile: 'client.key' },
      connection: { certFile: 'other.crt', keyFile: 'other.key' },
      certDir: dir,
    })

    expect(String(tls?.cert)).toBe('OTHER-CERT')
    expect(String(tls?.key)).toBe('OTHER-KEY')
  })

  it('rejects a connection certificate with no key rather than borrowing the global one', async () => {
    await expect(
      resolveConnectionTls({
        global: { certFile: 'client.crt', keyFile: 'client.key' },
        connection: { certFile: 'other.crt' },
        certDir: dir,
      }),
    ).rejects.toThrow(/no private key/)
  })

  it('withholds the global client certificate when the connection opts out', async () => {
    const tls = await resolveConnectionTls({
      global: { certFile: 'client.crt', keyFile: 'client.key', caFile: 'corp-root.pem' },
      connection: { useGlobalClientCertificate: false },
      certDir: dir,
    })

    expect(tls?.cert).toBeUndefined()
    expect(tls?.key).toBeUndefined()
    // The CA is a separate axis and still applies.
    expect(text(tls?.ca)).toEqual(['CORP'])
  })

  it('prefers a PFX over cert and key when both are named', async () => {
    const tls = await resolveConnectionTls({
      global: { certFile: 'client.crt', keyFile: 'client.key', pfxFile: 'client.pfx' },
      certDir: dir,
    })

    expect(String(tls?.pfx)).toBe('PFX')
    expect(tls?.cert).toBeUndefined()
  })

  it('attaches the passphrase the caller resolved from secure storage', async () => {
    const tls = await resolveConnectionTls({
      global: { pfxFile: 'client.pfx' },
      certDir: dir,
      passphrase: 'hunter2',
    })

    expect(tls?.passphrase).toBe('hunter2')
  })

  describe('rejectUnauthorized', () => {
    it('inherits the global setting', async () => {
      const tls = await resolveConnectionTls({ global: { rejectUnauthorized: false }, certDir: dir })
      expect(tls?.rejectUnauthorized).toBe(false)
    })

    /**
     * Most-specific-wins has to work in *both* directions. A user who disabled verification
     * globally to get one broken gateway working must still be able to re-enable it for a
     * connection they care about — an override that only ever loosens is not an override.
     */
    it('lets a connection re-enable verification the global block turned off', async () => {
      const tls = await resolveConnectionTls({
        global: { rejectUnauthorized: false },
        connection: { rejectUnauthorized: true },
        certDir: dir,
      })

      expect(tls).toBeUndefined()
    })

    it('lets a connection turn verification off on its own', async () => {
      const tls = await resolveConnectionTls({ connection: { rejectUnauthorized: false }, certDir: dir })
      expect(tls?.rejectUnauthorized).toBe(false)
    })
  })

  describe('paths', () => {
    it('lets an absolute path ignore certDir entirely', async () => {
      const tls = await resolveConnectionTls({
        connection: { caFile: path.join(dir, 'extra.pem') },
        certDir: path.join(dir, 'nonexistent-would-fail-if-used'),
      })

      expect(text(tls?.ca)).toEqual(['EXTRA'])
    })

    it('resolves a bare filename against certDir', async () => {
      const tls = await resolveConnectionTls({ connection: { caFile: 'extra.pem' }, certDir: dir })
      expect(text(tls?.ca)).toEqual(['EXTRA'])
    })

    /** Invariant 6: what was read has to reach the deny list, wherever it was configured. */
    it('reports every path it read so the caller can deny-list it', async () => {
      const seen: string[] = []
      await resolveConnectionTls({
        global: { caFile: 'corp-root.pem', certFile: 'client.crt', keyFile: 'client.key' },
        certDir: dir,
        onPaths: (paths) => seen.push(...paths),
      })

      expect(seen).toEqual([
        path.join(dir, 'corp-root.pem'),
        path.join(dir, 'client.crt'),
        path.join(dir, 'client.key'),
      ])
    })

    it('reports the attempted path even when the read fails', async () => {
      const seen: string[] = []
      await expect(
        resolveConnectionTls({ global: { caFile: 'missing.pem' }, certDir: dir, onPaths: (p) => seen.push(...p) }),
      ).rejects.toBeInstanceOf(TlsConfigError)

      expect(seen).toEqual([path.join(dir, 'missing.pem')])
    })

    it('names the file and the fix rather than surfacing an errno', async () => {
      await expect(resolveConnectionTls({ global: { caFile: 'missing.pem' }, certDir: dir })).rejects.toThrow(
        /CA certificate not found at .*missing\.pem.*Settings → Network/s,
      )
    })
  })
})
