export type ConfigScope = 'user' | 'workspace'

/**
 * Raw scoped JSON-file storage. Reads/writes text; parsing and validation happen in
 * packages/core/src/config/. `watch` fires on external changes (hand-edits) so the
 * UI and file loader stay in sync — see CLAUDE.md §15.
 */
export interface ConfigStore {
  /** Returns `undefined` if the scope has no config file yet. */
  read(scope: ConfigScope): Promise<string | undefined>
  write(scope: ConfigScope, contents: string): Promise<void>
  /** Returns an unsubscribe function. */
  watch(scope: ConfigScope, onChange: () => void): () => void
}
