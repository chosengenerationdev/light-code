/**
 * What "reach anywhere" still refuses (Fire Code; `HostServices.fileReach`).
 *
 * Fire Code lets a codebase's assistant read anywhere - every drive, every share - and write anywhere
 * with the user's approval each time. That widening is only safe with a floor under it, so two
 * lists apply to every path *outside* the workspace, on top of the configured deny list
 * (invariant 6), which applies everywhere as before:
 *
 * - **Never read or written**: where keys, passwords and session tokens live. An assistant that
 *   reads its way to an SSH key or a browser's saved logins needs only one more step to send it
 *   somewhere, and "it asked first" is no comfort when the prompt that got it there was injected.
 * - **Never written**: Windows and installed programs. Nothing an assistant should do touches
 *   them, and a mistake there is one no undo covers.
 *
 * Matched on the normalised path (lower case, forward slashes), by segment, so a project folder
 * merely *named* like one of these is not caught by accident.
 */

const norm = (p: string): string => `${p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')}/`

/** Folders whose contents are credentials, anywhere on the path. */
export const SECRET_FOLDERS = [
  '/.ssh/',
  '/.gnupg/',
  '/.aws/',
  '/.azure/',
  '/.kube/',
  '/.docker/',
  '/appdata/roaming/microsoft/credentials/',
  '/appdata/local/microsoft/credentials/',
  '/appdata/roaming/microsoft/protect/',
  '/appdata/roaming/microsoft/vault/',
  '/appdata/local/microsoft/vault/',
  '/appdata/roaming/microsoft/systemcertificates/',
  '/appdata/roaming/mozilla/firefox/profiles/',
  // Light Code's and Fire Code's own stores: the vault, its key, per-user secrets.
  '/appdata/local/fire-code/',
  // Its earlier names; a folder the move could not take is still the vault.
  '/appdata/local/sun-code/',
  // Its name until 0.5.0; a folder the move could not take is still the vault.
  '/appdata/local/sun-light-code/',
  '/appdata/local/light-code/data/users/',
  '/windows/system32/config/',
]

/** Single files that are credentials whatever folder holds them. */
const SECRET_FILE_NAMES = new Set([
  '.git-credentials',
  '.netrc',
  '_netrc',
  '.pypirc',
  '.npmrc',
  'login data',
  'login data for account',
  'cookies',
  'web data',
  'local state',
  'state.vscdb',
  'state.vscdb.backup',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'vault.key',
])

/** Key and certificate material by extension: outside a project these are almost never code. */
const SECRET_EXTENSIONS = ['.pfx', '.p12', '.pem', '.key', '.ppk', '.kdbx', '.jks', '.keystore']

/** Places nothing should write: Windows itself and installed programs. */
const SYSTEM_FOLDERS = ['/windows/', '/program files/', '/program files (x86)/', '/programdata/']

/** True for a path that holds keys, passwords or session tokens. */
export function isSecretPath(target: string): boolean {
  const p = norm(target)
  if (SECRET_FOLDERS.some((folder) => p.includes(folder))) return true
  const name = p.slice(0, -1).split('/').pop() ?? ''
  if (SECRET_FILE_NAMES.has(name)) return true
  return SECRET_EXTENSIONS.some((ext) => name.endsWith(ext))
}

/** True for Windows' own folders and installed programs, which are never written. */
export function isSystemPath(target: string): boolean {
  const p = norm(target)
  // Only at the root of a drive: `D:\work\windows\` is somebody's project folder.
  const afterDrive = p.replace(/^[a-z]:/, '')
  return SYSTEM_FOLDERS.some((folder) => afterDrive.startsWith(folder))
}
