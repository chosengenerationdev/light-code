/**
 * Async get/set/delete. Backend varies by host (DPAPI / Keychain / libsecret / file
 * fallback) — callers can surface `backendName()` so the UI never implies
 * keychain-grade protection when the active backend is a plain file. See CLAUDE.md §15.
 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  /** Delete every secret this store holds. Used by "clear all stored secrets". */
  clear(): Promise<void>
  backendName(): string
}
