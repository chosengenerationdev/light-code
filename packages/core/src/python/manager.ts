import { checkCollector } from '../dataset/checkCollector.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../logging/logger.js'
import type { SecretStore } from '../platform/secrets.js'
import { JUPYTER_CONNECTION_ENV } from './jupyter.js'
import { pythonEnvEntries, resolvePythonEnv, type PythonEnvEntry } from './env.js'
import type { Tool } from '../tools/types.js'
import type { CodeGenerator } from './codeGenerator.js'
import {
  defaultPythonToolsDir,
  describeIssue,
  loadRegistries,
  type RegisteredTool,
  type ToolLoadIssue,
} from './registry.js'
import {
  adaptPythonTool,
  createCollectorTool,
  createCreatePythonTool,
  createDeletePythonTool,
  createUpdatePythonTool,
  type PythonToolContext,
} from './tools.js'
import { installDependencies } from './deps.js'
import type { WorkerToolDescription } from './worker.js'
import {
  detectUv,
  detectBareInterpreter,
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
  /**
   * Which environment is in use.
   *
   * `interpreter` means an ambient Python with no virtualenv at all — see
   * `detectBareInterpreter`. It is distinct from `none` because `none` means nothing is running.
   */
  venvSource: 'workspace' | 'configured' | 'created' | 'interpreter' | 'none'
  venvIsUvManaged: boolean
  ready: boolean
  /** Why it is not ready, phrased for a human. */
  detail: string
  /**
   * Variables declared as secrets whose value is not in storage.
   *
   * Surfaced rather than logged, for the same reason refused tools are: the tool that needs the
   * variable fails with whatever its library says about a missing credential, which points at the
   * tool. Naming the variable points at the thing that is actually wrong, and the fix is one box.
   */
  missingEnv?: string[]
  /**
   * `sourceDir` says which configured folder it came from — only the first is writable, so the tab
   * can mark a shared tool read-only rather than offering a Remove that would be refused.
   */
  tools: { name: string; description: string; filePath: string; sourceDir: string }[]
  /** Read-only folders searched after `toolsDir`, in order. */
  extraToolDirs?: string[]
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
    /** Which kind, so the UI can say "new" and "changed" rather than flattening both. */
    kind: 'hash-mismatch' | 'unapproved' | 'invalid' | 'shadowed' | 'declined'
  }[]
}

export interface PythonManagerOptions {
  workspaceRoot: string | undefined
  /**
   * Lets a Python tool call another tool. Supplied by the host, absent where nobody can approve.
   *
   * See `worker.ts` for the transport and `bridge.ts` for the rules.
   */
  callTool?:
    ((name: string, args: Record<string, unknown>, caller: string) => Promise<unknown>) | undefined
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
  /**
   * Publishes a newly written tool, when tools are kept in a bucket.
   *
   * Supplied by the host, because the manager has no business knowing S3 exists — it sees a
   * callback, exactly as it sees folders rather than mirrors. Absent unless a folder is configured
   * and writable, so nothing changes for anyone who has not set one up.
   */
  onToolSaved?: ((name: string, source: string) => Promise<void>) | undefined
  /**
   * Session variables to add to the worker's environment, read at spawn time.
   *
   * A function rather than a value because the worker outlives an edit: reading it here means a
   * changed variable applies to the next worker, and the caller can say so, rather than the
   * manager holding a copy from whenever it was constructed.
   *
   * These are *added to* the allowlist in `minimalPythonEnv`, never a way around it. The
   * allowlist exists so a provider API key cannot reach model-authored code (§13), and that is
   * unchanged: what arrives here is what a human deliberately declared.
   */
  sessionEnv?: () => Record<string, string>
  /**
   * Reads the values of variables the user declared as secrets, at spawn time.
   *
   * Optional so a host without one simply has no secret-valued variables rather than failing to
   * start; the names are still reported as missing, so the difference is visible.
   */
  secrets?: SecretStore | undefined
  /**
   * The programming provider, if one is configured, resolved when the tool list is built.
   *
   * A resolver rather than a value because the tool parameters differ depending on the answer —
   * a specification when a code model will write the file, the source itself when the chat model
   * will. That has to be settled at build time, and the answer can change between turns.
   */
  generateSource?: () => CodeGenerator | undefined
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
  /**
   * Read-only folders searched after `toolsDir`, in order.
   *
   * Supplied by the host rather than read from config, because today they are bucket mirrors and
   * the manager has no business knowing S3 exists — it sees folders, exactly as the skill loader
   * does. Only the first folder is ever written to.
   */
  private extraToolDirs: string[] = []
  /** `name -> hash` the user declined. See `declinedTools` in the config schema. */
  private declinedTools: Record<string, string> = {}
  private venvPath = ''
  private venvSource: PythonStatus['venvSource'] = 'none'
  private venvIsUvManaged = false
  private interpreter = ''
  private indexUrl: string | undefined
  private extraIndexUrls: string[] = []
  private offline = false
  private timeoutMs = 30_000
  /**
   * The *declaration*, not the values: names, and which are secret. Values are read at spawn.
   *
   * Held because the worker outlives a save, and `envFingerprint` is what tells `configure` that
   * a save changed them — a worker's environment is fixed when it is spawned, so without this a
   * changed variable would apply at the next window rather than the next call.
   */
  private envEntries: PythonEnvEntry[] = []
  /** The Jupyter kernel tools run in, when this session was given one. See `jupyter.ts`. */
  private jupyterConnectionFile: string | undefined
  private envFingerprint = ''
  private missingEnv: string[] = []

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
    /** A Python to use directly, when there is no uv and no virtualenv. */
    interpreterPath?: string | undefined
    timeoutSeconds?: number | undefined
    /** The global tool timeout, used when Python has no limit of its own. */
    defaultTimeoutSeconds?: number | undefined
    indexUrl?: string | undefined
    extraIndexUrls?: string[] | undefined
    offline?: boolean | undefined
    /** Variables to run every tool with. See `env.ts` for the shape config holds. */
    env?:
      | Record<string, string | { value?: string | undefined; secret?: boolean | undefined }>
      | undefined
    /** Read-only folders to search after `toolsDir`. See `extraToolDirs`. */
    extraToolDirs?: readonly string[] | undefined
    /** `name -> hash` the user declined, so those exact bytes are not offered. */
    declinedTools?: Record<string, string> | undefined
    /**
     * A Jupyter kernel to run tools *inside*, named by its connection file.
     *
     * The notebook tells us; we never guess which kernel is which. `jupyter.ts` has the whole
     * argument and the one line a notebook needs.
     */
    jupyterConnectionFile?: string | undefined
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

    /*
     * A changed variable means the running worker is wrong, so it goes.
     *
     * `PythonWorker` takes its environment at construction — that is how a child process works —
     * and the worker is deliberately long-lived. Without this, saving a variable would appear to
     * do nothing until the window was reopened, which is indistinguishable from the setting not
     * working at all. Disposing here is safe because `configure` runs between turns, never during
     * one, and the next call spawns a fresh worker.
     */
    this.envEntries = pythonEnvEntries(config.env)
    /*
     * The kernel is part of the environment fingerprint below, on purpose.
     *
     * Pointing a session at a different notebook has to restart the worker for the same reason
     * a changed variable does: a child takes its environment once, at construction, and this
     * one is long-lived. Without it, choosing a kernel would appear to do nothing until the
     * window was reopened - and the failure would be silent, because the tools would keep
     * working, just in the wrong place.
     */
    /*
     * The session's own kernel beats the stored one, and that order is deliberate.
     *
     * A session started by a notebook - `--jupyter-kernel`, or the variable set when it spawned
     * us - was told which kernel by the only thing that knows. A value in config is standing,
     * and a stored connection file is stale the moment that kernel restarts, because Jupyter
     * writes a new one. So the specific, current statement wins over the general, possibly old
     * one.
     */
    const fromEnvironment = (process.env[JUPYTER_CONNECTION_ENV] ?? '').trim()
    const fromConfig = (config.jupyterConnectionFile ?? '').trim()
    const kernel = fromEnvironment.length > 0 ? fromEnvironment : fromConfig
    this.jupyterConnectionFile = kernel.length > 0 ? kernel : undefined
    const fingerprint = JSON.stringify([this.envEntries, this.jupyterConnectionFile])
    if (fingerprint !== this.envFingerprint) {
      this.envFingerprint = fingerprint
      if (this.worker !== undefined) {
        this.options.logger.info('Python environment variables changed; restarting the worker.')
        await this.dispose()
      }
    }

    /*
     * Python's own limit, then the global tool timeout, then 30 seconds.
     *
     * The middle term is the one that was missing: "everything on this machine is slow" is a
     * property of the environment rather than of Python, and without it the only way to say so
     * was to set the same number in three separate places.
     */
    this.timeoutMs = (config.timeoutSeconds ?? config.defaultTimeoutSeconds ?? 30) * 1000
    // Inside the workspace by default, deliberately: changes land in git and get reviewed,
    // which is the main real mitigation available (§13).
    this.toolsDir = config.toolsDir ?? defaultPythonToolsDir(this.options.workspaceRoot)
    this.extraToolDirs = [...(config.extraToolDirs ?? [])]
    this.declinedTools = { ...(config.declinedTools ?? {}) }
    this.indexUrl = config.indexUrl
    this.extraIndexUrls = config.extraIndexUrls ?? []
    this.offline = config.offline === true

    if (this.uv === undefined) this.uv = await detectUv(config.uvPath)

    /*
     * No uv is no longer the end of it.
     *
     * Light Code is often started inside an environment somebody else built — a Streamlit app, a
     * container, a conda env — where the interpreter already has the libraries the tools need and
     * installing a package manager to reach it makes no sense. So an ambient interpreter is used
     * as it is: nothing created, nothing installed. `detectBareInterpreter` says why that is the
     * right trade there and the wrong one when the environment is ours.
     */
    if (this.uv === undefined) {
      await this.startWithoutUv(config, this.options.workspaceRoot)
      return
    }

    try {
      const env = await this.childEnv()

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
        /*
         * Passed through rather than resolved here.
         *
         * The manager has no registry and no approval gate; the host has both. Threading the
         * function means the rules are decided once, where the information is, instead of this
         * file growing an opinion about which tools a tool may call.
         */
        ...(this.options.callTool !== undefined ? { callTool: this.options.callTool } : {}),
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

  /** Where *new* tool files are written, so the host can open and remove them on the user's behalf. */
  toolsDirectory(): string {
    return this.toolsDir
  }

  /** Every folder searched, writable first. The host opens files from any of them. */
  toolDirectories(): string[] {
    return [this.toolsDir, ...this.extraToolDirs].filter((dir) => dir.length > 0)
  }

  /** A loaded tool by name, so a caller can tell where it lives before acting on it. */
  findTool(name: string): RegisteredTool | undefined {
    return this.registered.find((tool) => tool.name === name)
  }

  async refresh(): Promise<void> {
    if (!this.enabled || this.toolsDir.length === 0) return
    const loaded = await loadRegistries(
      this.toolDirectories(),
      this.worker,
      this.options.logger,
      this.declinedTools,
    )
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
  /**
   * Every Python tool, management and generated alike. Kept for callers that want the lot.
   *
   * The two halves are also available separately, because the dispatcher must treat them
   * differently — see `managementTools`.
   */
  tools(): Tool<never>[] {
    return [...this.managementTools(), ...this.generatedTools()]
  }

  /**
   * The three fixed tools for *creating* Python tools, as opposed to the ones created.
   *
   * These are split out because the dispatcher must never hide them. It is a prompt-size
   * control, and its entire justification is that a handful of MCP servers can contribute
   * forty tools each whose schemas sit at the front of every request. There are three of
   * these, they never grow, and withholding them costs far more than it saves.
   *
   * Reported from real use: "it doesn't seem to always remember it has a tool to create python
   * tools — many times it is trying to create a python file in root folder". That is precisely
   * what hiding them produces. `create_python_tool` was unadvertised while `write_to_file` was
   * listed, so "make me a tool" got answered with the tool the model could actually see — and
   * the result is a script that is not registered, not hash-pinned and not callable.
   */
  managementTools(): Tool<never>[] {
    const context = this.toolContext()
    if (context === undefined) return []
    const worker = this.worker
    return [
      createCreatePythonTool(context),
      createUpdatePythonTool(context),
      createDeletePythonTool(context),
      /*
       * Offered only when a worker exists to run the check.
       *
       * Its whole value over `create_python_tool` is that it *runs* the tool before saving it, so
       * advertising it without something to run against would be advertising a promise it cannot
       * keep — and the wrong shape would go back to being discovered by a sync days later.
       */
      ...(worker === undefined
        ? []
        : [
            createCollectorTool({
              ...context,
              checkCollector: (name, filePath) => checkCollector(worker, name, filePath),
            }),
          ]),
    ] as unknown as Tool<never>[]
  }

  /** The user's own tools. These grow without bound, so these are what the dispatcher hides. */
  generatedTools(): Tool<never>[] {
    const worker = this.worker
    if (this.toolContext() === undefined || worker === undefined) return []
    return this.registered.map((tool) =>
      adaptPythonTool(tool, { worker, timeoutMs: this.timeoutMs }),
    ) as unknown as Tool<never>[]
  }

  /** What every tool wrapper needs, or undefined when Python is not usable at all. */
  private toolContext(): PythonToolContext | undefined {
    if (!this.enabled || !this.ready || this.worker === undefined) return undefined
    const worker = this.worker
    const uv = this.uv
    const generated = this.options.generateSource?.()
    return {
      toolsDir: this.toolsDir,
      ...(generated !== undefined ? { generateSource: generated } : {}),
      worker,
      onChanged: () => this.refresh(),
      // So `delete_python_tool` can tell a tool of its own from one mirrored out of a shared
      // folder, which it may not remove.
      findTool: (name: string) => this.findTool(name),
      ...(this.options.onToolSaved !== undefined
        ? { onSaved: this.options.onToolSaved }
        : {}),
      /*
       * No installing against an interpreter we do not own.
       *
       * Absent rather than failing, so the refusal happens before a file is written and names the
       * package. The reason travels with it because the advice differs: install uv, versus
       * install the package into the environment you already have.
       */
      ...(this.venvSource === 'interpreter'
        ? {
            installUnavailableReason:
              `Light Code is using the Python interpreter at ${this.interpreter} directly, with no ` +
              'virtualenv, so it does not install or remove packages there — that environment ' +
              'belongs to whatever started it.',
          }
        : {}),
      ...(uv !== undefined
        ? {
            installDeps: async (packages: readonly string[]) =>
              installDependencies({
                uv,
                pythonPath: this.interpreter,
                packages,
                ...(this.indexUrl !== undefined ? { indexUrl: this.indexUrl } : {}),
                extraIndexUrls: this.extraIndexUrls,
                offline: this.offline,
                env: await this.childEnv(),
              }),
          }
        : {}),
    }
  }

  /**
   * Starts against an interpreter we did not create and do not own.
   *
   * Deliberately parallel to the uv path rather than folded into it: the two differ on the one
   * decision that matters — whether installing a package is allowed — and a single path with a
   * flag threaded through it is how that decision ends up being made in the wrong place.
   */
  private async startWithoutUv(
    config: { interpreterPath?: string | undefined },
    workspaceRoot: string,
  ): Promise<void> {
    const bare = await detectBareInterpreter(config.interpreterPath)
    if (bare === undefined) {
      this.ready = false
      this.detail =
        config.interpreterPath !== undefined && config.interpreterPath.trim().length > 0
          ? `The configured interpreter could not be run: ${config.interpreterPath}. ` +
            'Give the full path to a Python 3 executable, or clear the field to search the PATH.'
          : 'No Python was found. Either install uv (Settings \u2192 Python) so Light Code can ' +
            'manage an environment for you, or make a Python 3 interpreter available on PATH \u2014 ' +
            'if one is already installed, give its full path in Settings \u2192 Python.'
      return
    }

    try {
      const env = await this.childEnv()
      this.interpreter = bare.path
      this.venvPath = ''
      this.venvSource = 'interpreter'
      this.venvIsUvManaged = false

      const workerScript = await this.writeWorkerScript()
      this.worker ??= new PythonWorker({
        pythonPath: bare.path,
        workerScript,
        cwd: workspaceRoot,
        env,
        logger: this.options.logger,
        timeoutMs: this.timeoutMs,
        /*
         * Passed through rather than resolved here.
         *
         * The manager has no registry and no approval gate; the host has both. Threading the
         * function means the rules are decided once, where the information is, instead of this
         * file growing an opinion about which tools a tool may call.
         */
        ...(this.options.callTool !== undefined ? { callTool: this.options.callTool } : {}),
      })
      await this.refresh()
      this.ready = true
      /*
       * States the limitation up front rather than leaving it to be discovered by a tool that
       * fails to import something. "Where did my dependency go?" is the question §13's venv
       * reporting exists to answer, and the answer here is that it was never installed.
       */
      this.detail =
        `Ready \u2014 using Python ${bare.version} at ${bare.path}, with no virtualenv. ` +
        'Tools run against whatever that interpreter can already import; declared dependencies ' +
        'are NOT installed. Install uv if you want Light Code to manage an environment.'
    } catch (error) {
      this.ready = false
      this.detail = error instanceof Error ? error.message : String(error)
      this.options.logger.warn('python environment failed to start', this.detail)
    }
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
      ...(this.missingEnv.length > 0 ? { missingEnv: [...this.missingEnv] } : {}),
      ...(this.extraToolDirs.length > 0 ? { extraToolDirs: [...this.extraToolDirs] } : {}),
      tools: this.registered.map((tool) => ({
        name: tool.name,
        description: tool.description,
        filePath: tool.filePath,
        sourceDir: tool.sourceDir,
      })),
      issues: this.issues.map((issue) => ({
        detail: describeIssue(issue),
        name: issue.name,
        filePath: issue.filePath,
        // `invalid` means the file does not load at all — approving it would pin a broken
        // tool. Only a pin problem can be fixed by re-pinning.
        recoverable: issue.kind === 'hash-mismatch' || issue.kind === 'unapproved',
        /*
         * Carried as well as `recoverable`, because the two recoverable kinds need different
         * words. "New, never approved here" and "changed since you approved it" are not the same
         * news, and a card saying only "needs approval" would flatten the second into the first -
         * which is the one worth reading carefully.
         */
        kind: issue.kind,
      })),
    }
  }

  /**
   * The environment every Python child gets — the worker, `uv venv`, and a dependency install.
   *
   * **One owner, deliberately.** The expression was written out at three spawn sites, which is
   * the shape of bug that has cost this project the most: a fourth site, or a change made at two
   * of the three, silently gives some Python a different environment from the rest. A test reads
   * this file and fails if `minimalPythonEnv` is called anywhere but here.
   *
   * The user's own variables are applied last and therefore win. That is the point of declaring
   * them, and it is also why the whole `python` block is user-scope only: the names that can be
   * set include `PATH`, so a repository able to write here could choose which interpreter ran.
   */
  private async childEnv(): Promise<NodeJS.ProcessEnv> {
    const resolved = await resolvePythonEnv(this.envEntries, this.options.secrets)
    this.missingEnv = resolved.missing
    return minimalPythonEnv({
      ...(this.options.sessionEnv?.() ?? {}),
      /*
       * The Jupyter kernel tools run in, when the session was given one.
       *
       * Here rather than at the spawn site for this function's own reason: the worker, `uv
       * venv` and a dependency install must all agree about which environment they are in, and
       * a variable set at one of three places is the drift this file exists to prevent.
       *
       * Before `resolved.env`, so a user who declares the same name in `python.env` wins. They
       * have said something more specific than the session default, and silently overriding a
       * declaration would be the setting not working.
       */
      ...(this.jupyterConnectionFile !== undefined
        ? { [JUPYTER_CONNECTION_ENV]: this.jupyterConnectionFile }
        : {}),
      ...resolved.env,
    })
  }

  async dispose(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    await worker?.dispose()
  }
}
