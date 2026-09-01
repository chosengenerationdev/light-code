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

  /**
   * Atomic: writes a sibling file and renames it into place.
   *
   * `fs.writeFile` straight onto the live file truncates first, so anything that interrupts it
   * — a crash, a window closing, two saves overlapping — leaves invalid JSON. Every later read
   * then throws, and the product looks like it has lost the provider, the approvals and the
   * expert at once. A rename is a single filesystem operation: the file is either the old
   * contents or the new one, never half of each.
   *
   * The previous contents are kept beside it, which is what makes a damaged file survivable.
   */
  async write(scope: ConfigScope, contents: string): Promise<void> {
    const filePath = this.pathFor(scope)
    if (filePath === undefined) {
      throw new Error(`Cannot write ${scope} config: no workspace is open`)
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true })

    // Same directory, so the rename stays on one volume and is therefore atomic.
    const temporary = `${filePath}.${process.pid.toString(36)}.tmp`
    await fs.writeFile(temporary, contents, 'utf8')
    await fs.rename(temporary, filePath)

    /*
     * The backup is written *after* the live file, from the same contents.
     *
     * Copying the previous file before overwriting would seem more natural, and is wrong in the
     * case that matters: the very first write would leave no backup at all, so a config damaged
     * before its second save has nothing to recover from. Written this way the backup exists
     * from the first save onward and always holds something that parsed.
     */
    try {
      const backupTemp = `${backupPathFor(filePath)}.tmp`
      await fs.writeFile(backupTemp, contents, 'utf8')
      await fs.rename(backupTemp, backupPathFor(filePath))
    } catch {
      // A backup that could not be written is worth no interruption — the live file is safe,
      // which is the part that decides whether the product still works.
    }
  }

  async readBackup(scope: ConfigScope): Promise<string | undefined> {
    const filePath = this.pathFor(scope)
    if (filePath === undefined) return undefined
    try {
      return await fs.readFile(backupPathFor(filePath), 'utf8')
    } catch {
      return undefined
    }
  }

  async quarantine(scope: ConfigScope): Promise<string | undefined> {
    const filePath = this.pathFor(scope)
    if (filePath === undefined) return undefined
    const target = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      await fs.rename(filePath, target)
      return target
    } catch {
      return undefined
    }
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

/** The last-good copy, beside the file it protects so it shares its permissions and volume. */
function backupPathFor(filePath: string): string {
  return `${filePath}.bak`
}
