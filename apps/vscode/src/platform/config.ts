import { watch as fsWatch, type FSWatcher } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as vscode from 'vscode'
import { workspaceConfigPath as resolveWorkspaceConfigPath, type ConfigScope, type ConfigStore } from '@light-code/core'

/**
 * User scope lives under the extension's `globalStorageUri` (not `env-paths`, per
 * CLAUDE.md §15 — `env-paths` is core's cross-platform default for hosts, like the
 * future Node host, that have no better-suited native location). Workspace scope is
 * always `.lightcode/config.json` under the workspace root.
 */
export class VSCodeConfigStore implements ConfigStore {
  private readonly userConfigPath: string
  private readonly workspaceConfigPath: string | undefined

  constructor(context: vscode.ExtensionContext, workspaceRoot: string | undefined) {
    this.userConfigPath = path.join(context.globalStorageUri.fsPath, 'config.json')
    this.workspaceConfigPath = workspaceRoot ? resolveWorkspaceConfigPath(workspaceRoot) : undefined
  }

  async read(scope: ConfigScope): Promise<string | undefined> {
    const filePath = this.pathFor(scope)
    if (filePath === undefined) return undefined
    try {
      return await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async write(scope: ConfigScope, contents: string): Promise<void> {
    const filePath = this.pathFor(scope)
    if (filePath === undefined) {
      throw new Error(`Cannot write ${scope} config: no workspace is open`)
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, contents, 'utf8')
  }

  watch(scope: ConfigScope, onChange: () => void): () => void {
    const filePath = this.pathFor(scope)
    if (filePath === undefined) return () => {}

    let watcher: FSWatcher | undefined
    try {
      // Watch the parent directory, not the file: the file may not exist yet, and
      // some editors replace-on-save (unlink + create) rather than mutate in place.
      watcher = fsWatch(path.dirname(filePath), (_event, filename) => {
        if (filename === path.basename(filePath)) onChange()
      })
    } catch {
      // Parent directory doesn't exist yet — nothing to watch until the first write.
    }
    return () => watcher?.close()
  }

  private pathFor(scope: ConfigScope): string | undefined {
    return scope === 'user' ? this.userConfigPath : this.workspaceConfigPath
  }
}
