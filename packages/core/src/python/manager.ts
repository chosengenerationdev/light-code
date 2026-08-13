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
import { detectUv, ensureVenv, minimalPythonEnv, venvPythonPath, type UvInfo } from './uv.js'
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
  ready: boolean
  /** Why it is not ready, phrased for a human. */
  detail: string
  tools: { name: string; description: string; filePath: string }[]
  /** Refused tools, surfaced rather than logged — see `registry.ts`. */
  issues: string[]
}

export interface PythonManagerOptions {
  workspaceRoot: string | undefined
  /** Per-user storage; the venv lives here, outside the workspace. */
  storageDir: string
  logger: Logger
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
    // Outside it, so the venv is never indexed, committed or read by a file tool.
    this.venvPath = config.venvPath ?? path.join(this.options.storageDir, 'python-venv')

    if (this.uv === undefined) this.uv = await detectUv(config.uvPath)
    if (this.uv === undefined) {
      this.ready = false
      this.detail = 'uv was not found. Install it and set the path in Settings → Python, or add it to PATH.'
      return
    }

    try {
      const env = minimalPythonEnv()
      await ensureVenv({ uv: this.uv, venvDir: this.venvPath, env })
      const workerScript = await this.writeWorkerScript()
      this.worker ??= new PythonWorker({
        pythonPath: venvPythonPath(this.venvPath),
        workerScript,
        cwd: this.options.workspaceRoot,
        env,
        logger: this.options.logger,
        timeoutMs: this.timeoutMs,
      })
      await this.refresh()
      this.ready = true
      this.detail = `Ready — uv ${this.uv.version}.`
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
  async refresh(): Promise<void> {
    if (!this.enabled || this.toolsDir.length === 0) return
    const loaded = await loadRegistry(this.toolsDir, this.worker, this.options.logger)
    this.registered = loaded.tools
    this.issues = loaded.issues
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
    const context = { toolsDir: this.toolsDir, worker, onChanged: () => this.refresh() }

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
      ready: this.ready,
      detail: this.detail,
      tools: this.registered.map((tool) => ({
        name: tool.name,
        description: tool.description,
        filePath: tool.filePath,
      })),
      issues: this.issues.map(describeIssue),
    }
  }

  async dispose(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    await worker?.dispose()
  }
}
