import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { StdioControl } from './controlChannel.js'
import { startServer, type RunningServer } from './server.js'

/**
 * One codebase's agent asking another's, end to end: two running hosts, a stand-in model, and a relay doing Fire
 * Code's part (`apps/sun/native/src/agents.rs`) - an ask from one host's control line becomes a task on the other's,
 * and its answer goes back. Asked for: "agent from one code base can talk to another agent that's in another code
 * base to get help or do certain things".
 */

const servers: RunningServer[] = []
let model: Server | undefined
const folders: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await new Promise<void>((resolve) => (model === undefined ? resolve() : model.close(() => resolve())))
  model = undefined
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
})

/** Codebase A's agent asks B; B's agent answers with attempt_completion; A finishes with what B said. */
async function standInModel(): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = []
  model = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end()
        return
      }
      requests.push(body)
      const sent = JSON.parse(body) as { messages: { role: string; content: string | null }[] }
      const last = sent.messages[sent.messages.length - 1]
      const call = (name: string, args: object): string =>
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${String(requests.length)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
      let event: string
      if (last?.role === 'user' && String(last.content).includes('A request from the agent working in codebase')) {
        event = call('attempt_completion', { result: 'Use rates.v2 - the old endpoint was retired in March.' })
      } else if (last?.role === 'user') {
        event = call('ask_codebase_agent', { codebase: 'billing', request: 'Which rates endpoint should a client call now?' })
      } else {
        const result = String(last?.content ?? '')
        event = call('attempt_completion', { result: `Billing says: ${result.split('answered:\n\n')[1] ?? result}` })
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${event}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => model!.listen(0, '127.0.0.1', () => resolve()))
  return { baseUrl: `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1`, requests }
}

type Message = { type: string } & Record<string, unknown>

async function host(name: string, baseUrl: string, control: StdioControl, siblings: { name: string; path: string }[]): Promise<{ url: string; poll: () => Promise<Message[]>; post: (m: object) => Promise<void>; workspace: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `lc-agents-${name}-data-`))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `lc-agents-${name}-ws-`))
  folders.push(dataDir, workspace)
  const configFile = path.join(dataDir, 'config.json')
  await fs.writeFile(configFile, JSON.stringify({ profiles: [{ id: 'local', label: 'Local', wireFormat: 'openai', baseUrl, model: 'stand-in', auth: { type: 'none' } }], activeProfileId: 'local' }))
  const running = await startServer({
    workspaceRoot: workspace,
    dataDir,
    configFile,
    clientAssets: {},
    ripgrepPath: () => undefined,
    noToken: true,
    logSink: () => undefined,
    codebaseAgents: control.agents(),
    siblings,
  })
  servers.push(running)
  const url = running.url
  return {
    url,
    workspace,
    poll: async () => ((await (await fetch(`${url}/api/poll`, { headers: { Origin: url } })).json()) as { messages: Message[] }).messages,
    post: async (message) => {
      const response = await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(message) })
      expect(response.status).toBe(202)
    },
  }
}

describe("asking another codebase's agent", () => {
  it('sends the request to that codebase, which works on it and answers back', async () => {
    const { baseUrl, requests } = await standInModel()
    // Fire Code's part: route an ask from A to B as a task, and B's answer back to A.
    // Each relays into the other, so each refers to the other before both exist.
    // eslint-disable-next-line prefer-const
    let toB: StdioControl | undefined
    const relayed: string[] = []
    const lineFrom = (raw: string): Record<string, unknown> => JSON.parse(raw.replace(/^light-code-monitor: /, '')) as Record<string, unknown>
    const asks = new Map<string, unknown>()
    const toA: StdioControl = new StdioControl((raw) => {
      const line = lineFrom(raw)
      relayed.push(String(line.type))
      if (line.type === 'agentAsk') {
        asks.set('t1', line.id)
        toB!.feed(`${JSON.stringify({ type: 'agentTask', id: 't1', from: 'payments', message: line.message, depth: line.depth })}\n`)
      }
    })
    toB = new StdioControl((raw) => {
      const line = lineFrom(raw)
      relayed.push(String(line.type))
      if (line.type === 'agentDone') toA.feed(`${JSON.stringify({ type: 'agentReply', id: asks.get(String(line.id)), ok: line.ok, text: line.text, chat: 'From payments: Which rates endpoint' })}\n`)
    })

    const b = await host('billing', baseUrl, toB, [{ name: 'payments', path: '.' }])
    const a = await host('payments', baseUrl, toA, [{ name: 'billing', path: '.' }])
    await b.poll()
    await a.poll()

    const inboxA: Message[] = []
    const inboxB: Message[] = []
    const until = async (inbox: Message[], poll: () => Promise<Message[]>, match: (m: Message) => boolean, also?: () => Promise<void>): Promise<Message> => {
      const deadline = Date.now() + 20_000
      for (;;) {
        const found = inbox.find(match)
        if (found !== undefined) return found
        if (Date.now() > deadline) throw new Error(`timed out; saw ${inbox.map((m) => m.type).join(', ')}`)
        inbox.push(...(await poll()))
        await also?.()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    await a.post({ type: 'sendMessage', text: 'Our rates call fails - find out from billing what to use.' })
    // A's ask is approved by the user, with the literal request on screen (invariant 8).
    const approval = await until(inboxA, a.poll, (m) => m.type === 'approvalRequest')
    expect(approval.toolName).toBe('ask_codebase_agent')
    expect(JSON.stringify(approval.preview)).toContain('Which rates endpoint should a client call now?')
    expect(JSON.stringify(approval.preview)).toContain('codebase \\"billing\\"')
    await a.post({ type: 'approvalResponse', id: approval.id, decision: 'approve' })

    // B shows the request as its first message and runs, without anybody typing.
    await until(inboxB, b.poll, (m) => m.type === 'hostTurnStarted')
    const shown = JSON.stringify(inboxB.find((m) => m.type === 'taskRestored'))
    expect(shown).toContain('A request from the agent working in codebase')
    expect(shown).toContain('Which rates endpoint should a client call now?')

    // B's answer reaches A's agent, which finishes with it.
    await until(inboxA, a.poll, (m) => m.type === 'done', async () => void inboxB.push(...(await b.poll())))
    const finalRequest = requests.at(-1)!
    expect(finalRequest).toContain('Use rates.v2')
    expect(finalRequest).toContain('From payments: Which rates endpoint')
    expect(relayed).toEqual(['agentAsk', 'agentDone'])
  }, 60_000)
})
