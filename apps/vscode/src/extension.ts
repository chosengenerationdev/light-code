import * as vscode from 'vscode'
import { ChatViewProvider } from './webview/chatViewProvider.js'

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

  const provider = new ChatViewProvider(context, outputChannel)
  // Without `retainContextWhenHidden`, VS Code tears the webview down whenever the view is
  // hidden — switching to Explorer and back would silently discard the whole transcript.
  // This keeps it across view switches; surviving a window reload is Phase 6b's job.
  const viewDisposable = vscode.window.registerWebviewViewProvider('lightCode.chatView', provider, {
    webviewOptions: { retainContextWhenHidden: true },
  })

  const openCommand = vscode.commands.registerCommand('lightCode.openPanel', () => {
    void vscode.commands.executeCommand('workbench.view.extension.lightCode')
  })

  context.subscriptions.push(viewDisposable, openCommand)
}

export function deactivate(): void {}
