import fs from 'node:fs/promises'
import path from 'node:path'
import type { SecretStore } from '@light-code/core'

/**
 * Secrets in a file with owner-only permissions.
 *
 * **This is not keychain-grade and the UI says so.** §15 requires the active backend to be
 * reported rather than implied, and §3 states plainly that Light Code does not defend
 * against another process running as the same user. Encrypting the file would not change
 * that — the key would have to sit beside it, readable by exactly the same processes — so
 * this stores plaintext at 0600 and is honest about it rather than performing security.
 *
 * A real improvement is DPAPI on Windows, Keychain on macOS, libsecret on Linux. Each needs
 * a native module, which is a packaging decision (§14), not something to fake here.
 *
 * One file per principal. On a shared server, file permissions do *not* separate users —
 * every session runs as the service account — so this is isolation of *storage*, not of
 * privilege. See `docs/hosting.md`.
 */
export class FileSecretStore implements SecretStore {

  private cache: Record<string, string> | undefined
  /** Serialises writes: two concurrent saves would otherwise lose one another's keys. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  private async load(): Promise<Record<string, string>> {
    if (this.cache !== undefined) return this.cache
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.cache = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
    } catch {
      // Missing or unreadable both mean "no secrets yet". A corrupt file must not take the
      // whole session down; the user re-enters a key, which is recoverable, and a crash on
      // startup is not.
      this.cache = {}
    }
    return this.cache
  }

  private write(mutate: (secrets: Record<string, string>) => void): Promise<void> {
    this.queue = this.queue.then(async () => {
      const secrets = await this.load()
      mutate(secrets)
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      // Written to a temp file and renamed, so an interrupted write cannot replace a good
      // file with a truncated one. `mode` is set at create time rather than chmod'd after,
      // which would leave a window where the file exists and is world-readable.
      const temp = `${this.filePath}.${process.pid}.tmp`
      await fs.writeFile(temp, JSON.stringify(secrets, null, 2), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temp, this.filePath)
    })
    return this.queue
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.load())[key]
  }

  async set(key: string, value: string): Promise<void> {
    await this.write((secrets) => {
      secrets[key] = value
    })
  }

  async delete(key: string): Promise<void> {
    await this.write((secrets) => {
      delete secrets[key]
    })
  }

  /** Real deletion, per §15: the file is removed, not emptied key by key. */
  async clear(): Promise<void> {
    await this.write((secrets) => {
      for (const key of Object.keys(secrets)) delete secrets[key]
    })
  }

  /** Surfaced in the UI so it never implies keychain-grade protection (§15). */
  backendName(): string {
    return 'file (owner-only permissions, not an OS keychain)'
  }
}
