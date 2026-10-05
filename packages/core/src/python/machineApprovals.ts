import fs from 'node:fs/promises'
import path from 'node:path'
import { replaceFile } from '../platform/node/replaceFile.js'

/**
 * Python tool code approved anywhere on this machine, by content hash - so a tool reviewed in one
 * Fire Code codebase is not reviewed again in the next one that holds the identical file.
 *
 * Why this keeps §13's guarantee: approval was always of **exact bytes**, recorded per folder only
 * because each folder had its own registry. The same bytes in another folder are the same code the
 * user read; a single changed byte is a different hash and asks again. Approval stays per machine -
 * the list lives in Fire Code's own data folder, which no tool may write (`fs/reach.ts`), and a
 * colleague's bucket or a cloned repository cannot add to it. A declined hash is still declined.
 */
export interface MachineApprovals {
  /** Whether these exact bytes were approved somewhere on this machine. */
  has(hash: string): Promise<boolean>
  /** Records approved hashes (with the tool's name, for a person reading the file). */
  add(entries: readonly { hash: string; name: string }[]): Promise<void>
  /** When the list last changed, so an open codebase can notice an approval made in another. */
  stamp(): Promise<number>
}

interface LedgerFile {
  version: 1
  hashes: Record<string, { name: string; at: string }>
}

export class FileMachineApprovals implements MachineApprovals {
  private cache: { mtime: number; hashes: Set<string> } | undefined
  private writing: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  async stamp(): Promise<number> {
    try {
      return (await fs.stat(this.file)).mtimeMs
    } catch {
      return 0
    }
  }

  private async read(): Promise<LedgerFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as LedgerFile
      if (parsed.version === 1 && typeof parsed.hashes === 'object') return parsed
    } catch {
      // Missing or unreadable: nothing approved elsewhere, which only means asking again.
    }
    return { version: 1, hashes: {} }
  }

  async has(hash: string): Promise<boolean> {
    const mtime = await this.stamp()
    if (this.cache === undefined || this.cache.mtime !== mtime) {
      this.cache = { mtime, hashes: new Set(Object.keys((await this.read()).hashes)) }
    }
    return this.cache.hashes.has(hash)
  }

  add(entries: readonly { hash: string; name: string }[]): Promise<void> {
    const next = this.writing.then(async () => {
      const ledger = await this.read()
      let changed = false
      for (const entry of entries) {
        if (ledger.hashes[entry.hash] !== undefined) continue
        ledger.hashes[entry.hash] = { name: entry.name, at: new Date().toISOString() }
        changed = true
      }
      if (!changed) return
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      // Re-read just before writing would still race another process; temp-and-rename at least
      // never leaves half a file, and a lost entry only means one more question somewhere.
      const temporary = `${this.file}.${String(process.pid)}.${String(Date.now())}.tmp`
      await fs.writeFile(temporary, JSON.stringify(ledger, null, 1), 'utf8')
      await replaceFile(temporary, this.file)
      this.cache = undefined
    })
    this.writing = next.catch(() => undefined)
    return next
  }
}
