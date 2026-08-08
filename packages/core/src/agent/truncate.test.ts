import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DiskTruncationStore, RecordingTruncationStore, truncateToolResult } from './truncate.js'

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

describe('deleteMany', () => {
  let dir: string
  let store: DiskTruncationStore

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-truncate-delete-'))
    store = new DiskTruncationStore(dir)
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('removes spilled output so a deleted task leaves nothing behind', async () => {
    const handle = await store.save('spilled output')
    expect(await store.read(handle, 0, 1)).toBe('spilled output')

    await store.deleteMany([handle])
    expect(await store.read(handle, 0, 1)).toBeUndefined()
  })

  it('is idempotent — deleting an already-gone handle is not an error', async () => {
    const handle = await store.save('x')
    await store.deleteMany([handle])
    await expect(store.deleteMany([handle])).resolves.toBeUndefined()
  })

  it('refuses a path-traversal handle rather than deleting outside the store', async () => {
    const victim = path.join(dir, 'keep.txt')
    await fs.writeFile(victim, 'not yours to delete')

    await store.deleteMany(['../keep.txt', '../../keep.txt'])

    await expect(fs.readFile(victim, 'utf8')).resolves.toBe('not yours to delete')
  })
})

describe('RecordingTruncationStore', () => {
  let dir: string
  let recording: RecordingTruncationStore

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-truncate-record-'))
    recording = new RecordingTruncationStore(new DiskTruncationStore(dir))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('records every handle it spills, so a task knows which files it owns', async () => {
    recording.startTask()
    const first = await recording.save('a')
    const second = await recording.save('b')

    expect(recording.spilledHandles().sort()).toEqual([first, second].sort())
  })

  it('attributes handles to the task that is open', async () => {
    recording.startTask()
    await recording.save('belongs to task one')
    expect(recording.spilledHandles()).toHaveLength(1)

    // Opening another task must not inherit the previous task's handles, or deleting it
    // would delete output belonging to a task that still references it.
    recording.startTask(['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'])
    expect(recording.spilledHandles()).toEqual(['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'])
  })

  it('still reads through to the underlying store', async () => {
    recording.startTask()
    const handle = await recording.save('readable')
    expect(await recording.read(handle, 0, 1)).toBe('readable')
  })

  it('stops tracking a handle once it is deleted', async () => {
    recording.startTask()
    const handle = await recording.save('doomed')
    await recording.deleteMany([handle])
    expect(recording.spilledHandles()).toEqual([])
  })
})

describe('redaction at the spill boundary', () => {
  let dir: string

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-truncate-redact-'))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  /**
   * Spilled output is the largest thing persisted and the most likely to contain a secret:
   * whole-file reads and raw command output, kept long after the session. Redacting the
   * transcript while leaving this in the clear would have been a hole, and was — caught by
   * grepping the spill directory rather than only the transcripts.
   */
  it('strips a known secret before writing spilled output to disk', async () => {
    const store = new DiskTruncationStore(dir, () => ['corp-gateway-key-9f3a1c'])
    const handle = await store.save('GATEWAY_KEY=corp-gateway-key-9f3a1c\nsecond line')

    const onDisk = await fs.readFile(path.join(dir, `${handle}.txt`), 'utf8')
    expect(onDisk).not.toContain('corp-gateway-key-9f3a1c')
    expect(onDisk).toContain('[REDACTED]')
  })

  it('strips Bearer tokens by pattern even with no known secrets configured', async () => {
    const store = new DiskTruncationStore(dir)
    const handle = await store.save('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.body.sig')

    expect(await fs.readFile(path.join(dir, `${handle}.txt`), 'utf8')).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('leaves ordinary output untouched', async () => {
    const store = new DiskTruncationStore(dir, () => ['corp-gateway-key-9f3a1c'])
    const handle = await store.save('just some file contents')
    expect(await store.read(handle, 0, 1)).toBe('just some file contents')
  })
})
