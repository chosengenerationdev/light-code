import type { ConfigScope, ConfigStore } from '../platform/config.js'
import { parseConfig, type LightCodeConfig } from './schema.js'
import { mergeScopes, type ScopeMergeResult } from './scopes.js'

export class ConfigManager {
  constructor(private readonly store: ConfigStore) {}

  async load(): Promise<ScopeMergeResult> {
    const [userRaw, workspaceRaw] = await Promise.all([
      this.store.read('user'),
      this.store.read('workspace'),
    ])
    const userConfig = parseConfig(userRaw)
    const workspaceConfig = parseConfig(workspaceRaw)
    return mergeScopes(userConfig, workspaceConfig)
  }

  /** Read-modify-write: shallow-merges `patch` into the scope's existing content. */
  async save(scope: ConfigScope, patch: LightCodeConfig): Promise<void> {
    const existing = parseConfig(await this.store.read(scope))
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
