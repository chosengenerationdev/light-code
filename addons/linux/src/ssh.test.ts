import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server, utils, type Connection } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createServer } from './server.js'
import type { LinuxSettings, Machine } from './settings.js'
import { ensureLocalKey, installCommand, KEY_NAME, setUpKey } from './keySetup.js'
import { localPathFor, SshPool } from './ssh.js'

/**
 * Against a real SSH server - ssh2's own server side, in this process - so sign-in, host keys,
 * commands, SFTP and a jump host all go over the actual protocol.
 */

const { STATUS_CODE } = utils.sftp
const FILES: Record<string, string> = { '/var/log/app/server.log': 'line 1\nERROR boom\nline 3\n' }

interface FakeHost {
  port: number
  commands: string[]
  logins: { username: string; ok: boolean; method?: string }[]
  /** Public keys added to authorized_keys by a command, as their base64 blob. */
  authorized: Set<string>
  close: () => Promise<void>
}

async function startServer(hostKey: string, options: { keys?: boolean } = {}): Promise<FakeHost> {
  const commands: string[] = []
  const logins: { username: string; ok: boolean; method?: string }[] = []
  const authorized = new Set<string>()
  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        const ok = ctx.username === 'ann' && ctx.password === 'right'
        logins.push({ username: ctx.username, ok })
        return ok ? ctx.accept() : ctx.reject()
      }
      // Key sign-in, as sshd does it: only a key in authorized_keys, and only with a valid signature.
      if (ctx.method === 'publickey' && options.keys !== false) {
        const blob = ctx.key.data.toString('base64')
        if (!authorized.has(blob)) return ctx.reject(['password', 'publickey'])
        if (ctx.signature === undefined) return ctx.accept()
        const key = utils.parseKey(`${ctx.key.algo} ${blob}`)
        const ok = !(key instanceof Error) && key.verify(ctx.blob ?? Buffer.alloc(0), ctx.signature, ctx.hashAlgo) === true
        logins.push({ username: ctx.username, ok, method: 'publickey' })
        return ok ? ctx.accept() : ctx.reject()
      }
      return ctx.reject(['password'])
    })
    client.on('ready', () => {
      // A jump host forwards to wherever it is asked.
      client.on('tcpip', (accept, _reject, info) => {
        const upstream = net.connect(info.destPort, info.destIP)
        const stream = accept()
        stream.pipe(upstream).pipe(stream)
      })
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('exec', (accept, _reject, info) => {
          const stream = accept()
          commands.push(info.command)
          if (info.command.includes('authorized_keys')) for (const match of info.command.matchAll(/ssh-ed25519 ([A-Za-z0-9+/=]+)/g)) authorized.add(match[1] as string)
          stream.write(`ran: ${info.command}\n`)
          stream.stderr.write('a warning\n')
          stream.exit(0)
          stream.end()
        })
        session.on('sftp', (accept) => {
          const sftp = accept()
          const handles = new Map<string, { file: string; done: boolean }>()
          const attrsFor = (file: string): { mode: number; size: number; uid: number; gid: number; atime: number; mtime: number } => ({
            mode: file in FILES ? 0o100644 : 0o040755,
            size: Buffer.byteLength(FILES[file] ?? ''),
            uid: 0,
            gid: 0,
            atime: 0,
            mtime: 0,
          })
          const stat = (reqid: number, file: string): void => {
            if (file in FILES || file === '/var/log') sftp.attrs(reqid, attrsFor(file))
            else sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
          }
          sftp.on('STAT', stat)
          sftp.on('LSTAT', stat)
          sftp.on('OPEN', (reqid, file) => {
            if (!(file in FILES)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            const handle = String(handles.size + 1)
            handles.set(handle, { file, done: false })
            sftp.handle(reqid, Buffer.from(handle))
          })
          sftp.on('FSTAT', (reqid, handle) => {
            const open = handles.get(handle.toString())
            if (open === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            sftp.attrs(reqid, attrsFor(open.file))
          })
          sftp.on('READ', (reqid, handle, offset, length) => {
            const open = handles.get(handle.toString())
            if (open === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            const data = Buffer.from(FILES[open.file] ?? '')
            if (offset >= data.length) return sftp.status(reqid, STATUS_CODE.EOF)
            sftp.data(reqid, data.subarray(offset, offset + length))
          })
          sftp.on('CLOSE', (reqid, handle) => {
            handles.delete(handle.toString())
            sftp.status(reqid, STATUS_CODE.OK)
          })
        })
      })
    })
    client.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return { port, commands, logins, authorized, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

const keyA = utils.generateKeyPairSync('ed25519').private
const keyB = utils.generateKeyPairSync('ed25519').private

let dir: string
let host: FakeHost
let pool: SshPool | undefined
let machines: Machine[]

function settings(): LinuxSettings {
  return { machines, extraCommands: [], timeoutSeconds: 30, maxDownloadMB: 1, dataDir: dir, downloadsDir: path.join(dir, 'downloads') }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-linux-'))
  host = await startServer(keyA)
  machines = [{ id: 'm1', label: 'web1', host: '127.0.0.1', port: host.port, username: 'ann', auth: 'password', password: 'right' }]
})
afterEach(async () => {
  pool?.dispose()
  pool = undefined
  await host.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('connecting', () => {
  it('signs in, trusts the host key the first time, and reuses one connection', async () => {
    pool = new SshPool(settings)
    const first = await pool.run(machines[0]!, 'uptime', 10_000)
    expect(first.stdout).toBe('ran: uptime\n')
    expect(first.stderr).toBe('a warning\n')
    expect(first.code).toBe(0)
    expect(first.newKey).toMatch(/^SHA256:/)
    const second = await pool.run(machines[0]!, 'df -h', 10_000)
    expect(second.newKey).toBeUndefined()
    expect(host.logins.filter((login) => login.ok)).toHaveLength(1)
  })

  it('refuses a changed host key, sending nothing - the machine rebuilt, or something in between', async () => {
    pool = new SshPool(settings)
    // What an earlier connection to this host and port saved.
    pool.knownHosts.set(`127.0.0.1:${String(host.port)}`, 'SHA256:the-key-it-had-before')
    await expect(pool.run(machines[0]!, 'uptime', 10_000)).rejects.toThrow(/host key .* has CHANGED/)
    expect(host.commands).toEqual([])
    expect(host.logins).toEqual([])
  })

  it('does not retry a refused password, so an account is never locked', async () => {
    machines = [{ ...machines[0]!, password: 'wrong' }]
    pool = new SshPool(settings)
    await expect(pool.run(machines[0]!, 'uptime', 10_000)).rejects.toThrow(/refused the sign-in .* not retried/)
    expect(host.logins).toEqual([{ username: 'ann', ok: false }])
  })

  it('goes through a jump host', async () => {
    const target = await startServer(keyB)
    try {
      machines = [
        { id: 'j', label: 'bastion', host: '127.0.0.1', port: host.port, username: 'ann', auth: 'password', password: 'right' },
        { id: 't', label: 'inner', host: '127.0.0.1', port: target.port, username: 'ann', auth: 'password', password: 'right', jumpVia: 'bastion' },
      ]
      pool = new SshPool(settings)
      const result = await pool.run(machines[1]!, 'hostname', 10_000)
      expect(result.stdout).toBe('ran: hostname\n')
      expect(target.commands).toEqual(['hostname'])
      expect(host.commands).toEqual([])
    } finally {
      pool?.dispose()
      pool = undefined
      await target.close()
    }
  })
})

describe('downloading', () => {
  it('copies a file under the machine label, keeping its path', async () => {
    pool = new SshPool(settings)
    const local = localPathFor(settings().downloadsDir, 'web1', '/var/log/app/server.log')
    const { size } = await pool.download(machines[0]!, '/var/log/app/server.log', local, 1024 * 1024)
    expect(size).toBe(Buffer.byteLength(FILES['/var/log/app/server.log']!))
    expect(fs.readFileSync(local, 'utf8')).toBe(FILES['/var/log/app/server.log'])
    expect(local).toBe(path.join(dir, 'downloads', 'web1', 'var', 'log', 'app', 'server.log'))
  })

  it('refuses a folder and a file over the limit, and never writes above the folder', async () => {
    pool = new SshPool(settings)
    await expect(pool.download(machines[0]!, '/var/log', path.join(dir, 'x'), 1024)).rejects.toThrow(/is a folder/)
    await expect(pool.download(machines[0]!, '/var/log/app/server.log', path.join(dir, 'y'), 5)).rejects.toThrow(/over the 0 MB limit/)
    expect(localPathFor(dir, 'web1', '/../../etc/passwd')).toBe(path.join(dir, 'web1', 'etc', 'passwd'))
  })
})

describe('the tools the agent gets', () => {
  it('lists the machines, runs a read-only command, refuses anything else, and downloads', async () => {
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        values: { timeoutSeconds: 20 },
        records: [{ id: 'm1', values: { label: 'web1', host: '127.0.0.1', port: host.port, username: 'ann', auth: 'password', notes: 'the web tier' } }],
        secrets: { m1: { password: 'LC_SECRET_TEST' } },
      }),
    )
    const saved = { ...process.env }
    Object.assign(process.env, { LIGHT_CODE_ADDON_SETTINGS: file, LIGHT_CODE_ADDON_DATA: dir, LIGHT_CODE_ADDON_DOWNLOADS: path.join(dir, 'downloads'), LC_SECRET_TEST: 'right' })
    const { server, pool: serverPool } = createServer()
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await server.connect(serverSide)
      const client = new McpClient({ name: 'test', version: '1' })
      await client.connect(clientSide)
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['download', 'forget_host_key', 'machines', 'run', 'test_connection'])
      expect(tools.tools.find((tool) => tool.name === 'run')?.description).toContain('web1')

      const textOf = (result: unknown): string => ((result as { content: { text: string }[] }).content[0]?.text ?? '')
      expect(textOf(await client.callTool({ name: 'machines', arguments: {} }))).toContain('web1: ann@127.0.0.1')
      const ran = await client.callTool({ name: 'run', arguments: { machine: 'WEB1', command: "grep -n 'ERROR' /var/log/app/server.log | tail -n 5" } })
      expect(textOf(ran)).toContain("ran: grep -n 'ERROR' /var/log/app/server.log | tail -n 5")
      const refused = await client.callTool({ name: 'run', arguments: { machine: 'web1', command: 'rm -rf /tmp/x' } })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toContain('not on the read-only list')
      expect(host.commands).not.toContain('rm -rf /tmp/x')
      const got = await client.callTool({ name: 'download', arguments: { machine: 'web1', path: '/var/log/app/server.log' } })
      expect(textOf(got)).toContain(path.join(dir, 'downloads', 'web1', 'var', 'log', 'app', 'server.log'))
      const unknown = await client.callTool({ name: 'run', arguments: { machine: 'db9', command: 'uptime' } })
      expect(textOf(unknown)).toContain('The machines are: web1')
      await client.close()
    } finally {
      serverPool.dispose()
      process.env = saved
    }
  })
})

describe('setting up key sign-in', () => {
  it('makes one key for this PC, adds it once, proves it, and says which file to sign in with', async () => {
    const keys = path.join(dir, 'ssh')
    pool = new SshPool(settings)
    const first = await setUpKey(pool, machines[0]!, keys)
    expect(first.keyFile).toBe(path.join(keys, KEY_NAME))
    expect(fs.readFileSync(path.join(keys, `${KEY_NAME}.pub`), 'utf8')).toMatch(/^ssh-ed25519 \S+ light-code@/)
    expect(host.authorized.size).toBe(1)
    expect(host.logins.some((login) => login.method === 'publickey' && login.ok)).toBe(true)
    // The key alone now signs in: no password at all.
    const keyOnly = { ...machines[0]!, label: 'web1-key', auth: 'key' as const, keyFile: first.keyFile! }
    delete (keyOnly as { password?: string }).password
    expect((await pool.run(keyOnly, 'uptime', 10_000)).stdout).toBe('ran: uptime\n')

    const again = await setUpKey(pool, machines[1] ?? machines[0]!, keys)
    expect(again.text).toContain("Used this PC's key")
    expect(fs.readdirSync(keys).sort()).toEqual([KEY_NAME, `${KEY_NAME}.pub`])
  })

  it('leaves the machine on its password when the server will not take the key', async () => {
    await host.close()
    host = await startServer(keyA, { keys: false })
    machines = [{ ...machines[0]!, port: host.port }]
    pool = new SshPool(settings)
    const result = await setUpKey(pool, machines[0]!, path.join(dir, 'ssh'))
    expect(result.keyFile).toBeUndefined()
    expect(result.text).toContain('signing in with it failed')
  })

  it('sends one fixed command, quoting nothing but a key it made itself', () => {
    const { publicLine } = ensureLocalKey(path.join(dir, 'ssh'))
    expect(installCommand(publicLine)).toContain(`grep -qxF '${publicLine}' ~/.ssh/authorized_keys`)
    expect(() => installCommand("ssh-ed25519 AAAA x'; reboot; echo '")).toThrow(/not in the expected form/)
  })

  it('is a button only: offered solely when Light Code keeps such tools from the model', async () => {
    const settingsFile = path.join(dir, 'settings.json')
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        records: [{ id: 'm1', values: { label: 'web1', host: '127.0.0.1', port: host.port, username: 'ann', auth: 'password' } }],
        secrets: { m1: { password: 'LC_SECRET_TEST' } },
      }),
    )
    const saved = { ...process.env }
    Object.assign(process.env, {
      LIGHT_CODE_ADDON_SETTINGS: settingsFile,
      LIGHT_CODE_ADDON_DATA: dir,
      LC_SECRET_TEST: 'right',
      LIGHT_CODE_LINUX_KEY_DIR: path.join(dir, 'ssh'),
      LIGHT_CODE_ADDON_PANEL_TOOLS: '1',
    })
    const { server, pool: serverPool } = createServer()
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await server.connect(serverSide)
      const client = new McpClient({ name: 'test', version: '1' })
      await client.connect(clientSide)
      const listed = (await client.listTools()).tools.find((tool) => tool.name === 'setup_key')
      expect(listed?._meta?.['lightCode/panelOnly']).toBe(true)
      const result = await client.callTool({ name: 'setup_key', arguments: { label: 'web1' } })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({ lightCode: { recordUpdate: { auth: 'key', keyFile: path.join(dir, 'ssh', KEY_NAME) } } })
      await client.close()
    } finally {
      serverPool.dispose()
      process.env = saved
    }
  })
})
