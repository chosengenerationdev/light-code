import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CLIENT_ASSET_BYTES } from './generated/clientAssets.js'
import { SOURCE_PACK } from './generated/sourcePack.js'
import { writePackageCopy, writeSourceTree } from './cli.js'

/**
 * What the bundle carries, and what `--export-pkg` and `--export-code` do with it.
 *
 * Both exist for one situation: somebody who can install Node but cannot reach a registry, and
 * cannot reach GitHub from the office. So the bundle carries its own browser assets *and* its own
 * source, and either can be written out with nothing else present.
 */

const repoRoot = path.join(__dirname, '..', '..', '..')

/** The shape of `sourcePack.mjs`, which is plain JavaScript and has no declarations. */
type PackModule = {
  collectSource: (root: string) => Record<string, string>
  SOURCE_ROOTS: string[]
  SKIP_DIRECTORIES: Set<string>
}

async function loadPack(): Promise<PackModule> {
  /*
   * A dynamic import through a variable, so TypeScript does not try to resolve a `.mjs` file it
   * has no declarations for. The module is plain JavaScript on purpose - `esbuild.mjs` imports
   * it too, and a build script cannot import TypeScript.
   */
  const specifier = '../sourcePack.mjs'
  return (await import(/* @vite-ignore */ specifier)) as PackModule
}

describe('the committed stubs', () => {
  /*
   * Both are replaced at build time. Committing the real thing would put a megabyte and a half of
   * base64 into the repository, re-committed on every change to the UI or to any source file —
   * and a diff nobody can read is a diff nobody reviews.
   */
  it('carry nothing in the repository', () => {
    expect(Object.keys(CLIENT_ASSET_BYTES)).toEqual([])
    expect(SOURCE_PACK).toBe('')
  })
})

describe('what the source pack collects', () => {
  it('includes everything needed to build the Node half', async () => {
    const { collectSource } = await loadPack()
    const files = Object.keys(collectSource(repoRoot))

    for (const required of [
      'apps/host/src/cli.ts',
      'apps/host/package.json',
      'apps/host/esbuild.mjs',
      'apps/host/sourcePack.mjs',
      'packages/core/src/index.ts',
      'packages/ui/src/App.tsx',
      'package.json',
      'pnpm-workspace.yaml',
      // The lockfile, so an install resolves the same versions rather than whatever is newest on
      // the mirror that day.
      'pnpm-lock.yaml',
      'tsconfig.base.json',
    ]) {
      expect(files, required).toContain(required)
    }
  })

  it('leaves out the extension, which is not the Node half', async () => {
    const { collectSource } = await loadPack()
    const files = Object.keys(collectSource(repoRoot))
    expect(files.some((file) => file.startsWith('apps/vscode/'))).toBe(false)
  })

  it('leaves out everything generated or heavy', async () => {
    const { collectSource } = await loadPack()
    const files = Object.keys(collectSource(repoRoot))

    for (const forbidden of ['node_modules', 'dist/', '.git/', 'docs/gifs/']) {
      expect(
        files.filter((file) => file.includes(forbidden)),
        `${forbidden} reached the pack`,
      ).toEqual([])
    }
  })

  it('leaves out .tsbuildinfo, which is the one that is not obvious', async () => {
    /*
     * It cost a debugging round. TypeScript's record of what it has already compiled, consulted by
     * `composite` projects before doing any work — so a packed one made `tsc` report success and
     * emit **nothing**, leaving `packages/core` with no `dist` and `packages/ui` unable to resolve
     * `@light-code/core/browser`. The error pointed at a module that was plainly there.
     */
    const { collectSource } = await loadPack()
    const files = Object.keys(collectSource(repoRoot))
    expect(files.filter((file) => file.endsWith('.tsbuildinfo'))).toEqual([])
  })

  it('uses forward slashes, so a pack made on Windows unpacks on Linux', async () => {
    const { collectSource } = await loadPack()
    expect(Object.keys(collectSource(repoRoot)).some((file) => file.includes('\\'))).toBe(false)
  })
})

describe('writing the source out', () => {
  let target: string

  beforeEach(async () => {
    target = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-export-'))
    await fs.rm(target, { recursive: true, force: true })
  })

  afterEach(async () => {
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
  })

  /** A pack of two files, so these test the writer rather than the repository. */
  async function tinyPack(files: Record<string, string>): Promise<string> {
    const { gzipSync } = await import('node:zlib')
    return gzipSync(Buffer.from(JSON.stringify(files), 'utf8')).toString('base64')
  }

  it('writes the files, creating directories as it goes', async () => {
    const pack = await tinyPack({ 'a/b/c.ts': 'export const x = 1\n', 'package.json': '{}\n' })
    expect(await writeSourceTree(pack, target)).toBe(2)
    expect(await fs.readFile(path.join(target, 'a', 'b', 'c.ts'), 'utf8')).toBe('export const x = 1\n')
  })

  it('refuses a directory that already has something in it', async () => {
    /*
     * It writes several hundred files, and the machine this is for is the one with no `git` to
     * undo them with. Refusing costs one command; merging into somebody's work costs a day.
     */
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'mine.txt'), 'work', 'utf8')

    await expect(writeSourceTree(await tinyPack({ 'a.ts': '' }), target)).rejects.toThrow(/not empty/)
    expect(await fs.readFile(path.join(target, 'mine.txt'), 'utf8')).toBe('work')
  })

  it('refuses a path that would land outside the directory', async () => {
    // Every entry came from our own build, and "the build would not produce that" is not a
    // boundary — this writes to an arbitrary place on somebody's disk.
    await expect(
      writeSourceTree(await tinyPack({ '../escaped.ts': 'x' }), target),
    ).rejects.toThrow(/outside/)
  })

  it('says so when the build carried no source at all', async () => {
    // Running the stub — a bundle not produced by `pnpm build`. Better than writing zero files
    // and reporting success.
    await expect(writeSourceTree('', target)).rejects.toThrow(/carries no source/)
  })
})

describe('writing the bundle out', () => {
  it('copies the file it is given, making the directory if needed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-pkg-'))
    try {
      const source = path.join(dir, 'source.cjs')
      await fs.writeFile(source, 'console.log(1)\n', 'utf8')

      const written = await writePackageCopy(source, path.join(dir, 'nested', 'light-code-pkg'))
      expect(await fs.readFile(written, 'utf8')).toBe('console.log(1)\n')
      // Left bare on purpose: Node reads an extensionless file as CommonJS, which is what the
      // bundle is, so `node light-code-pkg` works as written.
      expect(path.extname(written)).toBe('')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
