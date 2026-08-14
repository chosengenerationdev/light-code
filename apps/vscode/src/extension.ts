import * as vscode from 'vscode'
import { ConfigManager, Logger, isDue, wireChatBridge, type ChatBridge, type Schedule } from '@light-code/core'
import { VSCodeConfigStore } from './platform/config.js'
import { WebviewTransport } from './platform/transport.js'
import { ChatViewProvider } from './webview/chatViewProvider.js'
import { createVSCodeHostServices } from './webview/hostServices.js'

/** How often the host looks in on the scheduler. Frequent enough to revive it within a minute. */
const SCHEDULE_POLL_MS = 30_000

/**
 * How stale the bridge's last tick may be before the timer is presumed dead.
 *
 * The bridge ticks every 15s, so three missed ticks is a confident diagnosis rather than a
 * slow machine. This exists because the timer has now stopped twice leaving no trace of why —
 * the honest response to that is to watch it, not to assume the next fix held.
 */
const TICK_STALE_MS = 75_000

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
  let bridge: ChatBridge | undefined
  const ensureBridge = (): ChatBridge => {
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
    void (async () => {
      try {
        /*
         * Once a bridge exists this is a watchdog rather than a starter.
         *
         * The bridge's own timer has stopped twice now — after working for a while, with
         * nothing in the log — so its liveness is checked rather than assumed. A stale
         * last-tick means the interval is gone, and it is restarted here without the user
         * having to notice and press anything.
         */
        if (bridge !== undefined) {
          const health = bridge.schedulerHealth()
          const stale = health.lastTickAt !== undefined && Date.now() - health.lastTickAt > TICK_STALE_MS
          if (!health.running || stale) {
            outputChannel.appendLine(
              `[warn] the schedule timer stopped (running=${String(health.running)}, last tick ${
                health.lastTickAt === undefined ? 'never' : new Date(health.lastTickAt).toISOString()
              }) — restarting it`,
            )
            bridge.restartScheduler()
          }
          return
        }

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
