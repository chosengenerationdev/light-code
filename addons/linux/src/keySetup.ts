import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { utils } from 'ssh2'

import type { Machine } from './settings.js'
import { SshError, type SshPool } from './ssh.js'

/**
 * "Set up SSH key": from password sign-in to key sign-in in one press.
 *
 * Asked for directly: "what if user doesn't have ssh key setup, can you give one click button ... which
 * should create keys and copy to the server ... so that future connections can be done using keys".
 *
 * - **One key for this PC**, `%USERPROFILE%\.ssh\light-code_ed25519`, made once and used for every
 *   machine - which is how people use one key, and where SSH tools and Light Code's own file floor
 *   (`fs/reach.ts`, which never lets the agent read `.ssh`) both expect it. A key already there is
 *   reused and never replaced. Not passphrase-protected, as `ssh-keygen` is when Enter is pressed: a
 *   passphrase only Light Code knew would make the key useless to anything else.
 * - **Only the public half leaves the PC**, appended to `~/.ssh/authorized_keys` by one fixed command
 *   with nothing from the model or the tab in it: the key line is generated here and checked against
 *   its exact shape before it is quoted. Already present, it is not added twice.
 * - **Proved before anything changes here**: a fresh connection signs in with the key alone. Only then
 *   is the machine switched to the key (Light Code applies the `recordUpdate`); otherwise it stays on
 *   its password and the message says what the server may be refusing.
 * - **A button, never a tool the model has**: it writes to a server, so it is marked panel-only and is
 *   offered only by a Light Code that keeps such tools from the model.
 */

export const KEY_NAME = 'light-code_ed25519'

/** The key's folder: the user's own `.ssh`, or one given for tests. */
export function keyFolder(env: NodeJS.ProcessEnv = process.env): string {
  return env['LIGHT_CODE_LINUX_KEY_DIR'] ?? path.join(os.homedir(), '.ssh')
}

const PUBLIC_LINE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [A-Za-z0-9@._-]{1,80})?$/

/** This PC's key, made if there is none. Returns the private key's path and the public key line. */
export function ensureLocalKey(folder: string): { privatePath: string; publicLine: string; created: boolean } {
  const privatePath = path.join(folder, KEY_NAME)
  const publicPath = `${privatePath}.pub`
  if (fs.existsSync(privatePath)) {
    let line = fs.existsSync(publicPath) ? fs.readFileSync(publicPath, 'utf8').trim() : ''
    if (!PUBLIC_LINE.test(line)) {
      const parsed = utils.parseKey(fs.readFileSync(privatePath))
      if (parsed instanceof Error) {
        throw new SshError(`${privatePath} exists but cannot be read (${parsed.message}) - it may be protected by a passphrase. Remove it, or sign in with Pageant.`)
      }
      const key = Array.isArray(parsed) ? parsed[0] : parsed
      if (key === undefined || key.type !== 'ssh-ed25519') throw new SshError(`${privatePath} is not an ed25519 key made by Light Code.`)
      line = `ssh-ed25519 ${key.getPublicSSH().toString('base64')}`
    }
    return { privatePath, publicLine: line, created: false }
  }
  const comment = `light-code@${(os.hostname() || 'pc').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60)}`
  const pair = utils.generateKeyPairSync('ed25519', { comment })
  fs.mkdirSync(folder, { recursive: true })
  // `wx`: never over a key that appeared meanwhile.
  fs.writeFileSync(privatePath, pair.private, { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(publicPath, `${pair.public}\n`, { flag: 'wx', mode: 0o644 })
  return { privatePath, publicLine: pair.public.trim(), created: true }
}

/** The one command run on the server: the key appended once, with the permissions sshd requires. */
export function installCommand(publicLine: string): string {
  if (!PUBLIC_LINE.test(publicLine)) throw new SshError('The public key is not in the expected form; nothing was sent.')
  const quoted = `'${publicLine}'`
  return (
    'umask 077 && mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && ' +
    `(grep -qxF ${quoted} ~/.ssh/authorized_keys || printf '\\n%s\\n' ${quoted} >> ~/.ssh/authorized_keys)`
  )
}

export interface KeySetupResult {
  text: string
  keyFile?: string
}

export async function setUpKey(pool: SshPool, machine: Machine, folder = keyFolder()): Promise<KeySetupResult> {
  const key = ensureLocalKey(folder)
  const installed = await pool.run(machine, installCommand(key.publicLine), 30_000)
  if (installed.timedOut || installed.code !== 0) {
    return {
      text:
        `Could not add the key on ${machine.label}${installed.code !== null ? ` (exit code ${String(installed.code)})` : ''}: ` +
        `${installed.stderr.trim() || installed.stdout.trim() || 'no reason given'}. It still signs in as before.`,
    }
  }
  // A fresh connection with the key and nothing else: the only proof that it works.
  const probe: Machine = {
    ...machine,
    label: `${machine.label}#key-check`,
    auth: 'key',
    keyFile: key.privatePath,
  }
  delete probe.password
  delete probe.passphrase
  try {
    await pool.run(probe, 'true', 20_000)
  } catch (error) {
    return {
      text:
        `The key was added to ~/.ssh/authorized_keys on ${machine.label}, but signing in with it failed: ` +
        `${error instanceof Error ? error.message : String(error)}\nThe server may not allow key sign-in (PubkeyAuthentication), may look ` +
        'for keys elsewhere (AuthorizedKeysFile), or may refuse a home folder others can write to. It still signs in with its password.',
    }
  } finally {
    pool.close(probe.label)
  }
  return {
    keyFile: key.privatePath,
    text:
      `${key.created ? `Made a key for this PC: ${key.privatePath}.\n` : `Used this PC's key: ${key.privatePath}.\n`}` +
      `Added it on ${machine.label} and signed in with it. ${machine.label} now signs in with the key; the stored password is ` +
      'kept - remove it with Edit if you no longer want it stored.',
  }
}
