import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- a build script in plain JavaScript, imported for its functions.
import { projectFiles, startHere, writeSourceArchive, zip } from '../../../scripts/source-archive.mjs'

/*
 * "Export source code" hands somebody the whole project to build where GitHub cannot be reached.
 * The round trip (extract, install, build, test, package) was run by hand; these pin what it
 * depends on, so a change to the list or the writer cannot quietly ship an archive that opens
 * but does not build.
 */
const repoRoot = path.resolve(__dirname, '../../..')

/** Reads a zip back with nothing but zlib, entry by entry from the local headers. */
function unzip(archive: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let at = 0
  while (archive.readUInt32LE(at) === 0x04034b50) {
    const method = archive.readUInt16LE(at + 8)
    const size = archive.readUInt32LE(at + 18)
    const nameLength = archive.readUInt16LE(at + 26)
    const extra = archive.readUInt16LE(at + 28)
    const name = archive.subarray(at + 30, at + 30 + nameLength).toString('utf8')
    const body = archive.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size)
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body))
    at += 30 + nameLength + extra + size
  }
  return out
}

describe('the source archive', () => {
  const files = projectFiles(repoRoot) as string[]

  it('holds the whole project — every app, the instructions for Claude, and the build setup', () => {
    for (const expected of [
      'CLAUDE.md',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'apps/vscode/package.json',
      'apps/vscode/resources/icon-256.png',
      'apps/host/package.json',
      'apps/intellij/build.gradle.kts',
      'packages/core/src/index.ts',
      'packages/ui/src/App.tsx',
      'scripts/source-archive.mjs',
    ]) {
      expect(files, expected).toContain(expected)
    }
  })

  it('leaves out build output, dependencies, packages and the 48 MB of animations', () => {
    expect(files.some((file) => /(^|\/)(node_modules|dist|\.git|build)\//.test(file))).toBe(false)
    expect(files.some((file) => file.startsWith('docs/gifs/'))).toBe(false)
    expect(files.some((file) => /\.(vsix|tgz|tsbuildinfo)$/.test(file))).toBe(false)
  })

  it('writes a zip any reader can open, binary files byte for byte', () => {
    const icon = fs.readFileSync(path.join(repoRoot, 'apps/vscode/resources/icon-256.png'))
    const entries = unzip(zip([['p/a.txt', Buffer.from('hello hello hello hello')], ['p/icon.png', icon]]) as Buffer)
    expect(entries.get('p/a.txt')?.toString()).toBe('hello hello hello hello')
    expect(entries.get('p/icon.png')?.equals(icon)).toBe(true)
  })

  it('puts everything in one folder named for the version, with START_HERE.md on top', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-src-')), 'source.zip')
    writeSourceArchive(repoRoot, out, '9.9.9')
    const entries = unzip(fs.readFileSync(out))
    expect([...entries.keys()].every((name) => name.startsWith('light-code-source-9.9.9/'))).toBe(true)
    const note = entries.get('light-code-source-9.9.9/START_HERE.md')?.toString() ?? ''
    expect(note).toContain('pnpm install --ignore-scripts')
    expect(note).toContain('C:\\src\\light-code')
    expect(note).toContain('CLAUDE.md')
    expect(entries.get('light-code-source-9.9.9/CLAUDE.md')?.toString()).toBe(fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8'))
  })

  it('names the version in its own note', () => {
    expect(startHere('1.2.3')).toContain('# Light Code 1.2.3')
  })
})
