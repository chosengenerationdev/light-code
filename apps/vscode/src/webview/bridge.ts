import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as vscode from 'vscode'
import {
  ConfigManager,
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
  createChatProvider,
  createAskExpertTool,
  createSearchOpensearchTool,
  resolveConnectionTls,
  vectorStoreTls,
  OpenSearchClient,
  createDefaultToolRegistry,
  detectClaudeCli,
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
} from '@light-code/core'
import { WebviewApprovalGate } from './approvalGate.js'
import { NodeFileSystem } from '../platform/filesystem.js'
import { NodeTerminal } from '../platform/terminal.js'
import { VSCodeConfigStore } from '../platform/config.js'
import { JsonTaskStore } from '../platform/taskStore.js'
import { resolveRipgrepPath } from '../platform/ripgrep.js'
import { VSCodeSecretStore } from '../platform/secrets.js'
import { WebviewTransport } from '../platform/transport.js'

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
async function toSummary(profile: ProviderProfile, secrets: VSCodeSecretStore): Promise<ProfileSummary> {
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

/** Wires the webview's chat UI to the agent loop and the Providers settings screen. */
export function wireChatBridge(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  const logger = new Logger({ level: 'debug', sink: (line) => outputChannel.appendLine(line) })
  const transport = new WebviewTransport(webview, logger)
  const secrets = new VSCodeSecretStore(context.secrets, logger)
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const configManager = new ConfigManager(new VSCodeConfigStore(context, workspaceRoot))
  const httpClient = new FetchHttpClient()
  const conversation = new Conversation(workspaceRoot !== undefined ? buildSystemPrompt(workspaceRoot) : undefined)

  // Wrapped so the current task knows which spilled results it owns — deleting a task has
  // to delete its spilled output, and only this layer sees the handles.
  // Refreshed whenever config is loaded (once per turn). Read synchronously by the spill
  // path, which cannot await a keychain lookup in the middle of writing a tool result.
  let cachedSecretValues: readonly string[] = []
  const truncationStore = new RecordingTruncationStore(
    new DiskTruncationStore(path.join(context.globalStorageUri.fsPath, 'tool-results'), () => cachedSecretValues),
  )
  const taskStore = new JsonTaskStore(context.globalStorageUri.fsPath, truncationStore, logger)
  const builtinTools = createDefaultToolRegistry()
  builtinTools.register(createReadToolResultTool(truncationStore))

  // Files read via read_file this session; write_to_file/apply_diff check this before
  // touching an existing file. Session-scoped, so it lives alongside the conversation.
  const readFiles = new Set<string>()
  const denylist = new PathDenylist()
  // Resolved once: the answer cannot change within a session, and a missing binary should
  // be reported to the log once rather than on every turn.
  const ripgrepPath = resolveRipgrepPath(context.extensionPath, logger)
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
  let activeTaskId: string | undefined = context.workspaceState.get<string>(ACTIVE_TASK_KEY)
  let activeTaskCreatedAt = Date.now()

  async function setActiveTaskId(id: string | undefined): Promise<void> {
    activeTaskId = id
    await context.workspaceState.update(ACTIVE_TASK_KEY, id)
  }

  function post(message: HostToUiMessage): void {
    transport.post(message)
  }

  /**
   * Approvals are keyed by workspace path but stored user-side (invariant 5) — a repo
   * must not be able to grant itself permissions via `.lightcode/config.json`.
   */
  const approvalsKey = workspaceRoot ?? '__no_workspace__'
  // Cached so the policy gate can answer synchronously mid-turn without re-reading config.
  let cachedApprovals: WorkspaceApprovals = {}
  let cachedModeId: string | undefined

  async function loadSettings(): Promise<LightCodeConfig> {
    const { config } = await configManager.load()
    cachedApprovals = config.approvals?.[approvalsKey] ?? {}
    cachedModeId = config.modeId
    return config
  }

  async function saveApprovals(next: WorkspaceApprovals): Promise<void> {
    const { config } = await configManager.load()
    await configManager.save('user', { approvals: { ...config.approvals, [approvalsKey]: next } })
    cachedApprovals = next
    post({ type: 'settings', modeId: findMode(cachedModeId).id, approvals: next })
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

  const mcp = new McpRegistry(secrets, { onStateChanged: () => postMcp() }, logger, () => cachedApprovals.allowedTools ?? [])

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
  ): ToolRegistry {
    const combined = new ToolRegistry()
    for (const tool of builtinTools.list()) combined.register(tool)
    for (const tool of mcp.enabledTools()) combined.register(tool)
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
    // Registered only when the CLI is actually runnable, so the model is never told about
    // a tool that would fail — the same rule mode filtering follows.
    if (expert !== undefined) {
      combined.register(createAskExpertTool({ cli: expert.cli, ...(expert.model !== undefined ? { model: expert.model } : {}) }))
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
      ? new ShadowGit(workspaceRoot, path.join(context.globalStorageUri.fsPath, 'checkpoints', 'shadow.git'))
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
        void vscode.window.showWarningMessage(`Light Code: ${warning.message}`)
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

  async function handleSendMessage(text: string, images?: ImageAttachmentInput[]): Promise<void> {
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
      // Listed once per turn so the tool description can name real indexes; a failure here
      // only costs the model that hint, never the tool.
      const searchIndexes =
        search !== undefined ? await search.client.listIndexes().then((list) => list.map((i) => i.name)).catch(() => []) : []

      // Rebuilt whenever the profile or expert availability changes, so the model can
      // answer "which model are you?" accurately and knows whether ask_expert exists.
      // A profile switch is a session boundary, so replacing the prefix here is free (§12).
      const desiredPrompt = buildSystemPrompt(workspaceRoot, {
        model: profile.model,
        providerLabel: profile.label,
        expertAvailable: expertCliInfo !== undefined,
      })
      if (conversation.systemPrompt() !== desiredPrompt) conversation.setSystemPrompt(desiredPrompt)

      // Lazy connect (§11): a configured-but-unused server costs nothing until a turn
      // actually needs its tools. Failures are per-server and surface in the MCP tab.
      await syncMcpFromConfig(config)
      await mcp.ensureConnected()

      const toolContext: ToolExecutionContext = {
        fs: new NodeFileSystem(),
        terminal: new NodeTerminal(),
        workspaceRoot,
        denylist,
        readFiles,
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
        mode: findMode(config.modeId),
        contextWindow: capabilities.contextWindow,
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
      await runAgentTurn(
        provider,
        conversation,
        messageText,
        currentToolRegistry(
          expertCliInfo !== undefined
            ? { cli: expertCliInfo, ...(config.expert?.model !== undefined ? { model: config.expert.model } : {}) }
            : undefined,
          search !== undefined ? { client: search.client, store: search.store, indexes: searchIndexes } : undefined,
        ),
        toolContext,
        {
          onContextUpdate: (breakdown, supersededCount, compactedCount) => {
            post({ type: 'contextUsage', usage: { ...breakdown, supersededCount, compactedCount } })
          },
          onCompacted: (summarisedCount) => post({ type: 'compacted', summarisedCount }),
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
      activeAbortController = undefined
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
      const pattern = query.length > 0 ? `**/*${query}*` : '**/*'
      const found = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 30)
      const paths = found
        .map((uri) => path.relative(workspaceRoot, uri.fsPath).split(path.sep).join('/'))
        .sort((a, b) => a.length - b.length)
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
  async function postExpert(): Promise<void> {
    const { config } = await configManager.load()
    const configured = config.expert?.path ?? 'claude'
    const detected = await detectClaudeCli(configured)
    // Cache the probe so the next turn does not re-spawn it.
    expertCli = detected
    expertCliPath = configured

    post({
      type: 'expert',
      enabled: config.expert?.enabled === true,
      available: detected.available,
      path: configured,
      ...(detected.version !== undefined ? { version: detected.version } : {}),
      ...(detected.reason !== undefined ? { reason: detected.reason } : {}),
      ...(config.expert?.model !== undefined ? { model: config.expert.model } : {}),
    })
  }

  async function handleSetExpert(enabled: boolean, cliPath?: string, model?: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      await configManager.save('user', {
        expert: {
          ...config.expert,
          enabled,
          ...(cliPath !== undefined && cliPath.length > 0 ? { path: cliPath } : {}),
          ...(model !== undefined && model.length > 0 ? { model } : { model: undefined }),
        },
      })
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
   * Builds a read-only client for a configured connection, resolving credentials from
   * secure storage and the CA from disk at call time rather than caching either.
   */
  async function openSearchClientFor(store: VectorStoreConfig, id: string): Promise<OpenSearchClient> {
    const connection: OpenSearchConnection = { url: store.url }

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
    return new OpenSearchClient(httpClient, connection)
  }

  /**
   * The active connection for this session, or undefined when search is off.
   *
   * Search tools exist only when a connection is selected — §12 requires the tool set to be
   * stable within a session, so selection is the boundary at which it may change.
   */
  async function resolveSearch(
    config: LightCodeConfig,
  ): Promise<{ client: OpenSearchClient; store: VectorStoreConfig; id: string } | undefined> {
    const id = config.activeVectorStoreId
    if (id === undefined) return undefined
    const store = config.vectorStores?.[id]
    if (store === undefined) return undefined
    try {
      return { client: await openSearchClientFor(store, id), store, id }
    } catch (error) {
      logger.warn('could not build the search client', String(error))
      return undefined
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
        kind: 'opensearch',
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
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ['json'] },
        defaultUri: vscode.Uri.file('light-code-config.json'),
      })
      if (uri === undefined) return
      await fs.writeFile(uri.fsPath, JSON.stringify(config, null, 2), 'utf8')
      void vscode.window.showInformationMessage(`Light Code config exported to ${uri.fsPath}`)
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleImportConfig(): Promise<void> {
    try {
      const uris = await vscode.window.showOpenDialog({
        filters: { JSON: ['json'] },
        canSelectMany: false,
      })
      const uri = uris?.[0]
      if (uri === undefined) return

      const raw = await fs.readFile(uri.fsPath, 'utf8')
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

      void vscode.window.showInformationMessage(
        needKeys.length > 0
          ? `Light Code config imported. Re-enter the API key for: ${needKeys.join(', ')} (exports never include secrets).`
          : 'Light Code config imported.',
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
      void vscode.window.showInformationMessage('Light Code: workspace rolled back.')
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function postSettings(): Promise<void> {
    await loadSettings()
    post({ type: 'settings', modeId: findMode(cachedModeId).id, approvals: cachedApprovals })
  }

  /** Approve now, and remember it for this workspace. */
  async function handleAlwaysAllow(id: string, scope: 'tool' | 'command'): Promise<void> {
    const request = userGate.getRequest(id)
    userGate.resolve(id, 'approve')
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
      void handleSendMessage(message.text, message.images)
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
    } else if (message.type === 'approvalResponse') {
      userGate.resolve(message.id, message.decision)
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
    } else if (message.type === 'deleteMcpServer') {
      void handleDeleteMcpServer(message.name)
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
    } else if (message.type === 'requestNetwork') {
      void postNetwork()
    } else if (message.type === 'saveNetwork') {
      void handleSaveNetwork(message.settings)
    } else if (message.type === 'requestExpert') {
      void postExpert()
    } else if (message.type === 'setExpert') {
      void handleSetExpert(message.enabled, message.path, message.model)
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

  return {
    dispose: () => {
      // Disposing while a turn awaits approval would otherwise leak a pending promise.
      userGate.denyAll()
      // stdio servers are child processes — not closing them leaks one per panel open.
      void mcp.closeAll()
      unsubscribe()
    },
  }
}
