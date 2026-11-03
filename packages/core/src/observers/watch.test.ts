import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ObserverAgent, type ObserverStatus } from './process.js'

/**
 * The real `fire-fs watch` (observer.rs) calling a stand-in OpenAI-compatible model on loopback, through the
 * real supervisor. The one test of the Rust model call end to end: request shape, the auth header asked for
 * per call, the one 401 retry, the reply parsed, and the handoff at the threshold with a new process started.
 *
 * Needs a built helper: `cargo build -p fire-fs --no-default-features --target-dir target/slim` in
 * apps/sun/native, or LIGHT_CODE_TEST_FIRE_FS naming one. Skipped without it, and says so.
 */

const root = path.resolve(__dirname, '../../../..')
const candidates = [
  process.env['LIGHT_CODE_TEST_FIRE_FS'],
  path.join(root, 'apps/sun/native/target/slim/debug/fire-fs.exe'),
  path.join(root, 'apps/sun/native/target/slim/release/fire-fs.exe'),
  path.join(root, 'apps/sun/native/target/debug/fire-fs.exe'),
].filter((p): p is string => p !== undefined)
const exe = candidates.find((p) => existsSync(p))

interface Seen {
  auth: string | undefined
  body: { model?: string; messages?: { role: string; content: string }[]; stream?: boolean }
}

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    request.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
    request.on('end', () => resolve(body))
  })
}

async function model(reply: (seen: Seen, n: number) => { status: number; body: unknown }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  server = createServer((request, response) => {
    void readBody(request).then((text) => {
      const entry: Seen = { auth: request.headers.authorization, body: JSON.parse(text) as Seen['body'] }
      seen.push(entry)
      const answer = reply(entry, seen.length)
      response.writeHead(answer.status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${String(address.port)}/v1`, seen }
}

const completion = (content: string, promptTokens: number): unknown => ({
  choices: [{ message: { role: 'assistant', content } }],
  usage: { prompt_tokens: promptTokens, completion_tokens: 10 },
})

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe.skipIf(exe === undefined)(`fire-fs watch, for real (${exe ?? 'no helper built - skipped'})`, () => {
  it('reviews a step with a fresh auth header, retries a 401 once, and hands off at the threshold', async () => {
    const { url, seen } = await model((entry, n) => {
      if (n === 1) return { status: 401, body: { error: 'expired' } }
      // 9000 of a 10000 window: past 70%, so the first answered review hands off.
      return { status: 200, body: completion(`Here: {"verdict":"note","note":"You never read a.ts","severity":"high","state":"goal: fix a.ts (call ${String(n)})"}`, n === 2 ? 9_000 : 100) }
    })
    const replies: unknown[] = []
    const statuses: ObserverStatus[] = []
    let token = 0
    const forced: boolean[] = []
    const agent = new ObserverAgent({
      exe: exe!,
      role: 'guard',
      system: 'You are the guard.',
      window: 10_000,
      model: { wire: 'openai', baseUrl: url, model: 'test-model' },
      resolveAuth: (force) => {
        forced.push(force)
        token += 1
        return Promise.resolve({ Authorization: `Bearer token-${String(token)}` })
      },
      onResult: (reply) => replies.push(reply),
      onStatus: (s) => statuses.push(s),
      log: () => undefined,
    })
    agent.start()
    agent.send({ kind: 'assistant', at: Date.now(), text: 'a.ts exports login()' })
    await until(() => replies.length >= 1)
    expect(replies[0]).toMatchObject({ verdict: 'note', note: 'You never read a.ts', state: 'goal: fix a.ts (call 2)' })
    // The 401: asked once more with force, and the second header is the one that was answered.
    expect(forced).toEqual([false, true])
    expect(seen[0]!.auth).toBe('Bearer token-1')
    expect(seen[1]!.auth).toBe('Bearer token-2')
    expect(seen[1]!.body).toMatchObject({ model: 'test-model', stream: false })
    expect(seen[1]!.body.messages?.[0]).toEqual({ role: 'system', content: 'You are the guard.' })
    expect(seen[1]!.body.messages?.[1]?.content).toContain('a.ts exports login()')

    // The handoff: a second process, started with the first one's notes in its instructions.
    await until(() => statuses.some((s) => s.generation === 2 && s.state === 'running'))
    expect(agent.current.handoffs).toBe(1)
    agent.send({ kind: 'toolResult', at: Date.now(), tool: 'read_file', ok: true, text: 'export function login() {}' })
    await until(() => replies.length >= 2)
    const third = seen[2]!.body.messages!
    expect(third[0]!.content).toContain('Handoff from your previous instance')
    expect(third[0]!.content).toContain('goal: fix a.ts (call 2)')
    // A fresh context: the system prompt and the one new batch, not the old conversation.
    expect(third).toHaveLength(2)
    agent.stop()
  }, 30_000)

  it('reports a model it cannot reach and keeps the events for the next try', async () => {
    const statuses: ObserverStatus[] = []
    const agent = new ObserverAgent({
      exe: exe!,
      role: 'auditor',
      system: 's',
      window: 10_000,
      model: { wire: 'anthropic', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' },
      resolveAuth: () => Promise.resolve({ 'x-api-key': 'k' }),
      onResult: () => undefined,
      onStatus: (s) => statuses.push(s),
      log: () => undefined,
    })
    agent.start()
    agent.send({ kind: 'turnEnd', at: Date.now(), ending: 'done' })
    await until(() => statuses.some((s) => s.state === 'retrying'))
    expect(statuses.find((s) => s.state === 'retrying')?.lastError).toContain('Could not reach http://127.0.0.1:9/v1/messages')
    agent.stop()
  }, 30_000)
})
