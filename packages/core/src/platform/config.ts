export type ConfigScope = 'user' | 'workspace'

/**
 * Raw scoped JSON-file storage. Reads/writes text; parsing and validation happen in
 * packages/core/src/config/. `watch` fires on external changes (hand-edits) so the
 * UI and file loader stay in sync — see CLAUDE.md §15.
 */
export interface ConfigStore {
  /** Returns `undefined` if the scope has no config file yet. */
  read(scope: ConfigScope): Promise<string | undefined>
  /**
   * Replaces the scope's contents.
   *
   * **Must be atomic**: write elsewhere and rename into place. A partial write leaves invalid
   * JSON, and every read then throws — which presents as the extension losing its provider,
   * its approvals and its expert all at once, with a file only a human can repair. That has
   * happened to a real user (2026-09-01).
   *
   * An implementation should also keep the previous contents recoverable; see `readBackup`.
   */
  write(scope: ConfigScope, contents: string): Promise<void>
  /**
   * The last contents this store wrote successfully, if it keeps them.
   *
   * Optional: a store with nowhere to keep one simply cannot recover, and `ConfigManager`
   * reports the corruption instead. Never used unless the live file fails to parse.
   */
  readBackup?(scope: ConfigScope): Promise<string | undefined>
  /**
   * Moves an unreadable file aside and returns where it went, so recovery never destroys
   * evidence. A user whose config broke deserves the broken copy, not just an apology.
   */
  quarantine?(scope: ConfigScope): Promise<string | undefined>
  /** Returns an unsubscribe function. */
  watch(scope: ConfigScope, onChange: () => void): () => void
}
