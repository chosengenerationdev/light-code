import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * A strategy, end to end - asked for: "make sure application of strategy is working end to end fine".
 *
 * A running host, and one stand-in model on loopback playing both parts, told apart by model name: the main agent
 * (`main`, streamed, scripted to follow the strategy) and the specialists (`spec`). The strategy is programmer ⇄
 * tester until "all tests pass", at most 2 rounds, with a contract on the connector. What is checked is every claim
 * the feature makes, over the wire:
 *
 * - the strategy is set from the window's own message and reaches the main agent's instructions, contract included;
 * - each specialist is told its part (the judge to give a verdict line, both ends the contract);
 * - rounds are counted from consultations that ran, and a third round is refused;
 * - every consultation, and the refusal, is in the exchange log the window shows, and `strategy_history` returns it;
 * - the strategy and its log come back when the chat is reopened;
 * - with the Rust helper, each specialist keeps its own context, and the main agent's never holds it.
 */

let running: RunningServer | undefined
let model: Server | undefined
const folders: string[] = []

afterEach(async () => {
  await running?.close()
  running = undefined
  await new Promise<void>((resolve) => (model === undefined ? resolve() : model.close(() => resolve())))
  model = undefined
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
})

type Body = { model: string; stream?: boolean; messages: { role: string; content?: unknown; tool_calls?: unknown[] }[] }

const text = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content ?? ''))

/** The main agent's script: which call to make, by how many tool results it has already seen. */
const SCRIPT: ({ name: string; args: Record<string, unknown> } | { say: string })[] = [
  { name: 'ask_agent', args: { role: 'programmer', question: 'Fix the rounding in invoice totals.' } },
  { name: 'ask_agent', args: { role: 'tester', question: 'Test the rounding change: test_round and test_total.' } },
  { name: 'ask_agent', args: { role: 'programmer', question: 'test_round still fails: fix it.' } },
  { name: 'ask_agent', args: { role: 'tester', question: 'Test again.' } },
  { name: 'ask_agent', args: { role: 'programmer', question: 'One more try.' } },
  { name: 'strategy_history', args: {} },
  { say: 'Stopped after the two rounds the strategy allows: test_round still fails.' },
]

async function standInModel(): Promise<{ baseUrl: string; main: Body[]; spec: Body[] }> {
  const main: Body[] = []
  const spec: Body[] = []
  model = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end()
        return
      }
      const body = JSON.parse(raw) as Body
      let reply: { say: string } | { name: string; args: Record<string, unknown> }
      if (body.model === 'spec') {
        spec.push(body)
        const question = text(body.messages.filter((m) => m.role === 'user').at(-1)?.content)
        reply = { say: question.includes('You are the judge') ? 'Ran both tests.\nCONDITION: NOT MET - test_round fails' : "Changed round() to banker's rounding." }
      } else {
        main.push(body)
        const step = body.messages.filter((m) => m.role === 'tool').length
        reply = SCRIPT[Math.min(step, SCRIPT.length - 1)]!
      }
      if (body.stream !== true) {
        // The Rust specialist process asks without streaming.
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'say' in reply ? reply.say : '' } }], usage: { prompt_tokens: 100 } }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if ('say' in reply) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.say } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      } else {
        const call = { index: 0, id: `call-${String(main.length)}`, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.args) } }
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => model!.listen(0, '127.0.0.1', () => resolve()))
  return { baseUrl: `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1`, main, spec }
}

type Message = { type: string } & Record<string, unknown>

const STRATEGY = {
  id: 'tdd',
  name: 'Test until green',
  updatedAt: 1,
  nodes: [
    { id: 'p', role: 'programmer', x: 40, y: 40, instructions: 'Keep changes minimal.' },
    { id: 't', role: 'tester', x: 300, y: 40, readOnly: true },
  ],
  edges: [{ id: 'loop', from: 'p', to: 't', twoWay: true, maxRounds: 2, until: 'all tests pass', contract: 'the changed functions and why' }],
}

const helper = [
  path.resolve(import.meta.dirname, '../../sun/native/target/slim/release/fire-fs.exe'),
  path.resolve(import.meta.dirname, '../../sun/native/target/slim/debug/fire-fs.exe'),
].find((p) => existsSync(p))

async function run(fastFs: string | undefined): Promise<{ main: Body[]; spec: Body[]; inbox: Message[]; reopened: Message }> {
  const { baseUrl, main, spec } = await standInModel()
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-strategy-data-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-strategy-ws-'))
  folders.push(dataDir, workspace)
  const configFile = path.join(dataDir, 'config.json')
  await fs.writeFile(
    configFile,
    JSON.stringify({
      profiles: [
        { id: 'main', label: 'Main', wireFormat: 'openai', baseUrl, model: 'main', auth: { type: 'none' } },
        { id: 'spec', label: 'Specialist', wireFormat: 'openai', baseUrl, model: 'spec', auth: { type: 'none' } },
      ],
      activeProfileId: 'main',
      // Auto, not Agent team: the strategy applies in every mode.
      modeId: 'auto',
      agents: { roles: { programmer: { kind: 'profile', profileId: 'spec' }, tester: { kind: 'profile', profileId: 'spec' } } },
      // Consultations are reads; the test approves nothing by hand.
      approvals: { [workspace]: { autoApprove: { read: true } } },
    }),
  )
  running = await startServer({
    workspaceRoot: workspace,
    dataDir,
    configFile,
    clientAssets: {},
    ripgrepPath: () => undefined,
    noToken: true,
    logSink: () => undefined,
    ...(fastFs !== undefined ? { fastFs } : {}),
  })
  const url = running.url
  await fetch(`${url}/api/poll`, { headers: { Origin: url } })
  const inbox: Message[] = []
  const post = async (message: object): Promise<void> => {
    const response = await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(message) })
    expect(response.status).toBe(202)
  }
  const until = async (match: (message: Message) => boolean, after = 0): Promise<Message> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const found = inbox.slice(after).find(match)
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error(`timed out; saw ${inbox.map((m) => m.type).join(', ')}`)
      const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
      inbox.push(...((await response.json()) as { messages: Message[] }).messages)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }

  // What the window's "Save and use in this chat" sends.
  await post({ type: 'requestAgents' })
  await post({ type: 'saveStrategy', strategy: STRATEGY, use: true })
  await until((m) => m.type === 'strategyResult')
  // Approve anything a consultation asks about; consultations of these roles ask nothing (reads only).
  await post({ type: 'sendMessage', text: 'Fix the rounding in invoice totals, following the strategy.' })
  await until((m) => m.type === 'done')
  await post({ type: 'requestStrategies' })
  const mark = inbox.length
  await until((m) => m.type === 'strategies', mark)

  // Reopen the chat from history: the strategy and what passed under it come back.
  const tasks = await (async () => {
    await post({ type: 'requestTasks' })
    return (await until((m) => m.type === 'tasks' && Array.isArray(m['tasks']) && (m['tasks'] as unknown[]).length > 0)) as unknown as { tasks: { id: string }[] }
  })()
  await post({ type: 'newTask' })
  await until((m) => m.type === 'taskRestored' && m['taskId'] === undefined)
  const before = inbox.length
  await post({ type: 'openTask', id: tasks.tasks[0]!.id })
  const reopened = await until((m) => m.type === 'strategies' && m['active'] !== undefined, before)
  return { main, spec, inbox, reopened }
}

function expectStrategyHeld(result: Awaited<ReturnType<typeof run>>): void {
  const { main, spec, inbox, reopened } = result
  // 1. The strategy reached the main agent's instructions, contract and loop rules included.
  const system = text(main[0]!.messages[0]!.content)
  expect(system).toContain('## Strategy: Test until green')
  expect(system).toContain('Repeat until: "all tests pass"')
  expect(system).toContain('at most 2 rounds')
  expect(system).toContain('passes on: the changed functions and why')
  expect(system).toContain("the user's instructions for it: \"Keep changes minimal.\"")

  // 2. Each specialist was told its part.
  const asked = spec.map((body) => text(body.messages.filter((m) => m.role === 'user').at(-1)?.content))
  const testerAsk = asked.find((q) => q.includes('Test the rounding change'))!
  expect(testerAsk).toContain('You are the judge of a back-and-forth')
  expect(testerAsk).toContain('CONDITION: MET')
  expect(testerAsk).toContain('From Programmer you are given, as agreed: the changed functions and why')
  expect(testerAsk).toContain('read-only')
  const programmerAsk = asked.find((q) => q.includes('Fix the rounding in invoice totals.'))!
  expect(programmerAsk).toContain('As agreed, it must contain: the changed functions and why')
  expect(programmerAsk).toContain('Keep changes minimal.')

  // 3. Rounds counted from what ran; the third round refused. The fifth call never reached a specialist.
  expect(spec.filter((body) => body.messages.some((m) => text(m.content).includes('One more try.')))).toHaveLength(0)
  const lastMain = main.at(-1)!
  const toolResults = lastMain.messages.filter((m) => m.role === 'tool').map((m) => text(m.content))
  expect(toolResults[1]).toContain('round 1 of 2 - not met - test_round fails')
  expect(toolResults[3]).toContain('all 2 rounds used')
  expect(toolResults[4]).toContain('The strategy allows at most 2 rounds between Programmer and Tester')
  // 4. strategy_history answered from the record.
  expect(toolResults[5]).toContain('Programmer ⇄ Tester: round 2 of 2, not met - test_round fails')
  expect(toolResults[5]).toContain('REFUSED')

  // The window's view: the progress, and every exchange including the refusal.
  const latest = [...inbox].reverse().find((m) => m.type === 'strategies' && Array.isArray(m['exchanges']))! as unknown as {
    progress: Record<string, { rounds: number; met?: boolean }>
    exchanges: { role: string; refused?: string }[]
  }
  expect(latest.progress['loop']).toMatchObject({ rounds: 2, met: false })
  expect(latest.exchanges.map((e) => `${e.role}${e.refused !== undefined ? ':refused' : ''}`)).toEqual(['programmer', 'tester', 'programmer', 'tester', 'programmer:refused'])

  // 5. Reopened from history, it is all still there.
  const back = reopened as unknown as { active: { name: string }; exchanges: unknown[]; progress: Record<string, { rounds: number }> }
  expect(back.active.name).toBe('Test until green')
  expect(back.exchanges).toHaveLength(5)
  expect(back.progress['loop']?.rounds).toBe(2)

  // The main agent's context never held a specialist's: the judge's instructions went only to the tester.
  for (const body of main) expect(JSON.stringify(body)).not.toContain('You are the judge of a back-and-forth')
}

describe('a strategy, end to end', () => {
  it('is applied as drawn, with specialists answering in the host', async () => {
    expectStrategyHeld(await run(undefined))
  }, 90_000)

  it.skipIf(helper === undefined)(`is applied as drawn, with each specialist in its own Rust process (${helper ?? 'no helper built - skipped'})`, async () => {
    const result = await run(helper)
    expectStrategyHeld(result)
    // Its own context: the programmer's second question arrives after its first exchange, in its own conversation.
    const programmerSecond = result.spec.find((body) => body.messages.some((m) => text(m.content).includes('test_round still fails')))!
    expect(programmerSecond.stream).not.toBe(true)
    const said = programmerSecond.messages.map((m) => text(m.content)).join('\n')
    expect(said).toContain('Fix the rounding in invoice totals.')
    expect(said).toContain("Changed round() to banker's rounding.")
  }, 90_000)
})
