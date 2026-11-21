import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * The decision model, end to end, on a running host - asked for: D3 set up as an OpenAI-compatible profile powering
 * Agent team mode, "make sure we dont disturb any existing workings".
 *
 * One stand-in model on loopback: `main` (the chat, streamed) and `d3` (the decision model, answering with token
 * log-probabilities the way vLLM does). Checked: a confident pick reaches the main assistant as an instruction to
 * consult that specialist and is shown above the message box; no decision model changes nothing and asks nothing; a
 * decision model that gives no probabilities routes nothing and says so; the Test button reads its answers.
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

type Body = { model: string; stream?: boolean; logprobs?: boolean; messages: { role: string; content?: unknown }[] }
type Message = { type: string } & Record<string, unknown>
const text = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content ?? ''))

type SystemOne = { model: string; state: string; questions: { q: { type: string; instructions: string; criteria?: Record<string, string> } } }

/**
 * `d3` answers the first specialist (or yes) with probability `p`: on `/systemone` as D3 does (`api: 'systemone'`, the
 * default), or - for a decision model behind chat completions - on `/chat/completions` with token log-probabilities,
 * `/systemone` answering 404. `'no-probabilities'`: no `/systemone`, and plain text on chat completions.
 */
async function standIn(d3: { p: number; api?: 'systemone' | 'chat' } | 'no-probabilities'): Promise<{ baseUrl: string; main: Body[]; decisions: Body[]; systemOne: SystemOne[] }> {
  const main: Body[] = []
  const decisions: Body[] = []
  const systemOne: SystemOne[] = []
  model = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    request.on('end', () => {
      if (request.url?.endsWith('/systemone') === true) {
        if (d3 === 'no-probabilities' || d3.api === 'chat') {
          response.writeHead(404).end()
          return
        }
        const body = JSON.parse(raw) as SystemOne
        systemOne.push(body)
        const asked = body.questions.q
        const keys = Object.keys(asked.criteria ?? {})
        // The first specialist is the second option (the first is the main assistant).
        const answer =
          asked.type === 'noul'
            ? { type: 'noul', noul: d3.p, probabilities: { yes: d3.p, no: 1 - d3.p }, confidence: d3.p }
            : { type: 'choice', choice: keys[1], probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 1 ? d3.p : (1 - d3.p) / (keys.length - 1)])), confidence: d3.p }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ object: 'structured_decision', model: body.model, answers: { q: answer }, usage: { input_tokens: 100, output_tokens: 0 } }))
        return
      }
      // The host also asks /models for the context window: nothing to say there.
      if (request.url?.endsWith('/chat/completions') !== true) {
        response.writeHead(404).end()
        return
      }
      const body = JSON.parse(raw) as Body
      if (body.model === 'd3') {
        decisions.push(body)
        const question = text(body.messages.at(-1)?.content)
        const yesno = question.includes('Answer Yes or No')
        const first = yesno ? 'Yes' : 'B'
        const second = yesno ? 'No' : 'A'
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify(
            d3 === 'no-probabilities'
              ? { choices: [{ message: { role: 'assistant', content: first } }] }
              : {
                  choices: [
                    {
                      message: { role: 'assistant', content: first },
                      logprobs: { content: [{ token: first, logprob: Math.log(d3.p), top_logprobs: [{ token: first, logprob: Math.log(d3.p) }, { token: second, logprob: Math.log(1 - d3.p) }] }] },
                    },
                  ],
                },
          ),
        )
        return
      }
      main.push(body)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => model!.listen(0, '127.0.0.1', () => resolve()))
  return { baseUrl: `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1`, main, decisions, systemOne }
}

async function host(baseUrl: string, extra: Record<string, unknown>): Promise<{ post: (m: object) => Promise<void>; until: (match: (m: Message) => boolean) => Promise<Message>; inbox: Message[] }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-decision-data-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-decision-ws-'))
  folders.push(dataDir, workspace)
  const configFile = path.join(dataDir, 'config.json')
  await fs.writeFile(
    configFile,
    JSON.stringify({
      profiles: [
        { id: 'main', label: 'Main', wireFormat: 'openai', baseUrl, model: 'main', auth: { type: 'none' } },
        { id: 'spec', label: 'Specialist', wireFormat: 'openai', baseUrl, model: 'spec', auth: { type: 'none' } },
        { id: 'd3', label: 'D3', wireFormat: 'openai', baseUrl, model: 'd3', auth: { type: 'none' } },
      ],
      activeProfileId: 'main',
      modeId: 'agent-team',
      agents: { roles: { tester: { kind: 'profile', profileId: 'spec' } } },
      ...extra,
    }),
  )
  running = await startServer({ workspaceRoot: workspace, dataDir, configFile, clientAssets: {}, ripgrepPath: () => undefined, noToken: true, logSink: () => undefined })
  const url = running.url
  const inbox: Message[] = []
  // Opens the session, which a message needs first.
  inbox.push(...((await (await fetch(`${url}/api/poll`, { headers: { Origin: url } })).json()) as { messages: Message[] }).messages)
  const post = async (message: object): Promise<void> => {
    const response = await fetch(`${url}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(message) })
    expect(response.status).toBe(202)
  }
  const until = async (match: (message: Message) => boolean): Promise<Message> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const found = inbox.find(match)
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error(`timed out; saw ${inbox.map((m) => m.type).join(', ')}`)
      const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
      inbox.push(...((await response.json()) as { messages: Message[] }).messages)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  return { post, until, inbox }
}

const lastUser = (body: Body | undefined): string => text(body?.messages.filter((m) => m.role === 'user').at(-1)?.content)

describe('the decision model in Agent team mode', () => {
  it('sends a message to the specialist it is sure of, and says so', async () => {
    const { baseUrl, main, decisions, systemOne } = await standIn({ p: 0.9 })
    const { post, until } = await host(baseUrl, { decisionModel: { profileId: 'd3' } })
    await post({ type: 'requestSettings' })
    const settings = await until((m) => m.type === 'settings')
    expect(settings['decisionLabel']).toBe('D3')
    await post({ type: 'sendMessage', text: 'Write unit tests for the date parser.' })
    const route = await until((m) => m.type === 'decisionRoute')
    await until((m) => m.type === 'done')
    expect(route['role']).toBe('tester')
    expect(route['probability']).toBeCloseTo(0.9, 5)
    // Asked on D3's own API, as a choice with the specialists described - never as a chat completion.
    expect(decisions).toHaveLength(0)
    // The routing question only: skill-and-tool picks are switched on per chat, and this chat has not.
    const routing = systemOne.find((body) => body.questions.q.instructions.startsWith('Who should handle'))
    expect(systemOne).toHaveLength(1)
    expect(routing?.model).toBe('d3')
    expect(routing?.state).toContain('Write unit tests for the date parser.')
    expect(routing?.questions.q.type).toBe('choice')
    expect(Object.keys(routing?.questions.q.criteria ?? {})).toEqual(['the_main_assistant', 'tester'])
    expect(lastUser(main[0])).toContain('The decision model sent this request to `tester`')
  })

  it('leaves it to the main assistant below the threshold', async () => {
    const { baseUrl, main } = await standIn({ p: 0.6 })
    const { post, until } = await host(baseUrl, { decisionModel: { profileId: 'd3', routeThreshold: 0.75 } })
    await post({ type: 'sendMessage', text: 'Write unit tests for the date parser.' })
    await until((m) => m.type === 'done')
    expect(lastUser(main[0])).not.toContain('decision model')
  })

  it('changes nothing and asks nothing without a decision model', async () => {
    const { baseUrl, main, decisions, systemOne } = await standIn({ p: 0.9 })
    const { post, until, inbox } = await host(baseUrl, {})
    await post({ type: 'requestSettings' })
    const settings = await until((m) => m.type === 'settings')
    expect(settings['decisionLabel']).toBeUndefined()
    await post({ type: 'sendMessage', text: 'Write unit tests for the date parser.' })
    await until((m) => m.type === 'done')
    expect(decisions).toHaveLength(0)
    expect(systemOne).toHaveLength(0)
    expect(lastUser(main[0])).toBe('Write unit tests for the date parser.')
    expect(inbox.some((m) => m.type === 'decisionRoute')).toBe(false)
  })

  it('routes nothing when the answer carries no probabilities, and says why', async () => {
    const { baseUrl, main } = await standIn('no-probabilities')
    const { post, until } = await host(baseUrl, { decisionModel: { profileId: 'd3' } })
    await post({ type: 'sendMessage', text: 'Write unit tests for the date parser.' })
    const route = await until((m) => m.type === 'decisionRoute')
    await until((m) => m.type === 'done')
    expect(route['role']).toBeUndefined()
    expect(String(route['note'])).toContain('without probabilities')
    expect(lastUser(main[0])).not.toContain('decision model')
  })

  it('works with a decision model behind chat completions too, when /systemone is not there', async () => {
    const { baseUrl, main, decisions } = await standIn({ p: 0.9, api: 'chat' })
    const { post, until } = await host(baseUrl, { decisionModel: { profileId: 'd3' } })
    await post({ type: 'sendMessage', text: 'Write unit tests for the date parser.' })
    const route = await until((m) => m.type === 'decisionRoute')
    await until((m) => m.type === 'done')
    expect(route['role']).toBe('tester')
    expect(text(decisions[0]?.messages.at(-1)?.content)).toContain('B. Tester')
    expect(lastUser(main[0])).toContain('The decision model sent this request to `tester`')
  })

  it('uses the endpoint path set for an office gateway', async () => {
    const { baseUrl, main, systemOne } = await standIn({ p: 0.9 })
    // The stand-in answers any path ending in /systemone; the setting decides which path is asked.
    const { post, until } = await host(baseUrl, { decisionModel: { profileId: 'd3', endpoint: '/gateway/d3/systemone' } })
    await post({ type: 'sendMessage', text: 'Write unit tests for the date parser.' })
    const route = await until((m) => m.type === 'decisionRoute')
    await until((m) => m.type === 'done')
    expect(route['role']).toBe('tester')
    expect(systemOne).toHaveLength(1)
    expect(lastUser(main[0])).toContain('The decision model sent this request to `tester`')
  })

  it('in a chat that switched it on, in any mode, suggests the tool a request needs; a new chat from it keeps it', async () => {
    const { baseUrl, main, systemOne } = await standIn({ p: 0.9 })
    const { post, until, inbox } = await host(baseUrl, { modeId: 'auto', decisionModel: { profileId: 'd3' } })
    // Tools only: this workspace has no skills, and a chat chooses what it asks for.
    await post({ type: 'setChatSkillToolPicks', value: 'tools' })
    await until((m) => m.type === 'chatSkillToolPicks' && m['value'] === 'tools')
    await post({ type: 'sendMessage', text: 'Show me the files in this folder.' })
    await until((m) => m.type === 'done')
    const asked = systemOne.find((body) => body.questions.q.instructions.startsWith('Which tool'))
    // The stand-in favours the first real option after "nothing in particular": whichever tool is listed first.
    const first = Object.keys(asked?.questions.q.criteria ?? {})[1]
    expect(first).toBeDefined()
    expect(lastUser(main[0])).toContain('[Decision model] For this request these look right: tool')
    expect(lastUser(main[0])).toContain('this is advice, not an instruction')

    // "+": the new chat keeps the switch.
    const before = inbox.length
    await post({ type: 'newTask' })
    await until((m) => m.type === 'taskRestored' && m['taskId'] === undefined)
    await post({ type: 'requestChatSkillToolPicks' })
    const kept = await until((m) => m.type === 'chatSkillToolPicks' && inbox.indexOf(m) >= before)
    expect(kept['value']).toBe('tools')
    // The tool question carried the request with the chat before it - the gap a follow-up would fall into.
    expect(asked?.state).toContain('Latest request:\nShow me the files in this folder.')

    await running?.close()
    running = undefined
    await new Promise<void>((resolve) => (model === undefined ? resolve() : model.close(() => resolve())))
    const off = await standIn({ p: 0.9 })
    // A chat that never switched it on asks nothing.
    const second = await host(off.baseUrl, { modeId: 'auto', decisionModel: { profileId: 'd3' } })
    await second.post({ type: 'sendMessage', text: 'Show me the files in this folder.' })
    await second.until((m) => m.type === 'done')
    expect(off.systemOne).toHaveLength(0)
    expect(lastUser(off.main[0])).toBe('Show me the files in this folder.')
  })

  it('Test decision model shows what was read from each answer', async () => {
    const { baseUrl } = await standIn({ p: 0.95 })
    const { post, until } = await host(baseUrl, { decisionModel: { profileId: 'd3' } })
    await post({ type: 'requestDecisionModel' })
    const panel = await until((m) => m.type === 'decisionModel')
    expect(panel['label']).toBe('D3')
    expect((panel['profiles'] as { id: string }[]).map((p) => p.id)).toEqual(['main', 'spec', 'd3'])
    await post({ type: 'testDecisionModel' })
    const result = await until((m) => m.type === 'decisionModelTest')
    const results = result['results'] as { ok: boolean; source: string; probabilities: Record<string, number> }[]
    expect(results.map((r) => r.ok)).toEqual([true, true])
    expect(results[0]?.source).toBe('systemone')
    expect(results[0]?.probabilities['yes']).toBeCloseTo(0.95, 5)
    // The stand-in gives the second option the probability, which in the sample question is the writer: what is read
    // is what was said.
    expect(results[1]?.probabilities['writer']).toBeCloseTo(0.95, 5)
  })
})
