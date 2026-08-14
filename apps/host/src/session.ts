import { watch as fsWatch, type FSWatcher } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  Logger,
  wireChatBridge,
  workspaceConfigPath,
  type ConfigScope,
  type ConfigStore,
  type HostServices,
  type HostUi,
  type Transport,
  type WorkspaceState,
} from '@light-code/core'
import { FileSecretStore } from './fileSecretStore.js'
import { storageKeyFor, type Principal } from './identity.js'

/** User scope lives under the principal's own directory; workspace scope in the repo. */
class FileConfigStore implements ConfigStore {
  constructor(
    private readonly userConfigPath: string,
    private readonly workspaceRoot: string | undefined,
  ) {}

  private pathFor(scope: ConfigScope): string | undefined {
    if (scope === 'user') return this.userConfigPath
    return this.workspaceRoot !== undefined ? workspaceConfigPath(this.workspaceRoot) : undefined
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
    if (filePath === undefined) throw new Error(`Cannot write ${scope} config: no workspace is open`)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // 0600: user config holds no secret values, but it does hold every endpoint and
    // certificate path, which is not something to leave world-readable on a shared server.
    await fs.writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600 })
  }

  watch(scope: ConfigScope, onChange: () => void): () => void {
    const filePath = this.pathFor(scope)
    if (filePath === undefined) return () => {}
    let watcher: FSWatcher | undefined
    try {
      // The parent, not the file: it may not exist yet, and editors replace on save.
      watcher = fsWatch(path.dirname(filePath), (_event, filename) => {
        if (filename === path.basename(filePath)) onChange()
      })
    } catch {
      // Nothing to watch until the first write creates the directory.
    }
    return () => watcher?.close()
  }
}

/** Persisted per principal, so two people in one workspace are not in one conversation. */
class FileWorkspaceState implements WorkspaceState {
  private values: Record<string, string> = {}

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) this.values = parsed as Record<string, string>
    } catch {
      this.values = {}
    }
  }

  get(key: string): string | undefined {
    return this.values[key]
  }

  async set(key: string, value: string | undefined): Promise<void> {
    if (value === undefined) delete this.values[key]
    else this.values[key] = value
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(this.values, null, 2), { encoding: 'utf8', mode: 0o600 })
  }
}

/**
 * A browser has no native file picker a server can open, and no toast.
 *
 * Every `HostUi` method is specified as non-load-bearing precisely so this can be honest
 * rather than inventing something. `showOpenDialog` returning `undefined` is
 * indistinguishable from a cancel, and every path field stays typeable — which is why the
 * VS Code Browse buttons were built as an addition to the text input rather than a
 * replacement for it.
 */
function createBrowserUi(workspaceRoot: string | undefined, post: (line: string) => void): HostUi {
  return {
    showInfo: (message) => post(`[info] ${message}`),
    showWarning: (message) => post(`[warn] ${message}`),
    showOpenDialog: async () => undefined,
    showSaveDialog: async () => undefined,
    /*
     * Logged, and the action declined. A terminal has nowhere to put a clickable notification,
     * and `HostUi`'s contract is that no method may be load-bearing (§19) — so resolving false
     * is the honest answer rather than a reason to block the feature here.
     */
    showActionMessage: async (message, _action, level) => {
      post(`[${level}] ${message}`)
      return false
    },
    // Nothing to reveal: the browser UI is whatever tab the user already has open.
    revealPanel: async () => {},
    // No editor to open one in. Logged so the content is not simply lost.
    openDocument: async ({ title }) => post(`[info] ${title} is available in the task history`),

    /**
     * A plain recursive walk, since there is no editor index to borrow. Pruned at the
     * directories that would otherwise dominate the result and the runtime.
     */
    async findFiles(pattern, limit) {
      if (workspaceRoot === undefined) return []
      const needle = pattern.replace(/^\*\*\//, '').replace(/\*/g, '').toLowerCase()
      const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.venv', '__pycache__'])
      const found: string[] = []

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (found.length >= limit || depth > 12) return
        let entries
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (found.length >= limit) return
          if (entry.name.startsWith('.') && entry.name !== '.env') continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (!skip.has(entry.name)) await walk(full, depth + 1)
          } else if (needle.length === 0 || entry.name.toLowerCase().includes(needle)) {
            found.push(full)
          }
        }
      }

      await walk(workspaceRoot, 0)
      return found
    },
  }
}

export interface SessionOptions {
  principal: Principal
  transport: Transport
  workspaceRoot: string | undefined
  /** Root for all per-user data. Each principal gets a subdirectory beneath it. */
  dataDir: string
  ripgrepPath: string | undefined
  logSink: (line: string) => void
}

/**
 * One principal's bridge, with storage scoped to them.
 *
 * The scoping is the whole reason `Principal` exists: config, secrets, task history and
 * spilled tool results all live under a directory derived from the principal id, so adding
 * SSO changes who that is and nothing else.
 */
export async function createSession(options: SessionOptions): Promise<{ dispose: () => void }> {
  const userDir = path.join(options.dataDir, 'users', storageKeyFor(options.principal))
  await fs.mkdir(userDir, { recursive: true, mode: 0o700 })

  const workspaceState = new FileWorkspaceState(path.join(userDir, 'workspace-state.json'))
  await workspaceState.load()

  const services: HostServices = {
    transport: options.transport,
    secrets: new FileSecretStore(path.join(userDir, 'secrets.json')),
    configStore: new FileConfigStore(path.join(userDir, 'config.json'), options.workspaceRoot),
    workspaceState,
    ui: createBrowserUi(options.workspaceRoot, options.logSink),
    workspaceRoot: options.workspaceRoot,
    storageDir: userDir,
    ripgrepPath: options.ripgrepPath,
    logSink: options.logSink,
  }

  new Logger({ level: 'debug', sink: options.logSink }).info(
    `session for ${options.principal.displayName} → ${userDir}`,
  )
  return wireChatBridge(services)
}
