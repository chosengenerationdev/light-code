import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSecretStore } from './fileSecretStore.js'

/*
 * Light Code Sun runs one host per codebase against one secrets file. Two instances here stand in
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
