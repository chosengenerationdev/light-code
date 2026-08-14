import * as vscode from 'vscode'
import { Logger, type HostServices, type HostUi, type OpenDialogOptions } from '@light-code/core'
import { VSCodeConfigStore } from '../platform/config.js'
import { resolveRipgrepPath } from '../platform/ripgrep.js'
import { VSCodeSecretStore } from '../platform/secrets.js'
import { WebviewTransport } from '../platform/transport.js'

/**
 * The VS Code implementation of `HostServices`.
 *
 * Everything genuinely specific to running inside the editor lives here; the bridge itself
 * is in core and shared with the Node server. Keeping this file small is the measure of
 * whether that split is holding.
 */
export function createVSCodeHostServices(
  transport: WebviewTransport,
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): HostServices {
  const logSink = (line: string): void => outputChannel.appendLine(line)
  const logger = new Logger({ level: 'debug', sink: logSink })
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

  const ui: HostUi = {
    showInfo: (message) => void vscode.window.showInformationMessage(`Light Code: ${message}`),
    showWarning: (message) => void vscode.window.showWarningMessage(`Light Code: ${message}`),

    async showActionMessage(message: string, action: string, level: 'info' | 'warning') {
      const show = level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage
      const chosen = await show(`Light Code: ${message}`, action)
      return chosen === action
    },

    async openDocument({ title, content, language }: { title: string; content: string; language?: string }) {
      /*
       * An untitled in-memory document rather than a temp file on disk. Nothing to clean up,
       * nothing left behind after a crash, and no path for the user to wonder about — and a
       * transcript is not something they asked to have written anywhere.
       */
      const document = await vscode.workspace.openTextDocument({
        content: `# ${title}\n\n${content}`,
        language: language ?? 'markdown',
      })
      // Beside the panel rather than replacing it, and preview:false so opening a second run
      // does not silently replace the first in the same tab.
      await vscode.window.showTextDocument(document, { preview: false })
    },

    async revealPanel() {
      // The view's own focus command, contributed by the `views` entry in package.json. Using
      // it rather than a custom command means VS Code handles the container being collapsed.
      await vscode.commands.executeCommand('lightCode.chatView.focus')
    },

    async showOpenDialog(options: OpenDialogOptions) {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: options.kind === 'file',
        canSelectFolders: options.kind === 'folder',
        canSelectMany: false,
        openLabel: 'Select',
        ...(options.defaultPath !== undefined ? { defaultUri: vscode.Uri.file(options.defaultPath) } : {}),
        ...(options.extensions !== undefined && options.extensions.length > 0
          ? { filters: { Supported: options.extensions } }
          : {}),
      })
      return uris?.[0]?.fsPath
    },

    async showSaveDialog(options) {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(options.defaultName),
        ...(options.extensions !== undefined ? { filters: { Supported: options.extensions } } : {}),
      })
      return uri?.fsPath
    },

    /**
     * The editor's own index, not a tree walk: it already honours `files.exclude` and
     * `search.exclude`, so `node_modules` never appears and it stays fast in a large repo.
     */
    async findFiles(pattern, limit) {
      const found = await vscode.workspace.findFiles(pattern, '**/node_modules/**', limit)
      return found.map((uri) => uri.fsPath)
    },
  }

  return {
    transport,
    secrets: new VSCodeSecretStore(context.secrets, logger),
    configStore: new VSCodeConfigStore(context, workspaceRoot),
    workspaceState: {
      get: (key) => context.workspaceState.get<string>(key),
      set: (key, value) => Promise.resolve(context.workspaceState.update(key, value)),
    },
    ui,
    workspaceRoot,
    storageDir: context.globalStorageUri.fsPath,
    // Resolved once per session: the answer cannot change while running, and a missing
    // binary should be logged once rather than on every turn.
    ripgrepPath: resolveRipgrepPath(context.extensionPath, logger),
    logSink,
  }
}
