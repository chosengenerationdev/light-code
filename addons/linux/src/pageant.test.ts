import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server, utils, type Connection } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'

import type { LinuxSettings, Machine } from './settings.js'
import { findPageantPipe, SshPool } from './ssh.js'

/**
 * Pageant, reached through its named pipe - never through the helper program (`pagent.exe`) the SSH
 * library would otherwise start. A stand-in Pageant here: a real Windows named pipe, named as Pageant
 * names its own, speaking the SSH agent protocol and holding one key.
 */

describe('finding Pageant', () => {
  it("prefers this user's pipe, takes any Pageant otherwise, and says none when it is not running", () => {
    const pipes = ['openssh-ssh-agent', 'pageant.someone.aaaa', 'pageant.ann.bbbb', 'mojo.123']
    expect(findPageantPipe(() => pipes, 'Ann')).toBe('\\\\.\\pipe\\pageant.ann.bbbb')
    expect(findPageantPipe(() => ['pageant.someone.aaaa'], 'ann')).toBe('\\\\.\\pipe\\pageant.someone.aaaa')
    expect(findPageantPipe(() => ['openssh-ssh-agent'], 'ann')).toBeUndefined()
    expect(
      findPageantPipe(() => {
        throw new Error('no pipes here')
      }, 'ann'),
    ).toBeUndefined()
  })
})

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const str = (b: Buffer | string): Buffer => {
  const bytes = typeof b === 'string' ? Buffer.from(b) : b
  return Buffer.concat([u32(bytes.length), bytes])
}

/** The SSH agent protocol, as Pageant speaks it on its pipe: list identities, and sign. */
function startAgent(pipe: string, privateKey: string): net.Server {
  const key = utils.parseKey(privateKey)
  if (key instanceof Error) throw key
  const parsed = Array.isArray(key) ? key[0]! : key
  const blob = parsed.getPublicSSH()
  return net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
        const length = buffer.readUInt32BE(0)
        const message = buffer.subarray(4, 4 + length)
        buffer = buffer.subarray(4 + length)
        let reply: Buffer
        if (message[0] === 11) {
          reply = Buffer.concat([Buffer.from([12]), u32(1), str(blob), str('stand-in pageant key')])
        } else if (message[0] === 13) {
          const keyLength = message.readUInt32BE(1)
          const dataLength = message.readUInt32BE(5 + keyLength)
          const data = message.subarray(9 + keyLength, 9 + keyLength + dataLength)
          const signature = parsed.sign(data)
          reply = Buffer.concat([Buffer.from([14]), str(Buffer.concat([str('ssh-ed25519'), str(signature as Buffer)]))])
        } else {
          reply = Buffer.from([5])
        }
        socket.write(Buffer.concat([u32(reply.length), reply]))
      }
    })
  })
}

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const step of cleanup.reverse()) await step()
  cleanup = []
})

describe.skipIf(process.platform !== 'win32')('signing in through Pageant', () => {
  it('finds a running Pageant by itself and signs in with its key, starting no program', async () => {
    const pair = utils.generateKeyPairSync('ed25519')
    const user = os.userInfo().username
    const pipe = `\\\\.\\pipe\\pageant.${user}.lctest${String(process.pid)}${String(Date.now())}`
    const agent = startAgent(pipe, pair.private)
    await new Promise<void>((resolve) => agent.listen(pipe, resolve))
    cleanup.push(() => new Promise((resolve) => agent.close(() => resolve())))

    // An SSH server that knows only this key, and checks its signature as sshd does.
    const knownBlob = (utils.parseKey(pair.public) as { getPublicSSH: () => Buffer }).getPublicSSH().toString('base64')
    const commands: string[] = []
    const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client: Connection) => {
      client.on('authentication', (ctx) => {
        if (ctx.method !== 'publickey' || ctx.key.data.toString('base64') !== knownBlob) return ctx.reject(['publickey'])
        if (ctx.signature === undefined) return ctx.accept()
        const key = utils.parseKey(`${ctx.key.algo} ${knownBlob}`)
        return !(key instanceof Error) && key.verify(ctx.blob ?? Buffer.alloc(0), ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject()
      })
      client.on('ready', () =>
        client.on('session', (accept) =>
          accept().on('exec', (acceptExec, _reject, info) => {
            const stream = acceptExec()
            commands.push(info.command)
            stream.write('ok\n')
            stream.exit(0)
            stream.end()
          }),
        ),
      )
      client.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise((resolve) => server.close(() => resolve())))

    expect(findPageantPipe()).toBe(pipe)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pageant-'))
    cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }))
    const machine: Machine = { id: 'm', label: 'web1', host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, username: 'ann', auth: 'pageant' }
    const settings = (): LinuxSettings => ({ machines: [machine], extraCommands: [], timeoutSeconds: 30, maxDownloadMB: 1, dataDir: dir, downloadsDir: dir })
    const pool = new SshPool(settings)
    cleanup.push(async () => pool.dispose())
    const result = await pool.run(machine, 'uptime', 10_000)
    expect(result.stdout).toBe('ok\n')
    expect(commands).toEqual(['uptime'])
  })
})

describe('the bundle', () => {
  it('never refers to the helper program the library would start for Pageant', () => {
    // `agent: 'pageant'` is the only way the library reaches pagent.exe; the add-on never passes it.
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ssh.ts'), 'utf8')
    expect(source).not.toMatch(/agent\s*=\s*'pageant'/)
  })
})
