import fs from 'node:fs/promises'
import type { DirEntry, FileSystem, FileStat } from '../filesystem.js'

export class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, 'utf8')
  }

  async readBytes(path: string): Promise<Buffer> {
    return fs.readFile(path)
  }

  async readBytesSlice(path: string, start: number, end: number): Promise<Buffer> {
    const length = Math.max(0, end - start)
    if (length === 0) return Buffer.alloc(0)

    const handle = await fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      // `bytesRead` is short at end-of-file, so the buffer is trimmed rather than returning
      // the zero padding as if it were content.
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
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
