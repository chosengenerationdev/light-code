import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TruncationStore } from '../../agent/truncate.js'
import type { Task } from '../../history/types.js'
import { JsonTaskStore } from './taskStore.js'

class FakeTruncationStore implements TruncationStore {
  public deleted: string[] = []
  async save(): Promise<string> {
    return 'unused'
  }
  async read(): Promise<string | undefined> {
    return undefined
  }
  async deleteMany(handles: readonly string[]): Promise<void> {
    this.deleted.push(...handles)
  }
}

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ID_A,
    workspaceRoot: '/repo',
    title: 'A task',
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    resultHandles: [],
    ...overrides,
  }
}

describe('JsonTaskStore', () => {
  let root: string
  let truncation: FakeTruncationStore
  let store: JsonTaskStore

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-tasks-'))
    truncation = new FakeTruncationStore()
    store = new JsonTaskStore(root, truncation)
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('round-trips a task', async () => {
    await store.save(task())
    expect(await store.load(ID_A)).toEqual(task())
  })

  it('returns undefined for a task that does not exist', async () => {
    expect(await store.load(ID_A)).toBeUndefined()
  })

  it('lists newest first', async () => {
    await store.save(task({ id: ID_A, title: 'older', updatedAt: 1 }))
    await store.save(task({ id: ID_B, title: 'newer', updatedAt: 99 }))

    expect((await store.list('/repo')).map((entry) => entry.title)).toEqual(['newer', 'older'])
  })

  it('scopes the list to one workspace, so another project\'s work never appears', async () => {
    await store.save(task({ id: ID_A, workspaceRoot: '/repo' }))
    await store.save(task({ id: ID_B, workspaceRoot: '/other' }))

    expect((await store.list('/repo')).map((entry) => entry.id)).toEqual([ID_A])
    expect((await store.list('/other')).map((entry) => entry.id)).toEqual([ID_B])
  })

  it('replaces rather than duplicates an index entry when a task is saved again', async () => {
    await store.save(task({ title: 'first' }))
    await store.save(task({ title: 'second', updatedAt: 3_000 }))

    const listed = await store.list('/repo')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.title).toBe('second')
  })

  it('counts messages excluding the system prompt', async () => {
    await store.save(task())
    expect((await store.list('/repo'))[0]?.messageCount).toBe(1)
  })

  it('deletes the transcript and its spilled tool results', async () => {
    await store.save(task({ resultHandles: ['h1', 'h2'] }))
    await store.delete(ID_A)

    expect(await store.load(ID_A)).toBeUndefined()
    expect(await store.list('/repo')).toEqual([])
    expect(truncation.deleted).toEqual(['h1', 'h2'])
  })

  it('deleting a task that is already gone is not an error', async () => {
    await expect(store.delete(ID_A)).resolves.toBeUndefined()
  })

  /**
   * The index is a cache, not the truth. Losing it must not lose history — otherwise a
   * single corrupt write would silently erase every past conversation from the UI while
   * the transcripts sat intact on disk.
   */
  it('rebuilds a missing index by scanning the task files', async () => {
    await store.save(task({ id: ID_A, title: 'kept' }))
    await fs.rm(path.join(root, 'tasks', 'index.json'))

    expect((await store.list('/repo')).map((entry) => entry.title)).toEqual(['kept'])
    // And the rebuild is written back, so the next list does not rescan.
    await expect(fs.readFile(path.join(root, 'tasks', 'index.json'), 'utf8')).resolves.toContain('kept')
  })

  it('rebuilds an unparseable index rather than reporting no history', async () => {
    await store.save(task({ title: 'kept' }))
    await fs.writeFile(path.join(root, 'tasks', 'index.json'), 'not json at all')

    expect((await store.list('/repo')).map((entry) => entry.title)).toEqual(['kept'])
  })

  it('rebuilds an index that parsed but is the wrong shape', async () => {
    await store.save(task({ title: 'kept' }))
    await fs.writeFile(path.join(root, 'tasks', 'index.json'), '{"not":"an array"}')

    expect((await store.list('/repo')).map((entry) => entry.title)).toEqual(['kept'])
  })

  it('skips a corrupt task file during a rebuild instead of failing the whole list', async () => {
    await store.save(task({ id: ID_A, title: 'kept' }))
    await fs.writeFile(path.join(root, 'tasks', `${ID_B}.json`), '{ truncated')
    await fs.rm(path.join(root, 'tasks', 'index.json'))

    expect((await store.list('/repo')).map((entry) => entry.title)).toEqual(['kept'])
  })

  it('tolerates a task file missing optional fields', async () => {
    await fs.mkdir(path.join(root, 'tasks'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'tasks', `${ID_A}.json`),
      JSON.stringify({ id: ID_A, workspaceRoot: '/repo', messages: [] }),
    )

    const loaded = await store.load(ID_A)
    expect(loaded?.title).toBe('Untitled task')
    expect(loaded?.resultHandles).toEqual([])
  })

  it('refuses an id that is not one of ours, so it can never escape the directory', async () => {
    expect(await store.load('../../../etc/passwd')).toBeUndefined()
    await expect(store.save(task({ id: '../escape' }))).rejects.toThrow(/unexpected id/)
  })

  it('leaves the previous transcript intact if a write is interrupted', async () => {
    await store.save(task({ title: 'good' }))
    // A .tmp left behind by an interrupted write must not be mistaken for a task.
    await fs.writeFile(path.join(root, 'tasks', `${ID_B}.json.tmp`), '{ half written')
    await fs.rm(path.join(root, 'tasks', 'index.json'))

    expect((await store.list('/repo')).map((entry) => entry.title)).toEqual(['good'])
  })

  it('returns an empty list before anything has been saved', async () => {
    expect(await store.list('/repo')).toEqual([])
  })
})
