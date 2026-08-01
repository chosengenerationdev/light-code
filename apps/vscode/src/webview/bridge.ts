import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import * as vscode from 'vscode'
import {
  ConfigManager,
  Conversation,
  FetchHttpClient,
  Logger,
  OpenAIProvider,
  createAuthStrategy,
  parseConfig,
  resolveActiveProfile,
  runAgentTurn,
  validateProviderForm,
  type Auth,
  type HostToUiMessage,
  type ProfileInput,
  type ProfileSummary,
  type ProviderProfile,
  type UiToHostMessage,
} from '@light-code/core'
import { VSCodeConfigStore } from '../platform/config.js'
import { VSCodeSecretStore } from '../platform/secrets.js'
import { WebviewTransport } from '../platform/transport.js'

function apiKeyRefFor(profileId: string): string {
  return `profile:${profileId}:apiKey`
}

function toSummary(profile: ProviderProfile): ProfileSummary {
  return {
    id: profile.id,
    label: profile.label,
    wireFormat: profile.wireFormat,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasApiKey: profile.auth.type === 'apiKey',
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
  const secrets = new VSCodeSecretStore(context.secrets)
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const configManager = new ConfigManager(new VSCodeConfigStore(context, workspaceRoot))
  const httpClient = new FetchHttpClient()
  const conversation = new Conversation()

  let activeAbortController: AbortController | undefined

  function post(message: HostToUiMessage): void {
    transport.post(message)
  }

  async function postProfiles(): Promise<void> {
    const { config } = await configManager.load()
    const profiles = (config.profiles ?? []).map(toSummary)
    post({ type: 'profiles', profiles, activeProfileId: config.activeProfileId })
  }

  async function handleSendMessage(text: string): Promise<void> {
    activeAbortController = new AbortController()
    try {
      const { config } = await configManager.load()
      const profile = resolveActiveProfile(config)
      const authStrategy = createAuthStrategy(profile.auth, secrets)
      const provider = new OpenAIProvider(httpClient, profile, authStrategy, logger)

      // Send cumulative text, not the delta — webview `postMessage` delivery isn't
      // guaranteed, and this makes each message self-correcting rather than letting
      // one dropped delta permanently corrupt everything streamed after it.
      let cumulativeText = ''
      await runAgentTurn(
        provider,
        conversation,
        text,
        {
          onTextChunk: (chunk) => {
            cumulativeText += chunk
            post({ type: 'textChunk', text: cumulativeText })
          },
          onDone: () => post({ type: 'done' }),
          onError: (message) => post({ type: 'error', message }),
        },
        { signal: activeAbortController.signal },
      )
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
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

      let auth: Auth
      if (input.apiKey.trim().length > 0) {
        await secrets.set(apiKeyRef, input.apiKey.trim())
        auth = { type: 'apiKey', apiKeyRef }
      } else if (existing?.auth.type === 'apiKey') {
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
        const newRef = apiKeyRefFor(newId)
        if (existingKey !== undefined) await secrets.set(newRef, existingKey)
        auth = { type: 'apiKey', apiKeyRef: newRef }
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
      await configManager.save('user', imported)
      await postProfiles()
      void vscode.window.showInformationMessage('Light Code config imported.')
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
      void handleSendMessage(message.text)
    } else if (message.type === 'cancel') {
      activeAbortController?.abort()
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

  return { dispose: unsubscribe }
}
