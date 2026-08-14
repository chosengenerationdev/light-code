import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PathDenylist } from '../fs/denylist.js'
import type { DirEntry, FileStat, FileSystem } from '../platform/filesystem.js'
import { attachMentions, parseMentions, resolveMentions } from './mentions.js'

class RealFileSystem implements FileSystem {
  async readFile(target: string): Promise<string> {
    return fs.readFile(target, 'utf8')
  }
  async readBytes(target: string): Promise<Buffer> {
    return fs.readFile(target)
  }
  async writeFile(target: string, contents: string): Promise<void> {
    await fs.writeFile(target, contents, 'utf8')
  }
  async stat(target: string): Promise<FileStat> {
    const stats = await fs.stat(target)
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
    }
  }
  async readdir(target: string): Promise<DirEntry[]> {
    const entries = await fs.readdir(target, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }))
  }
  async exists(target: string): Promise<boolean> {
    try {
      await fs.stat(target)
      return true
    } catch {
      return false
    }
  }
  async mkdir(target: string): Promise<void> {
    await fs.mkdir(target, { recursive: true })
  }
}

describe('parseMentions', () => {
  it('finds a simple file mention', () => {
    expect(parseMentions('explain @src/auth.ts please')).toEqual(['src/auth.ts'])
  })

  it('finds several, in order, without duplicates', () => {
    expect(parseMentions('compare @a.ts with @b.ts and @a.ts again')).toEqual(['a.ts', 'b.ts'])
  })

  it('supports quoting for paths with spaces', () => {
    expect(parseMentions('look at @"src/my file.ts"')).toEqual(['src/my file.ts'])
  })

  /** "what does @src/auth.ts do?" must not try to open a file called `auth.ts do?`. */
  it('strips trailing sentence punctuation', () => {
    expect(parseMentions('what does @src/auth.ts do?')).toEqual(['src/auth.ts'])
    expect(parseMentions('see @a.ts, @b.ts.')).toEqual(['a.ts', 'b.ts'])
  })

  it('finds nothing in text with no mentions', () => {
    expect(parseMentions('no mentions here')).toEqual([])
    expect(parseMentions('email me at foo@example.com')).toEqual(['example.com'])
  })
})

describe('resolveMentions', () => {
  let root: string
  const filesystem = new RealFileSystem()

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lc-mentions-')))
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'export const auth = 1')
    await fs.writeFile(path.join(root, 'src', 'user.ts'), 'export const user = 2')
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reads a file', async () => {
    const [mention] = await resolveMentions('explain @src/auth.ts', { fs: filesystem, workspaceRoot: root })
    expect(mention?.kind).toBe('file')
    expect(mention?.content).toBe('export const auth = 1')
    expect(mention?.relativePath).toBe('src/auth.ts')
  })

  it('lists a directory rather than dumping every file in it', async () => {
    const [mention] = await resolveMentions('what is in @src', { fs: filesystem, workspaceRoot: root })
    expect(mention?.kind).toBe('directory')
    expect(mention?.content).toContain('auth.ts')
    expect(mention?.content).toContain('user.ts')
    // A listing, not the contents.
    expect(mention?.content).not.toContain('export const')
  })

  /**
   * A mention path is user-typed text, not a capability. It must be confined exactly as a
   * tool path is — otherwise `@` becomes a way to read anything on the machine.
   */
  it('refuses a path outside the workspace', async () => {
    const [mention] = await resolveMentions('@../../../etc/passwd', { fs: filesystem, workspaceRoot: root })
    expect(mention?.kind).toBe('error')
    expect(mention?.content).toMatch(/outside the workspace/)
  })

  it('refuses a denied path, so certificates stay unreadable', async () => {
    const denylist = new PathDenylist()
    await denylist.add(path.join(root, 'src', 'auth.ts'))

    const [mention] = await resolveMentions('@src/auth.ts', { fs: filesystem, workspaceRoot: root, denylist })
    expect(mention?.kind).toBe('error')
    expect(mention?.content).toMatch(/not readable/)
  })

  it('reports a missing file without throwing', async () => {
    const [mention] = await resolveMentions('@src/absent.ts', { fs: filesystem, workspaceRoot: root })
    expect(mention?.kind).toBe('error')
  })

  it('resolves several mentions in one message', async () => {
    const mentions = await resolveMentions('@src/auth.ts and @src/user.ts', { fs: filesystem, workspaceRoot: root })
    expect(mentions.map((m) => m.kind)).toEqual(['file', 'file'])
  })
})

describe('attachMentions', () => {
  it('leaves the message alone when there is nothing to attach', () => {
    expect(attachMentions('hello', [])).toBe('hello')
  })

  /** The question must stay readable, not be buried under the file it refers to. */
  it('appends rather than substituting in place', () => {
    const result = attachMentions('explain @a.ts', [
      { raw: 'a.ts', kind: 'file', relativePath: 'a.ts', content: 'source here' },
    ])

    expect(result.startsWith('explain @a.ts')).toBe(true)
    expect(result).toContain('File: a.ts')
    expect(result).toContain('source here')
  })

  it('passes an error through as plain text the model can act on', () => {
    const result = attachMentions('explain @gone.ts', [
      { raw: 'gone.ts', kind: 'error', relativePath: 'gone.ts', content: 'Could not attach "gone.ts": missing.' },
    ])
    expect(result).toContain('Could not attach')
    expect(result).not.toContain('```')
  })
})
