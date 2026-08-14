import * as vscode from 'vscode'
import { ConfigManager, Logger, isDue, wireChatBridge, type Schedule } from '@light-code/core'
import { VSCodeConfigStore } from './platform/config.js'
import { WebviewTransport } from './platform/transport.js'
import { ChatViewProvider } from './webview/chatViewProvider.js'
import { createVSCodeHostServices } from './webview/hostServices.js'

/** Matches the bridge's own tick. A minute is the finest interval a schedule can ask for. */
const SCHEDULE_POLL_MS = 60_000

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Light Code')
  context.subscriptions.push(outputChannel)

  // Fires for every change to this extension's secrets, including ones made outside our
  // own code. Paired with VSCodeSecretStore's own logging, this is what tells us whether
  // a vanished credential was deleted by Light Code or by something else.
  context.subscriptions.push(
    context.secrets.onDidChange((event) => {
      outputChannel.appendLine(`[info] SecretStorage.onDidChange: "${event.key}"`)
    }),
  )

  const transport = new WebviewTransport(new Logger({ level: 'debug', sink: (line) => outputChannel.appendLine(line) }))

  /*
   * The bridge is created once and outlives every webview.
   *
   * It used to be created per view, which meant everything it owns — the conversation, the
   * MCP connections, and the schedule timer — was destroyed whenever the panel was torn
   * down. A schedule cannot fire from a timer that no longer exists, which is exactly the
   * reported symptom: nothing ran, yet Run Now worked, because Run Now is only reachable
   * from the panel that was keeping the timer alive.
   */
  let bridge: { resync: () => void; dispose: () => void } | undefined
  const ensureBridge = (): { resync: () => void } => {
    bridge ??= wireChatBridge(createVSCodeHostServices(transport, context, outputChannel))
    return bridge
  }

  const provider = new ChatViewProvider(context, transport, ensureBridge)
  const viewDisposable = vscode.window.registerWebviewViewProvider('lightCode.chatView', provider, {
    // Keeps the webview alive across view switches so a quick trip to Explorer does not
    // rebuild it. The transcript survives a full teardown too now, via `resync`.
    webviewOptions: { retainContextWhenHidden: true },
  })

  const openCommand = vscode.commands.registerCommand('lightCode.openPanel', () => {
    void vscode.commands.executeCommand('workbench.view.extension.lightCode')
  })

  /*
   * A deliberately tiny poller that reads config and nothing else.
   *
   * The extension now activates at startup so schedules work without the panel ever being
   * opened — but §11 is clear that nothing may *spawn* at startup, and constructing the
   * bridge starts MCP servers and the Python worker. So this reads the config file, and only
   * when something is actually due does it build the bridge, which then takes over ticking
   * with its own timer.
   */
  const configManager = new ConfigManager(
    new VSCodeConfigStore(context, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
  )
  const poll = setInterval(() => {
    if (bridge !== undefined) return
    void (async () => {
      try {
        const { config } = await configManager.load()
        const schedules: Schedule[] = Object.values(config.schedules ?? {})
        if (schedules.some((schedule) => isDue(schedule, Date.now()))) {
          outputChannel.appendLine('[info] a schedule is due — starting Light Code in the background')
          ensureBridge()
        }
      } catch (error) {
        outputChannel.appendLine(`[warn] schedule poll failed: ${String(error)}`)
      }
    })()
  }, SCHEDULE_POLL_MS)

  context.subscriptions.push(viewDisposable, openCommand, {
    dispose: () => {
      clearInterval(poll)
      bridge?.dispose()
    },
  })
}

export function deactivate(): void {}
