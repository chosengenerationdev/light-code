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
  OpenAIProvider,
  PathDenylist,
  PolicyApprovalGate,
  ShadowGit,
  addToAllowlist,
  buildSystemPrompt,
  createAuthStrategy,
  createDefaultToolRegistry,
  createReadToolResultTool,
  findMode,
  parseConfig,
  removeFromAllowlist,
  resolveActiveProfile,
  runAgentTurn,
  validateProviderForm,
  type ApprovableGroup,
  type Auth,
  type Checkpoint,
  type HostToUiMessage,
  type LightCodeConfig,
  type ProfileInput,
  type ProfileSummary,
  type ProviderProfile,
  type RunAgentTurnOptions,
  type ToolCallSummary,
  type ToolExecutionContext,
  type UiToHostMessage,
  type WorkspaceApprovals,
} from '@light-code/core'
import { WebviewApprovalGate } from './approvalGate.js'
import { NodeFileSystem } from '../platform/filesystem.js'
import { NodeTerminal } from '../platform/terminal.js'
import { VSCodeConfigStore } from '../platform/config.js'
import { VSCodeSecretStore } from '../platform/secrets.js'
import { WebviewTransport } from '../platform/transport.js'

/**
 * Tools whose "result" is really the model addressing the user, not work performed.
 * The agent loop already terminates on these (see `runAgentTurn`); here they also skip
 * the tool-block rendering and appear as ordinary assistant messages.
 */
const CONTROL_TOOLS = new Set(['attempt_completion', 'ask_followup_question'])

function apiKeyRefFor(profileId: string): string {
  return `profile:${profileId}:apiKey`
}

/**
 * `hasApiKey` reflects whether the secret **actually exists in the store**, not merely
 * whether config claims an `apiKeyRef`. Those can diverge (a secret deleted or never
 * written leaves a dangling reference), and reporting the config's claim would show
 * "Set — leave blank to keep" for a key that isn't there — leaving the user no way to
 * fix it from the UI. Still never sends the value itself (invariant 7).
 */
async function toSummary(profile: ProviderProfile, secrets: VSCodeSecretStore): Promise<ProfileSummary> {
  const hasApiKey = profile.auth.type === 'apiKey' && (await secrets.get(profile.auth.apiKeyRef)) !== undefined
  return {
    id: profile.id,
    label: profile.label,
    wireFormat: profile.wireFormat,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasApiKey,
  }
}

/** Pretty-prints tool arguments for display; falls back to the raw string if it isn't JSON. */
function formatToolArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw.length > 0 ? raw : '{}'), null, 2)
  } catch {
    return raw
  }
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

  const truncationStore = new DiskTruncationStore(path.join(context.globalStorageUri.fsPath, 'tool-results'))
  const toolRegistry = createDefaultToolRegistry()
  toolRegistry.register(createReadToolResultTool(truncationStore))

  // Files read via read_file this session; write_to_file/apply_diff check this before
  // touching an existing file. Session-scoped, so it lives alongside the conversation.
  const readFiles = new Set<string>()
  const denylist = new PathDenylist()

  let activeAbortController: AbortController | undefined
  /** The task's rollback point — the snapshot taken before its first edit. */
  let taskCheckpoint: Checkpoint | undefined

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

  async function handleSendMessage(text: string): Promise<void> {
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

      const profile = resolveActiveProfile(config)
      const authStrategy = createAuthStrategy(profile.auth, secrets)
      const provider = new OpenAIProvider(httpClient, profile, authStrategy, logger)

      const toolContext: ToolExecutionContext = {
        fs: new NodeFileSystem(),
        terminal: new NodeTerminal(),
        workspaceRoot,
        denylist,
        readFiles,
        signal: activeAbortController.signal,
      }

      const turnOptions: RunAgentTurnOptions = {
        signal: activeAbortController.signal,
        truncationStore,
        approvalGate,
        // Resolved once per turn, so the tool definitions stay byte-stable for the whole
        // loop — swapping them mid-turn would break the prompt cache prefix (§12).
        mode: findMode(config.modeId),
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
      await runAgentTurn(
        provider,
        conversation,
        text,
        toolRegistry,
        toolContext,
        {
          onTextChunk: (chunk) => {
            cumulativeText += chunk
            post({ type: 'textChunk', text: cumulativeText })
          },
          onToolCall: (toolCall) => {
            // Each tool call starts a fresh assistant text block in the transcript.
            cumulativeText = ''
            if (CONTROL_TOOLS.has(toolCall.name)) return
            const summary: ToolCallSummary = {
              id: toolCall.id,
              name: toolCall.name,
              arguments: formatToolArguments(toolCall.arguments),
            }
            post({ type: 'toolCall', toolCall: summary })
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
            post({ type: 'toolResult', toolCall: summary })
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
    }
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

    try {
      const { config } = await configManager.load()
      const profiles = config.profiles ?? []
      const id = input.id ?? randomUUID()
      const existing = profiles.find((p) => p.id === id)
      const apiKeyRef = apiKeyRefFor(id)

      // Only ever claim `apiKey` auth when the secret genuinely exists in the store.
      // Trusting config's own claim here is what lets a dangling apiKeyRef survive
      // every subsequent save, leaving the profile permanently unusable.
      let auth: Auth
      if (input.apiKey.trim().length > 0) {
        await secrets.set(apiKeyRef, input.apiKey.trim())
        auth = { type: 'apiKey', apiKeyRef }
      } else if (existing?.auth.type === 'apiKey' && (await secrets.get(apiKeyRef)) !== undefined) {
        auth = { type: 'apiKey', apiKeyRef } // leave the existing secret untouched
      } else {
        auth = { type: 'none' }
      }

      const saved: ProviderProfile = {
        id,
        label: input.label.trim(),
        wireFormat: input.wireFormat,
        baseUrl: input.baseUrl.trim(),
        model: input.model.trim(),
        auth,
      }

      const nextProfiles = existing ? profiles.map((p) => (p.id === id ? saved : p)) : [...profiles, saved]
      // The very first profile ever created becomes active automatically.
      const activeProfileId = config.activeProfileId ?? (nextProfiles.length === 1 ? id : undefined)
      await configManager.save('user', { profiles: nextProfiles, activeProfileId })

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
      let auth: Auth = { type: 'none' }
      if (source.auth.type === 'apiKey') {
        const existingKey = await secrets.get(source.auth.apiKeyRef)
        // If the source secret is missing there's nothing to copy — leave the duplicate
        // as `none` rather than pointing it at a secret that was never written.
        if (existingKey !== undefined) {
          const newRef = apiKeyRefFor(newId)
          await secrets.set(newRef, existingKey)
          auth = { type: 'apiKey', apiKeyRef: newRef }
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

      await secrets.delete(apiKeyRefFor(id))

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

  const unsubscribe = transport.onMessage((raw) => {
    const message = raw as UiToHostMessage
    if (message.type === 'sendMessage') {
      if (activeAbortController !== undefined) {
        // The composer is supposed to prevent this — a guard against UI/host desync
        // corrupting the shared conversation and streaming buffer with interleaved turns.
        logger.warn('Ignoring sendMessage: a turn is already in progress.')
        return
      }
      void handleSendMessage(message.text)
    } else if (message.type === 'cancel') {
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
    } else if (message.type === 'requestProfiles') {
      void postProfiles()
    } else if (message.type === 'saveProfile') {
      void handleSaveProfile(message.profile)
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

  return {
    dispose: () => {
      // Disposing while a turn awaits approval would otherwise leak a pending promise.
      userGate.denyAll()
      unsubscribe()
    },
  }
}
