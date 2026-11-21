import { describe, expect, it } from 'vitest'

import type { HttpClient, HttpResponse } from '../platform/http.js'
import type { ProviderProfile } from '../providers/types.js'
import type { ResolvedAgent } from '../agents/team.js'
import { afterConsult, type Strategy } from '../strategy/strategy.js'
import { decide, loopVerdict, readDecision, type DecisionQuestion } from './decide.js'
import { describeRoute, MAIN_OPTION, routedRole, routeQuestion } from './route.js'

/**
 * Asked for: D3 (vLLM Semantic Router's decision model) as an OpenAI-compatible profile powering Agent team mode, and
 * nothing of it without one. Its response format was not known, so every shape it could take is read here - and
 * nothing that carries no probability is taken as one.
 */

const CHOICE: DecisionQuestion = {
  kind: 'choice',
  question: 'Who should handle it?',
  options: [
    { id: MAIN_OPTION, label: 'The main assistant' },
    { id: 'tester', label: 'Tester' },
    { id: 'dba', label: 'Database expert' },
  ],
}
const YESNO: DecisionQuestion = { kind: 'yesno', question: 'Is it met?' }

const chat = (content: string, logprobs?: unknown, extra: Record<string, unknown> = {}): unknown => ({
  choices: [{ message: { role: 'assistant', content }, ...(logprobs !== undefined ? { logprobs } : {}) }],
  ...extra,
})

describe('reading the decision model', () => {
  it('reads token probabilities on the first answer token (vLLM / OpenAI logprobs)', () => {
    const body = chat('B', {
      content: [
        { token: 'B', logprob: Math.log(0.8), top_logprobs: [{ token: 'B', logprob: Math.log(0.8) }, { token: ' A', logprob: Math.log(0.15) }, { token: 'C', logprob: Math.log(0.04) }, { token: 'The', logprob: Math.log(0.01) }] },
      ],
    })
    const decision = readDecision(body, CHOICE, 5)
    expect(decision.ok).toBe(true)
    expect(decision.source).toBe('logprobs')
    expect(decision.best?.id).toBe('tester')
    expect(decision.probabilities?.['tester']).toBeCloseTo(0.8 / 0.99, 3)
    expect(decision.probabilities?.[MAIN_OPTION]).toBeCloseTo(0.15 / 0.99, 3)
  })

  it('reads the older logprobs shape, and Yes/No in any casing', () => {
    const body = { choices: [{ text: ' Yes', logprobs: { tokens: [' Yes'], top_logprobs: [{ ' Yes': Math.log(0.7), ' yes': Math.log(0.1), ' No': Math.log(0.2) }] } }] }
    const decision = readDecision(body, YESNO, 1)
    expect(decision.probabilities?.['yes']).toBeCloseTo(0.8, 5)
    expect(decision.probabilities?.['no']).toBeCloseTo(0.2, 5)
  })

  it('reads JSON scores in the reply, in the shapes a router may use', () => {
    expect(readDecision(chat('{"probabilities": {"A": 0.1, "B": 0.85, "C": 0.05}}'), CHOICE, 1).best).toEqual({ id: 'tester', probability: 0.85 })
    expect(readDecision(chat('```json\n{"scores": [{"label": "Database expert", "probability": 0.9}, {"label": "Tester", "probability": 0.1}]}\n```'), CHOICE, 1).best?.id).toBe('dba')
    expect(readDecision(chat('{"answer": "Yes", "confidence": 0.93}'), YESNO, 1).probabilities?.['yes']).toBeCloseTo(0.93, 5)
    expect(readDecision(chat('{"p_yes": 0.2, "p_no": 0.8}'), YESNO, 1).probabilities?.['no']).toBeCloseTo(0.8, 5)
    // Beside `choices`, as a router's own field.
    expect(readDecision(chat('B', undefined, { probabilities: { yes: '70%', no: '30%' } }), YESNO, 1).probabilities?.['yes']).toBeCloseTo(0.7, 5)
  })

  it('reads a score question as a number from 0 to 1', () => {
    const scored = readDecision(chat('{"score": 7}'), { kind: 'score', question: 'How well?' }, 1)
    expect(scored.score).toBeCloseTo(0.7, 5)
    const fromTokens = readDecision(chat('8', { content: [{ token: '8', logprob: Math.log(0.5), top_logprobs: [{ token: '8', logprob: Math.log(0.5) }, { token: '6', logprob: Math.log(0.5) }] }] }), { kind: 'score', question: 'How well?' }, 1)
    expect(fromTokens.score).toBeCloseTo(0.7, 5)
  })

  it('never takes a bare answer as a probability', () => {
    const decision = readDecision(chat('B'), CHOICE, 1)
    expect(decision.ok).toBe(false)
    expect(decision.error).toContain('without probabilities')
    expect(decision.best).toBeUndefined()
  })
})

let gateways = 0
/** A stand-in endpoint; each gets its own base URL, since what a base URL serves is remembered per URL. */
function fakeGateway(
  answer: (url: string, body: Record<string, unknown>, attempt: number) => { status: number; body: unknown },
  endpoint?: string,
) {
  const sent: { url: string; body: Record<string, unknown> }[] = []
  gateways += 1
  const http: HttpClient = {
    async request(url, options = {}) {
      const body = JSON.parse(String(options.body)) as Record<string, unknown>
      sent.push({ url, body })
      const reply = answer(url, body, sent.length)
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
      return { status: reply.status, headers: {}, text: async () => text, json: async <T>() => JSON.parse(text) as T, body: null } satisfies HttpResponse
    },
  }
  const profile = { id: 'd3', label: 'D3', wireFormat: 'openai', baseUrl: `https://router${String(gateways)}.test/v1`, model: 'vllm-sr/d3', auth: { type: 'none' } } as unknown as ProviderProfile
  return { sent, model: { profile, http, auth: { resolveHeaders: async () => ({}) }, ...(endpoint !== undefined ? { endpoint } : {}) } }
}

/** D3's answer shape, as its model card documents it. */
const structured = (answer: Record<string, unknown>): unknown => ({ object: 'structured_decision', model: 'vllm-sr/d3', answers: { q: answer }, usage: { input_tokens: 213, output_tokens: 0 } })
const questionOf = (body: Record<string, unknown> | undefined): { type: string; instructions: string; criteria?: unknown } =>
  (body?.['questions'] as { q: { type: string; instructions: string; criteria?: unknown } }).q

describe("D3's own decision API (/v1/systemone)", () => {
  it('asks a choice with readable option keys and their descriptions, and maps the answer back to our ids', async () => {
    const gateway = fakeGateway(() => ({
      status: 200,
      body: structured({ type: 'choice', choice: 'tester', probabilities: { the_main_assistant: 0.1, tester: 0.85, database_expert: 0.05 }, confidence: 0.85 }),
    }))
    const decision = await decide(gateway.model, { ...CHOICE, inputs: { text: 'write tests' } })
    expect(gateway.sent[0]?.url).toBe(`${gateway.model.profile.baseUrl}/systemone`)
    expect(gateway.sent[0]?.body).toMatchObject({ model: 'vllm-sr/d3', state: 'write tests' })
    expect(questionOf(gateway.sent[0]?.body)).toMatchObject({ type: 'choice', instructions: 'Who should handle it?' })
    expect(Object.keys(questionOf(gateway.sent[0]?.body).criteria as object)).toEqual(['the_main_assistant', 'tester', 'database_expert'])
    expect(decision).toMatchObject({ ok: true, source: 'systemone', best: { id: 'tester', probability: 0.85 } })
    expect(gateway.sent).toHaveLength(1)
  })

  it('asks yes/no as noul and reads its probability of yes', async () => {
    const gateway = fakeGateway(() => ({ status: 200, body: structured({ type: 'noul', noul: 0.5808, probabilities: { yes: 0.5808, no: 0.4192 }, confidence: 0.5808 }) }))
    const decision = await decide(gateway.model, YESNO)
    expect(questionOf(gateway.sent[0]?.body).type).toBe('noul')
    expect(decision.probabilities?.['yes']).toBeCloseTo(0.5808, 4)
    const onlyNoul = fakeGateway(() => ({ status: 200, body: structured({ type: 'noul', noul: 0.9 }) }))
    expect((await decide(onlyNoul.model, YESNO)).probabilities?.['yes']).toBeCloseTo(0.9, 5)
  })

  it('asks a score over named levels and gives the expected level from 0 to 1', async () => {
    const gateway = fakeGateway(() => ({ status: 200, body: structured({ type: 'score', probabilities: { 'not at all': 0, 'a little': 0, partly: 0.5, mostly: 0.5, completely: 0 } }) }))
    const decision = await decide(gateway.model, { kind: 'score', question: 'How complete?' })
    expect(questionOf(gateway.sent[0]?.body).criteria).toEqual(['not at all', 'a little', 'partly', 'mostly', 'completely'])
    expect(decision.score).toBeCloseTo(0.625, 5)
  })

  it('sends pictures as data URLs, and reads an answer a gateway wrapped under data', async () => {
    const gateway = fakeGateway(() => ({ status: 200, body: { data: structured({ type: 'noul', noul: 0.7 }) } }))
    const decision = await decide(gateway.model, { ...YESNO, inputs: { text: 'chart', images: [{ mediaType: 'image/png', data: 'AAAA' }] } })
    expect(gateway.sent[0]?.body['images']).toEqual(['data:image/png;base64,AAAA'])
    expect(decision.probabilities?.['yes']).toBeCloseTo(0.7, 5)
  })

  it('uses the endpoint path set for an office gateway, with no fallback, and never another host', async () => {
    const gateway = fakeGateway((url) => (url.endsWith('/d3/v1/systemone') ? { status: 200, body: structured({ type: 'noul', noul: 0.8 }) } : { status: 404, body: 'no' }), '/d3/v1/systemone')
    expect((await decide(gateway.model, YESNO)).ok).toBe(true)
    expect(gateway.sent[0]?.url).toBe(`${gateway.model.profile.baseUrl}/d3/v1/systemone`)
    const wrong = fakeGateway(() => ({ status: 404, body: 'no such path' }), '/wrong/systemone')
    expect((await decide(wrong.model, YESNO)).error).toContain('HTTP 404')
    expect(wrong.sent).toHaveLength(1)
    const outside = fakeGateway(() => ({ status: 200, body: {} }), 'https://elsewhere.test/systemone')
    expect((await decide(outside.model, YESNO)).error).toContain('starting with /')
    expect(outside.sent).toHaveLength(0)
  })
})

describe('a decision model behind chat completions (when /systemone is not there)', () => {
  it('falls back once on 404, remembers it, and asks for token probabilities (again without them if refused)', async () => {
    const gateway = fakeGateway((url, body) =>
      url.endsWith('/systemone')
        ? { status: 404, body: 'not found' }
        : body['logprobs'] === true
          ? { status: 400, body: { error: 'logprobs is not supported' } }
          : { status: 200, body: chat('{"yes": 0.9, "no": 0.1}') },
    )
    const decision = await decide(gateway.model, YESNO)
    expect(decision).toMatchObject({ ok: true, source: 'json' })
    expect(gateway.sent.map((s) => s.url.split('/').at(-1))).toEqual(['systemone', 'completions', 'completions'])
    expect(gateway.sent[1]?.body['logprobs']).toBe(true)
    expect(gateway.sent[2]?.body['logprobs']).toBeUndefined()
    await decide(gateway.model, YESNO)
    expect(gateway.sent.slice(3).map((s) => s.url.split('/').at(-1))).toEqual(['completions'])
  })

  it('"chat" asks chat completions only, lettering the options', async () => {
    const gateway = fakeGateway(() => ({ status: 200, body: chat('{"answer": "B", "confidence": 0.9}') }), 'chat')
    const decision = await decide(gateway.model, CHOICE)
    expect(decision.best?.id).toBe('tester')
    expect(gateway.sent[0]?.url.endsWith('/chat/completions')).toBe(true)
    const user = (gateway.sent[0]?.body['messages'] as { content: string }[])[1]?.content ?? ''
    expect(user).toContain('A. The main assistant')
    expect(user).toContain('Answer with the letter')
  })

  it('reports a failure instead of throwing', async () => {
    const gateway = fakeGateway(() => ({ status: 503, body: 'down' }))
    const decision = await decide(gateway.model, YESNO)
    expect(decision.ok).toBe(false)
    expect(decision.error).toContain('HTTP 503')
  })
})

const team = [
  { role: 'tester', name: 'Tester', summary: 'writes and runs tests', available: true },
  { role: 'gone', name: 'Gone', summary: 'profile deleted', available: false },
] as unknown as ResolvedAgent[]

describe('routing in Agent team mode', () => {
  it('offers the main assistant and every specialist that can answer', () => {
    const question = routeQuestion('write tests for the parser', team, [])
    expect(question.options?.map((option) => option.id)).toEqual([MAIN_OPTION, 'tester'])
  })

  it('sends to a specialist only at or above the threshold, and never when the main assistant wins', () => {
    const decision = (id: string, probability: number) => ({ ok: true, best: { id, probability }, source: 'logprobs' as const, raw: '', ms: 1 })
    expect(routedRole(decision('tester', 0.8), 0.75)).toEqual({ role: 'tester', probability: 0.8 })
    expect(routedRole(decision('tester', 0.7), 0.75)).toBeUndefined()
    expect(routedRole(decision(MAIN_OPTION, 0.99), 0.75)).toBeUndefined()
    expect(routedRole({ ok: false, source: 'none', raw: '', ms: 1 }, 0.75)).toBeUndefined()
    expect(describeRoute('tester', 'Tester', 0.8)).toContain('ask_agent')
  })
})

describe('strategy loops judged by the decision model', () => {
  const strategy: Strategy = {
    id: 's',
    name: 'build and test',
    nodes: [
      { id: 'n1', role: 'programmer', x: 0, y: 0 },
      { id: 'n2', role: 'tester', x: 1, y: 0 },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', twoWay: true, until: 'all tests pass', maxRounds: 3 }],
  } as unknown as Strategy
  const name = (role: string): string => role

  it('decides yes, no, or leaves it to the judge in between', () => {
    const yes = (p: number) => ({ ok: true, probabilities: { yes: p, no: 1 - p }, source: 'logprobs' as const, raw: '', ms: 1 })
    expect(loopVerdict(yes(0.9), 0.8)?.met).toBe(true)
    expect(loopVerdict(yes(0.1), 0.8)?.met).toBe(false)
    expect(loopVerdict(yes(0.5), 0.8)).toBeUndefined()
  })

  it('a verdict from the decision model wins over the judge wording; without one the wording decides as before', () => {
    const working = afterConsult(strategy, {}, 'programmer', 'done', name).progress
    const judged = afterConsult(strategy, working, 'tester', 'CONDITION: NOT MET - two fail', name, new Map([['e1', { met: true, detail: 'decision model 0.93' }]]))
    expect(judged.progress['e1']?.met).toBe(true)
    expect(judged.note).toContain('the decision model says the condition is met (decision model 0.93)')
    const worded = afterConsult(strategy, working, 'tester', 'CONDITION: NOT MET - two fail', name)
    expect(worded.progress['e1']?.met).toBe(false)
  })
})
