import fs from 'node:fs/promises'
import { replaceFile } from '@light-code/core'
import path from 'node:path'
import type { SecretStore } from '@light-code/core'
import { isVaultEnvelope, openSecrets, sealSecrets } from './vaultCrypto.js'

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
  /**
   * The file's modification time and size when `cache` was read.
   *
   * Light Code Sun runs one process per codebase and points them all at one secrets file, so a key
   * entered in one must reach the others, and one process saving must not write back a stale copy
   * that drops what another just added. So a read checks the stamp and a write re-reads first.
   */
  private stamp: string | undefined
  /** Serialises writes: two concurrent saves would otherwise lose one another's keys. */
  private queue: Promise<void> = Promise.resolve()

  /**
   * Set when the file is encrypted and could not be opened - no key, or the wrong one. Writes are
   * then refused: treating it as empty, as an unreadable plain file is, would replace every saved
   * key with whatever was saved next.
   */
  private sealedShut = false

  /**
   * `key` encrypts the file (Sun Code; see `vaultCrypto.ts`). Without one it is plain JSON,
   * as it always was. A plain file read with a key is taken as it is and encrypted on the next save,
   * which is how existing secrets move into the vault.
   */
  constructor(
    private readonly filePath: string,
    private readonly key?: Buffer,
  ) {}

  private async currentStamp(): Promise<string | undefined> {
    try {
      const stat = await fs.stat(this.filePath)
      return `${String(stat.mtimeMs)}:${String(stat.size)}`
    } catch {
      return undefined
    }
  }

  private async load(): Promise<Record<string, string>> {
    const stamp = await this.currentStamp()
    if (this.cache !== undefined && stamp === this.stamp) return this.cache
    this.stamp = stamp
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
      this.sealedShut = false
      if (isVaultEnvelope(parsed)) {
        if (this.key === undefined) {
          this.sealedShut = true
          this.cache = {}
        } else {
          try {
            this.cache = openSecrets(parsed, this.key)
          } catch {
            this.sealedShut = true
            this.cache = {}
          }
        }
      } else {
        this.cache = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
      }
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
      // Fresh from disk, never the cache: another process may have saved since we last looked.
      this.cache = undefined
      const secrets = await this.load()
      if (this.sealedShut) {
        throw new Error(
          `${this.filePath} is encrypted and this process cannot open it, so nothing was saved - saving would have replaced every key in it. Start this codebase from Sun Code.`,
        )
      }
      mutate(secrets)
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      // Written to a temp file and renamed, so an interrupted write cannot replace a good
      // file with a truncated one. `mode` is set at create time rather than chmod'd after,
      // which would leave a window where the file exists and is world-readable.
      const temp = `${this.filePath}.${process.pid}.tmp`
      const body = this.key === undefined ? secrets : sealSecrets(secrets, this.key)
      await fs.writeFile(temp, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600 })
      await replaceFile(temp, this.filePath)
      this.stamp = await this.currentStamp()
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
    return this.key === undefined
      ? 'file (owner-only permissions, not an OS keychain)'
      : 'encrypted file (Windows per-user protection, through Sun Code)'
  }
}
