import { appendFile, readFile } from 'node:fs/promises'
import { normalizeForComparison } from '../fs/confine.js'

/**
 * Which chat changed which file, and when - shared by every chat on one codebase (Fire Code's chat
 * tabs, each its own process). One JSON object per line, appended: no read-modify-write, so two
 * chats writing at once cannot lose each other's lines, and a torn last line costs one entry.
 *
 * It exists for rollback. Restoring a file to this chat's checkpoint also discards whatever
 * another chat did to it since, so before rolling back, the chat looks here and asks first.
 */
export class ChangeLedger {
  constructor(
    private readonly file: string,
    /** This chat, as the user sees it: "Chat 2", or the name they gave the tab. */
    readonly chat: string,
  ) {}

  /** Best effort: a ledger that cannot be written must never fail an edit that happened. */
  record(path: string): void {
    const line = JSON.stringify({ chat: this.chat, path: normalizeForComparison(path), at: Date.now() })
    void appendFile(this.file, `${line}\n`).catch(() => undefined)
  }

  /** For each of `paths`, the other chats that changed it after `since`. */
  async othersSince(paths: readonly string[], since: number): Promise<Map<string, string[]>> {
    const wanted = new Map(paths.map((p) => [normalizeForComparison(p), p]))
    const found = new Map<string, string[]>()
    const text = await readFile(this.file, 'utf8').catch(() => undefined)
    if (text === undefined) return found
    for (const line of text.split('\n')) {
      let entry: { chat?: unknown; path?: unknown; at?: unknown }
      try {
        entry = JSON.parse(line) as typeof entry
      } catch {
        continue
      }
      if (typeof entry.path !== 'string' || typeof entry.chat !== 'string' || typeof entry.at !== 'number') continue
      if (entry.chat === this.chat || entry.at < since) continue
      const original = wanted.get(entry.path)
      if (original === undefined) continue
      const chats = found.get(original) ?? []
      if (!chats.includes(entry.chat)) chats.push(entry.chat)
      found.set(original, chats)
    }
    return found
  }
}

/** The set of files this chat changed, which also writes each one to the shared ledger. */
export class RecordedChanges extends Set<string> {
  constructor(private readonly ledger: ChangeLedger | undefined) {
    super()
  }

  override add(value: string): this {
    this.ledger?.record(value)
    return super.add(value)
  }
}
