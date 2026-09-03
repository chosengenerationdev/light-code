import type { ConfigScope, ConfigStore } from '../platform/config.js'
import { ConfigValidationError, parseConfig, type LightCodeConfig } from './schema.js'
import {
  applyWorkspaceOverrides,
  overridesFor,
  workspaceOverrideKey,
  type WorkspaceOverrides,
} from './workspaceOverrides.js'
import { mergeScopes, type ScopeMergeResult } from './scopes.js'

export class ConfigManager {
  /**
   * @param workspaceRoot Which project is open, so its own settings apply.
   *
   * Applied **here** rather than at each call site. Callers read config in dozens of places and
   * every one of them must see the same answer — a per-project value that reached the agent loop
   * but not the settings panel is the "one fact in two places" failure this project has paid for
   * more than any other.
   */
  constructor(
    private readonly store: ConfigStore,
    private readonly workspaceRoot?: string,
  ) {}

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
    const merged = mergeScopes(userConfig, workspaceConfig)

    /*
     * The project's own settings, last.
     *
     * Read from *user* config, never from the workspace file: invariant 5 is about who may write
     * a value, and that is unchanged. This only lets the user say something different for this
     * project than for the last one.
     */
    const overrides = overridesFor(
      userConfig.workspaces as Record<string, WorkspaceOverrides> | undefined,
      this.workspaceRoot,
    )
    return { ...merged, config: applyWorkspaceOverrides(merged.config, overrides) }
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

  /**
   * Saves a value for **this project only**, leaving the user's default alone.
   *
   * Goes into user config under the workspace's path, so a repository still cannot write it —
   * the same shape `approvals` has used since Phase 4. Passing `undefined` for a key removes the
   * override and the global default applies again, which has to be possible or a project setting
   * is a one-way door.
   */
  async saveForWorkspace(overrides: Partial<WorkspaceOverrides>): Promise<void> {
    if (this.workspaceRoot === undefined) {
      throw new Error('No folder is open, so there is no project to save this for.')
    }
    const key = workspaceOverrideKey(this.workspaceRoot)

    await this.save('user', {
      workspaces: await this.mergedOverrides(key, overrides),
    } as LightCodeConfig)
  }

  /** Read inside the queued save, so two per-project writes cannot lose each other. */
  private async mergedOverrides(
    key: string,
    overrides: Partial<WorkspaceOverrides>,
  ): Promise<Record<string, WorkspaceOverrides>> {
    const existing = (await this.readScope('user')).workspaces as
      | Record<string, WorkspaceOverrides>
      | undefined
    const all = { ...existing }
    // Whatever spelling this project is already stored under, so a case difference does not
    // quietly create a second entry that shadows the first.
    const matching = Object.keys(all).find((candidate) => workspaceOverrideKey(candidate) === key) ?? key

    const next: Record<string, unknown> = { ...(all[matching] ?? {}) }
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete next[name]
      else next[name] = value
    }

    // An empty entry is removed rather than left behind: "this project has no settings of its
    // own" and "this project has an entry saying nothing" should not be two different states.
    if (Object.keys(next).length === 0) delete all[matching]
    else all[matching] = next as WorkspaceOverrides
    return all
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
