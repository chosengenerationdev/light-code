import * as vscode from 'vscode'
import {
  ConfigManager,
  Conversation,
  FetchHttpClient,
  Logger,
  OpenAIProvider,
  createAuthStrategy,
  resolveActiveProfile,
  runAgentTurn,
  type Auth,
  type HostToUiMessage,
  type ProviderProfile,
  type UiToHostMessage,
} from '@light-code/core'
import { VSCodeConfigStore } from '../platform/config.js'
import { VSCodeSecretStore } from '../platform/secrets.js'
import { WebviewTransport } from '../platform/transport.js'

/** Only one profile is managed until Phase 2b's real multi-profile Providers tab exists. */
const SINGLE_PROFILE_ID = 'default'

/** Wires the webview's chat UI to the agent loop. Phase 2: one OpenAI-compatible profile, no tools. */
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

  async function handleRequestProfile(): Promise<void> {
    try {
      const { config } = await configManager.load()
      logger.debug('requestProfile: loaded config', JSON.stringify(config))
      const profile = resolveActiveProfile(config)
      post({ type: 'profile', baseUrl: profile.baseUrl, model: profile.model, hasApiKey: profile.auth.type === 'apiKey' })
    } catch (error) {
      logger.debug('requestProfile: no active profile', error instanceof Error ? error.message : String(error))
      post({ type: 'profile', baseUrl: '', model: '', hasApiKey: false })
    }
  }

  async function handleSaveProfile(baseUrl: string, model: string, apiKey: string): Promise<void> {
    const trimmedBaseUrl = baseUrl.trim()
    const trimmedModel = model.trim()
    if (trimmedBaseUrl.length === 0 || trimmedModel.length === 0) {
      post({ type: 'error', message: 'Base URL and model are both required.' })
      return
    }

    try {
      const apiKeyRef = `profile:${SINGLE_PROFILE_ID}:apiKey`
      const { config } = await configManager.load()
      const existing = config.profiles?.find((p) => p.id === SINGLE_PROFILE_ID)
      const hadApiKey = existing?.auth.type === 'apiKey'

      let auth: Auth
      if (apiKey.trim().length > 0) {
        await secrets.set(apiKeyRef, apiKey.trim())
        auth = { type: 'apiKey', apiKeyRef }
      } else if (hadApiKey) {
        auth = { type: 'apiKey', apiKeyRef } // leave the existing secret untouched
      } else {
        auth = { type: 'none' }
      }

      const profile: ProviderProfile = {
        id: SINGLE_PROFILE_ID,
        label: 'Default',
        wireFormat: 'openai',
        baseUrl: trimmedBaseUrl,
        model: trimmedModel,
        auth,
      }
      await configManager.save('user', { profiles: [profile], activeProfileId: SINGLE_PROFILE_ID })
      const { config: reloaded } = await configManager.load()
      logger.debug('saveProfile: wrote and re-read config', JSON.stringify(reloaded))
      post({ type: 'profileSaved' })
    } catch (error) {
      logger.debug('saveProfile: failed', error instanceof Error ? error.message : String(error))
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
    } else if (message.type === 'requestProfile') {
      void handleRequestProfile()
    } else if (message.type === 'saveProfile') {
      void handleSaveProfile(message.baseUrl, message.model, message.apiKey)
    }
  })

  return { dispose: unsubscribe }
}
