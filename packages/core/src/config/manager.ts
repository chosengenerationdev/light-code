import type { ConfigScope, ConfigStore } from '../platform/config.js'
import { ConfigValidationError, parseConfig, type LightCodeConfig } from './schema.js'
import { mergeScopes, type ScopeMergeResult } from './scopes.js'

export class ConfigManager {
  constructor(private readonly store: ConfigStore) {}

  /**
   * Serialises every save, per scope.
   *
   * `save` is read-modify-write with an `await` between the read and the write, so two
   * concurrent calls both read the old contents and the second silently discards the first's
   * change. Saving the junior assessment while the expert panel saves its measured price is
   * exactly that shape, and it happens without anyone doing anything unusual.
   *
   * A chain rather than a lock: each save waits for the previous one to finish, so ordering
   * is the order the calls were made and nothing needs to handle contention.
   */
  private writes: Record<ConfigScope, Promise<unknown>> = {
    user: Promise.resolve(),
    workspace: Promise.resolve(),
  }

  /**
   * Whether the last `load()` had to fall back to a backup, and where the damaged file went.
   *
   * Reported rather than thrown: recovering silently would hide a real fault, and throwing
   * would leave the product unusable for a problem it has already fixed.
   */
  private lastRecovery: { scope: ConfigScope; quarantinedTo?: string } | undefined

  /** Cleared by the reader, so a recovery is announced once rather than on every load. */
  takeRecovery(): { scope: ConfigScope; quarantinedTo?: string } | undefined {
    const recovery = this.lastRecovery
    this.lastRecovery = undefined
    return recovery
  }

  async load(): Promise<ScopeMergeResult> {
    const [userConfig, workspaceConfig] = await Promise.all([
      this.readScope('user'),
      this.readScope('workspace'),
    ])
    return mergeScopes(userConfig, workspaceConfig)
  }

  /**
   * Reads one scope, falling back to the last good copy if the live file will not parse.
   *
   * Without this, one interrupted write bricks the product: every `load()` throws, so the
   * provider, the approvals and the expert all vanish at once and the only repair is editing
   * JSON by hand. That happened to a real user. A backup that parses is strictly better than
   * an error — and the damaged file is moved aside rather than deleted, because a user whose
   * config broke should get to keep the broken copy.
   *
   * A hand-edit that fails *validation* still throws, unchanged: that is a mistake the user
   * just made in a file they are looking at, and silently reverting it would be worse than
   * saying so.
   */
  private async readScope(scope: ConfigScope): Promise<LightCodeConfig> {
    const raw = await this.store.read(scope)
    try {
      return parseConfig(raw)
    } catch (error) {
      if (raw === undefined || !isUnparseable(error)) throw error

      const backup = await this.store.readBackup?.(scope)
      if (backup === undefined) throw error
      // A backup that is itself broken is no better than the file; report the original.
      let recovered: LightCodeConfig
      try {
        recovered = parseConfig(backup)
      } catch {
        throw error
      }

      const quarantinedTo = await this.store.quarantine?.(scope)
      this.lastRecovery = { scope, ...(quarantinedTo !== undefined ? { quarantinedTo } : {}) }
      // Put the good copy back, so the next write is not building on a file that cannot be read.
      await this.store.write(scope, backup)
      return recovered
    }
  }

  /** Read-modify-write: shallow-merges `patch` into the scope's existing content. */
  async save(scope: ConfigScope, patch: LightCodeConfig): Promise<void> {
    const queued = this.writes[scope].then(
      () => this.saveNow(scope, patch),
      () => this.saveNow(scope, patch),
    )
    // Kept unhandled-rejection-safe: the chain must survive one failed save, or every later
    // save on that scope is dropped.
    this.writes[scope] = queued.catch(() => undefined)
    await queued
  }

  private async saveNow(scope: ConfigScope, patch: LightCodeConfig): Promise<void> {
    const existing = await this.readScope(scope)
    const next = { ...existing, ...patch }
    // Round-trip through the schema so a bad save fails the same way a bad hand-edit does.
    const validated = parseConfig(JSON.stringify(next))
    await this.store.write(scope, JSON.stringify(validated, null, 2))
  }

  /** Fires with the freshly reloaded, merged config whenever either scope changes on disk. */
  watch(onChange: (result: ScopeMergeResult) => void): () => void {
    const reloadAndNotify = (): void => {
      this.load()
        .then(onChange)
        .catch(() => {
          // A hand-edit that fails validation is surfaced through `load()`'s caller,
          // not here — a bad edit-in-progress should not crash the watcher.
        })
    }
    const unsubscribeUser = this.store.watch('user', reloadAndNotify)
    const unsubscribeWorkspace = this.store.watch('workspace', reloadAndNotify)
    return () => {
      unsubscribeUser()
      unsubscribeWorkspace()
    }
  }
}

/**
 * Distinguishes "this is not JSON" from "this is JSON that breaks a rule".
 *
 * Only the first is recoverable from a backup. The second is a hand-edit the user just made
 * and can see, and quietly replacing it with an older file would be the wrong help.
 */
function isUnparseable(error: unknown): boolean {
  return error instanceof ConfigValidationError && error.message.includes('not valid JSON')
}
