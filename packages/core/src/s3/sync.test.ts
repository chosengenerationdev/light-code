import { describe, expect, it } from 'vitest'

import type { FileSystem } from '../platform/filesystem.js'
import type { S3Object } from './client.js'
import { syncFromS3, uploadToS3 } from './sync.js'
import type { S3Target } from './tools.js'

/**
 * Mirroring a bucket folder onto this disk.
 *
 * Only the files move: they are then loaded, watched and indexed by the machinery that already
 * exists, so an S3 skill and a local one are the same thing by the time anything looks at them.
 * Indexing stays exactly as configured, which was the stated requirement.
 */

interface FakeDisk {
  fs: FileSystem
  files: Map<string, Buffer>
  made: string[]
}

function disk(seed: Record<string, string> = {}): FakeDisk {
  const files = new Map<string, Buffer>(
    Object.entries(seed).map(([path, text]) => [path, Buffer.from(text)]),
  )
  const made: string[] = []
  const fs = {
    readBytes: async (path: string) => {
      const found = files.get(path)
      if (found === undefined) throw new Error('ENOENT')
      return found
    },
    writeBytes: async (path: string, contents: Uint8Array) => {
      files.set(path, Buffer.from(contents))
    },
    mkdir: async (path: string) => {
      made.push(path)
    },
  } as unknown as FileSystem
  return { fs, files, made }
}

function bucket(contents: Record<string, string>, readOnly = false): { target: S3Target; puts: Map<string, Buffer> } {
  const puts = new Map<string, Buffer>()
  const target: S3Target = {
    id: 'c1',
    label: 'team',
    bucket: 'team-bucket',
    prefix: 'shared/',
    readOnly,
    client: {
      list: async (prefix: string): Promise<S3Object[]> =>
        Object.keys(contents)
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key, size: contents[key]?.length ?? 0, lastModified: '2026-01-01T00:00:00Z' })),
      get: async (key: string) => Buffer.from(contents[key] ?? ''),
      put: async (key: string, bytes: Uint8Array) => {
        puts.set(key, Buffer.from(bytes))
      },
    } as unknown as S3Target['client'],
  }
  return { target, puts }
}

describe('bringing a folder down', () => {
  it('writes each matching file under the local folder', async () => {
    const { target } = bucket({
      'shared/skills/deploy.md': 'how we deploy',
      'shared/skills/oncall.md': 'who to call',
    })
    const local = disk()

    const result = await syncFromS3({
      target,
      prefix: 'skills',
      localDir: '/cache/skills',
      fs: local.fs,
      extensions: ['.md'],
    })

    expect(result.written.sort()).toEqual(['deploy.md', 'oncall.md'])
    expect(local.files.get('/cache/skills/deploy.md')?.toString()).toBe('how we deploy')
  })

  it('keeps the folder structure inside the prefix', async () => {
    const { target } = bucket({ 'shared/skills/team/a.md': 'x' })
    const local = disk()

    await syncFromS3({
      target,
      prefix: 'skills',
      localDir: '/cache/skills',
      fs: local.fs,
      extensions: ['.md'],
    })

    expect([...local.files.keys()]).toEqual(['/cache/skills/team/a.md'])
  })

  it('ignores files of other kinds', async () => {
    const { target } = bucket({ 'shared/skills/a.md': 'x', 'shared/skills/notes.txt': 'y' })
    const local = disk()

    const result = await syncFromS3({
      target,
      prefix: 'skills',
      localDir: '/cache/skills',
      fs: local.fs,
      extensions: ['.md'],
    })

    expect(result.written).toEqual(['a.md'])
  })

  /*
   * The watcher is watching this very folder, so rewriting an identical file would reload every
   * skill on every sync.
   */
  it('does not rewrite a file that has not changed', async () => {
    const { target } = bucket({ 'shared/skills/a.md': 'same' })
    const local = disk({ '/cache/skills/a.md': 'same' })

    const result = await syncFromS3({
      target,
      prefix: 'skills',
      localDir: '/cache/skills',
      fs: local.fs,
      extensions: ['.md'],
    })

    expect(result).toMatchObject({ written: [], unchanged: 1 })
  })

  /*
   * An S3 key is an arbitrary string, so anyone who can write to the bucket can create
   * `../../.ssh/id_rsa`. Following it would write outside the folder this sync owns — the bucket
   * is not trusted just because the connection to it is.
   */
  it('refuses a key that would escape the folder', async () => {
    const { target } = bucket({ 'shared/skills/../../escape.md': 'nope' })
    const local = disk()

    const result = await syncFromS3({
      target,
      prefix: 'skills',
      localDir: '/cache/skills',
      fs: local.fs,
      extensions: ['.md'],
    })

    expect(result.written).toEqual([])
    expect(result.failed[0]?.problem).toMatch(/outside the folder/)
    expect([...local.files.keys()]).toEqual([])
  })

  /*
   * A half-finished sync that had already emptied the folder would take somebody's skills away
   * over a network blip. A stale file is visible and fixable; a deleted one is not.
   */
  it('leaves a local file the bucket no longer has', async () => {
    const { target } = bucket({ 'shared/skills/a.md': 'x' })
    const local = disk({ '/cache/skills/gone.md': 'still here' })

    await syncFromS3({
      target,
      prefix: 'skills',
      localDir: '/cache/skills',
      fs: local.fs,
      extensions: ['.md'],
    })

    expect(local.files.get('/cache/skills/gone.md')?.toString()).toBe('still here')
  })

  it('reports a file it could not fetch rather than failing the whole sync', async () => {
    const { target } = bucket({ 'shared/skills/a.md': 'x', 'shared/skills/b.md': 'y' })
    const original = target.client.get.bind(target.client)
    target.client.get = async (key: string, signal?: AbortSignal) => {
      if (key.endsWith('b.md')) throw new Error('S3 AccessDenied')
      return original(key, signal)
    }
    const local = disk()

    const result = await syncFromS3({
      target,
      prefix: 'skills',
      localDir: '/cache/skills',
      fs: local.fs,
      extensions: ['.md'],
    })

    expect(result.written).toEqual(['a.md'])
    expect(result.failed[0]?.problem).toMatch(/AccessDenied/)
  })
})

describe('publishing one file back', () => {
  it('puts it under the same folder the sync reads', async () => {
    const { target, puts } = bucket({})
    await uploadToS3({ target, prefix: 'skills', relative: 'new.md', contents: Buffer.from('hello') })
    expect([...puts.keys()]).toEqual(['shared/skills/new.md'])
  })

  it('refuses when the connection is read-only', async () => {
    const { target } = bucket({}, true)
    await expect(
      uploadToS3({ target, prefix: 'skills', relative: 'new.md', contents: Buffer.from('x') }),
    ).rejects.toThrow(/read-only/)
  })
})
