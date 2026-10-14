import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { HostLanguageModels, HostModelInfo, HostModelRequest } from '../../providers/hostModels.js'
import type { StreamChunk } from '../../providers/types.js'

/**
 * GitHub Copilot for Fire Code, the Node host and the JetBrains plugin, through a VS Code window.
 *
 * Those hosts have no `vscode.lm`, and the only supported way to use somebody's Copilot is VS Code's
 * Language Model API (`providers/hostModels.ts` says why the direct-token route was refused). So every
 * VS Code window with the extension serves its models on a local pipe, and the other hosts connect to it.
 * Asked for in those terms ("relay via VS Code"), knowing it works only while a VS Code window is open.
 *
 * **Only this Windows user can use it.** Each window writes `{pipe, token}` to a file in the user's own
 * profile (`%LOCALAPPDATA%\light-code\lm-relay\<pid>.json`), and every request must carry that token,
 * compared in constant time. Another user cannot read the file, so finding the pipe is not enough - and
 * that holds whatever access Windows' default pipe ACL gives. A process running as the same user can
 * use it, which is true of everything else here too (CLAUDE.md §3: no protection from same-user processes).
 *
 * The wire is newline-delimited JSON: one request line, then answer lines. A request carries only
 * `ChatMessage`s and tool definitions; nothing of VS Code's types crosses.
 */

interface RelayEntry {
  pipe: string
  token: string
  pid: number
  startedAt: number
}

type RelayOp = { op: 'list' } | { op: 'chat'; request: HostModelRequest }
type RelayRequest = RelayOp & { token: string }

/** One request line may carry a long conversation with pictures in it. */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024

export function defaultRelayDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.join(env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'light-code', 'lm-relay')
  return path.join(os.homedir(), '.light-code', 'lm-relay')
}

function pipeName(id: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\light-code-lm-${id}` : path.join(os.tmpdir(), `light-code-lm-${id}.sock`)
}

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function writeLine(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`)
}

/**
 * Serves `models` to other hosts of this user. Called by the VS Code extension once per window; the
 * returned `dispose` closes the pipe and removes the window's file.
 */
export function startLmRelay(models: HostLanguageModels, options: { dir?: string; log?: (line: string) => void } = {}): { dispose(): void; pipe: string } {
  const dir = options.dir ?? defaultRelayDir()
  const token = randomBytes(32).toString('hex')
  const pipe = pipeName(randomBytes(12).toString('hex'))
  const file = path.join(dir, `${String(process.pid)}.json`)
  const log = options.log ?? (() => undefined)

  const server: Server = createServer((socket) => {
    let buffered = ''
    let handled = false
    const controller = new AbortController()
    socket.on('close', () => controller.abort())
    socket.on('error', () => controller.abort())
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      if (handled) return
      buffered += chunk
      if (buffered.length > MAX_REQUEST_BYTES) {
        handled = true
        writeLine(socket, { error: 'The request was too large.' })
        socket.end()
        return
      }
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      handled = true
      void answer(buffered.slice(0, newline), socket, controller.signal)
    })
  })

  async function answer(line: string, socket: Socket, signal: AbortSignal): Promise<void> {
    let request: RelayRequest
    try {
      request = JSON.parse(line) as RelayRequest
    } catch {
      writeLine(socket, { error: 'The request was not valid JSON.' })
      socket.end()
      return
    }
    // Nothing about the models, not even an error naming them, before the token checks out.
    if (!sameToken(request.token, token)) {
      socket.destroy()
      return
    }
    try {
      if (request.op === 'list') {
        writeLine(socket, { models: await models.listModels(signal) })
      } else if (request.op === 'chat') {
        for await (const chunk of models.chat(request.request, signal)) {
          if (signal.aborted) return
          writeLine(socket, { chunk })
        }
        writeLine(socket, { done: true })
      } else {
        writeLine(socket, { error: 'Unknown request.' })
      }
    } catch (error) {
      writeLine(socket, { error: error instanceof Error ? error.message : String(error) })
    }
    socket.end()
  }

  server.on('error', (error) => log(`Copilot relay: ${error.message}`))
  server.listen(pipe, () => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const entry: RelayEntry = { pipe, token, pid: process.pid, startedAt: Date.now() }
      writeFileSync(file, JSON.stringify(entry), { mode: 0o600 })
      log(`Copilot relay: serving VS Code's models to Fire Code and the Light Code host on this machine`)
    } catch (error) {
      log(`Copilot relay: could not record the pipe: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  return {
    pipe,
    dispose() {
      server.close()
      rmSync(file, { force: true })
    },
  }
}

/** The windows that say they are serving, newest first. A file whose pipe is gone is removed when found. */
function relayEntries(dir: string): { entry: RelayEntry; file: string }[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const entries: { entry: RelayEntry; file: string; at: number }[] = []
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8')) as Partial<RelayEntry>
      if (typeof entry.pipe === 'string' && typeof entry.token === 'string') {
        entries.push({ entry: entry as RelayEntry, file, at: statSync(file).mtimeMs })
      }
    } catch {
      // Half-written or not ours: skipped, never trusted.
    }
  }
  return entries.sort((a, b) => b.at - a.at)
}

export const NO_VSCODE_WINDOW =
  'No VS Code window with the Light Code extension is open, so GitHub Copilot cannot be reached. Open VS Code ' +
  '(Copilot signed in, Light Code 0.161.0 or later) and try again - the first request asks there whether Light Code may use Copilot.'

/** Opens a connection to the newest live window and sends one request; the answer lines are yielded. */
async function* exchange(dir: string, request: RelayOp, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  for (const { entry, file } of relayEntries(dir)) {
    const socket = await new Promise<Socket | undefined>((resolve) => {
      const candidate = connect(entry.pipe)
      candidate.once('connect', () => resolve(candidate))
      candidate.once('error', () => resolve(undefined))
    })
    if (socket === undefined) {
      // That window closed without tidying up (a crash, a killed process).
      rmSync(file, { force: true })
      continue
    }
    const onAbort = (): void => {
      socket.destroy()
    }
    signal?.addEventListener('abort', onAbort)
    try {
      socket.setEncoding('utf8')
      socket.write(`${JSON.stringify({ ...request, token: entry.token })}\n`)
      let buffered = ''
      let ended = false
      const queue: string[] = []
      let wake: (() => void) | undefined
      socket.on('data', (chunk: string) => {
        buffered += chunk
        let newline = buffered.indexOf('\n')
        while (newline >= 0) {
          queue.push(buffered.slice(0, newline))
          buffered = buffered.slice(newline + 1)
          newline = buffered.indexOf('\n')
        }
        wake?.()
      })
      const finish = (): void => {
        ended = true
        wake?.()
      }
      socket.on('close', finish)
      socket.on('error', finish)
      for (;;) {
        const line = queue.shift()
        if (line !== undefined) {
          yield JSON.parse(line) as Record<string, unknown>
          continue
        }
        if (ended) break
        await new Promise<void>((resolve) => (wake = resolve))
        wake = undefined
      }
      if (signal?.aborted === true) return
    } finally {
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
    }
    return
  }
  throw new Error(NO_VSCODE_WINDOW)
}

/** VS Code's models, from Fire Code, the Node host or the JetBrains plugin on this machine. */
export function createRelayLanguageModels(options: { dir?: string } = {}): HostLanguageModels {
  const dir = options.dir ?? defaultRelayDir()
  return {
    label: 'VS Code (relayed)',
    async listModels(signal) {
      for await (const line of exchange(dir, { op: 'list' }, signal)) {
        if (typeof line['error'] === 'string') throw new Error(line['error'])
        if (Array.isArray(line['models'])) return line['models'] as HostModelInfo[]
      }
      throw new Error('VS Code closed the connection without an answer.')
    },
    async *chat(request, signal) {
      for await (const line of exchange(dir, { op: 'chat', request }, signal)) {
        if (typeof line['error'] === 'string') throw new Error(line['error'])
        if (line['done'] === true) return
        if (line['chunk'] !== undefined) yield line['chunk'] as StreamChunk
      }
      if (signal?.aborted !== true) throw new Error('VS Code closed the connection before the answer finished - was the window closed?')
    },
  }
}
