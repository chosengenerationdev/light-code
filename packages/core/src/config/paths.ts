import envPaths from 'env-paths'
import path from 'node:path'

/**
 * Cross-platform default for the user-scope config file, used by hosts that have no
 * better-suited native location (Phase 10's Node host). `apps/vscode` uses
 * `ExtensionContext.globalStorageUri` instead — see CLAUDE.md §15.
 */
export function defaultUserConfigPath(): string {
  return path.join(envPaths('light-code').config, 'config.json')
}

/** Workspace-scope config always lives here, regardless of host. */
export function workspaceConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.lightcode', 'config.json')
}
