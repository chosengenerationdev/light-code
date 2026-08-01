import fs from 'node:fs/promises'
import type { DirEntry, FileSystem, FileStat } from '@light-code/core'

export class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, 'utf8')
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await fs.writeFile(path, contents, 'utf8')
  }

  async stat(path: string): Promise<FileStat> {
    const stat = await fs.lstat(path)
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const entries = await fs.readdir(path, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }))
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path)
      return true
    } catch {
      return false
    }
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true })
  }
}
