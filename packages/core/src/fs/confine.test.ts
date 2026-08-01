import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { confine, PathConfinementError } from './confine.js'

// Symlink creation needs a privilege Windows doesn't grant by default (Developer Mode
// or admin) — probe once, synchronously, so `it.skipIf` can gate the relevant test.
const symlinkProbeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'lc-symlink-probe-'))
let symlinksSupported = true
try {
  fsSync.symlinkSync(path.join(symlinkProbeDir, 'target'), path.join(symlinkProbeDir, 'link'))
} catch {
  symlinksSupported = false
}
fsSync.rmSync(symlinkProbeDir, { recursive: true, force: true })

describe('confine', () => {
  let root: string
  let outside: string

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-confine-root-'))
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-confine-outside-'))
    await fs.writeFile(path.join(root, 'inside.txt'), 'inside')
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
    if (symlinksSupported) {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape-link.txt'))
    }
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  it('allows a file directly inside the root', async () => {
    const result = await confine(path.join(root, 'inside.txt'), root)
    expect(path.basename(result)).toBe('inside.txt')
  })

  it('rejects ../ traversal outside the root', async () => {
    const traversal = path.join(root, '..', path.basename(outside), 'secret.txt')
    await expect(confine(traversal, root)).rejects.toThrow(PathConfinementError)
  })

  it('rejects an absolute path outside the root', async () => {
    await expect(confine(path.join(outside, 'secret.txt'), root)).rejects.toThrow(PathConfinementError)
  })

  it.skipIf(!symlinksSupported)(
    'rejects a symlink inside the root that resolves outside it',
    async () => {
      await expect(confine(path.join(root, 'escape-link.txt'), root)).rejects.toThrow(
        PathConfinementError,
      )
    },
  )

  it('allows a nonexistent path inside the root (about to be written)', async () => {
    const result = await confine(path.join(root, 'new-file.txt'), root)
    expect(path.basename(result)).toBe('new-file.txt')
  })

  it('rejects a nonexistent path outside the root', async () => {
    await expect(confine(path.join(outside, 'new-file.txt'), root)).rejects.toThrow(
      PathConfinementError,
    )
  })
})
