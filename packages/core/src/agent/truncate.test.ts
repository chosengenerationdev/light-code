import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DiskTruncationStore, truncateToolResult } from './truncate.js'

describe('truncateToolResult', () => {
  let dir: string
  let store: DiskTruncationStore

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-truncate-'))
    store = new DiskTruncationStore(dir)
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('leaves short output untouched', async () => {
    const result = await truncateToolResult('short', store, 100)
    expect(result.truncated).toBe(false)
    expect(result.content).toBe('short')
  })

  it('caps long output and returns a re-readable handle', async () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const result = await truncateToolResult(long, store, 100)

    expect(result.truncated).toBe(true)
    expect(result.content).toContain('Output truncated')

    const handle = /handle "([^"]+)"/.exec(result.content)?.[1]
    expect(handle).toBeDefined()

    const reread = await store.read(handle as string, 0, 3)
    expect(reread).toBe('line 0\nline 1\nline 2')
  })

  it('supports reading from an offset', async () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const handle = await store.save(long)

    const reread = await store.read(handle, 10, 2)
    expect(reread).toBe('line 10\nline 11')
  })

  it('returns undefined for an unknown handle', async () => {
    expect(await store.read('123e4567-e89b-12d3-a456-426614174000', 0, 10)).toBeUndefined()
  })

  it('rejects a path-traversal handle instead of reading outside the store', async () => {
    expect(await store.read('../../../etc/passwd', 0, 10)).toBeUndefined()
  })
})
