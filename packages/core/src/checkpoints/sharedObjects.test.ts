import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ShadowGit } from './shadowGit.js'

/**
 * Several chats on one codebase share one store of checkpoint objects (Fire Code).
 *
 * Each chat used to keep its own shadow repository, so every new chat added another full copy of
 * the codebase's snapshots. Driven against real git, because the claims are about git: objects
 * written by one chat restore in another, nothing lands in a chat's own folder, and objects a chat
 * wrote before the store existed still restore.
 */
const available = await ShadowGit.isGitAvailable()

let root: string
let workspace: string
let shared: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-shared-ckpt-'))
  workspace = path.join(root, 'ws')
  shared = path.join(root, 'codebase', 'checkpoint-objects')
  await fs.mkdir(workspace)
  // Large enough that a second copy would show.
  await fs.writeFile(path.join(workspace, 'big.txt'), 'line of the codebase\n'.repeat(20_000))
  await fs.writeFile(path.join(workspace, 'a.txt'), 'one\n')
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function sizeOf(dir: string): Promise<number> {
  let total = 0
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await fs.stat(path.join(entry.parentPath, entry.name))).size
  }
  return total
}

describe.skipIf(!available)('checkpoints shared by a codebase', () => {
  it('keeps one copy of the objects however many chats snapshot, and each restores', async () => {
    const chat1 = new ShadowGit(workspace, path.join(root, 'chat1', 'shadow.git'), shared)
    const chat2 = new ShadowGit(workspace, path.join(root, 'chat2', 'shadow.git'), shared)
    const first = await chat1.snapshot()
    const second = await chat2.snapshot()

    // The big file was stored once, in the shared store; neither chat's own repository holds it.
    expect(await sizeOf(path.join(root, 'chat2', 'shadow.git', 'objects'))).toBeLessThan(5_000)
    expect(await sizeOf(shared)).toBeGreaterThan(1_000)

    await fs.writeFile(path.join(workspace, 'a.txt'), 'changed by chat 2\n')
    await chat2.restoreFiles(second, [path.join(workspace, 'a.txt')])
    expect(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('one\n')

    await fs.writeFile(path.join(workspace, 'a.txt'), 'changed by chat 1\n')
    await chat1.restoreFiles(first, [path.join(workspace, 'a.txt')])
    expect(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('one\n')
  })

  it('refuses, rather than deleting files, when the checkpoint cannot be read', async () => {
    const chat = new ShadowGit(workspace, path.join(root, 'chat1', 'shadow.git'), shared)
    await chat.snapshot()
    await expect(chat.restoreFiles({ commit: '0123456789abcdef0123456789abcdef01234567', createdAt: 0 }, [path.join(workspace, 'a.txt')])).rejects.toThrow(
      'cannot be read',
    )
    expect(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('one\n')
  })

  it('still restores a checkpoint a chat took before the shared store existed', async () => {
    const own = path.join(root, 'chat1', 'shadow.git')
    const before = await new ShadowGit(workspace, own).snapshot()
    await fs.writeFile(path.join(workspace, 'a.txt'), 'later\n')
    await new ShadowGit(workspace, own, shared).restoreFiles(before, [path.join(workspace, 'a.txt')])
    expect(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('one\n')
  })
})
