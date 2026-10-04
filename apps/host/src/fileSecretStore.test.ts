import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSecretStore } from './fileSecretStore.js'

/*
 * Light Code Fire Code runs one host per codebase against one secrets file. Two instances here stand in
 * for two processes: each has its own cache, exactly as two processes would.
 */
describe('FileSecretStore shared by several processes', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true })
  })

  const twoStores = async (): Promise<[FileSecretStore, FileSecretStore]> => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-secrets-'))
    const file = path.join(dir, 'secrets.json')
    return [new FileSecretStore(file), new FileSecretStore(file)]
  }

  it('a save in one does not drop a key the other added after it last read', async () => {
    const [a, b] = await twoStores()
    // Both have read (and cached) the empty file.
    expect(await a.get('x')).toBeUndefined()
    expect(await b.get('x')).toBeUndefined()

    await a.set('profile:gateway:apiKey', 'from-a')
    await b.set('search:store:password', 'from-b')

    const onDisk = JSON.parse(await fs.readFile(path.join(dir!, 'secrets.json'), 'utf8')) as Record<string, string>
    expect(onDisk).toEqual({ 'profile:gateway:apiKey': 'from-a', 'search:store:password': 'from-b' })
  })

  it('a key entered in one is read by the other without a restart', async () => {
    const [a, b] = await twoStores()
    expect(await b.get('profile:gateway:apiKey')).toBeUndefined()
    await a.set('profile:gateway:apiKey', 'entered-once')
    expect(await b.get('profile:gateway:apiKey')).toBe('entered-once')
  })

  it('a delete in one reaches the other', async () => {
    const [a, b] = await twoStores()
    await a.set('k', 'v')
    expect(await b.get('k')).toBe('v')
    await a.delete('k')
    expect(await b.get('k')).toBeUndefined()
  })
})

describe('FileSecretStore encrypted for Fire Code', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true })
  })
  const key = Buffer.alloc(32, 7)
  const file = async (): Promise<string> => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-vault-'))
    return path.join(dir, 'secrets.json')
  }

  it('writes nothing readable, and reads back what it wrote', async () => {
    const at = await file()
    await new FileSecretStore(at, key).set('profile:gw:apiKey', 'sk-very-secret')
    const raw = await fs.readFile(at, 'utf8')
    expect(raw).not.toContain('sk-very-secret')
    expect(raw).not.toContain('profile:gw:apiKey')
    expect(JSON.parse(raw)).toMatchObject({ sunVault: 1 })
    expect(await new FileSecretStore(at, key).get('profile:gw:apiKey')).toBe('sk-very-secret')
  })

  it('moves an existing plain file into the vault on the next save, keeping its keys', async () => {
    const at = await file()
    await fs.writeFile(at, JSON.stringify({ old: 'kept' }))
    const store = new FileSecretStore(at, key)
    expect(await store.get('old')).toBe('kept')
    await store.set('new', 'added')
    expect(await fs.readFile(at, 'utf8')).not.toContain('kept')
    expect(await new FileSecretStore(at, key).get('old')).toBe('kept')
  })

  it('without the key, refuses to save rather than replacing every key', async () => {
    const at = await file()
    await new FileSecretStore(at, key).set('precious', 'value')
    const keyless = new FileSecretStore(at)
    expect(await keyless.get('precious')).toBeUndefined()
    await expect(keyless.set('other', 'x')).rejects.toThrow(/encrypted/)
    const wrongKey = new FileSecretStore(at, Buffer.alloc(32, 9))
    await expect(wrongKey.set('other', 'x')).rejects.toThrow(/encrypted/)
    expect(await new FileSecretStore(at, key).get('precious')).toBe('value')
  })
})
