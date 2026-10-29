import * as vscode from 'vscode'
import {
  addWorktree,
  currentBranchOf,
  defaultBaseBranch,
  listBranches,
  listWorktrees,
  mainCheckoutOf,
  markForSetup,
  removeWorktree,
  repositoryOf,
  setupMarkerFor,
  worktreeFolderFor,
  worktreeStatus,
  type ConfigManager,
  type WorktreeInfo,
} from '@light-code/core'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Several branches of one repository, each in its own VS Code window (core git/worktrees.ts).
 *
 * "Open branch in new window" makes a branch folder beside the repository and opens it in a new window, which
 * runs, debugs and has its own Light Code like any project; "Branches" lists them with their state and closes
 * one safely. Terminals and debug sessions in a branch window get LIGHT_CODE_BRANCH and LIGHT_CODE_PORT_OFFSET,
 * set by the extension - never written into a file in the repository.
 */

function thisFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

function same(a: string, b: string): boolean {
  const norm = (value: string): string => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value))
  return norm(a) === norm(b)
}

function openWindow(folder: string): Thenable<unknown> {
  return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true })
}

async function chosenFolderRoot(configManager: ConfigManager): Promise<string | undefined> {
  const { config } = await configManager.load()
  const folder = config.branches?.folder?.trim()
  return folder !== undefined && folder.length > 0 ? folder : undefined
}

async function openBranch(configManager: ConfigManager): Promise<void> {
  const here = thisFolder()
  const repo = here !== undefined ? await repositoryOf(here) : undefined
  if (here === undefined || repo === undefined) {
    void vscode.window.showWarningMessage('Open a folder that is in a git repository first.')
    return
  }
  let worktrees: WorktreeInfo[]
  let branches: Awaited<ReturnType<typeof listBranches>>
  try {
    ;[worktrees, branches] = await Promise.all([listWorktrees(repo), listBranches(repo)])
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not read the branches of ${path.basename(repo)}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  // Git makes a branch with the first commit: an empty repository has nothing to open or start from.
  if (branches.local.length === 0 && branches.remote.length === 0) {
    void vscode.window.showInformationMessage(
      `${path.basename(repo)} has no commits yet, so there is no branch to open or to start a new one from. Make a first commit, then open branches.`,
    )
    return
  }
  const openIn = new Map(worktrees.filter((each) => each.branch !== undefined).map((each) => [each.branch as string, each]))
  const current = currentBranchOf(here)
  // A new branch starts from the main branch by default (main or master), not from whatever is checked out.
  const base = await defaultBaseBranch(repo)
  type Item = vscode.QuickPickItem & { action: 'new' | 'open' | 'add'; branch?: string; folder?: string }
  const items: Item[] = [
    { label: '$(add) New branch…', description: `made from ${base ?? current ?? 'a branch you choose'} (or another you choose)`, action: 'new' },
    { label: 'Local branches', kind: vscode.QuickPickItemKind.Separator, action: 'add' },
    ...branches.local.map((branch): Item => {
      const open = openIn.get(branch)
      return open !== undefined
        ? { label: `$(window) ${branch}`, description: same(open.path, here) ? 'this window' : `open in ${open.path}`, action: 'open', branch, folder: open.path }
        : { label: `$(git-branch) ${branch}`, action: 'add', branch }
    }),
    ...(branches.remote.length > 0 ? [{ label: 'Remote branches (already fetched)', kind: vscode.QuickPickItemKind.Separator, action: 'add' } as Item] : []),
    ...branches.remote.map((branch): Item => ({ label: `$(cloud) ${branch}`, description: 'checked out as a local branch tracking it', action: 'add', branch })),
  ]
  const picked = await vscode.window.showQuickPick(items, { title: `Open a branch of ${path.basename(repo)} in a new window`, matchOnDescription: true })
  if (picked === undefined) return
  if (picked.action === 'open' && picked.folder !== undefined) {
    if (same(picked.folder, here)) void vscode.window.showInformationMessage(`${picked.branch ?? 'That branch'} is open in this window.`)
    else await openWindow(picked.folder)
    return
  }
  let branch = picked.branch
  let from: string | undefined
  if (picked.action === 'new') {
    branch = await vscode.window.showInputBox({ title: 'New branch', prompt: 'Name of the new branch', placeHolder: 'e.g. PAY-1234-add-retry' })
    if (branch === undefined || branch.trim().length === 0) return
    branch = branch.trim()
    const bases = [...new Set([base, current, ...branches.local, ...branches.remote].filter((each): each is string => each !== undefined))]
    from = await vscode.window.showQuickPick(
      bases.map((each) => ({ label: each, ...(each === base ? { description: 'main branch' } : each === current ? { description: 'this window' } : {}) })),
      { title: `Make ${branch} from` },
    ).then((picked) => picked?.label)
    if (from === undefined) return
  }
  if (branch === undefined) return
  const target = branch
  try {
    const folder = worktreeFolderFor(repo, target, await chosenFolderRoot(configManager))
    const made = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Opening ${target} in ${folder}…` },
      () => addWorktree({ repo, branch: target, ...(from !== undefined ? { from } : {}), folder }),
    )
    await markForSetup(made.folder)
    await openWindow(made.folder)
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not open ${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function manageBranches(): Promise<void> {
  const here = thisFolder()
  const repo = here !== undefined ? await repositoryOf(here) : undefined
  if (here === undefined || repo === undefined) {
    void vscode.window.showWarningMessage('Open a folder that is in a git repository first.')
    return
  }
  const worktrees = await listWorktrees(repo)
  const statuses = await Promise.all(
    worktrees.map((each) => (each.missing === true ? Promise.resolve(undefined) : worktreeStatus(each.path).catch(() => undefined))),
  )
  type Item = vscode.QuickPickItem & { tree: WorktreeInfo }
  const items: Item[] = worktrees.map((tree, index) => {
    const status = statuses[index]
    const state =
      tree.missing === true
        ? 'folder missing'
        : status === undefined
          ? ''
          : [
              status.uncommitted > 0 ? `${String(status.uncommitted)} uncommitted` : 'clean',
              status.noUpstream === true ? 'never pushed' : status.unpushed !== undefined && status.unpushed > 0 ? `${String(status.unpushed)} not pushed` : '',
            ]
              .filter(Boolean)
              .join(', ')
    return {
      label: `${tree.main ? '$(repo)' : '$(git-branch)'} ${tree.branch ?? '(detached)'}`,
      description: [tree.main ? 'main checkout' : '', same(tree.path, here) ? 'this window' : '', state].filter(Boolean).join(' · '),
      detail: tree.path,
      tree,
    }
  })
  const picked = await vscode.window.showQuickPick(items, { title: `Branch folders of ${path.basename(repo)}` })
  if (picked === undefined) return
  const actions = ['Open in a new window', ...(picked.tree.main ? [] : ['Close branch (remove its folder)'])]
  const action = await vscode.window.showQuickPick(actions, { title: picked.tree.branch ?? picked.tree.path })
  if (action === 'Open in a new window') {
    await openWindow(picked.tree.path)
    return
  }
  if (action === undefined) return
  if (same(picked.tree.path, here)) {
    void vscode.window.showWarningMessage('This window has that folder open. Close this window, then close the branch from another window of the repository.')
    return
  }
  const status = await worktreeStatus(picked.tree.path).catch(() => undefined)
  const losing = [
    status !== undefined && status.uncommitted > 0 ? `${String(status.uncommitted)} uncommitted change(s) will be lost` : '',
    status?.unpushed !== undefined && status.unpushed > 0 ? `${String(status.unpushed)} commit(s) are not pushed (they stay on the branch)` : '',
  ].filter(Boolean)
  const confirm = await vscode.window.showWarningMessage(
    `Remove the folder ${picked.tree.path}? The branch ${picked.tree.branch ?? ''} and its commits stay in the repository.${losing.length > 0 ? `\n\n${losing.join('\n')}` : ''}`,
    { modal: true },
    losing.length > 0 ? 'Remove anyway' : 'Remove folder',
  )
  if (confirm === undefined) return
  try {
    await removeWorktree(repo, picked.tree.path, status !== undefined && status.uncommitted > 0)
    void vscode.window.showInformationMessage(`Closed ${picked.tree.branch ?? picked.tree.path}. The branch is still in the repository.`)
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not remove ${picked.tree.path}: ${error instanceof Error ? error.message : String(error)}. If a window, terminal or running program still has it open, close that first.`,
    )
  }
}

/**
 * For a branch window: the branch and its port offset in every terminal and debug session, and its one-time
 * setup started at once (the Light Code agent - which runs it - would otherwise wait for the panel to open).
 */
async function prepareBranchWindow(context: vscode.ExtensionContext, startAgent: () => void): Promise<void> {
  const here = thisFolder()
  if (here === undefined || mainCheckoutOf(here) === undefined) return
  const branch = currentBranchOf(here)
  const list = await listWorktrees(here).catch(() => [] as WorktreeInfo[])
  const offset = String(Math.max(list.findIndex((each) => same(each.path, here)), 1))
  const env: Record<string, string> = { LIGHT_CODE_PORT_OFFSET: offset, ...(branch !== undefined ? { LIGHT_CODE_BRANCH: branch } : {}) }
  for (const [name, value] of Object.entries(env)) context.environmentVariableCollection.replace(name, value)
  context.environmentVariableCollection.description = `Branch folder${branch !== undefined ? ` (${branch})` : ''}: LIGHT_CODE_BRANCH and LIGHT_CODE_PORT_OFFSET`
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('*', {
      resolveDebugConfiguration(_folder, configuration) {
        const existing = (configuration as { env?: Record<string, string> }).env ?? {}
        return { ...configuration, env: { ...env, ...existing } }
      },
    }),
  )
  const marker = setupMarkerFor(here)
  if (marker !== undefined && fs.existsSync(marker)) startAgent()
}

export function registerBranchCommands(context: vscode.ExtensionContext, configManager: ConfigManager, startAgent: () => void): vscode.Disposable[] {
  void prepareBranchWindow(context, startAgent)
  return [
    vscode.commands.registerCommand('lightCode.openBranch', () => openBranch(configManager)),
    vscode.commands.registerCommand('lightCode.branches', () => manageBranches()),
  ]
}
