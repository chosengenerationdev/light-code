import { createHash, randomUUID } from 'node:crypto'
import { watch as watchPath, type FSWatcher } from 'node:fs'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { compareMentionCandidates } from '../context/mentionRanking.js'
import {
  coerceFormValue,
  type AskUserFormParams,
  type FormAnswer,
  type FormField,
  type FormValue,
} from '../tools/askUserForm.js'
import { confineToAny, normalizeForComparison } from '../fs/confine.js'
import { approveTool, forgetTool, isValidToolName, toolFileName } from '../python/registry.js'
import { isTranscriptMessage } from './backgroundMessages.js'
import {
  ConfigManager,
  type SecretStore,
  Conversation,
  DiskTruncationStore,
  FetchHttpClient,
  Logger,
  RecordingTruncationStore,
  McpRegistry,
  PathDenylist,
  PolicyApprovalGate,
  ShadowGit,
  ToolRegistry,
  addToAllowlist,
  assertCertDirOutsideWorkspace,
  attachMentions,
  buildSystemPrompt,
  formatToolArguments,
  CONTROL_TOOLS,
  createAuthStrategy,
  buildCodeGenerationPrompt,
  createChatProvider,
  mentionExcludes,
  PRICING_PROBE,
  pricingForPrompt,
  type ExpertPricing,
  type CodeGenerator,
  createAskExpertTool,
  createSearchOpensearchTool,
  createSearchCodebaseTool,
  createSearchDocsTool,
  SearchLog,
  createCallToolTool,
  createForgetDocsTool,
  PythonManager,
  createWriteSkillTool,
  createDeleteSkillTool,
  loadSkills,
  renderSkillsForPrompt,
  renderSkillsHintForPrompt,
  isValidSkillName,
  skillFileName,
  type Skill,
  Embedder,
  indexWorkspace,
  chunkSignatureFor,
  type IndexManifest,
  type IndexProgress,
  resolveConnectionTls,
  vectorStoreTls,
  OpenSearchClient,
  createVectorSearcher,
  createVectorIndexWriter,
  type VectorSearcher,
  createDefaultToolRegistry,
  detectClaudeCli,
  buildExpertBriefing,
  buildDocCorpus,
  createNotifyTool,
  parseNamespacedToolName,
  type ToolCatalogueEntry,
  syncVectorStores,
  ASSESSMENT_PROBES,
  buildAssessmentQuestion,
  consultExpert,
  type JuniorAssessment,
  type ProbeResult,
  checkExpertBudget,
  describeExpertBudget,
  type ExpertEstimate,
  expertBudgetUsage,
  type ExpertLimits,
  registryForSchedule,
  filterToolsForSchedule,
  skillsForSchedule,
  NEVER_AVAILABLE_TO_SCHEDULES,
  ScheduledApprovalGate,
  scheduledRunGuidance,
  nextFireTime,
  isDue,
  MAX_REMEMBERED_RUNS,
  type Schedule,
  createReadToolResultTool,
  deriveTitle,
  findMode,
  listModels,
  mcpServersSchema,
  venvPythonCandidates,
  VENV_DIR_NAMES,
  type McpServerConfig,
  namespacedToolName,
  parseConfig,
  redactTask,
  removeFromAllowlist,
  resolveActiveProfile,
  resolveMentions,
  resolveModelCapabilities,
  runAgentTurn,
  testConnection,
  toTranscript,
  validateProviderForm,
  type ApprovableGroup,
  type AuthStrategy,
  type AuthStrategyContext,
  type Auth,
  type Checkpoint,
  type ClaudeCliInfo,
  type OpenSearchConnection,
  type VectorStoreConfig,
  type HostToUiMessage,
  type ImageAttachmentInput,
  type LightCodeConfig,
  dispatcherEnabled,
  skillRetrievalEnabled,
  type NetworkSettingsInput,
  type McpServersConfig,
  type McpToolPermission,
  type ProfileInput,
  type ProfileSummary,
  type SearchConnectionInput,
  type SearchConnectionSummary,
  type ProviderProfile,
  type RunAgentTurnOptions,
  type Task,
  type ToolCallSummary,
  type ToolExecutionContext,
  type UiToHostMessage,
  type WorkspaceApprovals,
} from '../index.js'
import { WebviewApprovalGate } from './approvalGate.js'
import type { HostServices } from './services.js'
import { NodeFileSystem } from '../platform/node/filesystem.js'
import { NodeTerminal } from '../platform/node/terminal.js'
import { JsonTaskStore } from '../platform/node/taskStore.js'

/**
 * Secret keys are namespaced by profile so deleting a profile reliably deletes everything
 * it owns (§15) — orphans otherwise accumulate invisibly in the keychain.
 */
function apiKeyRefFor(profileId: string): string {
  return `profile:${profileId}:apiKey`
}
function clientSecretRefFor(profileId: string): string {
  return `profile:${profileId}:clientSecret`
}
function certPassphraseRefFor(profileId: string): string {
  return `profile:${profileId}:certPassphrase`
}
const SECRET_REFS_PER_PROFILE = [apiKeyRefFor, clientSecretRefFor, certPassphraseRefFor]

/** Cluster credentials, namespaced like a profile's so deleting one removes both (§15). */
function searchUserRefFor(id: string): string {
  return `search:${id}:username`
}
function searchPasswordRefFor(id: string): string {
  return `search:${id}:password`
}

/**
 * `hasApiKey` reflects whether the secret **actually exists in the store**, not merely
 * whether config claims an `apiKeyRef`. Those can diverge (a secret deleted or never
 * written leaves a dangling reference), and reporting the config's claim would show
 * "Set — leave blank to keep" for a key that isn't there — leaving the user no way to
 * fix it from the UI. Still never sends the value itself (invariant 7).
 */
async function toSummary(profile: ProviderProfile, secrets: SecretStore): Promise<ProfileSummary> {
  const summary: ProfileSummary = {
    id: profile.id,
    label: profile.label,
    wireFormat: profile.wireFormat,
    baseUrl: profile.baseUrl,
    model: profile.model,
    authType: profile.auth.type,
    hasApiKey: profile.auth.type === 'apiKey' && (await secrets.get(profile.auth.apiKeyRef)) !== undefined,
    hasClientSecret: false,
    hasCertPassphrase: false,
  }
  if (profile.modelCapabilities !== undefined) summary.modelCapabilities = profile.modelCapabilities
  // Not a secret: a path and a boolean. Only the passphrase is withheld (§15).
  if (profile.tls !== undefined) summary.connectionTls = profile.tls

  if (profile.auth.type === 'apigeeMtls') {
    // Every field below is non-secret: URLs, ids, header names, and cert *paths* (§15).
    // `clientSecretRef` and `passphraseRef` are deliberately reduced to booleans.
    const { clientSecretRef, ...apigee } = profile.auth.apigee
    const { passphraseRef, ...certs } = profile.auth.certs
    summary.apigee = apigee
    summary.certs = certs
    summary.hasClientSecret = clientSecretRef !== undefined && (await secrets.get(clientSecretRef)) !== undefined
    summary.hasCertPassphrase = passphraseRef !== undefined && (await secrets.get(passphraseRef)) !== undefined
  }
  return summary
}

/**
 * Drops empty strings so a cleared form field removes the key instead of persisting `""` —
 * an empty `tokenUrl` must fall back to the derived default, not override it with nothing.
 */
function stripEmpty<T extends object>(source: T): Partial<T> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim().length === 0) continue
    if (value === undefined) continue
    result[key] = typeof value === 'string' ? value.trim() : value
  }
  return result as Partial<T>
}

/**
 * Wires a chat UI to the agent loop and the settings screens.
 *
 * Host-agnostic: everything platform-specific arrives through `HostServices`. The VS Code
 * extension and the Node server both call this, which is the whole point — a fix to the
 * approval gate or the MCP tab reaches both without being written twice.
 */
/** How often the schedule timer looks. A quarter of the shortest interval a schedule can use. */
const SCHEDULE_TICK_MS = 15_000

/**
 * How long a single scheduled run may hold the scheduler before it is presumed wedged.
 *
 * Generous on purpose — a real run doing real work can take many minutes, and cutting one
 * short is worse than being late. This exists only to stop one stuck run from disabling every
 * schedule permanently.
 */
const STUCK_RUN_MS = 30 * 60_000

/**
 * A live bridge. Outlives any one view, so a host can rebuild its UI without rebuilding this.
 */
export interface ChatBridge {
  /** Re-pushes state a freshly created view could not have received. */
  resync: () => void
  /**
   * Whether the schedule timer is still ticking, for an outside watchdog.
   *
   * The timer has now stopped twice for reasons that left no trace, so the host polls this
   * and restarts it rather than trusting it to stay up. A scheduler that silently dies is
   * indistinguishable from one with nothing to do, which is why both failures took so long
   * to see.
   */
  schedulerHealth: () => { running: boolean; lastTickAt?: number; runningScheduleId?: string }
  /** Restarts the timer. Safe at any time; idempotent while it is healthy. */
  restartScheduler: () => void
  dispose: () => void
}

export function wireChatBridge(services: HostServices): ChatBridge {
  const { transport, secrets, ui, workspaceRoot, storageDir, ripgrepPath } = services
  const logger = new Logger({ level: 'debug', sink: services.logSink })
  const configManager = new ConfigManager(services.configStore)
  const httpClient = new FetchHttpClient()
  const conversation = new Conversation(workspaceRoot !== undefined ? buildSystemPrompt(workspaceRoot) : undefined)

  // Wrapped so the current task knows which spilled results it owns — deleting a task has
  // to delete its spilled output, and only this layer sees the handles.
  // Refreshed whenever config is loaded (once per turn). Read synchronously by the spill
  // path, which cannot await a keychain lookup in the middle of writing a tool result.
  let cachedSecretValues: readonly string[] = []
  const truncationStore = new RecordingTruncationStore(
    new DiskTruncationStore(path.join(storageDir, 'tool-results'), () => cachedSecretValues),
  )
  // Constructed here rather than injected: it needs the truncation store built just above,
  // and the JSON-file layout is host-agnostic. Storage *location* is the host's decision;
  // storage *format* is not.
  const taskStore = new JsonTaskStore(storageDir, truncationStore, logger)
  /*
   * Owns uv, the venv and the worker. Constructed unconditionally but inert until config
   * turns it on — §13 requires the feature not to exist until someone enables it, and an
   * inert object is easier to reason about than a conditionally-undefined one.
   */
  const python = new PythonManager({
    workspaceRoot,
    storageDir,
    logger,
    // Read at worker spawn, so a changed variable applies to the next worker rather than being
    // frozen at construction. Added to the allowlist in minimalPythonEnv, never a way past it.
    ...(services.sessionEnv !== undefined ? { sessionEnv: services.sessionEnv } : {}),
    ...(services.submitForReview !== undefined
      ? {
          submitForReview: (request: { name: string; content: string; existingContent: string; producedBy?: string }) =>
            services.submitForReview?.({ kind: 'python-tool', ...request }) ?? Promise.resolve(''),
        }
      : {}),
    /*
     * A resolver, not a generator: the tool's *parameters* change shape depending on whether one
     * is configured — specification versus source — so the answer is needed when the tool list is
     * built, not when it is called. Refreshed by `loadSettings`, which runs before every turn, so
     * changing the profile mid-session takes effect on the next message.
     */
    generateSource: () => cachedCodeGenerator,
    // A tool created, updated or deleted during a chat changes both the Python tab and the
    // documentation corpus. `postPython` refreshes the tab and schedules the reindex.
    onToolsChanged: () => {
      void postPython()
      // Same reasoning as MCP: a Python tool created after the panel opened must appear in
      // the schedule picker without the user reloading the window.
      void postSchedules()
      void postTools()
    },
  })

  /**
   * Skills, reloaded per turn.
   *
   * In the workspace beside the tools, for the same reason: a skill is prose the model
   * injects into its own future context, and plain markdown in git is the main thing
   * standing between that and an unreviewed instruction (§13).
   */
  const defaultSkillsDir = workspaceRoot !== undefined ? path.join(workspaceRoot, '.lightcode', 'skills') : undefined

  /**
   * Where skills are written, and the ordered list of folders they are read from.
   *
   * Both derive from config, so they are refreshed with everything else once per turn rather
   * than fixed when the bridge is constructed — a folder added in Settings has to take effect
   * without reloading the window.
   */
  let skillsDir = defaultSkillsDir
  let extraSkillDirs: string[] = []

  /** Relative entries resolve against the workspace; absolute ones are taken as given. */
  function resolveSkillDir(entry: string): string | undefined {
    const trimmed = entry.trim()
    if (trimmed.length === 0) return undefined
    if (path.isAbsolute(trimmed)) return path.resolve(trimmed)
    return workspaceRoot === undefined ? undefined : path.resolve(workspaceRoot, trimmed)
  }

  /** The write folder first — it wins name collisions — then the read-only ones in order. */
  function skillSearchPath(): string[] {
    return [skillsDir, ...extraSkillDirs].filter((dir): dir is string => dir !== undefined)
  }

  let skills: Skill[] = []
  let skillIssues: { filePath: string; detail: string }[] = []
  const refreshSkills = async (): Promise<void> => {
    const dirs = skillSearchPath()
    if (dirs.length === 0) return
    const loaded = await loadSkills(dirs)
    skills = loaded.skills
    skillIssues = loaded.issues
    for (const issue of loaded.issues) logger.warn(`skill ${issue.filePath}: ${issue.detail}`)
  }

  /*
   * Watches the skill folders, so a file dropped in appears without reopening anything.
   *
   * A skill is a markdown file people create in an editor, in a folder they can see — and the
   * panel only refreshed when it was asked to, so adding one and looking at the tab showed
   * nothing. There was no error to notice, which made it read as the skill being rejected.
   *
   * Watches the *directory*, not the files: a new file is the event that matters, and editors
   * save by replacing rather than writing in place, so a per-file watch would miss both.
   */
  let skillWatchers: FSWatcher[] = []
  let skillWatchTimer: ReturnType<typeof setTimeout> | undefined

  function stopWatchingSkills(): void {
    for (const watcher of skillWatchers) watcher.close()
    skillWatchers = []
    if (skillWatchTimer !== undefined) clearTimeout(skillWatchTimer)
    skillWatchTimer = undefined
  }

  function watchSkillFolders(): void {
    stopWatchingSkills()
    for (const dir of skillSearchPath()) {
      try {
        skillWatchers.push(
          // Recursive, because a skill may be a folder with SKILL.md inside — a non-recursive
          // watch sees the folder appear and then never hears about the file written into it.
          watchPath(dir, { recursive: true }, () => {
            /*
             * Debounced. One save produces several events on every platform, and each one would
             * otherwise reload the skills and schedule a documentation reindex.
             */
            if (skillWatchTimer !== undefined) clearTimeout(skillWatchTimer)
            skillWatchTimer = setTimeout(() => {
              void postSkills()
            }, 300)
          }),
        )
      } catch {
        // The folder may not exist yet — a first skill creates it, and `postSkills` re-arms the
        // watch afterwards. Failing to watch must never stop skills being read.
      }
    }
  }

  async function postSkills(): Promise<void> {
    // The folder list lives in config and is refreshed here, not only per turn — otherwise
    // adding a folder in Settings would show no change until the next message.
    await loadSettings()
    await refreshSkills()
    post({
      type: 'skills',
      skills: skills.map((skill) => ({ ...skill })),
      issues: skillIssues,
      ...(skillsDir !== undefined ? { skillsDir } : {}),
      extraDirs: extraSkillDirs,
    })
    // Skills are part of the corpus, so a written, deleted or relocated one makes the index
    // stale. Debounced and fingerprinted, so the usual case costs nothing.
    scheduleDocsReindex('skills changed')
    // Re-armed here rather than once at startup: the folder list can change, and the folder
    // itself may not have existed the first time this ran.
    watchSkillFolders()
  }

  /**
   * Opens a skill or Python tool in an editor tab.
   *
   * Confined to the folders those things live in. The path arrives from the UI, which only ever
   * sends one it was given — but "the UI would not do that" is not a boundary, and this opens a
   * file in the user's editor.
   */
  async function handleOpenManagedFile(filePath: string): Promise<void> {
    try {
      if (ui.openFile === undefined) {
        ui.showWarning('This host cannot open files. The path is shown beside each entry.')
        return
      }
      const roots = [
        python.toolsDirectory(),
        ...(skillsDir === undefined ? [] : [skillsDir]),
        ...extraSkillDirs.filter((dir): dir is string => dir !== undefined),
      ]
      if (roots.length === 0) return
      const real = await confineToAny(path.resolve(filePath), roots)
      await ui.openFile(real)
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDeletePythonTool(name: string): Promise<void> {
    try {
      const dir = python.toolsDirectory()
      if (dir.length === 0) return
      if (!isValidToolName(name)) throw new Error(`"${name}" is not a valid tool name.`)
      await fs.rm(path.join(dir, toolFileName(name)), { force: true })
      // The registry entry goes too. Leaving it would re-approve the next file to appear under
      // that name without anyone looking at it.
      await forgetTool(dir, name)
      await python.refresh()
      await postPython()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Re-pins a tool to the file as it stands now.
   *
   * The hash pin refuses a tool whose source changed since approval (§13), which is exactly
   * right when a repository ships a modified `.py` and exactly infuriating when the user edited
   * it themselves. This is the "yes, that was me" path, and it deliberately runs the file
   * through the same validation a model-authored one gets — a tool that does not load must not
   * be pinned, or the pin would start certifying broken code.
   */
  async function handleApprovePythonTool(name: string): Promise<void> {
    try {
      const dir = python.toolsDirectory()
      if (dir.length === 0) return
      if (!isValidToolName(name)) throw new Error(`"${name}" is not a valid tool name.`)

      const filePath = path.join(dir, toolFileName(name))
      const source = await fs.readFile(filePath, 'utf8')
      const described = await python.describe(name, filePath)
      if (described === undefined) {
        throw new Error(`"${name}" could not be loaded, so it was not approved. Fix the file and try again.`)
      }

      await approveTool(dir, name, source, described)
      await python.refresh()
      await postPython()
      ui.showInfo(`py__${name} approved as it stands now.`)
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDeleteSkillFile(name: string): Promise<void> {
    try {
      if (skillsDir === undefined) return
      // Same name rule the tool uses, so a hand-typed name cannot escape the directory.
      if (!isValidSkillName(name)) throw new Error(`"${name}" is not a valid skill name.`)

      /*
       * Only the write folder can be deleted from. The extras are shared or reference
       * material, and one person's assistant must not be able to remove a file everyone
       * else depends on.
       *
       * Said explicitly rather than left to `force: true`, which would report success while
       * deleting nothing — the skill would still be listed afterwards and the user would have
       * no idea why.
       */
      const existing = skills.find((skill) => skill.name === name)
      if (existing !== undefined && existing.sourceDir !== undefined && existing.sourceDir !== skillsDir) {
        throw new Error(
          `"${name}" lives in ${existing.sourceDir}, which is a read-only skills folder. Delete the file there, or remove the folder in Settings.`,
        )
      }

      await fs.rm(path.join(skillsDir, skillFileName(name)), { force: true })
      await postSkills()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const builtinTools = createDefaultToolRegistry()
  builtinTools.register(createReadToolResultTool(truncationStore))

  // Files read via read_file this session; write_to_file/apply_diff check this before
  // touching an existing file. Session-scoped, so it lives alongside the conversation.
  const readFiles = new Set<string>()
  const denylist = new PathDenylist()
  /** Certificates are re-read every request; without this the same warning would repeat. */
  const warnedExpiries = new Set<string>()

  /**
   * The Claude CLI expert, detected once per configured path. Spawning `claude --version`
   * on every turn would be wasteful, and the answer only changes when the user installs it
   * or edits the path.
   */
  let expertCli: ClaudeCliInfo | undefined
  let expertCliPath: string | undefined

  async function resolveExpert(config: LightCodeConfig): Promise<ClaudeCliInfo | undefined> {
    // Nothing is spawned unless the user turned it on (§13's opt-in posture).
    if (config.expert?.enabled !== true) return undefined
    const configured = config.expert.path ?? 'claude'
    if (expertCli === undefined || expertCliPath !== configured) {
      expertCliPath = configured
      expertCli = await detectClaudeCli(configured)
      if (!expertCli.available) logger.warn('expert unavailable', expertCli.reason ?? '')
    }
    return expertCli.available ? expertCli : undefined
  }

  /**
   * Messages typed while a turn is running. Held host-side rather than in the webview
   * because the loop consumes them mid-turn, and the webview can be destroyed and rebuilt
   * at any moment (it is whenever the view is hidden).
   */
  let queuedMessages: string[] = []

  function postQueued(): void {
    post({ type: 'queued', messages: [...queuedMessages] })
  }

  let activeAbortController: AbortController | undefined
  /** The task's rollback point — the snapshot taken before its first edit. */
  let taskCheckpoint: Checkpoint | undefined

  /**
   * The task being worked on. Created lazily on the first user message, so merely opening
   * the panel never leaves an empty task in the history list.
   *
   * Remembered in `workspaceState` rather than in memory, so reloading the window or
   * restarting VS Code reopens the conversation that was in progress rather than the most
   * recent one — those differ the moment the user reopens an older task.
   */
  const ACTIVE_TASK_KEY = 'lightCode.activeTaskId'
  let activeTaskId: string | undefined = services.workspaceState.get(ACTIVE_TASK_KEY)
  let activeTaskCreatedAt = Date.now()

  async function setActiveTaskId(id: string | undefined): Promise<void> {
    activeTaskId = id
    await services.workspaceState.set(ACTIVE_TASK_KEY, id)
  }

  function post(message: HostToUiMessage): void {
    // Only conversation traffic is withheld — see `backgroundMessages.ts` for why this is a
    // deny list rather than the allow list it started as.
    if (backgroundRun && isTranscriptMessage(message.type)) return
    transport.post(message)
  }

  /** True while a scheduled run is using the conversation, so the UI is not written to. */
  let backgroundRun = false

  /**
   * True while the *user's* turn is in flight.
   *
   * Distinct from `activeAbortController`, which a scheduled turn also sets. A schedule must
   * not start on top of someone who is mid-conversation, and this is the only thing that can
   * tell the two apart.
   */
  let userTurnRunning = false

  /** Set while a scheduled run is in flight, so a user message can wait for it rather than interleave. */
  let scheduledRunInFlight: Promise<void> | undefined

  /**
   * Approvals are keyed by workspace path but stored user-side (invariant 5) — a repo
   * must not be able to grant itself permissions via `.lightcode/config.json`.
   */
  /*
   * Scanned wide, shown narrow. The fetch limit is high enough that ranking has something to
   * choose from in a large repository, and bounded because this runs on every keystroke.
   */
  const MENTION_SCAN_LIMIT = 2000
  const MENTION_RESULT_LIMIT = 30

  /**
   * What the *currently running* schedule may call, or undefined in a chat.
   *
   * The tool registry — and the one `search_docs` inside it — is built before the run knows it
   * is a scheduled one, so this is read per call rather than captured. Set as a scheduled run
   * starts and cleared in its `finally`, alongside the conversation and task state the run
   * already snapshots and restores.
   */
  let scheduleToolAccess: ((toolName: string) => boolean) | undefined

  const approvalsKey = workspaceRoot ?? '__no_workspace__'

  /**
   * Finds this workspace's approvals however its path happens to be spelled.
   *
   * Approvals are stored under the workspace path, and on Windows the same folder legitimately
   * arrives as `d:\project` or `D:\project` depending on how the window was opened — with or
   * without a trailing separator, too. A JSON object key is an exact string, so the same
   * workspace could look like a different one between sessions and every "always allow" the
   * user had granted would silently stop applying. §16 is explicit that path comparison on
   * Windows must be case-insensitive; this is that rule reaching the one place that stored a
   * path as a key rather than comparing it.
   *
   * Reading tolerantly rather than rewriting the file: a rename on load would be a write on
   * every start, and two windows open on the same workspace would race to do it.
   */
  function comparableApprovalsKey(key: string): string {
    // `path.resolve` also drops a trailing separator, which is the other way one workspace
    // ends up with two spellings. The placeholder is left alone: resolving it would make the
    // key depend on the process's working directory, which is not stable between sessions.
    return key === '__no_workspace__' ? key : normalizeForComparison(path.resolve(key))
  }

  function approvalsFrom(stored: Record<string, WorkspaceApprovals> | undefined): WorkspaceApprovals {
    if (stored === undefined) return {}
    const exact = stored[approvalsKey]
    if (exact !== undefined) return exact
    const wanted = comparableApprovalsKey(approvalsKey)
    for (const [key, value] of Object.entries(stored)) {
      if (comparableApprovalsKey(key) === wanted) return value
    }
    return {}
  }
  // Cached so the policy gate can answer synchronously mid-turn without re-reading config.
  let cachedApprovals: WorkspaceApprovals = {}
  /** Mirrors config so the loop and the settings message agree without re-reading. */
  let cachedMaxIterations = 25
  // Mirrors packages/ui's DEFAULT_ACCENT. Duplicated rather than imported because core
  // must not depend on the UI package; the UI is authoritative and this is only the value
  // sent before the user has chosen one.
  let cachedAccentColor = '#22C55E'
  let cachedExpertColor = '#D97757'
  let cachedExpertLimits: ExpertLimits = {}
  /** The stored assessment, so the briefing can carry it without a config read per turn. */
  let cachedAssessment: JuniorAssessment | undefined
  /**
   * A ceiling for this chat only, overriding the configured default.
   *
   * Cleared with the task, like the spend it governs. One hard task deserving a bigger budget
   * is a real need; a raised ceiling that silently outlives it is a limit nobody set.
   */
  let taskExpertLimits: ExpertLimits | undefined
  /** The expert's estimate for this task, cleared with it. */
  let taskExpertEstimate: ExpertEstimate | undefined
  /** Non-empty while the junior is being assessed, for the progress line in the tab. */
  let assessmentStep: string | undefined

  function effectiveExpertLimits(): ExpertLimits {
    return taskExpertLimits ?? cachedExpertLimits
  }
  /**
   * Directories tools may read outside the workspace — a network share of logs, typically.
   *
   * Refreshed per turn with everything else, so adding one in Settings takes effect on the
   * next message rather than needing a reload.
   */
  let cachedReadRoots: string[] = []

  /**
   * Paths approved for this session only.
   *
   * "Allow once" means once per session, not once per call. A model reading the same log twice
   * would otherwise prompt twice, and a user clicking through repeats stops reading them —
   * which is how an approval prompt becomes a rubber stamp.
   */
  const sessionPathGrants = new Set<string>()

  /**
   * Asks whether a path outside every allowed root may be read.
   *
   * Goes through the same gate as a tool approval, so the prompt, the denial path and "always
   * allow" all behave as they do everywhere else. The preview shows the **resolved** path,
   * which is the ground truth invariant 8 asks for — the model's argument may be relative, or
   * a symlink pointing somewhere else entirely.
   */
  async function requestPathAccess(realPath: string): Promise<boolean> {
    const key = normalizeForComparison(realPath)
    if (sessionPathGrants.has(key)) return true

    const id = `path-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
    pendingPathApprovals.set(id, realPath)
    try {
      const decision = await userGate.requestApproval({
        id,
        // Named as what it is rather than as a tool: the user is granting access to a place,
        // and calling it `read_file` would make "always allow" read as something much wider.
        toolName: 'read a file outside the workspace',
        group: 'read',
        alwaysScope: 'folder',
        preview: {
          kind: 'text',
          text: [
            'The assistant wants to read a file outside this workspace:',
            '',
            realPath,
            '',
            'Allow reads only — it cannot write here whatever you choose.',
          ].join('\n'),
        },
      })
      if (decision !== 'approve') return false
      sessionPathGrants.add(key)
      return true
    } finally {
      pendingPathApprovals.delete(id)
    }
  }

  /** Which approval ids are path requests, so "always allow" knows to remember a folder. */
  const pendingPathApprovals = new Map<string, string>()

  /**
   * Forms the assistant is waiting on, by request id.
   *
   * Parked exactly as an approval is, and for the same reason: the turn genuinely cannot
   * continue until a person answers. Every path out of a turn settles these — a dismissal, a
   * cancelled turn, a disposed bridge — because a promise nobody will ever resolve is a turn
   * that hangs with no error and nothing to click.
   */
  const pendingForms = new Map<string, (answer: FormAnswer) => void>()
  /** The fields each pending form asked for, so the reply is coerced against them. */
  const pendingFormFields = new Map<string, readonly FormField[]>()

  function settleAllForms(): void {
    for (const resolve of pendingForms.values()) resolve({ submitted: false, values: {} })
    pendingForms.clear()
    pendingFormFields.clear()
  }

  async function requestForm(request: AskUserFormParams): Promise<FormAnswer> {
    const id = `form-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
    const answer = new Promise<FormAnswer>((resolve) => {
      pendingForms.set(id, resolve)
    })
    pendingFormFields.set(id, request.fields)
    post({
      type: 'formRequest',
      id,
      title: request.title,
      ...(request.description !== undefined ? { description: request.description } : {}),
      fields: request.fields,
    })
    try {
      return await answer
    } finally {
      pendingForms.delete(id)
      pendingFormFields.delete(id)
    }
  }

  /**
   * Turns a submitted form into typed values, refusing anything that does not fit its field.
   *
   * The form validates too, and that is for the user — but what reaches the model has to be
   * right regardless of what arrived over the bridge. An unanswered required field or a number
   * box holding letters comes back as a dismissal with the reason, not as a plausible value.
   */
  function answerFromResponse(
    fields: readonly FormField[],
    values: Record<string, string | boolean>,
  ): FormAnswer {
    const coerced: Record<string, FormValue> = {}
    for (const field of fields) {
      const result = coerceFormValue(field, values[field.name])
      if ('error' in result) {
        logger.warn(`form field rejected: ${result.error}`)
        return { submitted: false, values: {} }
      }
      coerced[field.name] = result.value
    }
    return { submitted: true, values: coerced }
  }

  /**
   * What the expert has cost since this task was opened.
   *
   * Scoped to the task rather than persisted, and the UI says so. Reconstructing a resumed
   * task's historical spend would mean parsing dollar figures back out of stored result text
   * — brittle, and wrong the moment that wording changes. A number that is *definitely* "this
   * session, this task" beats one that is quietly incomplete.
   *
   * `consultations` counts every attempt including failures; `usd` totals only the ones the
   * CLI priced, so `unpriced` records the gap rather than letting the total imply it is
   * complete when it is not.
   */
  /**
   * Every search the model ran this session.
   *
   * In memory and bounded. Retrieval is the one part of the product whose failures are quiet
   * — a search that returns confident neighbours for a query it misunderstood looks exactly
   * like one that worked — so the queries have to be visible somewhere to be judged at all.
   */
  const searchLog = new SearchLog(50, () => post({ type: 'searchLog', entries: [...searchLog.list()] }))

  let expertSpend = { usd: 0, consultations: 0, unpriced: 0, keepAlives: 0 }

  /**
   * The expert's conversation for the current task.
   *
   * Scoped to the task, not the workspace: consultations about one piece of work should build
   * on each other, and consultations about an unrelated task should not drag that history
   * along -- it would be paid for on every future call and would confuse the answer.
   */
  let expertSessionId: string | undefined

  function resetExpertSpend(): void {
    expertSpend = { usd: 0, consultations: 0, unpriced: 0, keepAlives: 0 }
    expertSessionId = undefined
    /*
     * A new task means a new session, so there is nothing left to keep warm. Without this the
     * timer would go on refreshing a session id that has just been discarded — spending on a
     * cache nothing will ever read.
     */
    stopKeepAlive()
    taskExpertLimits = undefined
    taskExpertEstimate = undefined
    postExpertSpend()
  }

  function postExpertSpend(): void {
    const limits = effectiveExpertLimits()
    const usage = expertBudgetUsage(expertSpend, limits)
    post({
      type: 'expertSpend',
      ...expertSpend,
      ...(usage === undefined ? {} : { usage }),
      ...(checkExpertBudget(expertSpend, limits).allowed ? {} : { exhausted: true }),
      maxSpendUsd: limits.maxSpendUsd ?? 0,
      maxConsultations: limits.maxConsultations ?? 0,
      overridden: taskExpertLimits !== undefined,
      ...(taskExpertEstimate === undefined ? {} : { estimate: taskExpertEstimate }),
    })
  }

  function recordConsultation(info: { costUsd?: number; isError: boolean }): void {
    expertSpend.consultations += 1
    if (info.costUsd !== undefined) expertSpend.usd += info.costUsd
    else expertSpend.unpriced += 1
    postExpertSpend()

    /*
     * What this plan does about pricing, learned from the answer rather than asked for.
     *
     * A failed consultation says nothing: it can return without a cost because it never got far
     * enough to have one, which is not the same as a plan that never prices anything.
     *
     * Written once. Re-writing config on every consultation would churn the file and its watcher
     * for a fact that does not change.
     */
    if (info.isError) return
    const learned = info.costUsd !== undefined
    if (cachedReportsCost === learned) return
    cachedReportsCost = learned
    void configManager
      .load()
      .then(async ({ config }) => {
        await configManager.save('user', { ...config, expert: { ...config.expert, reportsCost: learned } })
        await postExpert()
      })
      .catch(() => {
        // Not worth surfacing: the meter is already accurate for this session, and the only cost
        // of failing to persist is learning it again next time.
      })
  }
  let cachedModeId: string | undefined

  /** Rebuilt on every settings load, so a profile change reaches the next turn. */
  let cachedCodeGenerator: CodeGenerator | undefined
  /** Undefined means the defaults; an empty array means the user cleared the list. */
  let cachedMentionExcludes: string[] | undefined
  /** Undefined until a consultation has told us. See `recordConsultation`. */
  let cachedReportsCost: boolean | undefined
  /** Set while a measurement is running, so the panel can say what it is doing. */
  let measuringStep: string | undefined
  let cachedPricing: ExpertPricing | undefined
  let cachedKeepAlive = false
  let cachedProgrammingProfileId: string | undefined

  async function loadSettings(): Promise<LightCodeConfig> {
    const { config } = await configManager.load()
    cachedApprovals = approvalsFrom(config.approvals)
    cachedCodeGenerator = codeGeneratorFor(config)
    cachedProgrammingProfileId = config.programmingProfileId
    cachedModeId = config.modeId
    cachedMaxIterations = config.maxIterations ?? 25
    cachedAccentColor = config.ui?.accentColor ?? '#22C55E'
    cachedExpertColor = config.ui?.expertColor ?? '#D97757'
    cachedAssessment = config.expert?.assessment
    cachedReportsCost = config.expert?.reportsCost
    cachedPricing = config.expert?.pricing
    cachedKeepAlive = config.expert?.keepAlive === true
    // Switched off mid-task, the timer goes with it rather than waiting for its next tick.
    if (!cachedKeepAlive) stopKeepAlive()
    cachedExpertLimits = {
      ...(config.expert?.maxSpendUsd !== undefined ? { maxSpendUsd: config.expert.maxSpendUsd } : {}),
      ...(config.expert?.maxConsultations !== undefined ? { maxConsultations: config.expert.maxConsultations } : {}),
    }
    cachedMentionExcludes = config.filesystem?.excludeFromMentions
    cachedReadRoots = (config.filesystem?.readRoots ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    skillsDir = (config.skills?.dir !== undefined ? resolveSkillDir(config.skills.dir) : undefined) ?? defaultSkillsDir
    extraSkillDirs = (config.skills?.paths ?? [])
      .map(resolveSkillDir)
      .filter((dir): dir is string => dir !== undefined)
    return config
  }

  /**
   * Says so when a damaged config file was repaired from its backup.
   *
   * Recovery is deliberately not silent. Something wrote a file that could not be read, and a
   * user who is never told will not know a setting they changed just before it happened may
   * have gone with it — nor that the broken copy is still on disk if they want it.
   */
  function announceConfigRecovery(): void {
    const recovery = configManager.takeRecovery()
    if (recovery === undefined) return
    const where = recovery.quarantinedTo === undefined ? '' : ` The damaged file was kept as ${recovery.quarantinedTo}.`
    const message = `Your ${recovery.scope} settings file could not be read and was restored from the last good copy.${where} Anything changed immediately before this may need setting again.`
    logger.warn(message)
    post({ type: 'error', message })
  }

  async function saveApprovals(next: WorkspaceApprovals): Promise<void> {
    const { config } = await configManager.load()
    await configManager.save('user', { approvals: { ...config.approvals, [approvalsKey]: next } })
    cachedApprovals = next
    post({
      type: 'settings',
      modeId: findMode(cachedModeId).id,
      approvals: next,
      maxIterations: cachedMaxIterations,
      accentColor: cachedAccentColor,
      expertColor: cachedExpertColor,
      readRoots: cachedReadRoots,
      ...(cachedProgrammingProfileId !== undefined ? { programmingProfileId: cachedProgrammingProfileId } : {}),
      ...hostCapabilities(),
    })
  }

  /*
   * What the UI needs to know about the *host*, not the config.
   *
   * Derived from the services it was given rather than declared separately: a host that
   * implements `openWalkthrough` has native onboarding by definition, and one that does not is
   * telling the UI to render its own. Two ways of saying the same thing would eventually
   * disagree, and the failure is a button that does nothing.
   */
  function hostCapabilities(): { nativeGuide: boolean; guideMediaBase?: string; allowProgrammingProfile: boolean } {
    return {
      nativeGuide: ui.openWalkthrough !== undefined,
      allowProgrammingProfile: services.allowProgrammingProfile === true,
      ...(services.guideMediaBase !== undefined ? { guideMediaBase: services.guideMediaBase } : {}),
    }
  }

  const userGate = new WebviewApprovalGate(post)
  // Policy answers what it can from settings; anything else falls through to the user.
  const approvalGate = new PolicyApprovalGate(userGate, () => cachedApprovals)

  let mcpJson = '{\n  "mcpServers": {}\n}'
  /**
   * Mirrors what is on disk, so the form can edit one entry without reparsing the JSON.
   * Set together with `mcpJson` through `setMcpServersState` — two representations of the
   * same thing, kept in one place because that is exactly what drifts otherwise.
   */
  let mcpConfigs: McpServersConfig = {}

  function setMcpServersState(servers: McpServersConfig): void {
    mcpConfigs = servers
    mcpJson = JSON.stringify({ mcpServers: servers }, null, 2)
  }

  const mcp = new McpRegistry(
    secrets,
    {
      onStateChanged: () => {
        postMcp()
        /*
         * The schedule tool picker is built from the live registry, and MCP servers connect
         * seconds *after* the panel opens — the UI asks for schedules once, on mount, so it
         * captured an empty MCP list and never heard again. That is why no MCP tool could be
         * ticked for a schedule. Re-posting on every state change covers connect, disconnect
         * and tools/list_changed alike.
         */
        void postSchedules()
        // Same reasoning: MCP servers connect seconds after the panel opens, so a catalogue
        // fetched once on mount would show an empty list for ever.
        void postTools()
        // Fires on connect, disconnect and tools/list_changed — every way the MCP half of
        // the corpus can change. Opening the panel fires several at once, which is what the
        // debounce is for.
        scheduleDocsReindex('MCP tools changed')
      },
    },
    logger,
    () => cachedApprovals.allowedTools ?? [],
  )

  function postMcp(): void {
    const servers = mcp.states_()
    const warnings: Record<string, string[]> = {}
    for (const server of servers) warnings[server.name] = mcp.warningsFor(server.name)
    post({
      type: 'mcp',
      servers,
      json: mcpJson,
      warnings,
      configs: mcpConfigs,
      platform: process.platform === 'win32' ? 'win32' : 'posix',
    })
  }

  /**
   * Built-ins plus every enabled MCP tool, rebuilt per turn. MCP tools are ordinary
   * `Tool`s by this point, so mode filtering and the approval gate apply to them with
   * no special-casing.
   */
  function currentToolRegistry(
    expert?: { cli: ClaudeCliInfo; model?: string },
    search?: { client: OpenSearchClient; store: VectorStoreConfig; indexes: string[] },
    codebase?: { searcher: VectorSearcher; embedder: Embedder; index: string; connectionLabel: string },
    /** Retrieval for `search_docs`, when a store, an embedder and an indexed corpus exist. */
    docs?: { searcher: VectorSearcher; embedder: Embedder; index: string },
    /**
     * Hides MCP and Python schemas from the prompt, reachable through `call_tool` instead
     * (§12). Resolved once per turn like the mode, so the tool block stays byte-stable.
     */
    dispatcher = false,
    /**
     * Keeps skill summaries out of the prompt too, found with `search_docs` instead. Separate
     * from `dispatcher` because it is a separate trade — see `skillRetrievalEnabled`.
     */
    hideSkills = false,
  ): ToolRegistry {
    const combined = new ToolRegistry()
    for (const tool of builtinTools.list()) combined.register(tool)
    /*
     * MCP and Python tools are the whole reason the dispatcher exists: a few servers can
     * contribute forty tools each, and their schemas sit at the front of every request.
     * Built-ins stay advertised — there are nine, the model needs them constantly, and
     * making it search for `read_file` would be absurd.
     *
     * `dispatchOnly` withholds the *advertisement*, never the capability: the mode filter and
     * the approval gate still apply exactly as before, because the loop unwraps `call_tool`
     * before either of them runs.
     */
    for (const tool of mcp.enabledTools()) combined.register(tool, { dispatchOnly: dispatcher })
    /*
     * Python tools are adapted into the ordinary Tool interface, exactly as MCP tools are.
     * That is the design choice that matters: the loop, the approval gate and mode filtering
     * treat py__* like execute_command, with no special-casing upstream — so a model-authored
     * tool is approval-gated for free.
     */
    for (const tool of python.tools()) combined.register(tool, { dispatchOnly: dispatcher })
    // Offered whenever a folder is open. Unlike Python tools these need no interpreter —
    // a skill is markdown, so the only prerequisite is somewhere to put it.
    /*
     * Registered always, not only for schedules. An interactive session rarely needs it — the
     * user is already reading the reply — and the description says so; but a scheduled run is
     * built from this same registry, and a run that could not report would be pointless.
     */
    combined.register(
      createNotifyTool({
        notify: (message, level, details) => {
          /*
           * A report goes to a document, because the toast cannot hold one. VS Code
           * notifications are a plain string plus buttons — no Markdown, no table, no colour —
           * so "rich notification" has to mean "a notification that opens something rich".
           */
          if (details !== undefined) {
            void (async () => {
              const open = await ui.showActionMessage(message, 'Open report', level)
              if (open) await ui.openDocument({ title: message, content: details })
            })()
            return
          }
          /*
           * From a scheduled run the notification is the only thing the user will see, so it
           * carries a way into the transcript. Captured at call time rather than at
           * registration: the task id changes with every run, and the registry is rebuilt per
           * turn but the closure would otherwise still point at whatever was open when it was
           * built.
           */
          const taskId = runningScheduleId !== undefined ? activeTaskId : undefined
          if (taskId === undefined) {
            if (level === 'warning') ui.showWarning(message)
            else ui.showInfo(message)
            return
          }
          void openFromNotification(message, level, taskId)
        },
      }),
    )
    if (skillsDir !== undefined) {
      const context = {
        skillsDir,
        onChanged: refreshSkills,
        ...(services.submitForReview !== undefined
          ? {
              submitForReview: (request: { name: string; content: string; existingContent: string }) =>
                services.submitForReview?.({ kind: 'skill' as const, ...request }) ?? Promise.resolve(''),
            }
          : {}),
      }
      combined.register(createWriteSkillTool(context))
      combined.register(createDeleteSkillTool(context))
    }
    if (search !== undefined) {
      combined.register(
        createSearchOpensearchTool({
          client: search.client,
          connectionLabel: search.store.label,
          ...(search.store.defaultIndex !== undefined ? { defaultIndex: search.store.defaultIndex } : {}),
          availableIndexes: search.indexes,
          ...(search.store.limits !== undefined ? { limits: search.store.limits } : {}),
        }),
      )
    }
    /*
     * Offered only when an index could actually be searched: a connection, an embedder, and
     * an index name. Registering it without them would advertise a tool that always errors,
     * and the model would keep reaching for it instead of using search_files.
     */
    if (codebase !== undefined) {
      combined.register(createSearchCodebaseTool({ ...codebase, observer: searchLog }))
    }
    /*
     * `search_docs` is registered whenever the dispatcher is on, with or without a vector
     * store. Without one it matches names and descriptions from the live registry instead of
     * by meaning — and that fallback is load-bearing, not a nicety: hiding every MCP tool
     * behind a `search_docs` that did not exist would make them all permanently unreachable.
     */
    /*
     * Nothing is hidden unless there is something to hide.
     *
     * The dispatcher is on by default now, and the one case where it costs more than it saves
     * is a workspace with no MCP servers, no Python tools and no skills: `call_tool`,
     * `search_docs` and `forget_docs` carry their own descriptions, so registering them to
     * search an empty catalogue is pure loss. Conditioning on the catalogue removes that case
     * entirely rather than asking the user to notice it.
     *
     * `call_tool` and `search_docs` are decided separately because they answer to different
     * things: a workspace with skills but no MCP tools needs to *find* documentation without
     * needing an indirect way to *call* anything.
     */
    const hasHiddenTools = dispatcher && combined.dispatchOnlyList().length > 0
    const hasHiddenSkills = hideSkills && skills.length > 0
    if (hasHiddenTools) {
      combined.register(createCallToolTool())
    }
    if (dispatcher && (hasHiddenTools || hasHiddenSkills)) {
      // Registered with search_docs, never without it: releasing documentation only makes
      // sense where documentation is being retrieved.
      combined.register(createForgetDocsTool())
      combined.register(
        createSearchDocsTool({
          // Resolved per call, so a tool registered later in this same function is still
          // found, and so a schema is never served from a snapshot.
          listTools: () => combined.list(),
          listSkills: () => skills,
          // A hit for a tool this run cannot call is still worth returning — annotated, so the
          // run can say what it needed instead of being refused and reporting a failure.
          accessibleTo: (name) => scheduleToolAccess?.(name) ?? true,
          ...(docs !== undefined ? { retrieval: docs } : {}),
          observer: searchLog,
        }),
      )
    }
    // Registered only when the CLI is actually runnable, so the model is never told about
    // a tool that would fail — the same rule mode filtering follows.
    if (expert !== undefined) {
      combined.register(
        createAskExpertTool({
          cli: expert.cli,
          ...(expert.model !== undefined ? { model: expert.model } : {}),
          onConsultation: recordConsultation,
          // Read at call time, not captured: the user can raise the limit mid-task and the very
          // next consultation should honour it, without starting a new task to pick it up.
          budget: () => checkExpertBudget(expertSpend, effectiveExpertLimits()),
          /*
           * The measured cost goes with the budget, so the expert plans in this deployment's
           * units rather than from what it believes consultations cost in general.
           */
          budgetSummary: () =>
            describeExpertBudget(expertSpend, effectiveExpertLimits(), pricingForPrompt(cachedPricing)),
          onEstimate: (estimate) => {
            taskExpertEstimate = estimate
            postExpertSpend()
          },
          session: {
            get: () => expertSessionId,
            set: (sessionId) => {
              expertSessionId = sessionId
              // Only ever refreshes a session a real consultation created.
              if (sessionId !== undefined && cachedKeepAlive) ensureKeepAlive()
            },
          },
          /*
           * Lazy, and reading `combined` — the registry it describes is still being built at
           * this point, and the expert must be told about tools registered after this line
           * as much as before it.
           */
          briefing: () =>
            buildExpertBriefing({
              ...(cachedAssessment === undefined ? {} : { juniorAssessment: cachedAssessment }),
              // `ask_expert` itself is excluded: telling the expert it can consult itself is
              // noise at best and a loop at worst.
              promptTools: combined.promptList().filter((tool) => tool.name !== 'ask_expert'),
              dispatchOnlyTools: combined.dispatchOnlyList(),
              skills,
              retrievalAvailable: combined.get('search_docs') !== undefined,
            }),
        }),
      )
    }
    return combined
  }

  async function syncMcpFromConfig(config: LightCodeConfig): Promise<void> {
    const servers: McpServersConfig = config.mcpServers ?? {}
    setMcpServersState(servers)
    await mcp.configure(servers)
  }

  // Kept outside globalStorage's config area and outside the workspace, so a checkpoint
  // never lands inside the very tree it snapshots.
  const shadowGit =
    workspaceRoot !== undefined
      ? new ShadowGit(workspaceRoot, path.join(storageDir, 'checkpoints', 'shadow.git'))
      : undefined

  async function postProfiles(): Promise<void> {
    const { config } = await configManager.load()
    const profiles = await Promise.all((config.profiles ?? []).map((profile) => toSummary(profile, secrets)))
    post({ type: 'profiles', profiles, activeProfileId: config.activeProfileId })
  }

  /**
   * The live auth strategy, kept across turns.
   *
   * This must NOT be rebuilt per turn: the token cache, the proactive refresh timer, and
   * the single-flight guard all live inside the strategy instance, so a fresh one every
   * turn would mean a full mTLS handshake and a new `client_credentials` grant for every
   * user message — the caching in §10 would never engage at all.
   *
   * Keyed by profile id plus a fingerprint of the auth block, so editing credentials or
   * switching profiles discards the cached token instead of silently reusing a stale one.
   */
  let cachedAuth: { key: string; strategy: AuthStrategy } | undefined

  function authStrategyFor(config: LightCodeConfig, profile: ProviderProfile): AuthStrategy {
    const key = `${profile.id}|${profile.baseUrl}|${JSON.stringify(profile.auth)}|${config.certDir ?? ''}|${JSON.stringify(config.tls ?? {})}`
    const cached = cachedAuth
    if (cached !== undefined && cached.key === key) return cached.strategy

    const strategy = createAuthStrategy(profile.auth, buildAuthContext(config, profile))
    cachedAuth = { key, strategy }
    return strategy
  }

  /**
   * Assembles what core needs to build an auth strategy. Kept in one place so the chat
   * turn, the model list, and Test Connection all authenticate identically — a divergence
   * here would make "Test Connection passed but chat fails" possible, which would destroy
   * the whole point of that button (§10).
   */
  function buildAuthContext(config: LightCodeConfig, profile: ProviderProfile): AuthStrategyContext {
    return {
      secrets,
      http: httpClient,
      baseUrl: profile.baseUrl,
      wireFormat: profile.wireFormat,
      ...(profile.tls !== undefined ? { connectionTls: profile.tls } : {}),
      ...(config.tls !== undefined ? { globalTls: config.tls } : {}),
      ...(config.certDir !== undefined ? { defaultCertDir: config.certDir } : {}),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      // Invariant 6: whatever the loader actually read becomes unreadable to file tools.
      onCertPaths: (paths) => {
        void Promise.all(paths.map((certPath) => denylist.add(certPath))).catch((error: unknown) => {
          logger.warn('could not add cert path to the deny list', String(error))
        })
      },
      onExpiryWarning: (warning) => {
        if (warnedExpiries.has(warning.message)) return
        warnedExpiries.add(warning.message)
        ui.showWarning(warning.message)
      },
    }
  }

  /**
   * Values that must never reach a stored transcript, gathered from the secret store.
   *
   * `redact()`'s patterns catch `Bearer` tokens and `sk-`-style keys, but a corporate
   * gateway key often looks like neither. Passing the actual values means a tool result
   * that happens to echo one — a command printing an env var, a config file read back —
   * is caught by exact match rather than by hoping it matches a shape.
   */
  async function knownSecretValues(): Promise<string[]> {
    try {
      const { config } = await configManager.load()
      const refs = (config.profiles ?? []).flatMap((profile) => SECRET_REFS_PER_PROFILE.map((refFor) => refFor(profile.id)))
      const values = await Promise.all(refs.map((ref) => secrets.get(ref)))
      cachedSecretValues = values.filter((value): value is string => value !== undefined && value.length > 0)
      return [...cachedSecretValues]
    } catch (error) {
      // Redaction must never be the reason a transcript fails to save; the pattern-based
      // rules still apply, so this degrades rather than disables.
      logger.warn('could not read secrets for redaction', String(error))
      return []
    }
  }

  /** Writes the current conversation. Called after every turn, not only at the end. */
  async function persistActiveTask(): Promise<void> {
    if (workspaceRoot === undefined || conversation.isEmpty()) return

    if (activeTaskId === undefined) {
      await setActiveTaskId(randomUUID())
      activeTaskCreatedAt = Date.now()
      truncationStore.startTask()
    }

    const messages = conversation.toArray()
    const task: Task = {
      id: activeTaskId as string,
      workspaceRoot,
      title: deriveTitle(messages),
      createdAt: activeTaskCreatedAt,
      updatedAt: Date.now(),
      messages,
      resultHandles: truncationStore.spilledHandles(),
    }

    try {
      await taskStore.save(redactTask(task, await knownSecretValues()))
    } catch (error) {
      // A failed save must not take the conversation down with it — the user would lose
      // the turn they just had on top of the history they were already going to lose.
      logger.warn('could not save task history', String(error))
    }
  }

  async function postTasks(): Promise<void> {
    if (workspaceRoot === undefined) {
      post({ type: 'tasks', tasks: [], activeTaskId: undefined })
      return
    }
    post({ type: 'tasks', tasks: await taskStore.list(workspaceRoot), activeTaskId })
  }

  /**
   * Loads a stored task into the live conversation.
   *
   * `readFiles` is deliberately NOT restored. The read-before-edit constraint (§6) is
   * session-scoped on purpose: a resumed task must re-read a file before editing it,
   * because the file may have changed since the transcript was written. Restoring the set
   * would quietly weaken the invariant across a restart — the exact case where the
   * model's picture of the workspace is most likely to be stale.
   */
  async function openTask(id: string): Promise<void> {
    const task = await taskStore.load(id)
    if (task === undefined) {
      post({ type: 'error', message: 'That task could not be loaded — it may have been deleted.' })
      await postTasks()
      return
    }

    conversation.restore(task.messages)
    readFiles.clear()
    /*
     * Both reset on a task switch. The spend counter is explicitly "since this task was
     * opened", and the expert session belongs to the work it was about — resuming it for a
     * different task would pay to carry irrelevant history and would muddy the answers.
     */
    resetExpertSpend()
    taskCheckpoint = undefined
    activeTaskCreatedAt = task.createdAt
    truncationStore.startTask(task.resultHandles)
    await setActiveTaskId(task.id)

    post({ type: 'taskRestored', taskId: task.id, entries: toTranscript(task.messages) })
    await postTasks()
  }

  async function startNewTask(): Promise<void> {
    // The current task is already saved after each turn, so nothing needs flushing here.
    conversation.reset()
    readFiles.clear()
    resetExpertSpend()
    taskCheckpoint = undefined
    activeTaskCreatedAt = Date.now()
    truncationStore.startTask()
    await setActiveTaskId(undefined)

    post({ type: 'taskRestored', taskId: undefined, entries: [] })
    await postTasks()
  }

  async function deleteTask(id: string): Promise<void> {
    // Cascades to the task's spilled tool results inside the store.
    await taskStore.delete(id)
    if (id === activeTaskId) await startNewTask()
    else await postTasks()
  }

  /** Restores the in-progress task when the panel loads, so a reload is not a data loss. */
  async function restoreActiveTaskOnLoad(): Promise<void> {
    if (activeTaskId === undefined) {
      post({ type: 'taskRestored', taskId: undefined, entries: [] })
      return
    }

    const task = await taskStore.load(activeTaskId)
    if (task === undefined || task.workspaceRoot !== workspaceRoot) {
      // Deleted behind our back, or the remembered id belongs to another workspace.
      await setActiveTaskId(undefined)
      post({ type: 'taskRestored', taskId: undefined, entries: [] })
      return
    }

    conversation.restore(task.messages)
    activeTaskCreatedAt = task.createdAt
    truncationStore.startTask(task.resultHandles)
    post({ type: 'taskRestored', taskId: task.id, entries: toTranscript(task.messages) })
  }

  async function handleSendMessage(
    text: string,
    images?: ImageAttachmentInput[],
    /**
     * Set when this turn is an unattended scheduled run.
     *
     * Threaded through the ordinary path rather than duplicated: a second turn
     * implementation would drift from this one, and the drift would be in the half nobody
     * watches run. What changes is the registry, the approval gate and a paragraph of
     * guidance — everything else about a scheduled turn is an ordinary turn.
     */
    schedule?: Schedule,
  ): Promise<void> {
    if (workspaceRoot === undefined) {
      post({ type: 'error', message: 'Open a folder in VS Code before using Light Code — tools need a workspace root.' })
      return
    }

    activeAbortController = new AbortController()
    try {
      const config = await loadSettings()

      // Invariant 6: cert/key paths are unreadable by every file tool. Re-added each
      // turn so a config change takes effect without restarting the session.
      if (config.certDir !== undefined) await denylist.add(config.certDir)

      // Refresh before the turn, not after: tool results spill to disk *during* the turn,
      // and the spill path reads this synchronously. Populating it only at save time would
      // leave the very first turn's spilled output unredacted.
      await knownSecretValues()

      const profile = resolveActiveProfile(config)
      // The wire adapter is chosen per profile; auth composes with any of them (§10).
      const provider = createChatProvider(profile, httpClient, authStrategyFor(config, profile), logger)
      const capabilities = resolveModelCapabilities(profile.model, profile.modelCapabilities)
      const expertCliInfo = await resolveExpert(config)
      const search = await resolveSearch(config)
      const embedder = await resolveEmbedder(config)
      const codebaseIndex = codebaseIndexName(config)
      const docsIndex = docsIndexName(config)
      // Listed once per turn so the tool description can name real indexes; a failure here
      // only costs the model that hint, never the tool.
      const searchIndexes =
        search?.opensearch !== undefined
          ? await search.opensearch.listIndexes().then((list) => list.map((i) => i.name)).catch(() => [])
          : []

      // Rebuilt whenever the profile or expert availability changes, so the model can
      // answer "which model are you?" accurately and knows whether ask_expert exists.
      // A profile switch is a session boundary, so replacing the prefix here is free (§12).
      /*
       * Skills are loaded before the prompt is built and then left alone for the whole turn.
       * They sit at the front of the prompt, so a mid-turn change would invalidate the cache
       * prefix and everything after it — the same rule tool definitions follow (§12). A skill
       * written during a turn therefore appears at the next one, which is what write_skill
       * tells the model.
       */
      await refreshSkills()

      /*
       * Resolved once here and reused for the turn. The mode contributes both tool filtering
       * and system-prompt guidance, and those two must agree — a prompt telling the model to
       * consult an expert whose tool was filtered out would be worse than either alone.
       */
      const activeMode = findMode(config.modeId)

      /*
       * Computed from the *full* registry so the run is told the names it actually has, and
       * before the prompt is built because it lands in the cached prefix like everything else.
       */
      const scheduledGuidance =
        schedule === undefined
          ? undefined
          : scheduledRunGuidance(
              schedule,
              filterToolsForSchedule(currentToolRegistry(undefined, undefined, undefined, undefined, false).list(), schedule)
                .map((tool) => tool.name)
                .filter((name) => name !== 'attempt_completion'),
            )

      /*
       * A schedule names its skills instead of searching for them.
       *
       * Its tools are an allowlist the user ticked and may well not include `search_docs`, so
       * telling an unattended run that notes exist and to go and find them can leave it with
       * nothing to search with — and nobody is there to notice. Naming them up front is also
       * simply the better fit: a job that runs the same prompt every night knows in advance
       * which conventions apply, where a chat cannot.
       *
       * `allowedSkills` absent means all of them, so schedules written before this keep the
       * behaviour they had.
       */
      /*
       * A schedule can search for skills too, now that `search_docs` is always available to one
       * (see `ALWAYS_AVAILABLE_TO_SCHEDULES`). The earlier objection was that its allowlist might
       * not include the tool, leaving it told to search with nothing to search with.
       *
       * The exception is a schedule that **named** its skills. That selection is the user saying
       * which conventions apply to this job; listing them is honouring it, and making them
       * searchable instead would quietly reach past the choice.
       */
      const skillsSearchable =
        skillRetrievalEnabled(config.retrieval) && (schedule === undefined || schedule.allowedSkills === undefined)
      const turnSkills = schedule === undefined ? skills : skillsForSchedule(skills, schedule.allowedSkills)

      const desiredPrompt = buildSystemPrompt(workspaceRoot, {
        model: profile.model,
        providerLabel: profile.label,
        expertAvailable: expertCliInfo !== undefined,
        /*
         * Either the whole list or a count and an instruction to search — never both, and
         * never neither. `renderSkillsHintForPrompt` explains why the count stays.
         */
        skills: skillsSearchable ? renderSkillsHintForPrompt(skills.length) : renderSkillsForPrompt(turnSkills),
        skillsSearchable,
        canWriteSkills: skillsDir !== undefined,
        /*
         * Read from config rather than from the registry, because the prompt is built before the
         * registry is. Only the *off* case is claimed: "on but uv is missing" leaves the model
         * equally toolless, but the Python tab reports that with the actual reason, and telling
         * the user to switch on something already switched on would be worse than saying nothing.
         */
        pythonToolsDisabled: config.python?.dynamicTools !== 'on',
        /*
         * Junior mode's instructions are worse than useless without the expert to delegate
         * to: the model would be told to consult something it has no tool for. The picker
         * disables the mode in that case, but config can still name it, so it is checked
         * here too.
         */
        ...(() => {
          const parts: string[] = []
          if (activeMode.guidance !== undefined && (activeMode.requiresExpert !== true || expertCliInfo !== undefined)) {
            parts.push(activeMode.guidance)
          }
          if (scheduledGuidance !== undefined) parts.push(scheduledGuidance)
          return parts.length > 0 ? { modeGuidance: parts.join('\n\n') } : {}
        })(),
      })
      if (conversation.systemPrompt() !== desiredPrompt) conversation.setSystemPrompt(desiredPrompt)

      // Lazy connect (§11): a configured-but-unused server costs nothing until a turn
      // actually needs its tools. Failures are per-server and surface in the MCP tab.
      await syncMcpFromConfig(config)
      await mcp.ensureConnected()
      await python.configure(config.python ?? {})

      const toolContext: ToolExecutionContext = {
        fs: new NodeFileSystem(),
        terminal: new NodeTerminal(),
        workspaceRoot,
        denylist,
        readFiles,
        readRoots: cachedReadRoots,
        // Resolved per turn by the host, so an edit applies to the next command rather than
        // needing a new session. Absent in the extension, where there is nothing to resolve.
        ...(services.sessionEnv !== undefined ? { sessionEnv: services.sessionEnv() } : {}),
        /*
         * Omitted for a scheduled run: there is nobody to answer, and a run that could grant
         * itself new filesystem access would defeat the point of its allowlist.
         */
        ...(schedule === undefined ? { requestPathAccess } : {}),
        // Also withheld from a scheduled run: nobody is there to fill a form in, and a job
        // that stops to wait for one would never finish.
        ...(schedule === undefined ? { requestForm } : {}),
        signal: activeAbortController.signal,
        // Supplied by the host, not imported by core: the binary is platform-specific and
        // lives in the VSIX, so resolving it is a host concern (§4).
        ...(ripgrepPath !== undefined ? { ripgrepPath } : {}),
      }

      // `@`-mentions are resolved here, not by the model: the user named these paths
      // explicitly, so there is nothing to decide and nothing to approve. Confinement and
      // the deny list still apply, since the path is user-typed text.
      const mentions = await resolveMentions(text, { fs: toolContext.fs, workspaceRoot, denylist })
      const messageText = attachMentions(text, mentions)

      const turnOptions: RunAgentTurnOptions = {
        signal: activeAbortController.signal,
        truncationStore,
        approvalGate,
        // Resolved once per turn, so the tool definitions stay byte-stable for the whole
        // loop — swapping them mid-turn would break the prompt cache prefix (§12).
        mode: activeMode,
        contextWindow: capabilities.contextWindow,
        // CLAUDE.md §5 has called this configurable since Phase 0; until now it was not.
        maxIterations: cachedMaxIterations,
        drainQueuedMessages: () => {
          if (queuedMessages.length === 0) return []
          const drained = queuedMessages
          queuedMessages = []
          postQueued()
          return drained
        },
      }
      // Silently dropping an image on a text-only model would look like the model ignoring
      // it; the composer already hides attachment, so this is the backstop.
      if (images !== undefined && images.length > 0 && capabilities.supportsVision) {
        turnOptions.images = images.map((image) => ({ mediaType: image.mediaType, data: image.data }))
      } else if (images !== undefined && images.length > 0) {
        post({
          type: 'error',
          message: `${profile.model} does not accept images. Attachments were not sent — set "Supports images" in the profile's advanced settings if that is wrong.`,
        })
      }
      // Checkpoints degrade to unavailable rather than blocking the session when git
      // isn't installed — but edits then proceed with no rollback point, so say so.
      if (shadowGit !== undefined && (await ShadowGit.isGitAvailable())) {
        turnOptions.shadowGit = shadowGit
      } else {
        logger.warn('git not found on PATH — edits will proceed without a rollback checkpoint')
      }

      // Send cumulative text, not the delta — webview `postMessage` delivery isn't
      // guaranteed, and this makes each message self-correcting rather than letting
      // one dropped delta permanently corrupt everything streamed after it.
      let cumulativeText = ''
      let cumulativeReasoning = ''
      // Sticky once the expert has been consulted, matching how a restored transcript is
      // derived — so the live view and a reopened task mark the same work.
      let expertInformed = false
      const fullRegistry = currentToolRegistry(
          expertCliInfo !== undefined
            ? { cli: expertCliInfo, ...(config.expert?.model !== undefined ? { model: config.expert.model } : {}) }
            : undefined,
          search?.opensearch !== undefined
            ? { client: search.opensearch, store: search.store, indexes: searchIndexes }
            : undefined,
          /*
           * Only when all three exist. Resolved once per turn like everything else feeding
           * the prefix, so the tool block stays byte-stable for the whole loop (§12).
           */
          search !== undefined && embedder !== undefined && codebaseIndex !== undefined
            ? { searcher: search.searcher, embedder, index: codebaseIndex, connectionLabel: search.store.label }
            : undefined,
          /*
           * Retrieval for `search_docs`. Absent leaves it matching lexically over the live
           * registry, which is deliberately still useful — the dispatcher must not depend on
           * a vector store existing, or turning it on without one would hide every MCP tool
           * behind a search that could never find them.
           */
          search !== undefined && embedder !== undefined && docsIndex !== undefined
            ? { searcher: search.searcher, embedder, index: docsIndex }
            : undefined,
          dispatcherEnabled(config.retrieval),
          skillsSearchable,
      )

      /*
       * The security boundary for an unattended run is the *registry*, not the approval gate.
       * A tool the schedule did not name is never registered, so it never reaches the system
       * prompt and the model is never told it exists — the same layering §11 uses for disabled
       * MCP tools. The gate below is a second line of defence, not the first.
       */
      const turnRegistry = schedule !== undefined ? registryForSchedule(fullRegistry.list(), schedule) : fullRegistry
      if (schedule !== undefined) {
        turnOptions.approvalGate = new ScheduledApprovalGate(schedule)
        /*
         * Derived from the registry the run actually gets, not from `allowedTools` — so what
         * `search_docs` reports as callable is by construction the same set the gate will let
         * through. Two lists here would be two lists to keep in step, which is the bug shape
         * this project has paid for most often.
         */
        const granted = new Set(turnRegistry.list().map((tool) => tool.name))
        scheduleToolAccess = (name) => granted.has(name)
      }

      await runAgentTurn(
        provider,
        conversation,
        messageText,
        turnRegistry,
        toolContext,
        {
          onContextUpdate: (breakdown, supersededCount, compactedCount) => {
            post({ type: 'contextUsage', usage: { ...breakdown, supersededCount, compactedCount } })
          },
          onCompacted: (summarisedCount) => post({ type: 'compacted', summarisedCount }),
          onNudgedToContinue: () => {
            // Logged, not shown. The transcript already reads correctly — the preamble, then the
            // tool call it should have made — and a banner between them would explain a seam the
            // user cannot otherwise see. It belongs in the log, where a model doing this every
            // turn becomes visible as a pattern.
            logger.warn('the model described an action without calling a tool; asked it to continue')
          },
          onQueuedMessageConsumed: (text) => {
            // Shown as an ordinary user turn: that is exactly what it became in the
            // conversation, and a restored transcript will render it the same way.
            post({ type: 'queuedMessageConsumed', text })
            // The assistant text that follows belongs to a new step.
            cumulativeText = ''
          },
          onTextChunk: (chunk) => {
            cumulativeText += chunk
            post({ type: 'textChunk', text: cumulativeText, ...(expertInformed ? { expertInformed } : {}) })
          },
          onReasoningChunk: (chunk) => {
            cumulativeReasoning += chunk
            post({ type: 'reasoningChunk', text: cumulativeReasoning })
          },
          onToolCall: (toolCall) => {
            // Each tool call starts a fresh assistant text block in the transcript.
            cumulativeText = ''
            cumulativeReasoning = ''
            if (toolCall.name === 'ask_expert') expertInformed = true
            if (CONTROL_TOOLS.has(toolCall.name)) return
            const summary: ToolCallSummary = {
              id: toolCall.id,
              name: toolCall.name,
              arguments: formatToolArguments(toolCall.arguments),
            }
            post({ type: 'toolCall', toolCall: summary, ...(expertInformed ? { expertInformed } : {}) })
          },
          onToolResult: (toolCall, result) => {
            // The control tools aren't work being done — they're the model addressing the
            // user. Their content is the answer, so render it as a message rather than
            // something the user has to expand a collapsed block to read.
            if (CONTROL_TOOLS.has(toolCall.name)) {
              post({ type: 'textChunk', text: result.content })
              return
            }
            const summary: ToolCallSummary = {
              id: toolCall.id,
              name: toolCall.name,
              arguments: formatToolArguments(toolCall.arguments),
              result: result.content,
              ...(result.isError === true ? { isError: true } : {}),
            }
            post({ type: 'toolResult', toolCall: summary, ...(expertInformed ? { expertInformed } : {}) })
          },
          onCheckpoint: (checkpoint) => {
            taskCheckpoint = checkpoint
            post({ type: 'checkpointAvailable' })
          },
          onDone: () => post({ type: 'done' }),
          onError: (message) => post({ type: 'error', message }),
        },
        turnOptions,
      )
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      // Never leave the loop parked on an approval that can no longer be answered.
      userGate.denyAll()
      settleAllForms()
      activeAbortController = undefined
      // Cleared before anything else awaits, like the rest of a scheduled run's state: leaving
      // it set would make the next chat turn report its own tools as forbidden.
      scheduleToolAccess = undefined
      // Save in `finally`, so a cancelled or errored turn is still persisted. A turn that
      // failed halfway is exactly the one the user most wants to see again afterwards.
      await persistActiveTask()
      await postTasks()

      // Whatever did not get folded in — a turn that ended before reaching a boundary —
      // starts the next turn rather than being silently dropped.
      if (queuedMessages.length > 0 && activeAbortController === undefined) {
        const next = queuedMessages.join('\n\n')
        queuedMessages = []
        postQueued()
        void handleSendMessage(next)
      }
    }
  }

  /**
   * Writes any newly-typed secrets and returns the `Auth` block that references them.
   *
   * The write-only rule (invariant 7) means an empty secret field is ambiguous — "unchanged"
   * or "never set" — so it is resolved by asking the store, never by trusting config. A
   * config that claims a ref the store doesn't have is exactly the dangling-reference bug
   * that made a profile permanently unusable with no way to fix it from the UI.
   */
  async function buildAuthFromInput(input: ProfileInput, id: string): Promise<Auth> {
    /** Stores a newly-typed secret, or reports whether a usable one is already there. */
    async function persistSecret(ref: string, typed: string | undefined): Promise<boolean> {
      const value = typed?.trim() ?? ''
      if (value.length > 0) {
        await secrets.set(ref, value)
        return true
      }
      return (await secrets.get(ref)) !== undefined
    }

    if (input.authType === 'apigeeMtls') {
      const hasClientSecret = await persistSecret(clientSecretRefFor(id), input.clientSecret)
      const hasPassphrase = await persistSecret(certPassphraseRefFor(id), input.certPassphrase)
      // Switching a profile to mTLS retires its API key rather than leaving it in the
      // keychain — §10 is explicit that the two must never both be live.
      await secrets.delete(apiKeyRefFor(id))

      const certs = input.certs ?? {}
      return {
        type: 'apigeeMtls',
        certs: {
          ...stripEmpty(certs),
          ...(hasPassphrase ? { passphraseRef: certPassphraseRefFor(id) } : {}),
        },
        apigee: {
          ...stripEmpty(input.apigee ?? {}),
          ...(hasClientSecret ? { clientSecretRef: clientSecretRefFor(id) } : {}),
        },
      }
    }

    if (input.authType === 'none') return { type: 'none' }

    const apiKeyRef = apiKeyRefFor(id)
    if (await persistSecret(apiKeyRef, input.apiKey)) {
      return { type: 'apiKey', apiKeyRef }
    }
    // No key typed and none stored — `none` rather than a reference to a secret that was
    // never written, which is the dangling-ref case described above.
    return { type: 'none' }
  }

  async function handleSaveProfile(input: ProfileInput): Promise<void> {
    const fieldErrors = validateProviderForm({
      label: input.label,
      wireFormat: input.wireFormat,
      baseUrl: input.baseUrl,
      model: input.model,
    })
    if (fieldErrors.length > 0) {
      post({ type: 'error', message: fieldErrors.map((e) => `${e.path}: ${e.message}`).join('; ') })
      return
    }

    // Invariant 6, checked **at config time** rather than only when a handshake is
    // attempted (§10). Rejecting the save is what stops the bad path from ever existing;
    // catching it later would mean key material already sat inside the workspace.
    const certDir = input.certs?.certDir
    if (input.authType === 'apigeeMtls' && certDir !== undefined && certDir.trim().length > 0) {
      try {
        assertCertDirOutsideWorkspace(certDir.trim(), workspaceRoot)
      } catch (error) {
        post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        return
      }
    }

    try {
      const { config } = await configManager.load()
      const profiles = config.profiles ?? []
      const id = input.id ?? randomUUID()
      const existing = profiles.find((p) => p.id === id)

      const auth = await buildAuthFromInput(input, id)

      const saved: ProviderProfile = {
        id,
        label: input.label.trim(),
        wireFormat: input.wireFormat,
        baseUrl: input.baseUrl.trim(),
        model: input.model.trim(),
        auth,
      }
      if (input.modelCapabilities !== undefined) saved.modelCapabilities = input.modelCapabilities
      const connectionTls = stripEmpty(input.connectionTls ?? {})
      if (Object.keys(connectionTls).length > 0) saved.tls = connectionTls

      const nextProfiles = existing ? profiles.map((p) => (p.id === id ? saved : p)) : [...profiles, saved]
      // The very first profile ever created becomes active automatically.
      const activeProfileId = config.activeProfileId ?? (nextProfiles.length === 1 ? id : undefined)
      await configManager.save('user', { profiles: nextProfiles, activeProfileId })
      // The cache key can't see a *rotated* secret — the ref is unchanged — so any save
      // drops the cached strategy rather than leaving a token minted from the old one.
      cachedAuth = undefined

      post({ type: 'profileSaved' })
      await postProfiles()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDuplicateProfile(id: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const profiles = config.profiles ?? []
      const source = profiles.find((p) => p.id === id)
      if (source === undefined) {
        post({ type: 'error', message: `Profile "${id}" no longer exists.` })
        return
      }

      const newId = randomUUID()

      /** Copies a secret under the new profile's namespace; false when there was none. */
      async function copySecret(fromRef: string | undefined, toRef: string): Promise<boolean> {
        if (fromRef === undefined) return false
        const value = await secrets.get(fromRef)
        if (value === undefined) return false
        await secrets.set(toRef, value)
        return true
      }

      let auth: Auth = { type: 'none' }
      if (source.auth.type === 'apiKey') {
        // If the source secret is missing there's nothing to copy — leave the duplicate
        // as `none` rather than pointing it at a secret that was never written.
        if (await copySecret(source.auth.apiKeyRef, apiKeyRefFor(newId))) {
          auth = { type: 'apiKey', apiKeyRef: apiKeyRefFor(newId) }
        }
      } else if (source.auth.type === 'apigeeMtls') {
        const { clientSecretRef, ...apigee } = source.auth.apigee
        const { passphraseRef, ...certs } = source.auth.certs
        const copiedSecret = await copySecret(clientSecretRef, clientSecretRefFor(newId))
        const copiedPassphrase = await copySecret(passphraseRef, certPassphraseRefFor(newId))
        auth = {
          type: 'apigeeMtls',
          certs: { ...certs, ...(copiedPassphrase ? { passphraseRef: certPassphraseRefFor(newId) } : {}) },
          apigee: { ...apigee, ...(copiedSecret ? { clientSecretRef: clientSecretRefFor(newId) } : {}) },
        }
      }

      const duplicate: ProviderProfile = { ...source, id: newId, label: `${source.label} (copy)`, auth }
      await configManager.save('user', { profiles: [...profiles, duplicate] })
      await postProfiles()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDeleteProfile(id: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const profiles = config.profiles ?? []
      const remaining = profiles.filter((p) => p.id !== id)

      // Every secret this profile could own, not just the one its current auth type uses —
      // a profile switched from apiKey to mTLS would otherwise leave an orphan behind (§15).
      for (const refFor of SECRET_REFS_PER_PROFILE) await secrets.delete(refFor(id))

      const activeProfileId =
        config.activeProfileId === id ? remaining[0]?.id : config.activeProfileId
      await configManager.save('user', { profiles: remaining, activeProfileId })
      await postProfiles()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleSetActiveProfile(id: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const exists = (config.profiles ?? []).some((p) => p.id === id)
      if (!exists) {
        post({ type: 'error', message: `Profile "${id}" no longer exists.` })
        return
      }
      await configManager.save('user', { activeProfileId: id })
      await postProfiles()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Builds a throwaway profile from whatever is currently in the form, so Refresh Models
   * and Test Connection work before the profile is saved. Secrets are read from the store
   * under the form's profile id; a not-yet-saved profile therefore tests only what it can.
   */
  async function profileFromForm(input: ProfileInput): Promise<{ profile: ProviderProfile; auth: Auth } | undefined> {
    const baseUrl = input.baseUrl.trim()
    if (baseUrl.length === 0) {
      post({ type: 'error', message: 'Enter a base URL first.' })
      return undefined
    }

    const id = input.id ?? '__unsaved__'
    // Deliberately writes any typed secret to the store before testing: otherwise a first
    // Test Connection on a new profile could never succeed, which is when it matters most.
    const auth = await buildAuthFromInput(input, id)
    const profile: ProviderProfile = {
      id,
      label: input.label.trim().length > 0 ? input.label.trim() : 'Untitled',
      wireFormat: input.wireFormat,
      baseUrl,
      model: input.model.trim().length > 0 ? input.model.trim() : 'unset',
      auth,
      ...(input.connectionTls !== undefined ? { tls: stripEmpty(input.connectionTls) } : {}),
    }
    return { profile, auth }
  }

  /**
   * Workspace files matching an `@` query, for composer autocomplete.
   *
   * Uses VS Code's own file index rather than walking the tree: it already respects
   * `files.exclude` and `search.exclude`, so `node_modules` never appears, and it stays
   * fast in a large repository where a manual walk would not.
   */
  async function handleMentionCandidates(query: string): Promise<void> {
    if (workspaceRoot === undefined) {
      post({ type: 'mentionCandidates', query, paths: [] })
      return
    }
    try {
      /*
       * Fetch widely, then rank, then cut.
       *
       * The limit used to be the same 30 the list shows, and a file index returns matches in
       * its own order — so in any real repository the thirty that came back were an arbitrary
       * thirty, and the file being typed was often not among them. That is "it is not scanning
       * the codebase properly": the search was fine, the truncation was doing the choosing.
       *
       * The wider fetch is capped too, because `@` runs on every keystroke.
       */
      const pattern = query.length > 0 ? `**/*${query}*` : '**/*'
      const found = await ui.findFiles(pattern, MENTION_SCAN_LIMIT, mentionExcludes(cachedMentionExcludes))
      const paths = found
        .map((absolute) => path.relative(workspaceRoot, absolute).split(path.sep).join('/'))
        .sort(compareMentionCandidates(query))
        .slice(0, MENTION_RESULT_LIMIT)
      post({ type: 'mentionCandidates', query, paths })
    } catch (error) {
      logger.warn('mention lookup failed', String(error))
      post({ type: 'mentionCandidates', query, paths: [] })
    }
  }

  /**
   * Reports the expert's state. Detection runs even when disabled, so the tab can say
   * "found, not enabled" rather than leaving the user guessing whether the path is wrong.
   */
  /**
   * Reports the expert's state — always, including when working it out fails.
   *
   * Every caller used to be `void postExpert()`, so a rejection anywhere in here vanished: no
   * message, no log, and a settings tab stuck on "Checking…" for the life of the session. An
   * answer the user can act on beats silence, even when the answer is "this went wrong".
   */
  async function postExpert(options: { redetect?: boolean } = {}): Promise<void> {
    try {
      await postExpertInner(options.redetect !== false)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn(`could not check the expert CLI: ${reason}`)
      /*
       * A failed *detection* must not report the rest of the settings as gone.
       *
       * This used to post `enabled: false` with no assessment, which is a claim about
       * configuration rather than about the probe that failed — and it wiped whatever the tab
       * was showing. Losing a freshly finished assessment that way is exactly the reported
       * bug. So config is read again, and only availability is reported as unknown.
       */
      const settings = await configManager.load().then(
        (loaded) => loaded.config.expert,
        () => undefined,
      )
      post({
        ...expertMessageFrom(settings),
        available: false,
        path: settings?.path ?? expertCliPath ?? 'claude',
        reason: `Could not check whether the Claude CLI is available: ${reason}`,
      })
    }
  }

  /**
   * Everything the Expert tab is told that comes from *settings* rather than from the probe.
   *
   * One construction, used by both the success and the failure path. They had drifted three
   * times — the guide capability, the programming profile, and the measured pricing all reached
   * one and not the other — and the failure is always the same shape: a panel that shows nothing
   * where something was just saved, with no error to explain it.
   */
  function expertMessageFrom(settings: LightCodeConfig['expert']): Extract<HostToUiMessage, { type: 'expert' }> {
    return {
      type: 'expert',
      enabled: settings?.enabled === true,
      available: false,
      path: settings?.path ?? expertCliPath ?? 'claude',
      maxSpendUsd: settings?.maxSpendUsd ?? 0,
      maxConsultations: settings?.maxConsultations ?? 0,
      keepAlive: settings?.keepAlive === true,
      ...(settings?.model !== undefined ? { model: settings.model } : {}),
      ...(settings?.assessment !== undefined ? { assessment: settings.assessment } : {}),
      ...(settings?.reportsCost !== undefined ? { reportsCost: settings.reportsCost } : {}),
      ...(settings?.pricing !== undefined ? { pricing: settings.pricing } : {}),
      ...(measuringStep !== undefined ? { measuringStep } : {}),
    }
  }

  async function postExpertInner(redetect: boolean): Promise<void> {
    const { config } = await configManager.load()
    const configured = config.expert?.path ?? 'claude'
    /*
     * Re-probing spawns a process. After an assessment we have just used the CLI successfully,
     * so doing it again tells us nothing and does it at the moment the machine is busiest —
     * which is when the probe is most likely to time out and report the CLI as missing.
     */
    const detected =
      !redetect && expertCli !== undefined && expertCliPath === configured ? expertCli : await detectClaudeCli(configured)
    // Cache the probe so the next turn does not re-spawn it.
    expertCli = detected
    expertCliPath = configured

    post({
      // Everything from settings comes from one place, so the two paths cannot drift again.
      ...expertMessageFrom(config.expert),
      available: detected.available,
      path: configured,
      ...(detected.version !== undefined ? { version: detected.version } : {}),
      ...(detected.reason !== undefined ? { reason: detected.reason } : {}),
      ...(assessmentStep === undefined ? {} : { assessing: true, assessmentStep }),
    })
  }

  /**
   * Asks the junior a handful of probes, then has the expert grade the answers.
   *
   * **Evidence, not recall.** Asking the expert what it thinks of a model *name* would produce
   * an authoritative-sounding answer from training data that may predate the release or
   * describe a different quantisation — and would say nothing about this deployment, where a
   * gateway's own prompt and context limit change the behaviour anyway. Grading real answers
   * makes the judgement falsifiable, and the answers are kept so the user can judge it too.
   *
   * Costs one expert consultation plus a few cheap junior calls, which is why it is a button
   * rather than something that happens on its own.
   */
  /**
   * Measures what a consultation costs here, by having two.
   *
   * There is no way to learn the price of a consultation without one, and one sample cannot show
   * the thing that matters — the *ratio* between a cold session and a resumed one, which is what
   * every rule about using the expert cheaply depends on. So it is two calls, and the button says
   * so before it spends anything.
   *
   * Deliberately not part of detection. Detection runs whenever the panel opens; this bills you.
   */
  /**
   * Refreshes the expert's cache before the hour is up, so a break does not cost a cold start.
   *
   * ## Why fifty minutes
   *
   * The cache is one hour (`ephemeral_1h_input_tokens`) and that TTL is Anthropic's, not ours —
   * one hour is already the longer of the two they offer. Fifty leaves room for a slow call
   * without leaving so much that the pings pile up.
   *
   * ## What it will not do
   *
   * It never starts a session, only refreshes one that a real consultation created — a task where
   * the expert was never used should cost nothing at all. It stops the moment the budget is spent,
   * because pinging past a limit the user set to protect themselves is precisely the behaviour
   * that makes a background timer untrustworthy. And its cost is recorded, so nothing is spent
   * that the meter does not show.
   */
  const KEEP_ALIVE_MS = 50 * 60 * 1000
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined

  function stopKeepAlive(): void {
    if (keepAliveTimer === undefined) return
    clearInterval(keepAliveTimer)
    keepAliveTimer = undefined
  }

  function ensureKeepAlive(): void {
    if (keepAliveTimer !== undefined) return
    keepAliveTimer = setInterval(() => {
      void runKeepAlive()
    }, KEEP_ALIVE_MS)
    // Never hold the process open for this. A server waiting to shut down should not be kept
    // alive by a timer whose whole purpose is saving money.
    keepAliveTimer.unref?.()
  }

  async function runKeepAlive(): Promise<void> {
    const session = expertSessionId
    // No session means no cache to keep warm, and starting one would be spending for nothing.
    if (session === undefined) {
      stopKeepAlive()
      stopWatchingSkills()
      return
    }
    try {
      const { config } = await configManager.load()
      if (config.expert?.keepAlive !== true) {
        stopKeepAlive()
        return
      }
      const verdict = checkExpertBudget(expertSpend, effectiveExpertLimits())
      if (!verdict.allowed) {
        logger.info('expert keep-alive stopped: the budget for this task is spent')
        stopKeepAlive()
        return
      }
      const cli = await resolveExpert(config)
      if (cli === undefined) {
        stopKeepAlive()
        return
      }

      const answer = await consultExpert(
        cli,
        {
          question: PRICING_PROBE,
          cwd: workspaceRoot ?? process.cwd(),
          ...(config.expert?.model !== undefined ? { model: config.expert.model } : {}),
          resumeSessionId: session,
        },
        logger,
      )
      /*
       * Counted as a ping, not a consultation. The money goes into the total because money spent
       * is money spent; the count stays separate because a long task must not spend its
       * consultation allowance on automated pings and then refuse the expert when the work needs
       * it.
       */
      expertSpend.keepAlives += 1
      if (answer.costUsd !== undefined) expertSpend.usd += answer.costUsd
      if (answer.sessionId !== undefined) expertSessionId = answer.sessionId
      postExpertSpend()
      logger.info('expert keep-alive refreshed the session cache')
    } catch (error) {
      // A failed ping is not worth interrupting anyone over — the only consequence is paying a
      // cold start later, which is what would have happened anyway.
      logger.warn(`expert keep-alive failed: ${String(error)}`)
    }
  }

  async function handleMeasureExpertCost(): Promise<void> {
    /*
     * Already running. Said rather than ignored: two consultations take a while, and a button
     * that silently does nothing on the second click is indistinguishable from one that is broken
     * — which is exactly how this was reported.
     */
    if (measuringStep !== undefined) {
      post({ type: 'error', message: `Already measuring — ${measuringStep}` })
      return
    }

    /*
     * The panel is told *before* anything is awaited.
     *
     * This used to load config and probe for the CLI first, and probing spawns a process — on
     * Windows through a .cmd shim, which antivirus can make slow. For those seconds the button
     * looked untouched, so a click that was working was indistinguishable from one that had done
     * nothing at all. Whatever else this handler does, the first thing it does is say it started.
     */
    measuringStep = 'Starting…'
    logger.info('measuring what an expert consultation costs')
    await postExpert({ redetect: false })

    try {
      const { config } = await configManager.load()
      const cli = await resolveExpert(config)
      if (cli === undefined) {
        post({
          type: 'error',
          message:
            'The Claude CLI could not be found, so there is nothing to measure. Check the path in this tab.',
        })
        return
      }

      /*
       * A session of its own, discarded afterwards. Measuring inside the task's session would
       * make the first real consultation of that task look cheap, because this one would have
       * paid to establish it — and would leave "reply OK" in the expert's context for the rest
       * of the task.
       */
      let sessionId: string | undefined
      let resumeWorked = false
      const samples: (number | undefined)[] = []

      for (const [index, label] of ['first consultation', 'follow-up in the same session'].entries()) {
        measuringStep = `Measuring the ${label} (${String(index + 1)}/2)…`
        await postExpert({ redetect: false })

        const answer = await consultExpert(
          cli,
          {
            question: PRICING_PROBE,
            cwd: workspaceRoot ?? process.cwd(),
            ...(config.expert?.model !== undefined ? { model: config.expert.model } : {}),
            // Cold on the first pass, resumed on the second. That pair is the measurement.
            ...(sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
          },
          logger,
        )
        samples.push(answer.costUsd)
        /*
         * Whether the *second* pass had a session to resume. Without recording this, a CLI that
         * returns no session id produces two cold starts labelled cold and resumed, and the ratio
         * read off them is meaningless in a way nothing on screen would reveal.
         */
        if (index === 0) resumeWorked = answer.sessionId !== undefined
        sessionId = answer.sessionId ?? sessionId
      }

      const [cold, resumed] = samples
      const reportsCost = cold !== undefined || resumed !== undefined
      const pricing = {
        measuredAt: Date.now(),
        reportsCost,
        resumeWorked,
        ...(cold !== undefined ? { coldUsd: cold } : {}),
        ...(resumed !== undefined ? { resumedUsd: resumed } : {}),
      }

      const { config: current } = await configManager.load()
      await configManager.save('user', {
        ...current,
        expert: { ...current.expert, pricing, reportsCost },
      })
      logger.info(
        reportsCost
          ? `expert pricing measured: cold ${String(cold)} / resumed ${String(resumed)}`
          : 'expert pricing measured: this plan reports no cost per consultation',
      )
    } catch (error) {
      post({ type: 'error', message: `Could not measure the expert's cost: ${String(error)}` })
    } finally {
      measuringStep = undefined
      await postExpert({ redetect: false })
    }
  }

  async function handleAssessJunior(): Promise<void> {
    if (assessmentStep !== undefined) return
    try {
      const { config } = await configManager.load()
      const cli = await resolveExpert(config)
      if (cli === undefined) {
        post({ type: 'error', message: 'Enable the expert first — the assessment is its judgement, not ours.' })
        return
      }

      const profile = resolveActiveProfile(config)
      const provider = createChatProvider(profile, httpClient, authStrategyFor(config, profile), logger)

      const results: ProbeResult[] = []
      for (const [index, probe] of ASSESSMENT_PROBES.entries()) {
        assessmentStep = `Asking the junior: ${probe.measures} (${String(index + 1)}/${String(ASSESSMENT_PROBES.length)})`
        await postExpert({ redetect: false })

        let answer = ''
        try {
          /*
           * No tools and no system prompt beyond the probe. The point is to measure the model,
           * not the scaffolding around it — and a probe that could call `read_file` would
           * measure whether the harness works.
           */
          for await (const chunk of provider.streamChat([{ role: 'user', content: probe.prompt }])) {
            if (chunk.type === 'text') answer += chunk.text
            // A provider that streams an error rather than throwing is still a failed probe.
            if (chunk.type === 'error') throw new Error(chunk.error)
          }
          results.push({ id: probe.id, measures: probe.measures, prompt: probe.prompt, answer })
        } catch (error) {
          // A probe that fails is itself a finding — a model that times out on five short
          // questions is one the expert should know about.
          results.push({
            id: probe.id,
            measures: probe.measures,
            prompt: probe.prompt,
            answer,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      assessmentStep = 'Asking the expert to grade the answers'
      await postExpert({ redetect: false })

      const graded = await consultExpert(cli, {
        question: buildAssessmentQuestion(profile.model, results),
        cwd: workspaceRoot ?? process.cwd(),
        ...(config.expert?.model !== undefined ? { model: config.expert.model } : {}),
      })

      // Counted like any other consultation: it spent the user's money, and a total that
      // quietly omitted it would understate the spend.
      recordConsultation({ isError: graded.isError, ...(graded.costUsd !== undefined ? { costUsd: graded.costUsd } : {}) })

      if (graded.isError) {
        post({ type: 'error', message: `The expert could not assess the junior: ${graded.text}` })
        return
      }

      const assessment: JuniorAssessment = {
        model: profile.model,
        profileLabel: profile.label ?? profile.model,
        assessedAt: Date.now(),
        verdict: graded.text.trim(),
        probes: results,
        ...(graded.costUsd !== undefined ? { costUsd: graded.costUsd } : {}),
      }

      const latest = (await configManager.load()).config
      await configManager.save('user', { expert: { ...latest.expert, assessment } })
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      assessmentStep = undefined
      await postExpert({ redetect: false })
    }
  }

  async function handleClearAssessment(): Promise<void> {
    const { config } = await configManager.load()
    const expert = { ...config.expert }
    delete expert.assessment
    await configManager.save('user', { expert })
    await postExpert()
  }

  async function handleSetExpert(
    enabled: boolean,
    cliPath?: string,
    model?: string,
    limits?: { maxSpendUsd?: number; maxConsultations?: number },
  ): Promise<void> {
    try {
      const { config } = await configManager.load()
      await configManager.save('user', {
        expert: {
          ...config.expert,
          enabled,
          ...(cliPath !== undefined && cliPath.length > 0 ? { path: cliPath } : {}),
          ...(model !== undefined && model.length > 0 ? { model } : { model: undefined }),
          ...(limits?.maxSpendUsd !== undefined ? { maxSpendUsd: limits.maxSpendUsd } : {}),
          ...(limits?.maxConsultations !== undefined ? { maxConsultations: limits.maxConsultations } : {}),
        },
      })
      // Reloaded so the cap applies to the next consultation rather than to the next task.
      await loadSettings()
      postExpertSpend()
      // Force re-detection: the path may have changed, and a stale probe would report the
      // old binary as still present.
      expertCli = undefined
      expertCliPath = undefined
      await postExpert()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Builds a connection for *any* vector store, resolving credentials from secure storage and
   * the CA from disk at call time rather than caching either.
   *
   * **Backend-neutral, and named so since Qdrant and Chroma arrived.** It was
   * `openSearchConnectionFor`, which was accurate when there was one backend and became a lie
   * the moment there were three — the sort of name that has someone add a second, subtly
   * different connection builder rather than reuse this one. `OpenSearchConnection` is itself
   * an alias of `VectorStoreConnection` for the same reason.
   *
   * Every backend therefore inherits the global TLS block: a corporate root set once in
   * Settings → Network covers the gateway, the token endpoint, the embedder and the vector
   * store alike, and a per-connection CA adds to it rather than replacing it (§19).
   */
  async function vectorStoreConnectionFor(store: VectorStoreConfig, id: string): Promise<OpenSearchConnection> {
    const connection: OpenSearchConnection = { url: store.url, label: store.label }

    const username = store.usernameRef !== undefined ? await secrets.get(searchUserRefFor(id)) : undefined
    const password = store.passwordRef !== undefined ? await secrets.get(searchPasswordRefFor(id)) : undefined
    if (username !== undefined) connection.username = username
    if (password !== undefined) connection.password = password

    // Same resolver the gateway uses, so a corporate root set once in Settings → Network
    // covers the cluster too, and a per-cluster CA adds to it rather than replacing it.
    const { config } = await configManager.load()
    const perStore = vectorStoreTls(store)
    const passphraseRef = perStore?.passphraseRef ?? config.tls?.passphraseRef
    const tls = await resolveConnectionTls({
      ...(config.tls !== undefined ? { global: config.tls } : {}),
      ...(perStore !== undefined ? { connection: perStore } : {}),
      ...(config.certDir !== undefined ? { certDir: config.certDir } : {}),
      ...(passphraseRef !== undefined ? { passphrase: await secrets.get(passphraseRef) } : {}),
      onPaths: (paths) => {
        void Promise.all(paths.map((certPath) => denylist.add(certPath))).catch((error: unknown) => {
          logger.warn('could not add cert path to the deny list', String(error))
        })
      },
    })
    if (tls !== undefined) connection.tls = tls as NonNullable<OpenSearchConnection['tls']>
    return connection
  }

  async function openSearchClientFor(store: VectorStoreConfig, id: string): Promise<OpenSearchClient> {
    return new OpenSearchClient(httpClient, await vectorStoreConnectionFor(store, id))
  }

  /** The read half of whichever backend the active store names. Never a writer. */
  async function vectorSearcherFor(store: VectorStoreConfig, id: string): Promise<VectorSearcher> {
    return createVectorSearcher(httpClient, store, await vectorStoreConnectionFor(store, id))
  }

  /**
   * The active connection for this session, or undefined when search is off.
   *
   * Search tools exist only when a connection is selected — §12 requires the tool set to be
   * stable within a session, so selection is the boundary at which it may change.
   */
  async function resolveSearch(config: LightCodeConfig): Promise<
    | {
        /** Backend-neutral, for `search_codebase`. */
        searcher: VectorSearcher
        /**
         * Present only for an OpenSearch cluster, and that is the seam working as intended:
         * `search_docs` queries the organisation's *existing* indexes with raw DSL, which
         * Qdrant and Chroma have no counterpart for. When a future backend is active this is
         * undefined and the tool is simply not offered, rather than offered and broken.
         */
        opensearch?: OpenSearchClient
        store: VectorStoreConfig
        id: string
      }
    | undefined
  > {
    const id = config.activeVectorStoreId
    if (id === undefined) return undefined
    const store = config.vectorStores?.[id]
    if (store === undefined) return undefined
    try {
      return {
        searcher: await vectorSearcherFor(store, id),
        ...(store.kind === 'opensearch' ? { opensearch: await openSearchClientFor(store, id) } : {}),
        store,
        id,
      }
    } catch (error) {
      logger.warn('could not build the search client', String(error))
      return undefined
    }
  }

  /**
   * Front of every derived index name, overridable so a shared cluster can distinguish teams.
   * Changing it points at *new* collections — the old ones keep their data until deleted.
   */
  const DEFAULT_INDEX_PREFIX = 'light-code'

  /** The index Light Code writes this workspace into. User-set or derived; never model-supplied. */
  function codebaseIndexName(config?: LightCodeConfig): string | undefined {
    const chosen = config?.embedder?.indexName?.trim()
    if (chosen !== undefined && chosen.length > 0) return chosen
    if (workspaceRoot === undefined) return undefined
    // Derived from the workspace path so two projects on one cluster do not collide, and
    // so the same project reindexes into the same place. Hashed because an index name
    // cannot contain most path characters.
    const digest = createHash('sha256').update(path.resolve(workspaceRoot).toLowerCase()).digest('hex').slice(0, 16)
    return `${config?.embedder?.indexPrefix ?? DEFAULT_INDEX_PREFIX}-${digest}`
  }

  /**
   * Where the tool and skill documentation corpus lives.
   *
   * Derived from the codebase index name rather than configured separately, so enabling
   * retrieval does not require the user to invent and type a second collection name. It is a
   * *separate* collection because the two corpora have different lifetimes: code changes on
   * every edit, the tool catalogue only when a server or skill is added.
   */
  function docsIndexName(config?: LightCodeConfig): string | undefined {
    const chosen = config?.retrieval?.docsIndex?.trim()
    if (chosen !== undefined && chosen.length > 0) return chosen
    const base = codebaseIndexName(config)
    return base === undefined ? undefined : `${base}-docs`
  }

  /**
   * The embedder, built over an existing provider profile.
   *
   * A profile already carries a working base URL, auth strategy, client certificate and CA.
   * Duplicating that would mean two places to get mutual TLS right instead of one.
   */
  async function resolveEmbedder(config: LightCodeConfig): Promise<Embedder | undefined> {
    const settings = config.embedder
    if (settings?.profileId === undefined || settings.model === undefined || settings.dimensions === undefined) {
      return undefined
    }
    const profile = config.profiles?.find((candidate) => candidate.id === settings.profileId)
    if (profile === undefined) {
      logger.warn(`embedder points at profile "${settings.profileId}", which no longer exists`)
      return undefined
    }
    return new Embedder(httpClient, {
      profile,
      auth: authStrategyFor(config, profile),
      model: settings.model,
      dimensions: settings.dimensions,
    })
  }

  /**
   * Files git would not ignore, as a lookup set.
   *
   * `rg --files` rather than a hand-written `.gitignore` parser: ripgrep is already here,
   * and gitignore semantics — negation, `**`, anchoring, nested ignore files — are much
   * easier to get subtly wrong than to delegate. Returning `undefined` means "no ignore
   * information", and the indexer then relies on its own skip list alone.
   */
  async function ignoredFilesPredicate(): Promise<((relative: string) => boolean) | undefined> {
    if (workspaceRoot === undefined || ripgrepPath === undefined) return undefined
    try {
      const listed = await new Promise<string>((resolve, reject) => {
        const child = spawn(ripgrepPath, ['--files', '--hidden', '--glob', '!.git'], { cwd: workspaceRoot })
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
        child.on('error', reject)
        // ripgrep exits 1 when it lists nothing, which is not an error here.
        child.on('close', () => resolve(out))
      })
      const allowed = new Set(
        listed
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
          .map((line) => line.split(/[\\/]/).join('/')),
      )
      if (allowed.size === 0) return undefined
      // Directories are never reported as ignored: pruning them here would need the same
      // gitignore semantics this delegation exists to avoid. The per-file check is enough.
      return (relative) => !relative.endsWith('/') && !allowed.has(relative)
    } catch (error) {
      logger.warn('could not list files with ripgrep; indexing will use its own skip list only', String(error))
      return undefined
    }
  }

  let indexingAbort: AbortController | undefined

  /**
   * Saves one field of the `retrieval` block without dropping the others.
   *
   * `ConfigManager.save` merges one level only, so `{ retrieval: { skills: true } }` replaces
   * the whole block rather than adding to it. With a single toggle that was invisible; with two
   * it means each one silently switches the other off, and it has always quietly discarded a
   * hand-set `docsIndex` — which nothing in the UI writes, so nobody would connect the loss to
   * having clicked a checkbox.
   *
   * Merging here rather than making `save` deep: an array or a keyed map is *meant* to be
   * replaced, and a deep merge would make removing an entry from `approvals` or `profiles`
   * impossible. The nesting is this block's problem, so the fix belongs to this block.
   *
   * Reading the merged config is correct because `retrieval` is user-scope only (invariant 5),
   * so the merged view and the user file agree by construction.
   */
  async function saveRetrieval(patch: Partial<NonNullable<LightCodeConfig['retrieval']>>): Promise<void> {
    const { config } = await configManager.load()
    await configManager.save('user', { retrieval: { ...config.retrieval, ...patch } })
  }

  /**
   * Reports the dispatcher's state to the UI, including how many tools it is actually hiding.
   *
   * The count is the useful part: the setting is only worth having when the catalogue is big
   * enough to crowd the prompt, and "hides 2 tools" tells the user to leave it off far better
   * than any explanatory paragraph.
   */
  async function postDispatcher(): Promise<void> {
    const { config } = await configManager.load()
    // The skill count is part of what this reports, and nothing else has necessarily loaded
    // it yet — the panel can be opened before a single turn has run.
    await refreshSkills()
    const enabled = dispatcherEnabled(config.retrieval)
    // Counted with the dispatcher forced on, so the number answers "how many *would* be
    // hidden" while it is still switched off.
    const hidden = currentToolRegistry(undefined, undefined, undefined, undefined, true, true).dispatchOnlyList().length
    const index = docsIndexName(config)
    post({
      type: 'dispatcher',
      enabled,
      hiddenTools: hidden,
      skills: skillRetrievalEnabled(config.retrieval),
      hiddenSkills: skills.length,
      ...(index !== undefined ? { docsIndex: index } : {}),
    })
  }

  /**
   * Indexes the tool and skill documentation so `search_docs` can match by meaning.
   *
   * Separate from `handleStartIndexing` despite the similarity, because the two corpora have
   * nothing in common but the machinery: this one walks no files, respects no gitignore, and
   * changes when a server or skill is added rather than when code is edited. Folding them
   * together would mean re-embedding the whole workspace to pick up one new MCP tool.
   *
   * Small enough to write in one pass — a few hundred documents at most — so there is no
   * manifest, no incremental diffing and no progress reporting. It simply replaces the
   * collection's contents.
   */
  /**
   * The fingerprint of the corpus that was last written, kept beside the codebase manifests.
   *
   * Auto-reindexing without this would re-embed the whole catalogue every time an MCP server
   * reconnected, which happens on every panel open. Hashing what *would* be written and
   * comparing is far cheaper than embedding it — and the embedder model is part of the hash,
   * because changing model makes every stored vector incomparable with new ones.
   */
  function docsFingerprintPath(index: string, storeId: string): string {
    return path.join(storageDir, 'index-manifests', `${manifestKey(index, storeId)}.docs.json`)
  }

  /**
   * The bookkeeping key for one index **in one store**.
   *
   * These files record "everything up to here is already written", and that is a claim about a
   * particular collection in a particular backend — not about a name. Keyed on the name alone,
   * switching from OpenSearch to Qdrant left a manifest asserting the new, empty collection was
   * already populated: the codebase indexer would skip every unchanged file and the docs
   * reindex would report `unchanged` and write nothing, so search returned no results with no
   * error anywhere. Silence is the worst shape that failure could take.
   *
   * Including the store id means switching backends starts from an honest blank slate, and
   * switching *back* finds the earlier manifest still valid — the data in that cluster never
   * went anywhere.
   */
  function manifestKey(index: string, storeId: string): string {
    return `${index}@${storeId}`
  }

  async function readDocsFingerprint(index: string, storeId: string): Promise<string | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(docsFingerprintPath(index, storeId), 'utf8')) as { fingerprint?: unknown }
      return typeof raw.fingerprint === 'string' ? raw.fingerprint : undefined
    } catch {
      return undefined
    }
  }

  interface DocsIndexOutcome {
    indexed?: number
    index?: string
    error?: string
    /** True when the corpus was already up to date and nothing was embedded. */
    unchanged?: boolean
  }

  /**
   * Writes the tool and skill documentation corpus into its collection.
   *
   * `force` is what separates the button from the automatic path: pressing Index
   * documentation should visibly do something even when nothing has changed, whereas the
   * automatic trigger must cost nothing when the catalogue is the same as last time.
   */
  async function indexDocs(options: { force: boolean }): Promise<DocsIndexOutcome> {
    const { config } = await configManager.load()
    const index = docsIndexName(config)
    const search = await resolveSearch(config)
    const embedder = await resolveEmbedder(config)

    if (index === undefined) return { error: 'Open a folder first — the documentation index is named after it.' }
    if (search === undefined) return { error: 'Choose a search connection in Settings → Search first.' }
    if (embedder === undefined) return { error: 'Configure an embedding model in Settings → Search first.' }

    try {
      /*
       * Built with the dispatcher forced on, whatever the current setting. Otherwise nothing
       * would be dispatch-only at this moment and the corpus would come out empty — indexing
       * has to describe the catalogue as it will be *used*, not as it happens to be right now.
       */
      const registry = currentToolRegistry(undefined, undefined, undefined, undefined, true)
      const entries = buildDocCorpus({ dispatchOnlyTools: registry.dispatchOnlyList(), skills })

      const fingerprint = createHash('sha256')
        .update(`${embedder.model}:${String(embedder.dimensions)}`)
        .update(entries.map((entry) => `${entry.id}\u0000${entry.text}`).join('\u0001'))
        .digest('hex')

      if (!options.force && fingerprint === (await readDocsFingerprint(index, search.id))) {
        return { unchanged: true, index, indexed: entries.length }
      }

      if (entries.length === 0) return { indexed: 0, index }

      const writer = createVectorIndexWriter(
        httpClient,
        search.store,
        await vectorStoreConnectionFor(search.store, search.id),
      )
      await writer.ensureCollection(index, embedder.dimensions)

      const vectors = await embedder.embedBatch(entries.map((entry) => entry.text))
      const documents = entries.flatMap((entry, position) => {
        const vector = vectors[position]
        if (vector === undefined) return []
        // `path` carries the qualified id — see rag/toolDocs.ts for why that field is reused
        // rather than adding a second collection shape across every backend.
        return [{ id: entry.id, text: entry.text, path: entry.id, startLine: 1, endLine: 1, vector }]
      })

      /*
       * Entries that vanished — a server removed, a skill deleted — are deleted first.
       * Upserting alone would leave them matchable forever, and `search_docs` would keep
       * offering a tool the model cannot call.
       */
      const keep = new Set(documents.map((document) => document.id))
      const stale = (await writer.listPaths(index)).filter((existing) => !keep.has(existing))
      if (stale.length > 0) await writer.deleteByPaths(index, stale)
      await writer.upsert(index, documents)

      /*
       * Written only after the store accepted everything. A fingerprint saved before the
       * write would make a failed run look successful, and nothing would retry it.
       */
      await fs.mkdir(path.dirname(docsFingerprintPath(index, search.id)), { recursive: true })
      await fs.writeFile(
        docsFingerprintPath(index, search.id),
        JSON.stringify({ fingerprint, indexedAt: Date.now(), count: documents.length }),
        'utf8',
      )

      return { indexed: documents.length, index }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Runs a query by hand, through the same code path the model uses.
   *
   * Deliberately the *same* path rather than a simplified one. A panel that approximated the
   * real search would prove something, just not the thing being debugged — the whole reason
   * `runDocsSearch` was split out of the tool is so this cannot drift from it.
   */
  async function handleSearchProbe(query: string, target: 'codebase' | 'docs'): Promise<void> {
    try {
      const { config } = await configManager.load()
      const search = await resolveSearch(config)
      const embedder = await resolveEmbedder(config)

      if (target === 'codebase') {
        const index = codebaseIndexName(config)
        if (search === undefined || embedder === undefined || index === undefined) {
          post({
            type: 'searchProbe',
            query,
            text: '',
            error: 'Searching the codebase needs a connection, an embedding model and an indexed workspace.',
          })
          return
        }
        const tool = createSearchCodebaseTool({
          searcher: search.searcher,
          embedder,
          index,
          connectionLabel: search.store.label,
          observer: searchLog,
        })
        const result = await tool.execute({ query }, {} as ToolExecutionContext)
        post({
          type: 'searchProbe',
          query,
          text: result.content,
          ...(result.isError === true ? { error: 'The search failed.' } : {}),
        })
        return
      }

      /*
       * Built with the dispatcher forced on, so the probe searches the catalogue as it would
       * be *used*. With it off nothing is dispatch-only and the probe would report an empty
       * corpus, which says nothing about whether the index works.
       */
      const registry = currentToolRegistry(undefined, undefined, undefined, undefined, true)
      const docsIndex = docsIndexName(config)
      const tool = createSearchDocsTool({
        listTools: () => registry.list(),
        listSkills: () => skills,
        ...(search !== undefined && embedder !== undefined && docsIndex !== undefined
          ? { retrieval: { searcher: search.searcher, embedder, index: docsIndex } }
          : {}),
        observer: searchLog,
      })
      const result = await tool.execute({ query }, {} as ToolExecutionContext)
      post({
        type: 'searchProbe',
        query,
        text: result.content,
        ...(result.isError === true ? { error: 'The search failed.' } : {}),
      })
    } catch (error) {
      post({ type: 'searchProbe', query, text: '', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Empties the documentation index.
   *
   * Done with the writer's own `listPaths` + `deleteByPaths` rather than a new drop-collection
   * method: every backend already has to support both for stale-entry reconciliation, so this
   * needs nothing added to `VectorIndexWriter` and works the same on whatever is configured.
   * The collection is left in place — deleting it would take its mapping and vector width
   * with it, and the next index would have to guess them again.
   *
   * The fingerprint file goes too. Without that the automatic reindex would compare the corpus
   * against a hash that still matches, decide nothing had changed, and leave the index empty
   * indefinitely.
   */
  /**
   * Copies this workspace's index out of another store into the active one.
   *
   * Exists so switching backend does not mean paying to re-embed a whole repository. The
   * safety condition — that both sides were embedded by the same model, at the same width,
   * with the same chunking — is read from the *source's* manifest, which the indexer already
   * writes for its own diffing. Mixing embeddings would produce confident, plausible, wrong
   * neighbours with no error anywhere, which is why this refuses rather than warns.
   *
   * The manifest is copied across on success, so the destination inherits an accurate record
   * of what it now contains and the next incremental index does the right thing.
   */
  async function handleSyncVectorStore(fromId: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const target = await resolveSearch(config)
      const source = config.vectorStores?.[fromId]
      if (target === undefined || source === undefined) {
        post({ type: 'storeSync', running: false, error: 'Choose a search connection first.' })
        return
      }
      if (fromId === target.id) {
        post({ type: 'storeSync', running: false, error: 'That is the store you are already using.' })
        return
      }

      const index = codebaseIndexName(config)
      const embedder = await resolveEmbedder(config)
      if (index === undefined || embedder === undefined) {
        post({ type: 'storeSync', running: false, error: 'Configure an embedding model in Settings → Search first.' })
        return
      }

      post({ type: 'storeSync', running: true, fromLabel: source.label })

      const sourcePath = path.join(storageDir, 'index-manifests', `${manifestKey(index, fromId)}.json`)
      const manifest = await fs
        .readFile(sourcePath, 'utf8')
        .then((raw) => JSON.parse(raw) as IndexManifest)
        .catch(() => undefined)

      const result = await syncVectorStores({
        from: createVectorIndexWriter(httpClient, source, await vectorStoreConnectionFor(source, fromId)),
        to: createVectorIndexWriter(httpClient, target.store, await vectorStoreConnectionFor(target.store, target.id)),
        collection: index,
        manifest,
        current: { model: embedder.model, dimensions: embedder.dimensions },
        onProgress: (progress) => post({ type: 'storeSync', running: true, copied: progress.copied, fromLabel: source.label }),
      })

      // The destination inherits the record of what it now holds, so the next incremental
      // index diffs against the truth rather than re-embedding everything.
      if (manifest !== undefined) {
        const targetPath = path.join(storageDir, 'index-manifests', `${manifestKey(index, target.id)}.json`)
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await fs.writeFile(targetPath, JSON.stringify(manifest), 'utf8')
      }

      post({ type: 'storeSync', running: false, copied: result.copied, fromLabel: source.label })
    } catch (error) {
      post({ type: 'storeSync', running: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleClearDocsIndex(): Promise<void> {
    const { config } = await configManager.load()
    const index = docsIndexName(config)
    const search = await resolveSearch(config)

    if (index === undefined || search === undefined) {
      post({ type: 'docsIndexed', error: 'Choose a search connection in Settings → Search first.' })
      return
    }

    try {
      const writer = createVectorIndexWriter(
        httpClient,
        search.store,
        await vectorStoreConnectionFor(search.store, search.id),
      )
      const existing = await writer.listPaths(index)
      if (existing.length > 0) await writer.deleteByPaths(index, existing)
      await fs.rm(docsFingerprintPath(index, search.id), { force: true })
      post({ type: 'docsIndexed', indexed: 0, index })
      logger.info(`cleared ${String(existing.length)} documentation entries from "${index}"`)
    } catch (error) {
      post({ type: 'docsIndexed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleIndexDocs(): Promise<void> {
    const outcome = await indexDocs({ force: true })
    post({
      type: 'docsIndexed',
      ...(outcome.indexed !== undefined ? { indexed: outcome.indexed } : {}),
      ...(outcome.index !== undefined ? { index: outcome.index } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    })
  }

  let docsReindexTimer: ReturnType<typeof setTimeout> | undefined
  let docsReindexRunning = false

  /**
   * Reindexes the documentation after the catalogue changes, without being asked.
   *
   * **Debounced, because the triggers arrive in bursts.** Opening the panel connects every
   * MCP server and each one fires a state change; a skill written by the model fires another.
   * A few seconds of quiet coalesces those into a single run.
   *
   * Silent by design. This is background upkeep, and a notification every time a server
   * reconnected would be worse than the staleness it fixes — the fingerprint means the common
   * case does no work at all. Failures are logged rather than surfaced, and the next trigger
   * retries because the fingerprint is only written on success.
   */
  function scheduleDocsReindex(reason: string): void {
    if (docsReindexTimer !== undefined) clearTimeout(docsReindexTimer)
    docsReindexTimer = setTimeout(() => {
      docsReindexTimer = undefined
      if (docsReindexRunning) {
        // A run is already in flight. Queue behind it rather than embedding the same corpus
        // twice concurrently and racing over which result lands last.
        scheduleDocsReindex(reason)
        return
      }
      docsReindexRunning = true
      void (async () => {
        try {
          const { config } = await configManager.load()
          /*
           * Only worth doing when the schemas are actually hidden — with the dispatcher off
           * nothing consults this index, so indexing would be pure cost.
           *
           * Read through `dispatcherEnabled`, not `=== true`. This was written when the
           * dispatcher was off by default, and reading the key directly meant that once the
           * default flipped, every user who had never opened the setting had their tools hidden
           * and their documentation never indexed — findable only by the lexical fallback,
           * which is exactly the "it does not pick up my tools" report this came from.
           */
          if (!dispatcherEnabled(config.retrieval)) return
          const outcome = await indexDocs({ force: false })
          if (outcome.error !== undefined) {
            logger.warn(`documentation reindex failed (${reason}): ${outcome.error}`)
          } else if (outcome.unchanged !== true) {
            logger.info(`documentation reindexed (${reason}): ${String(outcome.indexed ?? 0)} entries`)
            post({
              type: 'docsIndexed',
              ...(outcome.indexed !== undefined ? { indexed: outcome.indexed } : {}),
              ...(outcome.index !== undefined ? { index: outcome.index } : {}),
            })
          }
        } finally {
          docsReindexRunning = false
        }
      })()
    }, 3_000)
  }

  async function handleStartIndexing(): Promise<void> {
    if (indexingAbort !== undefined) {
      post({ type: 'error', message: 'Indexing is already running.' })
      return
    }
    const { config } = await configManager.load()
    const index = codebaseIndexName(config)
    const search = await resolveSearch(config)
    const embedder = await resolveEmbedder(config)

    if (index === undefined || workspaceRoot === undefined) {
      post({ type: 'error', message: 'Open a folder before indexing.' })
      return
    }
    const root = workspaceRoot
    if (search === undefined) {
      post({ type: 'error', message: 'Choose a search connection in Settings → Search first.' })
      return
    }
    if (embedder === undefined) {
      post({ type: 'error', message: 'Configure an embedding model in Settings → Search first.' })
      return
    }

    indexingAbort = new AbortController()
    const manifestPath = path.join(storageDir, 'index-manifests', `${manifestKey(index, search.id)}.json`)
    try {
      const manifest = await loadIndexManifest(manifestPath, embedder)
      const isIgnored = await ignoredFilesPredicate()

      const result = await indexWorkspace({
        workspaceRoot: root,
        index,
        embedder,
        // The one place a writer is built. Not reachable from any tool — a user starts this
        // from Settings, which is what keeps the model unable to write to a cluster at all.
        writer: createVectorIndexWriter(httpClient, search.store, await vectorStoreConnectionFor(search.store, search.id)),
        denylist,
        manifest,
        saveManifest: async (next) => {
          await fs.mkdir(path.dirname(manifestPath), { recursive: true })
          await fs.writeFile(manifestPath, JSON.stringify(next), 'utf8')
        },
        ...(isIgnored !== undefined ? { isIgnored } : {}),
        onProgress: (progress: IndexProgress) => post({ type: 'indexProgress', progress }),
        signal: indexingAbort.signal,
      })
      post({ type: 'indexResult', result })
    } catch (error) {
      post({
        type: 'indexResult',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      indexingAbort = undefined
    }
  }

  async function loadIndexManifest(manifestPath: string, embedder: Embedder): Promise<IndexManifest> {
    try {
      return JSON.parse(await fs.readFile(manifestPath, 'utf8')) as IndexManifest
    } catch {
      // Missing or unreadable both mean "index everything", which is correct and safe —
      // the worst case is re-embedding work that was already done.
      return { model: embedder.model, dimensions: embedder.dimensions, chunkSignature: chunkSignatureFor(undefined), files: {} }
    }
  }

  async function postPython(): Promise<void> {
    const saved = (await configManager.load().then((loaded) => loaded.config.python, () => undefined)) ?? {}
    post({
      type: 'python',
      status: python.status(),
      settings: {
        dynamicTools: saved.dynamicTools ?? 'off',
        ...(saved.uvPath !== undefined ? { uvPath: saved.uvPath } : {}),
        ...(saved.toolsDir !== undefined ? { toolsDir: saved.toolsDir } : {}),
        ...(saved.venvPath !== undefined ? { venvPath: saved.venvPath } : {}),
        ...(saved.indexUrl !== undefined ? { indexUrl: saved.indexUrl } : {}),
        ...(saved.offline !== undefined ? { offline: saved.offline } : {}),
        ...(saved.timeoutSeconds !== undefined ? { timeoutSeconds: saved.timeoutSeconds } : {}),
      },
    })
    // Python tools are part of the corpus, and this fires whenever the registry reloads —
    // a tool created, updated, deleted, or the folder pointed somewhere else.
    scheduleDocsReindex('Python tools changed')
  }

  async function handleSetPython(input: Extract<UiToHostMessage, { type: 'setPython' }>): Promise<void> {
    try {
      await configManager.save('user', {
        python: {
          dynamicTools: input.dynamicTools,
          ...(input.uvPath !== undefined && input.uvPath.length > 0 ? { uvPath: input.uvPath } : {}),
          // Absent rather than empty when cleared, so the manager falls back to
          // `.lightcode/tools` instead of resolving an empty string against the workspace.
          ...(input.toolsDir !== undefined && input.toolsDir.trim().length > 0
            ? { toolsDir: input.toolsDir.trim() }
            : {}),
          ...(input.venvPath !== undefined && input.venvPath.trim().length > 0
            ? { venvPath: input.venvPath.trim() }
            : {}),
          ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
          ...(input.indexUrl !== undefined && input.indexUrl.length > 0 ? { indexUrl: input.indexUrl } : {}),
          ...(input.offline !== undefined ? { offline: input.offline } : {}),
        },
      })
      const { config } = await configManager.load()
      // Applied immediately rather than at the next turn: switching it on should show the
      // environment coming up, not sit silent until the user happens to send a message.
      await python.configure(config.python ?? {})
      await postPython()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function postEmbedder(config: LightCodeConfig): Promise<void> {
    const index = codebaseIndexName(config)
    let indexedFiles = 0
    if (index !== undefined) {
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(storageDir, 'index-manifests', `${index}.json`), 'utf8'),
        ) as IndexManifest
        indexedFiles = Object.keys(manifest.files ?? {}).length
      } catch {
        // No manifest yet means nothing has been indexed, which is the honest zero.
      }
    }
    post({
      type: 'embedder',
      ...(config.embedder?.profileId !== undefined ? { profileId: config.embedder.profileId } : {}),
      ...(config.embedder?.model !== undefined ? { model: config.embedder.model } : {}),
      ...(config.embedder?.dimensions !== undefined ? { dimensions: config.embedder.dimensions } : {}),
      ...(index !== undefined ? { indexName: index } : {}),
      // The configured value, not the resolved one, so the field round-trips what was typed
      // rather than replacing a blank with the default and looking like it was set.
      ...(config.embedder?.indexPrefix !== undefined ? { indexPrefix: config.embedder.indexPrefix } : {}),
      defaultIndexPrefix: DEFAULT_INDEX_PREFIX,
      indexedFiles,
    })
  }

  async function handleSaveEmbedder(
    profileId: string,
    model: string,
    dimensions: number,
    indexName?: string,
    indexPrefix?: string,
  ): Promise<void> {
    try {
      await configManager.save('user', {
        embedder: {
          profileId,
          model,
          dimensions,
          ...(indexName !== undefined && indexName.trim().length > 0 ? { indexName: indexName.trim() } : {}),
          // Absent rather than empty when cleared, so the default applies instead of a name
          // beginning with a stray dash.
          ...(indexPrefix !== undefined && indexPrefix.trim().length > 0 ? { indexPrefix: indexPrefix.trim() } : {}),
        },
      })
      const { config } = await configManager.load()
      await postEmbedder(config)
      /*
       * A changed prefix means different collection names, so whatever is in the new ones is
       * unrelated to what was in the old. The documentation corpus is small enough to just
       * rebuild; the codebase index is not, and the user has to press Index for that.
       */
      scheduleDocsReindex('index prefix changed')
      // Confirmed explicitly. The form resyncs to the same values it just sent, so without
      // this a successful save is visually indistinguishable from nothing happening.
      post({ type: 'embedderSaved' })
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Lists models for a saved profile, reusing its stored credentials and TLS. */
  async function handleRequestEmbedderModels(profileId: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const profile = config.profiles?.find((candidate) => candidate.id === profileId)
      if (profile === undefined) {
        post({ type: 'embedderModels', models: [], warning: 'That profile no longer exists.' })
        return
      }
      const result = await listModels(httpClient, profile, authStrategyFor(config, profile))
      post({
        type: 'embedderModels',
        models: result.ids,
        ...(result.warning !== undefined ? { warning: result.warning } : {}),
      })
    } catch (error) {
      // Never fatal: a gateway that publishes no catalogue is normal, and free-text entry
      // has to keep working regardless (§9).
      post({ type: 'embedderModels', models: [], warning: error instanceof Error ? error.message : String(error) })
    }
  }

  /** One SecretStorage key for the global key passphrase — there is only ever one. */
  const GLOBAL_PASSPHRASE_REF = 'tls:global:passphrase'

  async function postNetwork(): Promise<void> {
    const { config } = await configManager.load()
    // `passphraseRef` is dropped rather than sent: it is a pointer at a secret, and the UI
    // only ever needs to know whether one exists (invariant 7).
    const tls = { ...(config.tls ?? {}) }
    delete tls.passphraseRef
    post({
      type: 'network',
      settings: {
        ...(config.certDir !== undefined ? { certDir: config.certDir } : {}),
        tls,
        // The store, not config, decides this: the two can diverge, and only one of them
        // actually holds the passphrase.
        hasPassphrase: (await secrets.get(GLOBAL_PASSPHRASE_REF)) !== undefined,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      },
    })
  }

  async function handleSaveNetwork(input: NetworkSettingsInput): Promise<void> {
    try {
      const certDir = input.certDir?.trim()
      if (certDir !== undefined && certDir.length > 0) {
        // Invariant 6, checked at save time so the error names the field rather than
        // surfacing later as a puzzling handshake failure.
        assertCertDirOutsideWorkspace(certDir, workspaceRoot)
      }

      if (input.passphrase !== undefined) {
        if (input.passphrase.length > 0) await secrets.set(GLOBAL_PASSPHRASE_REF, input.passphrase)
        else await secrets.delete(GLOBAL_PASSPHRASE_REF)
      }

      const tls = stripEmpty(input.tls) as NonNullable<LightCodeConfig['tls']>
      if ((await secrets.get(GLOBAL_PASSPHRASE_REF)) !== undefined) tls.passphraseRef = GLOBAL_PASSPHRASE_REF

      await configManager.save('user', {
        certDir: certDir !== undefined && certDir.length > 0 ? certDir : undefined,
        tls,
      })
      // Trust material changed, so the cached strategy — and the token it holds — is stale.
      cachedAuth = undefined
      await postNetwork()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function postSearch(): Promise<void> {
    const { config } = await configManager.load()
    const connections: SearchConnectionSummary[] = []
    for (const [id, store] of Object.entries(config.vectorStores ?? {})) {
      connections.push({
        id,
        label: store.label,
        kind: store.kind,
        url: store.url,
        ...(store.defaultIndex !== undefined ? { defaultIndex: store.defaultIndex } : {}),
        ...(store.caFile !== undefined ? { caFile: store.caFile } : {}),
        ...(store.rejectUnauthorized !== undefined ? { rejectUnauthorized: store.rejectUnauthorized } : {}),
        ...(store.limits !== undefined ? { limits: store.limits } : {}),
        // Booleans only — the values never cross the bridge (invariant 7).
        hasUsername: (await secrets.get(searchUserRefFor(id))) !== undefined,
        hasPassword: (await secrets.get(searchPasswordRefFor(id))) !== undefined,
      })
    }
    post({ type: 'search', connections, activeConnectionId: config.activeVectorStoreId })
    await postEmbedder(config)
  }

  /** Builds a client from unsaved form state, so Test and index listing work before saving. */
  async function clientFromInput(input: SearchConnectionInput): Promise<OpenSearchClient> {
    const id = input.id ?? '__unsaved__'
    if (input.username !== undefined && input.username.length > 0) await secrets.set(searchUserRefFor(id), input.username)
    if (input.password !== undefined && input.password.length > 0) await secrets.set(searchPasswordRefFor(id), input.password)

    const store: VectorStoreConfig = {
      kind: 'opensearch',
      label: input.label.length > 0 ? input.label : 'Untitled',
      url: input.url,
      ...((await secrets.get(searchUserRefFor(id))) !== undefined ? { usernameRef: searchUserRefFor(id) } : {}),
      ...((await secrets.get(searchPasswordRefFor(id))) !== undefined ? { passwordRef: searchPasswordRefFor(id) } : {}),
      ...(input.caFile !== undefined && input.caFile.length > 0 ? { caFile: input.caFile } : {}),
      ...(input.rejectUnauthorized !== undefined ? { rejectUnauthorized: input.rejectUnauthorized } : {}),
    }
    return openSearchClientFor(store, id)
  }

  async function handleSaveSearchConnection(input: SearchConnectionInput): Promise<void> {
    try {
      if (input.url.trim().length === 0) {
        post({ type: 'error', message: 'Enter the cluster URL.' })
        return
      }
      const { config } = await configManager.load()
      const id = input.id ?? randomUUID()

      if (input.username !== undefined && input.username.length > 0) await secrets.set(searchUserRefFor(id), input.username)
      if (input.password !== undefined && input.password.length > 0) await secrets.set(searchPasswordRefFor(id), input.password)

      const store: VectorStoreConfig = {
        kind: input.kind ?? 'opensearch',
        label: input.label.trim().length > 0 ? input.label.trim() : 'OpenSearch',
        url: input.url.trim(),
        ...((await secrets.get(searchUserRefFor(id))) !== undefined ? { usernameRef: searchUserRefFor(id) } : {}),
        ...((await secrets.get(searchPasswordRefFor(id))) !== undefined ? { passwordRef: searchPasswordRefFor(id) } : {}),
        ...(input.defaultIndex !== undefined && input.defaultIndex.trim().length > 0
          ? { defaultIndex: input.defaultIndex.trim() }
          : {}),
        ...(input.caFile !== undefined && input.caFile.trim().length > 0 ? { caFile: input.caFile.trim() } : {}),
        ...(input.rejectUnauthorized !== undefined ? { rejectUnauthorized: input.rejectUnauthorized } : {}),
        ...(input.limits !== undefined ? { limits: input.limits } : {}),
      }

      await configManager.save('user', { vectorStores: { ...config.vectorStores, [id]: store } })
      await postSearch()
      // Only after the write succeeded: the form uses this to decide it can close.
      post({ type: 'searchConnectionSaved', id })
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDeleteSearchConnection(id: string): Promise<void> {
    const { config } = await configManager.load()
    const remaining = { ...config.vectorStores }
    delete remaining[id]
    await secrets.delete(searchUserRefFor(id))
    await secrets.delete(searchPasswordRefFor(id))
    await configManager.save('user', {
      vectorStores: remaining,
      ...(config.activeVectorStoreId === id ? { activeVectorStoreId: undefined } : {}),
    })
    await postSearch()
  }

  async function handleRequestSearchIndexes(input: SearchConnectionInput): Promise<void> {
    try {
      const indexes = await (await clientFromInput(input)).listIndexes()
      post({ type: 'searchIndexes', indexes })
    } catch (error) {
      // Never fatal: `_cat` is often denied to a low-privilege account while `_search`
      // is allowed, so free-text entry has to keep working (§9).
      post({ type: 'searchIndexes', indexes: [], warning: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleTestSearchConnection(input: SearchConnectionInput): Promise<void> {
    try {
      const info = await (await clientFromInput(input)).ping()
      post({
        type: 'searchTestResult',
        ok: true,
        detail: `Connected to ${info.clusterName ?? 'the cluster'}${info.version !== undefined ? ` (OpenSearch ${info.version})` : ''}.`,
      })
    } catch (error) {
      post({ type: 'searchTestResult', ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Tells the composer whether to offer image attachment for the active model (§9). */
  async function postCapabilities(): Promise<void> {
    try {
      const { config } = await configManager.load()
      const profile = resolveActiveProfile(config)
      const capabilities = resolveModelCapabilities(profile.model, profile.modelCapabilities)
      post({
        type: 'capabilities',
        supportsVision: capabilities.supportsVision,
        supportsTools: capabilities.supportsTools,
        contextWindow: capabilities.contextWindow,
      })
    } catch {
      // No profile configured yet — the composer simply offers no attachment button.
      post({ type: 'capabilities', supportsVision: false, supportsTools: true, contextWindow: 0 })
    }
  }

  async function handleRequestModels(input: ProfileInput): Promise<void> {
    try {
      const built = await profileFromForm(input)
      if (built === undefined) return

      const { config } = await configManager.load()
      const strategy = authStrategyFor(config, built.profile)
      const result = await listModels(httpClient, built.profile, strategy)
      post({ type: 'models', models: result.ids, ...(result.warning !== undefined ? { warning: result.warning } : {}) })
    } catch (error) {
      // listModels itself never throws; this catches config/secret failures above it.
      post({ type: 'models', models: [], warning: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleTestConnection(input: ProfileInput): Promise<void> {
    try {
      const built = await profileFromForm(input)
      if (built === undefined) return

      const { config } = await configManager.load()
      const result = await testConnection(built.profile, buildAuthContext(config, built.profile), httpClient)
      post({ type: 'testConnectionResult', ok: result.ok, steps: result.steps })
    } catch (error) {
      post({
        type: 'testConnectionResult',
        ok: false,
        steps: [{ step: 'certificates', status: 'failed', detail: error instanceof Error ? error.message : String(error) }],
      })
    }
  }

  /** Config export never includes secrets — the config file only ever holds `apiKeyRef` pointers, never key values. */
  async function handleExportConfig(): Promise<void> {
    try {
      const { config } = await configManager.load()
      const target = await ui.showSaveDialog({ defaultName: 'light-code-config.json', extensions: ['json'] })
      if (target === undefined) return
      await fs.writeFile(target, JSON.stringify(config, null, 2), 'utf8')
      ui.showInfo(`Config exported to ${target}`)
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleImportConfig(): Promise<void> {
    try {
      const source = await ui.showOpenDialog({ kind: 'file', extensions: ['json'] })
      if (source === undefined) return

      const raw = await fs.readFile(source, 'utf8')
      const imported = parseConfig(raw) // throws ConfigValidationError with a readable message on bad input

      // Exports deliberately carry no secrets, so an imported profile's `apiKeyRef`
      // points at a secret this machine may not have. Downgrade those to `none` rather
      // than leaving a dangling reference that fails later at request time, and name
      // the affected profiles so the user knows exactly which keys to re-enter.
      const needKeys: string[] = []
      const reconciled = await Promise.all(
        (imported.profiles ?? []).map(async (profile): Promise<ProviderProfile> => {
          if (profile.auth.type !== 'apiKey') return profile
          if ((await secrets.get(profile.auth.apiKeyRef)) !== undefined) return profile
          needKeys.push(profile.label)
          return { ...profile, auth: { type: 'none' } }
        }),
      )

      await configManager.save('user', { ...imported, profiles: reconciled })
      await postProfiles()

      ui.showInfo(
        needKeys.length > 0
          ? `Config imported. Re-enter the API key for: ${needKeys.join(', ')} (exports never include secrets).`
          : 'Config imported.',
      )
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleRollback(): Promise<void> {
    if (shadowGit === undefined || taskCheckpoint === undefined) {
      post({ type: 'error', message: 'There is no checkpoint to roll back to.' })
      return
    }
    try {
      await shadowGit.restore(taskCheckpoint)
      taskCheckpoint = undefined
      // The model's view of the files is now stale — say so rather than letting it keep
      // editing against content that no longer exists.
      conversation.addUserMessage('I rolled the workspace back to its state before your edits.')
      readFiles.clear()
      post({ type: 'rolledBack' })
      ui.showInfo('Workspace rolled back.')
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Writes Python tool source with a model chosen for code, when one is configured.
   *
   * Built here rather than in a host because building a provider means auth strategies, TLS
   * material and the wire adapter — the most security-sensitive construction in the product.
   * Duplicating that outside core to keep a feature host-only would be a far worse trade than the
   * one config key this adds, and the key is absent by default, so nothing changes for anyone who
   * does not set it.
   */
  function codeGeneratorFor(config: LightCodeConfig): CodeGenerator | undefined {
    /*
     * Off unless the host offers it. Checked here rather than only in the UI: the tool's
     * *parameters* change shape when a generator exists, so a hand-edited config would otherwise
     * make the extension ask for a specification instead of source with nothing in the panel to
     * explain why.
     */
    if (services.allowProgrammingProfile !== true) return undefined

    const id = config.programmingProfileId
    if (id === undefined || id.length === 0) return undefined

    const profile = config.profiles?.find((candidate) => candidate.id === id)
    /*
     * A named profile that no longer exists degrades to "the chat model writes it" rather than
     * failing the tool call. Quietly losing the split would be the bad outcome, so it is logged.
     */
    if (profile === undefined) {
      logger.warn(
        `programming provider "${id}" is configured but no such profile exists; the chat model will write tool source`,
      )
      return undefined
    }

    return async (request) => {
      const provider = createChatProvider(profile, httpClient, authStrategyFor(config, profile), logger)
      let text = ''
      for await (const chunk of provider.streamChat([{ role: 'user', content: buildCodeGenerationPrompt(request) }], {
        // No tools offered: it is being asked for a file, and offering tools invites it to use one.
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      })) {
        if (chunk.type === 'text') text += chunk.text
      }
      return { source: text, producedBy: profile.label }
    }
  }

  async function postSettings(): Promise<void> {
    await loadSettings()
    announceConfigRecovery()
    post({
      type: 'settings',
      modeId: findMode(cachedModeId).id,
      approvals: cachedApprovals,
      maxIterations: cachedMaxIterations,
      accentColor: cachedAccentColor,
      expertColor: cachedExpertColor,
      readRoots: cachedReadRoots,
      ...hostCapabilities(),
    })
  }

  /** Approve now, and remember it for this workspace. */
  async function handleAlwaysAllow(id: string, scope: 'tool' | 'command' | 'folder'): Promise<void> {
    const request = userGate.getRequest(id)
    const pathRequest = pendingPathApprovals.get(id)
    userGate.resolve(id, 'approve')

    /*
     * A path grant remembers the *containing folder*, not the file. "Always allow this one log
     * file" is almost never what someone means, and a folder is what the readRoots list is
     * made of — remembering a file would add an entry that matches nothing else in it.
     */
    if (pathRequest !== undefined) {
      const folder = path.dirname(pathRequest)
      sessionPathGrants.add(normalizeForComparison(pathRequest))
      if (scope === 'folder' && !cachedReadRoots.includes(folder)) {
        const { config } = await configManager.load()
        await configManager.save('user', {
          filesystem: { readRoots: [...(config.filesystem?.readRoots ?? []), folder] },
        })
        await postSettings()
      }
      return
    }

    if (request === undefined) return

    if (scope === 'command' && request.preview.kind === 'command') {
      // Remembers the exact string from ground truth, not from the model's arguments.
      await saveApprovals({
        ...cachedApprovals,
        allowedCommands: addToAllowlist(request.preview.command, cachedApprovals.allowedCommands ?? []),
      })
      return
    }
    await saveApprovals({
      ...cachedApprovals,
      allowedTools: addToAllowlist(request.toolName, cachedApprovals.allowedTools ?? []),
    })
  }

  async function handleSetAutoApprove(group: ApprovableGroup, enabled: boolean): Promise<void> {
    await saveApprovals({
      ...cachedApprovals,
      autoApprove: { ...cachedApprovals.autoApprove, [group]: enabled },
    })
  }

  async function handleSetMode(modeId: string): Promise<void> {
    await configManager.save('user', { modeId: findMode(modeId).id })
    await postSettings()
  }

  /** Reads the current server map, applies a change, persists, and re-syncs. */
  async function updateMcpServer(
    name: string,
    change: (entry: McpServersConfig[string]) => McpServersConfig[string],
  ): Promise<void> {
    const { config } = await configManager.load()
    const servers = config.mcpServers ?? {}
    const existing = servers[name]
    if (existing === undefined) return

    const next: McpServersConfig = { ...servers, [name]: change(existing) }
    await configManager.save('user', { mcpServers: next })
    setMcpServersState(next)
    await mcp.configure(next)
  }

  /**
   * Three-state per tool, composed from the two stores that already exist rather than a
   * third: `never` is the server's `disabledTools`, `always` is the workspace allow-list,
   * `ask` is neither. Switching to one state must clear the other, or a tool could be
   * simultaneously always-allowed and hidden.
   */
  async function handleSetToolPermission(server: string, tool: string, permission: McpToolPermission): Promise<void> {
    const namespaced = namespacedToolName(server, tool)

    await updateMcpServer(server, (entry) => {
      const disabled = new Set(entry.disabledTools ?? [])
      if (permission === 'never') disabled.add(tool)
      else disabled.delete(tool)
      return { ...entry, disabledTools: [...disabled] }
    })

    const allowed = cachedApprovals.allowedTools ?? []
    const nextAllowed = permission === 'always' ? addToAllowlist(namespaced, allowed) : removeFromAllowlist(namespaced, allowed)
    if (nextAllowed.length !== allowed.length) {
      await saveApprovals({ ...cachedApprovals, allowedTools: nextAllowed })
    }
    postMcp()
  }

  async function handleRequestMcp(): Promise<void> {
    const { config } = await configManager.load()
    await syncMcpFromConfig(config)
    postMcp()
  }

  /**
   * Validated against the same schema the file loader uses, so a bad paste fails here
   * with a readable message rather than at spawn time (§15).
   */
  async function handleSaveMcpServers(json: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (error) {
      post({ type: 'mcpSaveError', message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` })
      return
    }

    // Accept either the whole `{ "mcpServers": {...} }` wrapper or just the inner map,
    // since both forms get pasted in practice.
    const candidate =
      typeof parsed === 'object' && parsed !== null && 'mcpServers' in parsed
        ? (parsed as { mcpServers: unknown }).mcpServers
        : parsed

    const result = mcpServersSchema.safeParse(candidate)
    if (!result.success) {
      const detail = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
      post({ type: 'mcpSaveError', message: detail })
      return
    }

    try {
      await configManager.save('user', { mcpServers: result.data })
      await mcp.configure(result.data)
      setMcpServersState(result.data)
      postMcp()
      // Verify immediately rather than leaving the user to discover a typo the next time
      // they happen to use the server. Lazy connect is about startup cost, not about
      // withholding feedback on something just configured.
      await mcp.ensureConnected()
    } catch (error) {
      post({ type: 'mcpSaveError', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Saves one server from the form editor.
   *
   * Goes through the same `mcpServersSchema` the JSON editor and the file loader use, so a
   * form save and a hand-edit fail identically (§15's single-schema rule). The form does its
   * own field-level validation first; this is the backstop, not the only check.
   */
  async function handleSaveMcpServer(
    name: string,
    previousName: string | undefined,
    config: McpServerConfig,
  ): Promise<void> {
    try {
      const { config: loaded } = await configManager.load()
      const servers = { ...(loaded.mcpServers ?? {}) }
      // A rename is a delete plus an add. Done in this order so renaming to the same name
      // is a plain update rather than a delete of the entry being written.
      if (previousName !== undefined && previousName !== name) delete servers[previousName]
      servers[name] = config

      const result = mcpServersSchema.safeParse(servers)
      if (!result.success) {
        const detail = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
        post({ type: 'mcpSaveError', message: detail })
        return
      }

      await configManager.save('user', { mcpServers: result.data })
      setMcpServersState(result.data)
      await mcp.configure(result.data)
      postMcp()
      post({ type: 'mcpServerSaved', name })
      // Verify now rather than leaving a typo to surface the next time something happens
      // to need the server.
      await mcp.ensureConnected()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Finds the interpreter for a Python MCP server by looking on disk.
   *
   * Deriving the path from the platform is a guess; checking is an answer. The layout
   * follows whatever created the environment, not the machine reading it, so a venv built
   * under WSL or copied from a share can sit in `bin/` on Windows — and the symptom of
   * guessing wrong is ENOENT naming a path the user never typed.
   *
   * Falls back to looking for a conventional venv folder beside the script, which is where
   * it is in almost every project. Purely advisory: the form always lets the interpreter be
   * typed in, so a failure here narrows the work rather than blocking it.
   */
  async function handleProbePythonEnv(venvDir: string, script: string): Promise<void> {
    const exists = async (candidate: string): Promise<boolean> => {
      try {
        return (await fs.stat(candidate)).isFile()
      } catch {
        return false
      }
    }

    const search = async (dir: string): Promise<string | undefined> => {
      for (const candidate of venvPythonCandidates(dir)) {
        if (await exists(candidate)) return candidate
      }
      return undefined
    }

    try {
      const named = venvDir.trim()
      if (named.length > 0) {
        const found = await search(named)
        if (found !== undefined) {
          post({ type: 'pythonEnvProbe', interpreter: found, venvDir: named, detail: `Found ${found}` })
          return
        }
        post({
          type: 'pythonEnvProbe',
          detail: `No Python interpreter under "${named}". Check the path, or set the interpreter directly below.`,
        })
        return
      }

      const scriptPath = script.trim()
      if (scriptPath.length === 0) {
        post({ type: 'pythonEnvProbe', detail: 'Enter a virtualenv folder or a script path first.' })
        return
      }

      // Walk up from the script: a venv sits beside the entry point, or one level up in a
      // src/ layout. Two levels is enough for both and stops well short of scanning the disk.
      let dir = path.dirname(path.resolve(scriptPath))
      for (let depth = 0; depth < 3; depth++) {
        for (const name of VENV_DIR_NAMES) {
          const candidate = path.join(dir, name)
          const found = await search(candidate)
          if (found !== undefined) {
            post({ type: 'pythonEnvProbe', interpreter: found, venvDir: candidate, detail: `Found ${found}` })
            return
          }
        }
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      post({
        type: 'pythonEnvProbe',
        detail: `No ${VENV_DIR_NAMES.join(', ')} folder found near the script. Name the virtualenv folder, or set the interpreter directly.`,
      })
    } catch (error) {
      post({ type: 'pythonEnvProbe', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * A native picker for any path field in settings.
   *
   * A webview cannot open one itself, and typing an absolute path from memory is both
   * tedious and the most common way to end up with a server that will not start. Cancelling
   * sends nothing, so a dismissed dialog leaves the field exactly as it was.
   */
  async function handleBrowseForPath(purpose: string, kind: 'file' | 'folder', extensions?: string[]): Promise<void> {
    const picked = await ui.showOpenDialog({
      kind,
      // Opens where the user is already working rather than at some unrelated default.
      ...(workspaceRoot !== undefined ? { defaultPath: workspaceRoot } : {}),
      ...(extensions !== undefined && extensions.length > 0 ? { extensions } : {}),
    })
    // A host without a native dialog returns undefined, same as a cancel. The field stays
    // typeable either way, so there is nothing to report.
    if (picked === undefined) return
    post({ type: 'pathPicked', purpose, path: picked })
  }

  /**
   * A unique variant of `base`, given the names already taken.
   *
   * Shared by every clone so they behave the same way. "copy", then "copy 2" — a numeric suffix
   * from the start reads as a version rather than a duplicate.
   */
  function uniqueName(base: string, taken: readonly string[]): string {
    if (!taken.includes(base)) return base
    for (let index = 2; index < 1000; index++) {
      const candidate = `${base} ${String(index)}`
      if (!taken.includes(candidate)) return candidate
    }
    return `${base} ${String(Date.now())}`
  }

  /**
   * Copies a server entry, disabled.
   *
   * Secrets are `${secret:NAME}` *references* inside the config (§15), so a copy points at the
   * same credentials without either duplicating a value or losing one — unlike profile
   * duplication, which has to copy the stored secret because its key is namespaced per profile.
   *
   * Disabled, because the point of a clone is to change something before it runs, and a second
   * identical stdio server spawning immediately is a process nobody asked for.
   */
  async function handleDuplicateMcpServer(name: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const servers = { ...(config.mcpServers ?? {}) }
      const source = servers[name]
      if (source === undefined) return

      const copy = uniqueName(`${name} copy`, Object.keys(servers))
      servers[copy] = { ...source, disabled: true }
      await configManager.save('user', { mcpServers: servers })
      setMcpServersState(servers)
      await mcp.configure(servers)
      postMcp()
      post({ type: 'mcpServerSaved', name: copy })
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDeleteMcpServer(name: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const servers = { ...(config.mcpServers ?? {}) }
      if (servers[name] === undefined) return
      delete servers[name]

      await configManager.save('user', { mcpServers: servers })
      setMcpServersState(servers)
      // Closes the child process: a removed stdio server left running would keep its tools
      // alive for the rest of the session.
      await mcp.configure(servers)
      postMcp()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const unsubscribe = transport.onMessage((raw) => {
    const message = raw as UiToHostMessage
    if (message.type === 'sendMessage') {
      if (activeAbortController !== undefined) {
        // The composer is supposed to prevent this — a guard against UI/host desync
        // corrupting the shared conversation and streaming buffer with interleaved turns.
        logger.warn('Ignoring sendMessage: a turn is already in progress.')
        return
      }
      void (async () => {
        /*
         * Wait rather than refuse. A scheduled run holds the conversation for a few seconds;
         * rejecting the user's message for that window would look like the composer had
         * swallowed it, and interleaving the two would corrupt both transcripts.
         */
        if (scheduledRunInFlight !== undefined) {
          logger.info('holding the message until the scheduled run finishes')
          await scheduledRunInFlight
        }
        userTurnRunning = true
        try {
          await handleSendMessage(message.text, message.images)
        } finally {
          userTurnRunning = false
        }
      })()
    } else if (message.type === 'requestMentionCandidates') {
      void handleMentionCandidates(message.query)
    } else if (message.type === 'queueMessage') {
      queuedMessages.push(message.text)
      postQueued()
    } else if (message.type === 'unqueueMessage') {
      queuedMessages.splice(message.index, 1)
      postQueued()
    } else if (message.type === 'cancel') {
      // A cancelled turn discards the queue too: those messages were written for work that
      // is no longer happening, and replaying them into a fresh turn would surprise.
      queuedMessages = []
      postQueued()
      activeAbortController?.abort()
      userGate.denyAll()
      settleAllForms()
    } else if (message.type === 'approvalResponse') {
      userGate.resolve(message.id, message.decision)
    } else if (message.type === 'formResponse') {
      const resolve = pendingForms.get(message.id)
      // A response for a form nobody is waiting on is normal, not an error: the turn may have
      // been cancelled between the user pressing the button and the message arriving.
      if (resolve !== undefined) {
        pendingForms.delete(message.id)
        resolve(
          message.submitted
            ? answerFromResponse(pendingFormFields.get(message.id) ?? [], message.values)
            : { submitted: false, values: {} },
        )
        pendingFormFields.delete(message.id)
      }
    } else if (message.type === 'approvalResponseAlways') {
      void handleAlwaysAllow(message.id, message.scope)
    } else if (message.type === 'rollback') {
      void handleRollback()
    } else if (message.type === 'requestSettings') {
      void postSettings()
    } else if (message.type === 'requestTasks') {
      void postTasks()
    } else if (message.type === 'openTask') {
      void openTask(message.id)
    } else if (message.type === 'deleteTask') {
      void deleteTask(message.id)
    } else if (message.type === 'newTask') {
      void startNewTask()
    } else if (message.type === 'setMode') {
      void handleSetMode(message.modeId)
    } else if (message.type === 'setMaxIterations') {
      void configManager
        .save('user', { maxIterations: message.value })
        .then(() => postSettings())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setProgrammingProfile') {
      /*
       * An empty id clears it, which is how "the model I am chatting with" is expressed. Saving an
       * empty string instead would leave a key naming a profile that does not exist, and the
       * generator would log a warning on every settings load.
       */
      void configManager
        .load()
        .then(async ({ config }) => {
          const next = { ...config }
          if (message.id.length === 0) delete next.programmingProfileId
          else next.programmingProfileId = message.id
          await configManager.save('user', next)
          await postSettings()
        })
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setReadRoots') {
      void configManager
        .save('user', {
          filesystem: { readRoots: message.roots.map((root) => root.trim()).filter((root) => root.length > 0) },
        })
        .then(() => postSettings())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setAccentColor') {
      /*
       * Saved to user scope, not workspace: an accent is a preference about the person's
       * editor, and someone who picks teal wants teal in every repository they open.
       */
      void configManager
        // Both written together: `save` merges at the top level, so writing `ui` with only
        // one key would drop the other.
        .save('user', { ui: { accentColor: message.value, expertColor: cachedExpertColor } })
        .then(() => postSettings())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setExpertColor') {
      void configManager
        .save('user', { ui: { accentColor: cachedAccentColor, expertColor: message.value } })
        .then(() => postSettings())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setAutoApprove') {
      void handleSetAutoApprove(message.group, message.enabled)
    } else if (message.type === 'revokeAllowedTool') {
      void saveApprovals({
        ...cachedApprovals,
        allowedTools: removeFromAllowlist(message.toolName, cachedApprovals.allowedTools ?? []),
      })
    } else if (message.type === 'revokeAllowedCommand') {
      void saveApprovals({
        ...cachedApprovals,
        allowedCommands: removeFromAllowlist(message.command, cachedApprovals.allowedCommands ?? []),
      })
    } else if (message.type === 'requestMcp') {
      void handleRequestMcp()
    } else if (message.type === 'saveMcpServers') {
      void handleSaveMcpServers(message.json)
    } else if (message.type === 'saveMcpServer') {
      void handleSaveMcpServer(message.name, message.previousName, message.config)
    } else if (message.type === 'duplicateMcpServer') {
      void handleDuplicateMcpServer(message.name)
    } else if (message.type === 'deleteMcpServer') {
      void handleDeleteMcpServer(message.name)
    } else if (message.type === 'browseForPath') {
      void handleBrowseForPath(message.purpose, message.kind, message.extensions)
    } else if (message.type === 'probePythonEnv') {
      void handleProbePythonEnv(message.venvDir, message.script)
    } else if (message.type === 'connectMcpServer') {
      void mcp.connectServer(message.name)
    } else if (message.type === 'restartMcpServer') {
      void mcp.restart(message.name)
    } else if (message.type === 'setMcpServerEnabled') {
      void updateMcpServer(message.name, (entry) => ({ ...entry, disabled: !message.enabled })).then(() => postMcp())
    } else if (message.type === 'setMcpToolPermission') {
      void handleSetToolPermission(message.server, message.tool, message.permission)
    } else if (message.type === 'requestSearch') {
      void postSearch()
      // The dispatcher and the query log live on the Search tab, so they ship with the same
      // request rather than needing three round trips to populate one panel.
      void postDispatcher()
      post({ type: 'searchLog', entries: [...searchLog.list()] })
    } else if (message.type === 'saveSearchConnection') {
      void handleSaveSearchConnection(message.connection)
    } else if (message.type === 'deleteSearchConnection') {
      void handleDeleteSearchConnection(message.id)
    } else if (message.type === 'setActiveSearchConnection') {
      void configManager
        .save('user', { activeVectorStoreId: message.id })
        .then(() => postSearch())
    } else if (message.type === 'requestSearchIndexes') {
      void handleRequestSearchIndexes(message.connection)
    } else if (message.type === 'testSearchConnection') {
      void handleTestSearchConnection(message.connection)
    } else if (message.type === 'syncVectorStore') {
      void handleSyncVectorStore(message.fromId)
    } else if (message.type === 'clearDocsIndex') {
      void handleClearDocsIndex()
    } else if (message.type === 'indexDocs') {
      void handleIndexDocs()
    } else if (message.type === 'runSearchProbe') {
      void handleSearchProbe(message.query, message.target)
    } else if (message.type === 'clearSearchLog') {
      searchLog.clear()
    } else if (message.type === 'setDispatcher') {
      void saveRetrieval({ dispatcher: message.enabled })
        .then(() => {
          void postDispatcher()
          // Switching it on is the moment the index starts being consulted, and it may never
          // have been built. Off needs nothing — the index simply stops being read.
          if (message.enabled) scheduleDocsReindex('dispatcher enabled')
        })
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setSkillRetrieval') {
      void saveRetrieval({ skills: message.enabled })
        .then(() => {
          void postDispatcher()
          // Same reason as the dispatcher: switching it on is when the index starts being
          // consulted for skills, and it may never have been built.
          if (message.enabled) scheduleDocsReindex('skill retrieval enabled')
        })
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'startIndexing') {
      void handleStartIndexing()
    } else if (message.type === 'cancelIndexing') {
      indexingAbort?.abort()
    } else if (message.type === 'saveEmbedder') {
      void handleSaveEmbedder(
        message.profileId,
        message.model,
        message.dimensions,
        message.indexName,
        message.indexPrefix,
      )
    } else if (message.type === 'requestEmbedderModels') {
      void handleRequestEmbedderModels(message.profileId)
    } else if (message.type === 'openWalkthrough') {
      void ui.openWalkthrough?.()
    } else if (message.type === 'requestTools') {
      void postTools()
    } else if (message.type === 'requestSchedules') {
      void postSchedules()
    } else if (message.type === 'saveSchedule') {
      void handleSaveSchedule(message.schedule)
    } else if (message.type === 'duplicateSchedule') {
      void handleDuplicateSchedule(message.id)
    } else if (message.type === 'deleteSchedule') {
      void handleDeleteSchedule(message.id)
    } else if (message.type === 'setScheduleEnabled') {
      void handleSetScheduleEnabled(message.id, message.enabled)
    } else if (message.type === 'setTaskExpertLimits') {
      taskExpertLimits =
        message.maxSpendUsd === undefined && message.maxConsultations === undefined
          ? undefined
          : {
              ...(message.maxSpendUsd !== undefined ? { maxSpendUsd: message.maxSpendUsd } : {}),
              ...(message.maxConsultations !== undefined ? { maxConsultations: message.maxConsultations } : {}),
            }
      postExpertSpend()
    } else if (message.type === 'setExpertKeepAlive') {
      void configManager
        .load()
        .then(async ({ config }) => {
          await configManager.save('user', { ...config, expert: { ...config.expert, keepAlive: message.enabled } })
          await postExpert({ redetect: false })
        })
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'measureExpertCost') {
      void handleMeasureExpertCost()
    } else if (message.type === 'clearExpertPricing') {
      void configManager
        .load()
        .then(async ({ config }) => {
          const expert = { ...config.expert }
          delete expert.pricing
          delete expert.reportsCost
          await configManager.save('user', { ...config, expert })
          await postExpert({ redetect: false })
        })
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'assessJunior') {
      void handleAssessJunior()
    } else if (message.type === 'clearAssessment') {
      void handleClearAssessment()
    } else if (message.type === 'restartScheduler') {
      restartScheduleTimer()
      logger.info('schedule timer restarted by the user')
      void postSchedules()
    } else if (message.type === 'deleteScheduleRun') {
      void handleDeleteScheduleRun(message.id, message.at)
    } else if (message.type === 'clearScheduleRuns') {
      void handleClearScheduleRuns(message.id)
    } else if (message.type === 'openScheduleRun') {
      void openRunTranscript(message.taskId, message.title)
    } else if (message.type === 'runScheduleNow') {
      void runSchedule(message.id, 'manual')
    } else if (message.type === 'requestSkills') {
      void postSkills()
    } else if (message.type === 'saveSkillDirs') {
      void configManager
        .save('user', {
          skills: {
            ...(message.dir.trim().length > 0 ? { dir: message.dir.trim() } : {}),
            paths: message.paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
          },
        })
        .then(() => postSkills())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'openManagedFile') {
      void handleOpenManagedFile(message.path)
    } else if (message.type === 'deletePythonTool') {
      void handleDeletePythonTool(message.name)
    } else if (message.type === 'approvePythonTool') {
      void handleApprovePythonTool(message.name)
    } else if (message.type === 'deleteSkillFile') {
      void handleDeleteSkillFile(message.name)
    } else if (message.type === 'requestPython') {
      void postPython()
    } else if (message.type === 'setPython') {
      void handleSetPython(message)
    } else if (message.type === 'requestNetwork') {
      void postNetwork()
    } else if (message.type === 'saveNetwork') {
      void handleSaveNetwork(message.settings)
    } else if (message.type === 'requestExpert') {
      void postExpert()
    } else if (message.type === 'setExpert') {
      void handleSetExpert(message.enabled, message.path, message.model, {
        ...(message.maxSpendUsd !== undefined ? { maxSpendUsd: message.maxSpendUsd } : {}),
        ...(message.maxConsultations !== undefined ? { maxConsultations: message.maxConsultations } : {}),
      })
    } else if (message.type === 'requestProfiles') {
      void postProfiles()
      // Capabilities travel with the profile list: switching profiles can change whether
      // the composer offers attachment at all.
      void postCapabilities()
    } else if (message.type === 'saveProfile') {
      void handleSaveProfile(message.profile)
    } else if (message.type === 'requestModels') {
      void handleRequestModels(message.profile)
    } else if (message.type === 'testConnection') {
      void handleTestConnection(message.profile)
    } else if (message.type === 'duplicateProfile') {
      void handleDuplicateProfile(message.id)
    } else if (message.type === 'deleteProfile') {
      void handleDeleteProfile(message.id)
    } else if (message.type === 'setActiveProfile') {
      void handleSetActiveProfile(message.id)
    } else if (message.type === 'exportConfig') {
      void handleExportConfig()
    } else if (message.type === 'importConfig') {
      void handleImportConfig()
    }
  })

  // Start enabled servers as soon as the panel opens. The extension activates on
  // `onView:lightCode.chatView` (auto-generated from the `views` contribution), so this
  // runs when the user opens Light Code — not at VS Code startup. Doing it here means
  // tools are ready before the first message and health is visible immediately, rather
  // than a mistyped command sitting undetected until something happens to use it.
  // Deliberately not awaited: a slow server must not delay the panel rendering.
  void (async () => {
    try {
      const { config } = await configManager.load()
      await syncMcpFromConfig(config)
      await mcp.ensureConnected()
    } catch (error) {
      logger.warn(`Could not start MCP servers: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()

  // Restore the conversation that was in progress. The webview is rebuilt whenever the
  // view is hidden and on every window reload, so without this a reload silently discards
  // the transcript — which is the whole reason this phase exists.
  void (async () => {
    try {
      await restoreActiveTaskOnLoad()
      await postTasks()
    } catch (error) {
      logger.warn(`Could not restore the previous task: ${error instanceof Error ? error.message : String(error)}`)
      post({ type: 'taskRestored', taskId: undefined, entries: [] })
    }
  })()


  /**
   * Notifies, and opens the run's transcript if the user takes the action.
   *
   * The panel is revealed first. A notification can arrive with the view closed, and `openTask`
   * posts to a webview that is not there — the click would silently do nothing, which is worse
   * than not offering it.
   */
  async function openFromNotification(message: string, level: 'info' | 'warning', taskId: string): Promise<void> {
    const open = await ui.showActionMessage(message, 'Open', level)
    if (!open) return
    await ui.revealPanel()
    await openTask(taskId)
  }

  /**
   * Opens a stored task as a document, so a run can be read where files are read.
   *
   * Rendered from the same `toTranscript` the chat uses, so what appears in the editor is the
   * conversation that happened rather than a second, differently-derived view of it — two
   * renderings of one transcript would drift, which is §15's single-schema rule again.
   */
  async function openRunTranscript(taskId: string, title: string): Promise<void> {
    const task = await taskStore.load(taskId)
    if (task === undefined) {
      ui.showWarning('That run\'s transcript is no longer stored — task history may have been cleared.')
      return
    }

    const lines: string[] = []
    for (const entry of toTranscript(task.messages)) {
      if (entry.kind === 'text') {
        lines.push(entry.role === 'user' ? `## Prompt\n\n${entry.content}` : `## Reply\n\n${entry.content}`)
      } else if (entry.kind === 'reasoning') {
        lines.push(`## Thinking\n\n${entry.content}`)
      } else {
        const call = entry.toolCall
        lines.push(
          [
            `## Tool: ${call.name}${call.isError === true ? ' (failed)' : ''}`,
            '',
            '### Arguments',
            '```json',
            call.arguments,
            '```',
            ...(call.result !== undefined ? ['', '### Result', '```', call.result, '```'] : []),
          ].join('\n'),
        )
      }
    }

    await ui.openDocument({
      title,
      content: lines.length > 0 ? lines.join('\n\n') : '_This run produced no messages._',
    })
  }

  // ------------------------------------------------------------------ schedules (§9b)

  /**
   * The schedule currently running, so two cannot overlap.
   *
   * A run that overruns its next fire time must not start a second concurrent one: they would
   * share the conversation and the task store and interleave into nonsense. The later fire is
   * skipped rather than queued — a missed reminder is better than two tangled ones.
   */
  let runningScheduleId: string | undefined
  let scheduleTimer: ReturnType<typeof setInterval> | undefined
  /** When the timer last ran, so a stopped scheduler is visible rather than guessed at. */
  let lastScheduleTickAt: number | undefined
  /** When the in-flight run started, so a wedged one can be released rather than blocking forever. */
  let runStartedAt: number | undefined

  /** Every tool that exists, for the picker. Built with everything on so nothing is hidden. */
  function allToolsForPicker(): { name: string; description: string; group: string }[] {
    return currentToolRegistry(undefined, undefined, undefined, undefined, false)
      .list()
      /*
       * The ones a schedule can never be granted are not offered. A picker that lists a tool
       * the run will refuse teaches the wrong thing twice — once when it is ticked, and again
       * when the run reports it as unavailable.
       */
      .filter((tool) => !NEVER_AVAILABLE_TO_SCHEDULES.includes(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, group: tool.group }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Everything that exists right now, for the read-only Tools view.
   *
   * Built with the dispatcher *as configured* rather than forced either way, unlike the
   * documentation corpus — the point of this view is to show what the model can currently see,
   * so a truthful `advertised` matters more than a complete corpus.
   */
  async function postTools(): Promise<void> {
    const { config } = await configManager.load()
    // Same trap as the reindex above: reading the key directly made this view report the
    // dispatcher off — and compute `advertised` as though it were — for anyone running the
    // default. A read-only view of what the model can see is worth nothing if it is wrong.
    const dispatcher = dispatcherEnabled(config.retrieval)
    const registry = currentToolRegistry(undefined, undefined, undefined, undefined, dispatcher)
    const advertised = new Set(registry.promptList().map((tool) => tool.name))
    const pythonNames = new Set(python.tools().map((tool) => tool.name))
    const mcpNames = new Set(mcp.enabledTools().map((tool) => tool.name))

    post({
      type: 'tools',
      dispatcher,
      tools: registry
        .list()
        .map((tool) => {
          // Source is taken from the registries that produced them rather than guessed from
          // the name: a built-in could one day contain `__`, and a server could be called
          // `py`. Asking the thing that owns the tool cannot be wrong in either case.
          const server = mcpNames.has(tool.name) ? parseNamespacedToolName(tool.name)?.serverName : undefined
          const source = pythonNames.has(tool.name) ? 'python' : mcpNames.has(tool.name) ? 'mcp' : 'built-in'
          return {
            name: tool.name,
            description: tool.description,
            group: tool.group,
            source,
            ...(server !== undefined ? { server } : {}),
            advertised: advertised.has(tool.name),
          } satisfies ToolCatalogueEntry
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    })
  }

  async function loadSchedules(): Promise<Record<string, Schedule>> {
    const { config } = await configManager.load()
    return config.schedules ?? {}
  }

  async function postSchedules(): Promise<void> {
    // The picker lists real skills, so it has to reflect what is on disk now rather than
    // whatever the last turn happened to load.
    await refreshSkills()
    const schedules = await loadSchedules()
    post({
      type: 'schedules',
      schedules: Object.values(schedules).sort((a, b) => a.name.localeCompare(b.name)),
      tools: allToolsForPicker(),
      skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
      ...(runningScheduleId !== undefined ? { runningId: runningScheduleId } : {}),
      scheduler: {
        running: scheduleTimer !== undefined,
        ...(lastScheduleTickAt === undefined ? {} : { lastTickAt: lastScheduleTickAt }),
      },
    })
  }

  async function saveSchedules(next: Record<string, Schedule>): Promise<void> {
    await configManager.save('user', { schedules: next })
    await postSchedules()
  }

  async function handleSaveSchedule(schedule: Schedule): Promise<void> {
    try {
      const schedules = await loadSchedules()
      // A blank id means "new". Generated here rather than in the UI so two panels cannot
      // mint the same one.
      const id = schedule.id.length > 0 ? schedule.id : createHash('sha256').update(`${schedule.name}:${String(Date.now())}`).digest('hex').slice(0, 12)
      /*
       * Re-armed on every save. An edited trigger must take effect now rather than after the
       * next run, and a schedule created without this would have no `nextRunAt` and never fire.
       */
      const armed: Schedule = { ...schedule, id, nextRunAt: nextFireTime(schedule, Date.now()) }
      await saveSchedules({ ...schedules, [id]: armed })
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDeleteSchedule(id: string): Promise<void> {
    const schedules = await loadSchedules()
    const next = { ...schedules }
    delete next[id]
    await saveSchedules(next)
  }

  async function handleSetScheduleEnabled(id: string, enabled: boolean): Promise<void> {
    const schedules = await loadSchedules()
    const existing = schedules[id]
    if (existing === undefined) return
    /*
     * Re-enabling re-arms from now. Otherwise a schedule paused for a week is instantly overdue
     * the moment it comes back, which is never what pausing meant. Pausing drops the target
     * entirely so nothing can read a stale one as due.
     */
    const next: Schedule = enabled
      ? { ...existing, enabled, nextRunAt: nextFireTime(existing, Date.now()) }
      : { ...existing, enabled, nextRunAt: undefined }
    await saveSchedules({ ...schedules, [id]: next })
  }

  /**
   * Runs one schedule in its own task.
   *
   * A fresh task per run, so each is separately reviewable in history and no run inherits the
   * context of the last — a scheduled job accumulating a month of its own transcripts would
   * cost more every day and eventually stop fitting.
   */
  /**
   * Publishes the in-flight run so a user message can wait on it instead of interleaving.
   *
   * A separate wrapper because the body has early returns, and a promise recorded only on the
   * paths that actually run would leave a window where a send saw nothing to wait for.
   */
  async function runSchedule(id: string, reason: 'due' | 'manual'): Promise<void> {
    const run = runScheduleInner(id, reason)
    scheduledRunInFlight = run
    try {
      await run
    } finally {
      scheduledRunInFlight = undefined
    }
  }

  async function runScheduleInner(id: string, reason: 'due' | 'manual'): Promise<void> {
    if (runningScheduleId !== undefined) {
      logger.warn(`schedule ${id} skipped: "${runningScheduleId}" is still running`)
      return
    }
    if (userTurnRunning) {
      // Deferred, not dropped: it stays due and the next tick picks it up. Interrupting
      // someone mid-conversation to run a background job is never the right trade.
      logger.info(`schedule ${id} deferred: the user is mid-turn`)
      return
    }

    const schedules = await loadSchedules()
    const schedule = schedules[id]
    if (schedule === undefined) return

    runningScheduleId = id
    runStartedAt = Date.now()
    void postSchedules()

    /*
     * The user's conversation is put aside for the duration and handed back afterwards.
     *
     * A scheduled run used to call `startNewTask()`, which resets the one shared conversation
     * — so a job firing while someone was chatting wiped their transcript out from under
     * them. Snapshotting is enough because `Conversation` is restorable by value, and it
     * keeps the run on the ordinary turn path rather than forking a second implementation
     * that would drift (the same reasoning as threading `schedule` through in the first place).
     */
    const saved = {
      messages: conversation.toArray(),
      taskId: activeTaskId,
      createdAt: activeTaskCreatedAt,
      handles: truncationStore.spilledHandles(),
      readFiles: [...readFiles],
      checkpoint: taskCheckpoint,
    }
    backgroundRun = true

    const startedAt = Date.now()
    let result: 'ok' | 'error' = 'ok'
    let summary = ''

    try {
      await startNewTask()
      logger.info(`running schedule "${schedule.name}" (${reason})`)
      await handleSendMessage(schedule.prompt, undefined, schedule)
      summary = lastAssistantSummary()
    } catch (error) {
      result = 'error'
      summary = error instanceof Error ? error.message : String(error)
      /*
       * Surfaced, not swallowed. An unattended failure nobody sees is the worst outcome here —
       * the schedule looks like it is working right up until someone needs its output.
       */
      const failedTask = activeTaskId
      if (failedTask !== undefined) {
        void openFromNotification(`Scheduled run "${schedule.name}" failed: ${summary}`, 'warning', failedTask)
      } else {
        ui.showWarning(`Scheduled run "${schedule.name}" failed: ${summary}`)
      }
    } finally {
      const ranAsTask = activeTaskId

      /*
       * Restored before anything else awaits, so a user message arriving the instant the run
       * ends finds their own conversation rather than the job's.
       */
      conversation.restore(saved.messages)
      activeTaskCreatedAt = saved.createdAt
      truncationStore.startTask(saved.handles)
      readFiles.clear()
      for (const file of saved.readFiles) readFiles.add(file)
      taskCheckpoint = saved.checkpoint
      backgroundRun = false
      await setActiveTaskId(saved.taskId)

      runningScheduleId = undefined
      runStartedAt = undefined
      const latest = await loadSchedules()
      const current = latest[id]
      if (current !== undefined) {
        await saveSchedules({
          ...latest,
          [id]: {
            ...current,
            // Armed from completion, not from the start: a run slower than its own interval
            // would otherwise be due again the instant it finished and never rest.
            nextRunAt: nextFireTime(current, Date.now()),
            lastRunAt: startedAt,
            lastResult: result,
            ...(summary.length > 0 ? { lastSummary: summary.slice(0, 300) } : {}),
            ...(ranAsTask !== undefined ? { lastTaskId: ranAsTask } : {}),
            // Newest first, and capped — this lives in the config file, so an unbounded log
            // would grow forever and be rewritten on every run.
            runs: [
              {
                at: startedAt,
                result,
                durationMs: Date.now() - startedAt,
                ...(summary.length > 0 ? { summary: summary.slice(0, 300) } : {}),
                ...(ranAsTask !== undefined ? { taskId: ranAsTask } : {}),
              },
              ...(current.runs ?? []),
            ].slice(0, MAX_REMEMBERED_RUNS),
          },
        })
      } else {
        await postSchedules()
      }
    }
  }

  /**
   * Forgets remembered runs.
   *
   * `lastResult`/`lastSummary` go with them: leaving a summary behind after clearing the log
   * it came from would show a result with nothing to open, which reads as a bug rather than
   * as an empty list.
   */
  async function handleClearScheduleRuns(id: string | undefined): Promise<void> {
    const schedules = await loadSchedules()
    const next: Record<string, Schedule> = {}
    for (const [key, schedule] of Object.entries(schedules)) {
      if (id !== undefined && key !== id) {
        next[key] = schedule
        continue
      }
      const cleared = { ...schedule }
      delete cleared.runs
      delete cleared.lastResult
      delete cleared.lastSummary
      delete cleared.lastTaskId
      next[key] = cleared
    }
    await saveSchedules(next)
  }

  /**
   * Removes one run from the log.
   *
   * Keyed on `at` rather than an index: the list is re-sorted and capped as runs accumulate, so
   * an index the UI computed a moment ago can point at a different run by the time it arrives.
   * The start time is the one thing about a run that does not move.
   */
  /**
   * Copies a schedule, disabled and with no history.
   *
   * **Disabled on purpose.** Cloning is how someone makes a variant of a job that already
   * works, and a copy that started firing the moment it was created — on the original's
   * schedule, with the original's tools — would run something nobody had finished writing.
   * The run log is not copied either: those runs belong to the schedule that did them.
   */
  async function handleDuplicateSchedule(id: string): Promise<void> {
    const schedules = await loadSchedules()
    const source = schedules[id]
    if (source === undefined) return

    const newId = `${String(Date.now().toString(36))}${String(Math.random()).slice(2, 6)}`
    const copy: Schedule = {
      ...source,
      id: newId,
      name: uniqueName(`${source.name} copy`, Object.values(schedules).map((entry) => entry.name)),
      enabled: false,
    }
    delete copy.runs
    delete copy.lastRunAt
    delete copy.lastResult
    delete copy.lastSummary
    delete copy.lastTaskId
    delete copy.nextRunAt

    await saveSchedules({ ...schedules, [newId]: copy })
  }

  async function handleDeleteScheduleRun(id: string, at: number): Promise<void> {
    const schedules = await loadSchedules()
    const schedule = schedules[id]
    if (schedule === undefined) return

    const remaining = (schedule.runs ?? []).filter((run) => run.at !== at)
    const next: Schedule = { ...schedule, runs: remaining }

    /*
     * The summary shown on the row belongs to the newest run. Deleting that run has to move it
     * on, or the list would keep reporting a result whose log is gone — and the "Log" button
     * beside it would open nothing.
     */
    const newest = remaining[0]
    if (newest === undefined) {
      delete next.runs
      delete next.lastResult
      delete next.lastSummary
      delete next.lastTaskId
    } else if (schedule.lastRunAt === at) {
      next.lastRunAt = newest.at
      next.lastResult = newest.result
      if (newest.summary === undefined) delete next.lastSummary
      else next.lastSummary = newest.summary
      if (newest.taskId === undefined) delete next.lastTaskId
      else next.lastTaskId = newest.taskId
    }

    await saveSchedules({ ...schedules, [id]: next })
  }

  /** The final assistant message, for the schedule list and any notification. */
  function lastAssistantSummary(): string {
    const messages = conversation.toArray()
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim().length > 0) {
        return message.content.trim()
      }
    }
    return ''
  }

  /**
   * Checks once a minute rather than setting a timer per schedule.
   *
   * One timer cannot drift out of sync with the config, cannot leak when a schedule is
   * deleted, and does not need rebuilding on every edit. A minute is also the finest interval
   * the schema allows, so nothing is lost.
   */
  /** Stops and starts, unconditionally. The manual button and the watchdog share this. */
  function restartScheduleTimer(): void {
    if (scheduleTimer !== undefined) {
      clearInterval(scheduleTimer)
      scheduleTimer = undefined
    }
    startScheduleTimer()
  }

  function startScheduleTimer(): void {
    if (scheduleTimer !== undefined) return
    /*
     * Every 15 seconds, not every minute.
     *
     * A tick only reads a small JSON file, and at a one-minute poll a one-minute schedule
     * spends most of its life visibly overdue — it fires roughly every two minutes, which
     * reads as a broken scheduler even when it is working. Fifteen seconds bounds the lateness
     * at a quarter of the shortest interval anyone can ask for.
     */
    scheduleTimer = setInterval(() => {
      void runScheduleTick().catch((error: unknown) => {
        /*
         * An unhandled rejection here would be reported nowhere and the interval would keep
         * firing blind. Logged so a failing tick is diagnosable from the output channel
         * rather than inferred from schedules that never run.
         */
        logger.warn(`schedule tick failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, SCHEDULE_TICK_MS)
    // Immediately, too: a schedule that came due while the timer was down should not wait out
    // a full interval before anyone notices.
    void runScheduleTick().catch(() => undefined)
  }

  async function runScheduleTick(): Promise<void> {
    await (async () => {
        // Recorded before the early return so the UI can tell a busy scheduler from a dead
        // one — both look identical from the outside otherwise.
      lastScheduleTickAt = Date.now()
      if (runningScheduleId !== undefined) {
        /*
         * A run that never finishes would stop the scheduler for good, since every later tick
         * returns here. That is one of the shapes the "it just stopped" report can take, so it
         * is bounded rather than trusted: past the cap the flag is cleared and it is reported.
         * Worst case a slow run overlaps with the next one, which is far better than a
         * scheduler that is silently dead.
         */
        if (runStartedAt !== undefined && Date.now() - runStartedAt > STUCK_RUN_MS) {
          logger.warn(`schedule "${runningScheduleId}" has been running for too long — releasing the scheduler`)
          runningScheduleId = undefined
          runStartedAt = undefined
          void postSchedules()
        }
        return
      }
        const now = Date.now()
        const schedules = await loadSchedules()

        /*
         * Arm anything enabled that has no target — a schedule written before this field
         * existed, or one whose config was hand-edited. Without it such a schedule is
         * permanently not-due and silently never runs, which is the failure this whole
         * mechanism replaced.
         */
        const unarmed = Object.values(schedules).filter(
          (schedule) => schedule.enabled && schedule.nextRunAt === undefined,
        )
        if (unarmed.length > 0) {
          const armed = { ...schedules }
          for (const schedule of unarmed) {
            armed[schedule.id] = { ...schedule, nextRunAt: nextFireTime(schedule, now) }
          }
          await saveSchedules(armed)
          return
        }

        for (const schedule of Object.values(schedules)) {
          if (isDue(schedule, now)) {
            await runSchedule(schedule.id, 'due')
            // One per tick: a second would have to wait for the first anyway, and it will be
            // due again on the next pass.
            return
          }
        }
    })()
  }

  /*
   * Started once, at construction. Schedules only fire while VS Code is open — there is no
   * background service — and the Schedules tab says so rather than letting someone believe a
   * nightly job runs on a closed laptop.
   */
  startScheduleTimer()

  return {
    /**
     * Re-sends what a freshly created view cannot know.
     *
     * Everything else the UI needs it asks for on mount, but the transcript is pushed rather
     * than pulled — so without this, reopening the panel would show an empty chat while the
     * conversation was still very much alive in the bridge.
     */
    schedulerHealth: () => ({
      running: scheduleTimer !== undefined,
      ...(lastScheduleTickAt === undefined ? {} : { lastTickAt: lastScheduleTickAt }),
      ...(runningScheduleId === undefined ? {} : { runningScheduleId }),
    }),
    restartScheduler: () => {
      restartScheduleTimer()
    },
    resync: () => {
      void (async () => {
        try {
          /*
           * A live conversation is posted as it stands rather than reloaded from disk: the
           * store is only written at the end of a turn, so reloading mid-turn — during a
           * scheduled run, say — would replace what is happening with what happened last.
           */
          const live = conversation.toArray()
          if (live.length > 0) {
            post({ type: 'taskRestored', taskId: activeTaskId, entries: toTranscript(live) })
          } else {
            await restoreActiveTaskOnLoad()
          }
          await postTasks()
          await postSettings()
          await postSchedules()
        } catch (error) {
          logger.warn(`Could not resync the view: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    },
    dispose: () => {
      // Disposing while a turn awaits approval would otherwise leak a pending promise.
      userGate.denyAll()
      settleAllForms()
      // stdio servers are child processes — not closing them leaks one per panel open.
      void mcp.closeAll()
      // Same reasoning for the Python interpreter, and it kills the whole tree so a tool
      // that spawned a subprocess does not outlive the session (§16).
      void python.dispose()
      // A pending reindex would otherwise fire after teardown and post to a dead webview.
      if (docsReindexTimer !== undefined) clearTimeout(docsReindexTimer)
      if (scheduleTimer !== undefined) clearInterval(scheduleTimer)
      // Nothing may outlive the bridge, least of all something that spends money.
      stopKeepAlive()
      unsubscribe()
    },
  }
}
