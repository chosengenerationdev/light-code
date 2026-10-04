import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import * as vscode from 'vscode'
import { secretSlots, type ConfigManager, type SecretSlot } from '@light-code/core'
import { VSCodeSecretStore } from './platform/secrets.js'

/**
 * "Light Code: Share API keys with Fire Code".
 *
 * VS Code keeps Light Code's keys in its own encrypted storage, which no other program can read -
 * so a codebase in Fire Code linked to this config had every provider and connection but none of their
 * keys. This extension can read them, so it hands them over: the names are shown first and nothing
 * is sent until the person confirms; then each key travels once, over a named pipe only this
 * Windows user can open, to the running Fire Code, which seals it in its own vault (DPAPI, the same
 * protection it had here) as a named credential that every codebase can use.
 *
 * Nothing changes on this side. VS Code keeps its keys; this is a copy, made on request.
 */
export async function shareKeysWithSun(context: vscode.ExtensionContext, configManager: ConfigManager): Promise<void> {
  if (process.platform !== 'win32') {
    void vscode.window.showInformationMessage('Fire Code is a Windows app; there is nothing to share keys with on this system.')
    return
  }

  const slots = await collectSlots(context, configManager)
  const secrets = new VSCodeSecretStore(context.secrets)
  const found: { key: string; label: string; value: string }[] = []
  for (const slot of slots) {
    const value = await secrets.get(slot.key)
    if (value !== undefined && value.length > 0) found.push({ ...slot, value })
  }
  if (found.length === 0) {
    void vscode.window.showInformationMessage('Light Code has no stored keys to share — nothing in its settings has a key saved.')
    return
  }

  // Ground truth before anything leaves (invariant 8): the names of exactly what will be sent.
  const choice = await vscode.window.showWarningMessage(
    `Share ${String(found.length)} key${found.length === 1 ? '' : 's'} with Fire Code?`,
    {
      modal: true,
      detail:
        `${found.map((f) => `• ${f.label}`).join('\n')}\n\n` +
        'They are sent to Fire Code on this computer, which stores them encrypted for your Windows ' +
        'account as saved credentials every codebase can use. Values are never shown. VS Code keeps its own copy.',
    },
    'Share',
  )
  if (choice !== 'Share') return

  try {
    const reply = await sendToSun({ type: 'share', from: 'VS Code', entries: found })
    if (reply.ok !== true) throw new Error(reply.error ?? 'Fire Code refused the keys.')
    void vscode.window.showInformationMessage(
      `Shared ${String(reply.stored?.length ?? found.length)} key(s) with Fire Code. Codebases linked to this config can use them now.`,
    )
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    void vscode.window.showErrorMessage(
      missing
        ? 'Fire Code is not running. Open it (run fire-code), then share the keys again.'
        : `Could not share the keys with Fire Code: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Every secret slot named anywhere this extension's settings reach: the user config as it is on
 * disk (with every project's overrides, not only the open one's) and the open folders' own
 * `.lightcode/config.json`.
 */
async function collectSlots(context: vscode.ExtensionContext, configManager: ConfigManager): Promise<SecretSlot[]> {
  const sources: unknown[] = []
  try {
    sources.push((await configManager.load()).config)
  } catch {
    // A config that does not load still has a file to read below.
  }
  const files = [
    path.join(context.globalStorageUri.fsPath, 'config.json'),
    ...(vscode.workspace.workspaceFolders ?? []).map((f) => path.join(f.uri.fsPath, '.lightcode', 'config.json')),
  ]
  for (const file of files) {
    try {
      sources.push(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')))
    } catch {
      // Absent or unreadable: nothing to collect from it.
    }
  }
  const seen = new Map<string, SecretSlot>()
  for (const slot of sources.flatMap((source) => secretSlots(source))) {
    if (!seen.has(slot.key)) seen.set(slot.key, slot)
  }
  return [...seen.values()]
}

/** The pipe Fire Code listens on: per Windows user, matching `share.rs`. */
export function sunPipeName(name = 'fire-code'): string {
  return `\\\\.\\pipe\\${name}.${(process.env.USERNAME ?? 'user').toLowerCase()}`
}

/**
 * Fire Code first; then the pipe it listened on as Sun Code (0.5.x) and as Sun Light Code (0.4.x),
 * for somebody who has not updated it yet.
 */
async function sendToSun(message: unknown): Promise<{ ok?: boolean; error?: string; stored?: string[] }> {
  let last: unknown
  for (const name of ['fire-code', 'sun-code', 'sun-light-code']) {
    try {
      return await sendOnPipe(sunPipeName(name), message)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      last = error
    }
  }
  throw last
}

function sendOnPipe(pipe: string, message: unknown): Promise<{ ok?: boolean; error?: string; stored?: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipe)
    let text = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('Fire Code did not answer within 15 seconds.'))
    }, 15_000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`))
    socket.on('data', (chunk: string) => {
      text += chunk
      const end = text.indexOf('\n')
      if (end === -1) return
      clearTimeout(timer)
      socket.end()
      try {
        resolve(JSON.parse(text.slice(0, end)) as { ok?: boolean; error?: string; stored?: string[] })
      } catch {
        reject(new Error('Fire Code sent an answer that could not be read.'))
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
