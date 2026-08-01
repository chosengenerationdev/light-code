import * as vscode from 'vscode'
import { ChatViewProvider } from './webview/chatViewProvider.js'

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Light Code')
  context.subscriptions.push(outputChannel)

  const provider = new ChatViewProvider(context, outputChannel)
  const viewDisposable = vscode.window.registerWebviewViewProvider('lightCode.chatView', provider)

  const openCommand = vscode.commands.registerCommand('lightCode.openPanel', () => {
    void vscode.commands.executeCommand('workbench.view.extension.lightCode')
  })

  context.subscriptions.push(viewDisposable, openCommand)
}

export function deactivate(): void {}
