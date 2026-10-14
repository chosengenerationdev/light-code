import * as vscode from 'vscode'

import type { ChatBridge } from '@light-code/core'

/*
 * "Write commit message" on the Source Control title bar - Fire Code's "Write with agent", in VS Code.
 *
 * The message is written by the bridge (the same function Fire Code's dialog uses, so the two describe
 * a change the same way) and put in the repository's commit box for the person to read, edit and
 * commit themselves. Nothing is committed here.
 *
 * VS Code's git extension is reached through its public API, typed below only as far as it is used.
 * It is built in, but can be disabled, so its absence is said rather than thrown.
 */

interface GitRepository {
  rootUri: vscode.Uri
  inputBox: { value: string }
}

interface GitApi {
  repositories: GitRepository[]
  getRepository(uri: vscode.Uri): GitRepository | null
}

async function gitApi(): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git')
  if (extension === undefined) return undefined
  const exports = extension.isActive ? extension.exports : await extension.activate()
  return exports.getAPI(1)
}

/** The repository the button was pressed for, or the only one, or the one the person picks. */
async function chooseRepository(api: GitApi, clicked: unknown): Promise<GitRepository | undefined> {
  const rootUri = (clicked as { rootUri?: unknown } | undefined)?.rootUri
  if (rootUri instanceof vscode.Uri) {
    const repository = api.getRepository(rootUri)
    if (repository !== null) return repository
  }
  if (api.repositories.length <= 1) return api.repositories[0]
  const picked = await vscode.window.showQuickPick(
    api.repositories.map((repository) => ({ label: vscode.workspace.asRelativePath(repository.rootUri, true), repository })),
    { placeHolder: 'Which repository is the commit message for?' },
  )
  return picked?.repository
}

export function registerCommitMessageCommand(ensureBridge: () => ChatBridge): vscode.Disposable {
  return vscode.commands.registerCommand('lightCode.writeCommitMessage', async (clicked?: unknown): Promise<void> => {
    const api = await gitApi()
    if (api === undefined) {
      void vscode.window.showErrorMessage('Light Code needs VS Code\'s built-in Git extension to write a commit message, and it is disabled.')
      return
    }
    const repository = await chooseRepository(api, clicked)
    if (repository === undefined) {
      if (api.repositories.length === 0) void vscode.window.showErrorMessage('No git repository is open, so there is nothing to describe.')
      return
    }
    // A message somebody already typed is theirs; replacing it unasked would lose it.
    if (repository.inputBox.value.trim().length > 0) {
      const choice = await vscode.window.showWarningMessage(
        'Replace the commit message you have typed with one Light Code writes?',
        { modal: true },
        'Replace',
      )
      if (choice !== 'Replace') return
    }
    try {
      const message = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: 'Light Code is writing the commit message' },
        () => ensureBridge().writeCommitMessage(repository.rootUri.fsPath),
      )
      repository.inputBox.value = message
    } catch (error) {
      void vscode.window.showErrorMessage(`Light Code could not write a commit message: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
