import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadSkills } from '../skills/index.js'
import { loadRegistries } from '../python/registry.js'
import { runFastFs } from '../tools/fastFs.js'
import { LibraryReader } from './snapshot.js'

/**
 * Reported: loading skills and Python tools from the folders mirrored from a bucket took a minute and a half - "please
 * leverage the power of rust". The loaders now read through one snapshot of the folders, taken by the Rust helper (or
 * Node) in parallel, and a file unchanged since the last snapshot is not read again. What they load must not change.
 */

const folders: string[] = []
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

const helper = [
  path.resolve(import.meta.dirname, '../../../../apps/sun/native/target/slim/release/fire-fs.exe'),
  path.resolve(import.meta.dirname, '../../../../apps/sun/native/target/slim/debug/fire-fs.exe'),
].find((candidate) => existsSync(candidate))

async function library(): Promise<{ skills: string; tools: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'lc-library-'))
  folders.push(base)
  const skills = path.join(base, 'skills')
  const tools = path.join(base, 'tools')
  await mkdir(path.join(skills, 'deploy'), { recursive: true })
  await mkdir(tools, { recursive: true })
  await writeFile(path.join(skills, 'review.md'), '---\nname: review\ndescription: How we review\n---\nRead it all.')
  await writeFile(path.join(skills, 'deploy', 'SKILL.md'), '---\ndescription: How we deploy\n---\nSteps.')
  await writeFile(path.join(skills, 'nodesc.md'), '---\nname: nodesc\n---\nNo description.')
  await writeFile(path.join(tools, 'load.py'), '"""Loads things."""\ndef run() -> str:\n    return "ok"\n')
  return { skills, tools }
}

const logger = { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined } as never

describe('reading skills and tools through a snapshot', () => {
  it('loads exactly what reading the disk loads, from Node', async () => {
    const { skills, tools } = await library()
    const reader = new LibraryReader(() => undefined)
    const io = await reader.snapshot([{ dir: skills, kind: 'skills' }, { dir: tools, kind: 'tools' }])
    const viaSnapshot = await loadSkills([skills], undefined, io)
    const fromDisk = await loadSkills([skills])
    expect(viaSnapshot.skills.map((s) => s.name).sort()).toEqual(['deploy', 'review'])
    expect(viaSnapshot).toEqual(fromDisk)
    const registry = await loadRegistries([tools], undefined, logger, undefined, undefined, undefined, io)
    expect(registry).toEqual(await loadRegistries([tools], undefined, logger))
  })

  it('does not read a file again when it has not changed, and reads one that has', async () => {
    const { skills } = await library()
    const asked: Record<string, unknown>[] = []
    // A stand-in helper: answers like `fire-fs library`, recording what it was told it may skip.
    const reader = new LibraryReader(() => async (request) => {
      asked.push(request as Record<string, unknown>)
      const file = path.join(skills, 'review.md')
      const known = (request as { known: Record<string, [number, number]> }).known
      const unchanged = known[file] !== undefined
      return {
        ok: true,
        dirs: { [skills]: { exists: true, entries: [{ name: 'review.md', dir: false }] } },
        files: { [file]: unchanged ? { mtimeMs: 1, size: 10, unchanged: true } : { mtimeMs: 1, size: 10, text: '---\ndescription: d\n---\nx' } },
      }
    })
    const first = await loadSkills([skills], undefined, await reader.snapshot([{ dir: skills, kind: 'skills' }]))
    const second = await loadSkills([skills], undefined, await reader.snapshot([{ dir: skills, kind: 'skills' }]))
    expect(first.skills.map((s) => s.name)).toEqual(['review'])
    expect(second.skills.map((s) => s.name)).toEqual(['review'])
    expect(asked[0]!['known']).toEqual({})
    expect(Object.keys(asked[1]!['known'] as object)).toEqual([path.join(skills, 'review.md')])
  })

  it('falls back to Node when the helper does not know the operation, and says so once', async () => {
    const { skills } = await library()
    const notes: string[] = []
    let calls = 0
    const reader = new LibraryReader(
      () => async () => {
        calls += 1
        throw new Error('Unknown operation "library".')
      },
      (message) => notes.push(message),
    )
    for (let i = 0; i < 2; i++) {
      const loaded = await loadSkills([skills], undefined, await reader.snapshot([{ dir: skills, kind: 'skills' }]))
      expect(loaded.skills.map((s) => s.name).sort()).toEqual(['deploy', 'review'])
    }
    expect(calls).toBe(1)
    expect(notes).toHaveLength(1)
  })

  it.skipIf(helper === undefined)(`loads exactly what the disk gives, through the real Rust helper (${helper ?? 'not built'})`, async () => {
    const { skills, tools } = await library()
    const reader = new LibraryReader(() => (request) => runFastFs(helper as string, request) as Promise<Record<string, unknown>>)
    const io = await reader.snapshot([{ dir: skills, kind: 'skills' }, { dir: tools, kind: 'tools' }])
    expect(await loadSkills([skills], undefined, io)).toEqual(await loadSkills([skills]))
    expect(await loadRegistries([tools], undefined, logger, undefined, undefined, undefined, io)).toEqual(await loadRegistries([tools], undefined, logger))
    // A second snapshot reads nothing again, and still loads the same.
    const again = await reader.snapshot([{ dir: skills, kind: 'skills' }])
    expect(await loadSkills([skills], undefined, again)).toEqual(await loadSkills([skills]))
  })
})
