import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PathDenylist } from './denylist.js'

describe('PathDenylist', () => {
  let certDir: string
  let otherDir: string

  beforeAll(async () => {
    certDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-denylist-certs-'))
    otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-denylist-other-'))
    await fs.writeFile(path.join(certDir, 'client.key'), 'secret-key')
    await fs.writeFile(path.join(otherDir, 'readme.txt'), 'fine')
  })

  afterAll(async () => {
    await fs.rm(certDir, { recursive: true, force: true })
    await fs.rm(otherDir, { recursive: true, force: true })
  })

  it('denies a file directly on the list', async () => {
    const denylist = new PathDenylist()
    const keyPath = path.join(certDir, 'client.key')
    await denylist.add(keyPath)
    expect(await denylist.isDenied(keyPath)).toBe(true)
  })

  it('denies everything under a denied directory', async () => {
    const denylist = new PathDenylist()
    await denylist.add(certDir)
    expect(await denylist.isDenied(path.join(certDir, 'client.key'))).toBe(true)
  })

  it('allows paths outside the denylist', async () => {
    const denylist = new PathDenylist()
    await denylist.add(certDir)
    expect(await denylist.isDenied(path.join(otherDir, 'readme.txt'))).toBe(false)
  })
})
