import fs from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../logging/logger.js'
import type { Tool } from '../tools/types.js'
import { describeIssue, loadRegistry, type RegisteredTool, type ToolLoadIssue } from './registry.js'
import {
  adaptPythonTool,
  createCreatePythonTool,
  createDeletePythonTool,
  createUpdatePythonTool,
} from './tools.js'
import { installDependencies } from './deps.js'
import type { WorkerToolDescription } from './worker.js'
import {
  detectUv,
  discoverWorkspaceVenv,
  ensureVenv,
  minimalPythonEnv,
  type UvInfo,
} from './uv.js'
import { PythonWorker } from './worker.js'
import { PYTHON_WORKER_SOURCE } from './workerSource.js'

/**
 * Owns everything Python: detection, the virtualenv, the worker, and the tool list.
 *
 * Exists so the bridge does not have to. The lifecycle has several ways to be partly
 * available — `uv` missing, the venv not built yet, a tool refused for a hash mismatch — and
 * each has to degrade into a *reportable state* rather than an exception, because the panel
 * has to render something honest in every one of them.
 *
 * **Nothing here starts until `dynamicTools` is `on`.** Off by default (§13).
 */

export interface PythonStatus {
  enabled: boolean
  /** Undefined when `uv` could not be found; the UI then explains how to install it. */
  uv?: UvInfo | undefined
  toolsDir: string
  venvPath: string
  /**
   * Which environment is in use and why. Surfaced because "where did my dependency go?" is
   * otherwise unanswerable — reusing the project venv means installs land in *their* project.
   */
  venvSource: 'workspace' | 'configured' | 'created' | 'none'
  venvIsUvManaged: boolean
  ready: boolean
  /** Why it is not ready, phrased for a human. */
  detail: string
  tools: { name: string; description: string; filePath: string }[]
  /**
   * Refused tools, surfaced rather than logged — see `registry.ts`.
   *
   * Structured rather than a sentence, because a refusal the user can *act on* needs the tool's
   * name and file. A hash mismatch usually means they edited the file themselves, and the way
   * back is to read it and approve it again — which needs a button, and a button needs a name.
   */
  issues: {
    detail: string
    name: string
    filePath: string
    /** True when approving the file as it stands would resolve it. */
    recoverable: boolean
  }[]
}

export interface PythonManagerOptions {
  workspaceRoot: string | undefined
  /** Per-user storage; the venv lives here, outside the workspace. */
  storageDir: string
  logger: Logger
  /**
   * Fired after the registry reloads — a tool created, updated or deleted.
   *
   * The manager already refreshed itself on those events, but nothing outside it knew. The
   * host needs to, because the tool list is part of the documentation corpus and part of
   * what the Python tab displays; without this a tool deleted mid-chat stayed in both until
   * something else happened to refresh them.
   */
  onToolsChanged?: () => void
}

export class PythonManager {
  private worker: PythonWorker | undefined
  private uv: UvInfo | undefined
  private registered: RegisteredTool[] = []
  private issues: ToolLoadIssue[] = []
  private ready = false
  private detail = 'Dynamic Python tools are off.'
  private enabled = false
  private toolsDir = ''
  private venvPath = ''
  private venvSource: PythonStatus['venvSource'] = 'none'
  private venvIsUvManaged = false
  private interpreter = ''
  private indexUrl: string | undefined
  private extraIndexUrls: string[] = []
  private offline = false
  private timeoutMs = 30_000

  constructor(private readonly options: PythonManagerOptions) {}

  /**
   * Applies config and brings the environment up if it is on.
   *
   * Safe to call every turn: detection and venv creation are skipped once done, and turning
   * the feature off disposes the worker rather than leaving a stray interpreter behind.
   */
  async configure(config: {
    dynamicTools?: 'off' | 'on' | undefined
    uvPath?: string | undefined
    toolsDir?: string | undefined
    venvPath?: string | undefined
    timeoutSeconds?: number | undefined
    indexUrl?: string | undefined
    extraIndexUrls?: string[] | undefined
    offline?: boolean | undefined
  }): Promise<void> {
    const enabled = config.dynamicTools === 'on'
    if (!enabled) {
      if (this.enabled) await this.dispose()
      this.enabled = false
      this.ready = false
      this.registered = []
      this.issues = []
      this.detail = 'Dynamic Python tools are off.'
      return
    }
    if (this.options.workspaceRoot === undefined) {
      this.enabled = true
      this.ready = false
      this.detail = 'Open a folder — tools live in the workspace so they can be code-reviewed.'
      return
    }

    this.enabled = true
    this.timeoutMs = (config.timeoutSeconds ?? 30) * 1000
    // Inside the workspace by default, deliberately: changes land in git and get reviewed,
    // which is the main real mitigation available (§13).
    this.toolsDir = config.toolsDir ?? path.join(this.options.workspaceRoot, '.lightcode', 'tools')
    this.indexUrl = config.indexUrl
    this.extraIndexUrls = config.extraIndexUrls ?? []
    this.offline = config.offline === true

    if (this.uv === undefined) this.uv = await detectUv(config.uvPath)
    if (this.uv === undefined) {
      this.ready = false
      this.detail = 'uv was not found. Install it and set the path in Settings → Python, or add it to PATH.'
      return
    }

    try {
      const env = minimalPythonEnv()

      /*
       * Prefer an environment the project already has. That is where the user's internal
       * libraries are installed, and a private venv would be empty — a tool importing an
       * internal package would then fail in a way that looks like a bug in Light Code
       * rather than a missing install.
       *
       * Order: an explicitly configured path wins, then the workspace's own venv, then one
       * of ours as the fallback.
       */
      let interpreter: string
      if (config.venvPath !== undefined && config.venvPath.trim().length > 0) {
        this.venvPath = config.venvPath.trim()
        this.venvSource = 'configured'
        interpreter = await ensureVenv({ uv: this.uv, venvDir: this.venvPath, env })
      } else {
        const discovered = await discoverWorkspaceVenv(this.options.workspaceRoot)
        if (discovered !== undefined) {
          this.venvPath = discovered.path
          this.venvSource = 'workspace'
          this.venvIsUvManaged = discovered.uvManaged
          interpreter = discovered.interpreter
        } else {
          // Outside the workspace, so ours is never indexed, committed or read by a tool.
          this.venvPath = path.join(this.options.storageDir, 'python-venv')
          this.venvSource = 'created'
          this.venvIsUvManaged = true
          interpreter = await ensureVenv({ uv: this.uv, venvDir: this.venvPath, env })
        }
      }
      this.interpreter = interpreter

      const workerScript = await this.writeWorkerScript()
      this.worker ??= new PythonWorker({
        pythonPath: interpreter,
        workerScript,
        cwd: this.options.workspaceRoot,
        env,
        logger: this.options.logger,
        timeoutMs: this.timeoutMs,
      })
      await this.refresh()
      this.ready = true
      this.detail =
        this.venvSource === 'workspace'
          ? `Ready — using this project's virtualenv${this.venvIsUvManaged ? ' (uv-managed)' : ''}. ` +
            'Tool dependencies install into it.'
          : this.venvSource === 'configured'
            ? `Ready — using the configured virtualenv. uv ${this.uv.version}.`
            : `Ready — created a private virtualenv. uv ${this.uv.version}.`
    } catch (error) {
      this.ready = false
      this.detail = error instanceof Error ? error.message : String(error)
      this.options.logger.warn('python environment failed to start', this.detail)
    }
  }

  /**
   * Writes the worker script to disk and returns its path.
   *
   * The source is inlined into the bundle rather than shipped as a file: esbuild does not
   * copy `.py`, and resolving a path relative to the bundle is the trap that once shipped a
   * VSIX which could not activate at all. Rewritten every start, so an upgrade replaces an
   * older worker rather than silently keeping it.
   *
   * It lands in per-user storage, outside the workspace — it is ours, not the project's.
   */
  private async writeWorkerScript(): Promise<string> {
    const dir = path.join(this.options.storageDir, 'python-worker')
    await fs.mkdir(dir, { recursive: true })
    const scriptPath = path.join(dir, 'main.py')
    await fs.writeFile(scriptPath, PYTHON_WORKER_SOURCE, 'utf8')
    return scriptPath
  }

  /** Re-reads the tools directory. Cheap, and called after any create/update/delete. */
  /**
   * Validates a tool file and returns what it describes, without approving it.
   *
   * Exists so the settings tab can re-pin a hand-edited tool (§13) through exactly the same
   * check a model-authored one gets. Approving something that does not load would have the pin
   * start certifying broken code, which is worse than the mismatch it was meant to resolve.
   */
  async describe(name: string, filePath: string): Promise<WorkerToolDescription | undefined> {
    if (this.worker === undefined) return undefined
    try {
      return await this.worker.validate(name, filePath)
    } catch {
      return undefined
    }
  }

  /** Where tool files live, so the host can open and remove them on the user's behalf. */
  toolsDirectory(): string {
    return this.toolsDir
  }

  async refresh(): Promise<void> {
    if (!this.enabled || this.toolsDir.length === 0) return
    const loaded = await loadRegistry(this.toolsDir, this.worker, this.options.logger)
    this.registered = loaded.tools
    this.issues = loaded.issues
    this.options.onToolsChanged?.()
  }

  /**
   * Tools to offer the model this turn.
   *
   * Empty unless the environment is actually usable — offering `create_python_tool` with no
   * interpreter behind it would advertise something that always fails, and the model would
   * keep trying it instead of using `execute_command`.
   */
  tools(): Tool<never>[] {
    if (!this.enabled || !this.ready || this.worker === undefined) return []
    const worker = this.worker
    const uv = this.uv
    const context = {
      toolsDir: this.toolsDir,
      worker,
      onChanged: () => this.refresh(),
      ...(uv !== undefined
        ? {
            installDeps: (packages: readonly string[]) =>
              installDependencies({
                uv,
                pythonPath: this.interpreter,
                packages,
                ...(this.indexUrl !== undefined ? { indexUrl: this.indexUrl } : {}),
                extraIndexUrls: this.extraIndexUrls,
                offline: this.offline,
                env: minimalPythonEnv(),
              }),
          }
        : {}),
    }

    return [
      createCreatePythonTool(context),
      createUpdatePythonTool(context),
      createDeletePythonTool(context),
      ...this.registered.map((tool) => adaptPythonTool(tool, { worker, timeoutMs: this.timeoutMs })),
    ] as unknown as Tool<never>[]
  }

  status(): PythonStatus {
    return {
      enabled: this.enabled,
      uv: this.uv,
      toolsDir: this.toolsDir,
      venvPath: this.venvPath,
      venvSource: this.venvSource,
      venvIsUvManaged: this.venvIsUvManaged,
      ready: this.ready,
      detail: this.detail,
      tools: this.registered.map((tool) => ({
        name: tool.name,
        description: tool.description,
        filePath: tool.filePath,
      })),
      issues: this.issues.map((issue) => ({
        detail: describeIssue(issue),
        name: issue.name,
        filePath: issue.filePath,
        // `invalid` means the file does not load at all — approving it would pin a broken
        // tool. Only a pin problem can be fixed by re-pinning.
        recoverable: issue.kind === 'hash-mismatch' || issue.kind === 'unapproved',
      })),
    }
  }

  async dispose(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    await worker?.dispose()
  }
}
