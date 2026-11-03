import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { RoleProcess } from './roleProcess.js'

/**
 * A specialist in its own process, for real: `fire-fs agent` (role_agent.rs) against a stand-in OpenAI-compatible
 * model on loopback, through the real supervisor. What is checked is what was asked for - its own context kept
 * between questions, its tool calls run by the host (here, a recorder) and not by the process, and the handoff it
 * makes by itself near the limit: key points asked of its own model, then a fresh conversation seeded with them.
 *
 * Needs a built helper (`cargo build -p fire-fs --no-default-features --target-dir target/slim` in apps/sun/native,
 * or LIGHT_CODE_TEST_FIRE_FS). Skipped without one, and says so.
 */

const root = path.resolve(__dirname, '../../../..')
const exe = [
  process.env['LIGHT_CODE_TEST_FIRE_FS'],
  path.join(root, 'apps/sun/native/target/slim/debug/fire-fs.exe'),
  path.join(root, 'apps/sun/native/target/slim/release/fire-fs.exe'),
].find((p): p is string => p !== undefined && existsSync(p))

type Message = { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }
let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function model(answer: (messages: Message[], n: number) => unknown): Promise<{ url: string; seen: { messages: Message[]; tools?: unknown[]; tool_choice?: unknown }[] }> {
  const seen: { messages: Message[]; tools?: unknown[]; tool_choice?: unknown }[] = []
  server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Message[]; tools?: unknown[]; tool_choice?: unknown }
      seen.push(parsed)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(answer(parsed.messages, seen.length)))
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${String((server.address() as { port: number }).port)}/v1`, seen }
}

const text = (content: string, tokens: number): unknown => ({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: tokens } })
const toolCall = (name: string, args: unknown): unknown => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 100 },
})

describe.skipIf(exe === undefined)(`fire-fs agent, for real (${exe ?? 'no helper built - skipped'})`, () => {
  it('runs its tool calls through the host, keeps its own context, and hands off by itself near the limit', async () => {
    const { url, seen } = await model((messages, n) => {
      if (n === 1) return toolCall('read_file', { path: 'a.ts' })
      if (n === 2) return text('a.ts exports login(); it looks right.', 200)
      // Second question: 7500 of a 10000 window - past 70%, so a handoff follows this answer.
      if (n === 3) return text('Still fine, nothing new.', 7_500)
      if (n === 4) return text('KEY POINTS: reviewing login in a.ts; no problems found.', 7_600)
      return text('Fresh session answer.', 50)
    })
    const ran: string[] = []
    const agent = new RoleProcess({
      exe: exe!,
      role: 'tester',
      system: 'You are the tester.',
      window: 10_000,
      model: { wire: 'openai', baseUrl: url, model: 'test-model' },
      tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      resolveAuth: () => Promise.resolve({ Authorization: 'Bearer t' }),
      log: () => undefined,
    })
    const runTool = async (name: string, args: string): Promise<string> => {
      ran.push(`${name} ${args}`)
      return 'export function login() {}'
    }

    const first = await agent.consult({ prompt: 'Check the login change.', maxSteps: 5, tools: true, runTool })
    expect(first).toEqual({ text: 'a.ts exports login(); it looks right.', steps: 1, truncated: false })
    // The tool ran here, in the host, and its result went back to the model as a tool message.
    expect(ran).toEqual(['read_file {"path":"a.ts"}'])
    expect(seen[1]!.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: 'export function login() {}' })
    expect(seen[0]!.tool_choice).toBe('auto')

    // Its own context: the second question arrives after the whole first exchange.
    const second = await agent.consult({ prompt: 'Anything else?', maxSteps: 5, tools: true, runTool })
    expect(second.text).toBe('Still fine, nothing new.')
    expect(seen[2]!.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user'])

    // The handoff it made by itself: key points asked of its own model, with tools forbidden...
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(seen[3]!.tool_choice).toBe('none')
    expect(seen[3]!.messages.at(-1)?.content).toContain('key points')
    expect(agent.status.handoffs).toBe(1)
    expect(agent.keyPoints).toContain('reviewing login in a.ts')

    // ...and the next question starts a fresh conversation, in the same process, seeded with them.
    const third = await agent.consult({ prompt: 'One more look.', maxSteps: 5, tools: true, runTool })
    expect(third.text).toBe('Fresh session answer.')
    const fresh = seen[4]!.messages
    expect(fresh.map((m) => m.role)).toEqual(['system', 'user'])
    expect(fresh[0]!.content).toContain('KEY POINTS: reviewing login in a.ts')
    expect(agent.status.generation).toBe(1)
    agent.stop()
  }, 30_000)

  it('answers with what it has when its lookups run out', async () => {
    const { url, seen } = await model((_messages, n) => (n <= 2 ? toolCall('read_file', { path: `f${String(n)}` }) : text('Answered without more lookups.', 100)))
    const agent = new RoleProcess({
      exe: exe!,
      role: 'reviewer',
      system: 's',
      window: 100_000,
      model: { wire: 'openai', baseUrl: url, model: 'm' },
      tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }],
      resolveAuth: () => Promise.resolve({}),
      log: () => undefined,
    })
    const answer = await agent.consult({ prompt: 'Review.', maxSteps: 2, tools: true, runTool: async () => 'content' })
    expect(answer).toMatchObject({ text: 'Answered without more lookups.', steps: 2, truncated: true })
    // The last request forbids tools and tells it to answer.
    expect(seen[2]!.tool_choice).toBe('none')
    expect(seen[2]!.messages.at(-1)?.content).toContain('Answer now')
    agent.stop()
  }, 30_000)
})
