import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'

import type { LinuxSettings, Machine } from './settings.js'

/**
 * SSH from inside Node, with no program of its own.
 *
 * Asked for with one constraint above the rest: "I don't want these connections by agents to Linux
 * machines to raise any security alert", with plink or a Rust helper suggested. Both would put a new
 * executable on the machine opening SSH connections - plink in particular is on most EDR watch lists
 * because attackers carry it for tunnelling, and an unsigned helper is the shape the PowerShell
 * directory lookup was flagged for. `ssh2` is a JavaScript implementation running in the Node process
 * that already runs Light Code: no new binary, no child process, nothing written to disk but what is
 * downloaded. On the Linux side the same care: one connection per machine, reused for ten idle
 * minutes rather than a login per command, and a refused password is never retried, so an account
 * is never locked by the assistant.
 *
 * **Host keys are trusted on first use and then checked** (`known-hosts.json` in the add-on's data
 * folder). A changed key refuses the connection until the user says the machine was rebuilt.
 */

const IDLE_MS = 10 * 60 * 1000
const OUTPUT_LIMIT = 2 * 1024 * 1024

interface Pooled {
  client: Client
  lastUsed: number
  /** Set when this connection had to trust a key it had not seen before. */
  newKey?: string
}

export interface RunResult {
  code: number | null
  signal?: string
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export class KnownHosts {
  constructor(private readonly file: string) {}
  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }
  get(key: string): string | undefined {
    return this.read()[key]
  }
  set(key: string, value: string | undefined): void {
    const all = this.read()
    if (value === undefined) delete all[key]
    else all[key] = value
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${String(process.pid)}.tmp`
    fs.writeFileSync(temp, JSON.stringify(all, null, 2))
    fs.renameSync(temp, this.file)
  }
}

export function hostKeyId(machine: Pick<Machine, 'host' | 'port'>): string {
  return `${machine.host.toLowerCase()}:${String(machine.port)}`
}

/** Thrown with a message meant for the user and the assistant, never a raw protocol error. */
export class SshError extends Error {}

export class SshPool {
  private readonly pool = new Map<string, Pooled>()
  private readonly connecting = new Map<string, Promise<Pooled>>()
  private readonly timer: NodeJS.Timeout
  readonly knownHosts: KnownHosts

  constructor(private readonly settings: () => LinuxSettings) {
    this.knownHosts = new KnownHosts(path.join(settings().dataDir, 'known-hosts.json'))
    this.timer = setInterval(() => this.closeIdle(), 60_000)
    this.timer.unref()
  }

  private closeIdle(): void {
    const now = Date.now()
    for (const [label, pooled] of this.pool) {
      if (now - pooled.lastUsed > IDLE_MS) {
        pooled.client.end()
        this.pool.delete(label)
      }
    }
  }

  close(label?: string): void {
    for (const [key, pooled] of this.pool) {
      if (label === undefined || key === label.toLowerCase()) {
        pooled.client.end()
        this.pool.delete(key)
      }
    }
  }

  dispose(): void {
    clearInterval(this.timer)
    this.close()
  }

  /** A connected client for this machine, reusing one that is open. */
  async connect(machine: Machine, chain: string[] = []): Promise<Pooled> {
    const key = machine.label.toLowerCase()
    const open = this.pool.get(key)
    if (open !== undefined) {
      open.lastUsed = Date.now()
      return open
    }
    const pending = this.connecting.get(key)
    if (pending !== undefined) return pending
    const attempt = this.open(machine, chain).finally(() => this.connecting.delete(key))
    this.connecting.set(key, attempt)
    return attempt
  }

  private async open(machine: Machine, chain: string[]): Promise<Pooled> {
    if (chain.includes(machine.label.toLowerCase())) throw new SshError(`"${machine.label}" is reached through itself (${[...chain, machine.label].join(' -> ')}).`)
    if (chain.length >= 3) throw new SshError('More than three jump hosts in a row.')
    const config: ConnectConfig = {
      host: machine.host,
      port: machine.port,
      username: machine.username,
      readyTimeout: 20_000,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
    }
    // Through a jump host: a channel from it to this machine carries the whole connection.
    if (machine.jumpVia !== undefined) {
      const jump = this.settings().machines.find((m) => m.label.toLowerCase() === machine.jumpVia?.toLowerCase())
      if (jump === undefined) throw new SshError(`"${machine.label}" is reached through "${machine.jumpVia}", which is not one of the machines.`)
      const via = await this.connect(jump, [...chain, machine.label.toLowerCase()])
      config.sock = await new Promise<ClientChannel>((resolve, reject) =>
        via.client.forwardOut('127.0.0.1', 0, machine.host, machine.port, (error, stream) =>
          error ? reject(new SshError(`${jump.label} could not reach ${machine.host}:${String(machine.port)}: ${error.message}`)) : resolve(stream),
        ),
      )
    }
    switch (machine.auth) {
      case 'password':
        if (machine.password === undefined) throw new SshError(`No password is stored for "${machine.label}". Set it on the Linux tab.`)
        config.password = machine.password
        config.tryKeyboard = true
        break
      case 'key': {
        if (machine.keyFile === undefined) throw new SshError(`No key file is set for "${machine.label}".`)
        let key: Buffer
        try {
          key = fs.readFileSync(machine.keyFile)
        } catch (error) {
          throw new SshError(`Could not read the key file ${machine.keyFile}: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (key.toString('utf8', 0, 40).startsWith('PuTTY-User-Key-File-3')) {
          throw new SshError(
            `${machine.keyFile} is a PuTTY key in the newer format (version 3), which cannot be read here. Load it into Pageant and choose ` +
              '"Pageant" for this machine, or open it in PuTTYgen and save it with Conversions > Export OpenSSH key.',
          )
        }
        config.privateKey = key
        if (machine.passphrase !== undefined) config.passphrase = machine.passphrase
        break
      }
      case 'pageant': {
        // Never `agent: 'pageant'`: the library reaches Pageant that way by starting a helper program
        // of its own (pagent.exe) - a new executable, the one thing this add-on promises not to run, and
        // one a bundled add-on does not even carry. Pageant's named pipe needs nothing but Node.
        const pipe = findPageantPipe()
        if (pipe === undefined) {
          throw new SshError(
            'Pageant is not running - or is older than PuTTY 0.75 (2021), which is when it began to accept connections ' +
              'this way. Start Pageant and add your key to it, or choose Password for this machine on the Linux tab.',
          )
        }
        config.agent = pipe
        break
      }
      case 'agent': {
        const agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env['SSH_AUTH_SOCK']
        if (agent === undefined) throw new SshError('No SSH agent is running (SSH_AUTH_SOCK is not set).')
        config.agent = agent
        break
      }
    }

    const id = hostKeyId(machine)
    let newKey: string | undefined
    let mismatch: { known: string; seen: string } | undefined
    config.hostVerifier = (key: Buffer): boolean => {
      const seen = fingerprint(key)
      const known = this.knownHosts.get(id)
      if (known === undefined) {
        this.knownHosts.set(id, seen)
        newKey = seen
        return true
      }
      if (known === seen) return true
      mismatch = { known, seen }
      return false
    }

    const client = new Client()
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve())
      client.once('error', (error: Error & { level?: string }) => {
        if (mismatch !== undefined) {
          reject(
            new SshError(
              `The host key of ${machine.label} (${id}) has CHANGED: it was ${mismatch.known} and is now ${mismatch.seen}. ` +
                'Nothing was sent. This happens when a machine is rebuilt - or when something is intercepting the connection. ' +
                'Ask the user; if they confirm the machine was rebuilt, they can press "Forget host key" on the Linux tab.',
            ),
          )
          return
        }
        if (error.level === 'client-authentication') {
          reject(
            new SshError(
              `${machine.username}@${machine.host} refused the sign-in (${machine.auth}). It was not retried, so the account is not locked. ` +
                (machine.auth === 'pageant'
                  ? 'Is Pageant running, with the right key loaded?'
                  : machine.auth === 'agent'
                    ? 'Is the OpenSSH Authentication Agent service running, with the key added (ssh-add)?'
                    : 'Check the user name and the password or key on the Linux tab.'),
            ),
          )
          return
        }
        reject(new SshError(`Could not connect to ${machine.label} (${machine.host}:${String(machine.port)}): ${error.message}`))
      })
      client.connect(config)
    })
    const pooled: Pooled = { client, lastUsed: Date.now(), ...(newKey !== undefined ? { newKey } : {}) }
    client.on('close', () => {
      if (this.pool.get(machine.label.toLowerCase()) === pooled) this.pool.delete(machine.label.toLowerCase())
    })
    client.on('error', () => undefined)
    this.pool.set(machine.label.toLowerCase(), pooled)
    return pooled
  }

  /** Runs one command, already checked to be read-only, with a time limit. */
  async run(machine: Machine, command: string, timeoutMs: number): Promise<RunResult & { newKey?: string }> {
    const pooled = await this.connect(machine)
    return new Promise((resolve, reject) => {
      pooled.client.exec(command, (error, stream) => {
        if (error) {
          // A pooled connection that died since: dropped, so the next call opens a fresh one.
          this.close(machine.label)
          reject(new SshError(`${machine.label} refused to run the command: ${error.message}`))
          return
        }
        let stdout = ''
        let stderr = ''
        let truncated = false
        let timedOut = false
        const add = (current: string, chunk: Buffer): string => {
          if (current.length >= OUTPUT_LIMIT) {
            truncated = true
            return current
          }
          return current + chunk.toString('utf8')
        }
        const timer = setTimeout(() => {
          timedOut = true
          stream.signal('KILL')
          stream.close()
        }, timeoutMs)
        stream.on('data', (chunk: Buffer) => (stdout = add(stdout, chunk)))
        stream.stderr.on('data', (chunk: Buffer) => (stderr = add(stderr, chunk)))
        stream.on('close', (code: number | null, signal?: string) => {
          clearTimeout(timer)
          pooled.lastUsed = Date.now()
          resolve({
            code: code ?? null,
            ...(signal !== undefined ? { signal } : {}),
            stdout,
            stderr,
            timedOut,
            truncated,
            ...(pooled.newKey !== undefined ? { newKey: pooled.newKey } : {}),
          })
          delete pooled.newKey
        })
      })
    })
  }

  /** Copies one file down with SFTP. Refuses a folder, or a file larger than the limit. */
  async download(machine: Machine, remote: string, local: string, maxBytes: number): Promise<{ size: number }> {
    const pooled = await this.connect(machine)
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
      pooled.client.sftp((error, wrapper) => (error ? reject(new SshError(`${machine.label} offers no file transfer (SFTP): ${error.message}`)) : resolve(wrapper))),
    )
    try {
      const stats = await new Promise<{ size: number; isDirectory: () => boolean }>((resolve, reject) =>
        sftp.stat(remote, (error, s) => (error ? reject(new SshError(`${remote} on ${machine.label}: ${error.message}`)) : resolve(s))),
      )
      if (stats.isDirectory()) throw new SshError(`${remote} is a folder. Download files one at a time; list the folder with run "ls -la ${remote}".`)
      if (stats.size > maxBytes) {
        throw new SshError(
          `${remote} is ${(stats.size / 1048576).toFixed(1)} MB, over the ${String(Math.round(maxBytes / 1048576))} MB limit on the Linux tab. ` +
            `Read part of it with run instead (tail -n 2000 ${remote}, or grep).`,
        )
      }
      fs.mkdirSync(path.dirname(local), { recursive: true })
      const partial = `${local}.part`
      await new Promise<void>((resolve, reject) =>
        sftp.fastGet(remote, partial, (error) => (error ? reject(new SshError(`Could not download ${remote}: ${error.message}`)) : resolve())),
      )
      fs.renameSync(partial, local)
      pooled.lastUsed = Date.now()
      return { size: stats.size }
    } finally {
      sftp.end()
    }
  }
}

const PIPES = '\\\\.\\pipe\\'

/**
 * Pageant's named pipe, `\\.\pipe\pageant.<user>.<hash>`, found by listing the pipes - so a Pageant
 * that is running is used with nothing to set up. Since PuTTY 0.75 Pageant listens there, speaking the
 * same agent protocol as OpenSSH's, which the SSH library speaks itself. The hash part cannot be worked
 * out from outside, hence the listing. This user's pipe first; any Pageant pipe after that.
 */
export function findPageantPipe(
  list: () => string[] = () => (process.platform === 'win32' ? fs.readdirSync(PIPES) : []),
  user: string = safeUser(),
): string | undefined {
  let names: string[]
  try {
    names = list()
  } catch {
    return undefined
  }
  const pageant = names.filter((name) => name.toLowerCase().startsWith('pageant.'))
  const mine = pageant.find((name) => name.toLowerCase().startsWith(`pageant.${user.toLowerCase()}.`))
  const chosen = mine ?? pageant[0]
  return chosen === undefined ? undefined : `${PIPES}${chosen}`
}

function safeUser(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env['USERNAME'] ?? ''
  }
}

/** Where a remote file lands: under the machine's label, its own path kept, never above the folder. */
export function localPathFor(downloadsDir: string, label: string, remote: string): string {
  const parts = remote.split('/').filter((part) => part.length > 0 && part !== '.' && part !== '..')
  if (parts.length === 0) throw new SshError('Name a file to download.')
  // Characters Windows refuses in a file name, and control characters, become _.
  const safe = parts.map((part) => [...part].map((c) => (c.charCodeAt(0) < 32 || '<>:"|?*'.includes(c) ? '_' : c)).join(''))
  return path.join(downloadsDir, label, ...safe)
}
