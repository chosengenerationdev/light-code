import os from 'node:os'
import path from 'node:path'

/**
 * The one list of Python tool code approved on this machine, for this Windows user - read and written by
 * the VS Code extension, Fire Code and the Node host alike (`python/machineApprovals.ts`).
 *
 * Reported: a tool approved in Light Code was asked about again in Fire Code, same user, same machine.
 * The list existed, but in Fire Code's own data folder, and the extension never used one at all - so
 * the two products were two machines as far as approvals went. Approval is of exact bytes, so one list
 * changes nothing about what is trusted: the same code, read once, by the same person.
 *
 * Its folder is on the never-read, never-written floor (`fs/reach.ts`): a tool able to write this file
 * could approve itself. Fire Code copies its earlier list in on first start (`system::shared_approvals`).
 */
export const SHARED_APPROVALS_FOLDER = path.join('light-code', 'approvals')
export const SHARED_APPROVALS_FILE = 'approved-tools.json'

export function sharedMachineApprovalsFile(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const base =
    platform === 'win32'
      ? (env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'))
      : (env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share'))
  return path.join(base, SHARED_APPROVALS_FOLDER, SHARED_APPROVALS_FILE)
}

/**
 * The user's personal skills and Python tools - the "Only me" choice when one is created - shared by the
 * VS Code extension, Fire Code and the Node host for this user, and used in every project. Beside the
 * approvals list but not under it: these are ordinary files the agent reads, never on the reach floor.
 */
export function personalLibraryDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const base =
    platform === 'win32'
      ? (env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'))
      : (env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share'))
  return path.join(base, 'light-code', 'personal')
}
