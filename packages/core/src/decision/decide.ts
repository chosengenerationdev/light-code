import type { HttpClient } from '../platform/http.js'
import type { AuthStrategy, ProviderProfile } from '../providers/types.js'

/**
 * Asking a decision model a narrow question and reading back calibrated probabilities.
 *
 * Asked for: D3 (vLLM Semantic Router's decision model - text, JSON and images in; probabilities for Choice, Yes/No
 * and Score questions out), set up as an ordinary OpenAI-compatible provider profile, powering Agent team mode, and
 * present only when one is set up.
 *
 * **D3's own API comes first** (vllm-sr/d3 model card and the vLLM recipe, read 2026-11-20): `POST /v1/systemone`
 * with `{ model, state, questions: { <id>: { type: 'choice' | 'noul' | 'score', instructions, criteria } }, images }`,
 * answered by `{ object: 'structured_decision', answers: { <id>: { type, choice | noul, probabilities, confidence } } }`
 * - a probability for every option from its own forward pass, no text generated. D3 does not serve chat completions.
 * `noul` is its yes/no (`noul` = probability of yes); a choice's `criteria` maps option keys to descriptions; a
 * score's `criteria` is its list of level labels (2 to 10).
 *
 * Only when that path answers 404 or 405 (another kind of decision model behind an OpenAI-compatible gateway) is the
 * question asked as a chat completion, remembered per base URL, and its answer read in the two ways such a deployment
 * can give one, never guessed beyond them:
 * - **JSON in the reply** (or beside `choices` in the body): `{"probabilities": {...}}`, a list of
 *   `{label, probability}`, `{"answer": "B", "confidence": 0.9}`, `{"yes": 0.8, "no": 0.2}`, `{"score": 0.7}`.
 * - **Token log-probabilities** on the first answer token (`logprobs: true, top_logprobs: 20` is asked for): the
 *   probability mass on each option's letter, `Yes`/`No`, or the digits of a 0-10 score.
 *
 * A reply with neither is `ok: false` - a bare "B" says which option, not how sure, and a threshold over a number
 * nobody produced would be a decision presented as calibrated that is not. Settings → Agents → Test decision model
 * shows the raw reply and what was read from it, so the first real call at the office settles which path applies.
 */

export type DecisionKind = 'choice' | 'yesno' | 'score'

export interface DecisionOption {
  id: string
  label: string
  description?: string | undefined
}

export interface DecisionQuestion {
  kind: DecisionKind
  question: string
  /** For `choice`; at most 26 (lettered A-Z). Ignored for yes/no and score. */
  options?: readonly DecisionOption[] | undefined
  /** What the decision is about: text, structured data, pictures. */
  inputs?: {
    text?: string | undefined
    json?: unknown
    images?: readonly { mediaType: string; data: string }[] | undefined
  }
}

export interface Decision {
  /** Probabilities were read. False: `error` says why, and the caller falls back to what it did before. */
  ok: boolean
  /** By option id (`yes`/`no` for a yes/no question), summing to 1. */
  probabilities?: Record<string, number>
  best?: { id: string; probability: number }
  /** A score question's answer, 0 to 1. */
  score?: number
  source: 'systemone' | 'json' | 'logprobs' | 'none'
  /** The first 2,000 characters of what the model returned, for the Test button and the audit record. */
  raw: string
  error?: string
  ms: number
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Gateways that refused `logprobs`, by base URL: asked without it from then on. */
const NO_LOGPROBS = new Set<string>()

/** The options a question is answered over, by id: lettered choices, yes/no, or the eleven score digits. */
function answerOptions(question: DecisionQuestion): DecisionOption[] {
  if (question.kind === 'yesno') return [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]
  if (question.kind === 'score') return Array.from({ length: 11 }, (_, i) => ({ id: String(i), label: String(i) }))
  return (question.options ?? []).slice(0, LETTERS.length)
}

export function decisionMessages(question: DecisionQuestion): { role: string; content: unknown }[] {
  const options = answerOptions(question)
  const lines: string[] = [question.question.trim()]
  if (question.kind === 'choice') {
    lines.push('', 'Options:')
    options.forEach((option, i) => lines.push(`${LETTERS[i] ?? '?'}. ${option.label}${option.description !== undefined && option.description.length > 0 ? ` - ${option.description}` : ''}`))
    lines.push('', 'Answer with the letter of the best option only.')
  } else if (question.kind === 'yesno') {
    lines.push('', 'Answer Yes or No only.')
  } else {
    lines.push('', 'Answer with a whole number from 0 (not at all) to 10 (completely) only.')
  }
  const inputs = question.inputs ?? {}
  const context: string[] = []
  if (inputs.text !== undefined && inputs.text.trim().length > 0) context.push(`Input:\n${inputs.text.slice(0, 24_000)}`)
  if (inputs.json !== undefined) context.push(`Data:\n${JSON.stringify(inputs.json).slice(0, 24_000)}`)
  const text = `${context.length > 0 ? `${context.join('\n\n')}\n\n` : ''}${lines.join('\n')}`
  const images = inputs.images ?? []
  const content =
    images.length === 0
      ? text
      : [{ type: 'text', text }, ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } }))]
  return [
    { role: 'system', content: 'You are a decision model. Answer the question about the input exactly in the form asked for.' },
    { role: 'user', content },
  ]
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*%?\s*$/.test(value) ? Number.parseFloat(value) / (value.includes('%') ? 100 : 1) : undefined)

/** Which option a label names: its letter, its id, its label, or (yes/no) any casing of yes/no/true/false. */
function optionFor(label: string, options: readonly DecisionOption[], kind: DecisionKind): string | undefined {
  const clean = label.trim().replace(/^[("'\s]+|[)"'.:,\s]+$/g, '').toLowerCase()
  if (clean.length === 0) return undefined
  if (kind === 'yesno') {
    if (['yes', 'y', 'true', '1'].includes(clean)) return 'yes'
    if (['no', 'n', 'false', '0'].includes(clean)) return 'no'
    return undefined
  }
  if (kind === 'score') return /^(10|\d)$/.test(clean) ? clean : undefined
  const letter = clean.length === 1 ? LETTERS.indexOf(clean.toUpperCase()) : -1
  if (letter >= 0 && letter < options.length) return options[letter]?.id
  return options.find((option) => option.id.toLowerCase() === clean || option.label.toLowerCase() === clean)?.id
}

function normalise(weights: Map<string, number>): Record<string, number> | undefined {
  let total = 0
  for (const weight of weights.values()) total += Math.max(0, weight)
  if (total <= 0) return undefined
  const out: Record<string, number> = {}
  for (const [id, weight] of weights) out[id] = Math.max(0, weight) / total
  return out
}

/** The first JSON object in a reply, fenced or not. */
function jsonIn(text: string): Record<string, unknown> | undefined {
  const unfenced = text.replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Probabilities from a JSON answer in any of the shapes listed at the top; undefined when it holds none. */
export function probabilitiesFromJson(
  json: Record<string, unknown>,
  question: DecisionQuestion,
): { probabilities?: Record<string, number>; score?: number } | undefined {
  const options = answerOptions(question)
  const weights = new Map<string, number>()
  const add = (label: string, value: unknown): void => {
    const id = optionFor(label, options, question.kind)
    const p = num(value)
    if (id !== undefined && p !== undefined) weights.set(id, (weights.get(id) ?? 0) + p)
  }
  if (question.kind === 'score') {
    for (const key of ['score', 'value', 'probability', 'p']) {
      const value = num(json[key])
      if (value !== undefined) return { score: value > 10 ? Math.min(1, value / 100) : value > 1 ? value / 10 : Math.max(0, value) }
    }
  }
  for (const key of ['probabilities', 'probs', 'scores', 'distribution', 'choices', 'options']) {
    const value = json[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== 'object' || item === null) continue
        const record = item as Record<string, unknown>
        const label = [record['label'], record['option'], record['choice'], record['answer'], record['id'], record['name']].find((v) => typeof v === 'string') as string | undefined
        const p = [record['probability'], record['prob'], record['p'], record['score'], record['confidence']].find((v) => num(v) !== undefined)
        if (label !== undefined) add(label, p)
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [label, p] of Object.entries(value as Record<string, unknown>)) add(label, p)
    }
  }
  if (weights.size === 0 && question.kind === 'yesno') {
    for (const [key, value] of Object.entries(json)) {
      const k = key.toLowerCase().replace(/^p_?/, '')
      if (k === 'yes' || k === 'no') add(k, value)
    }
  }
  if (weights.size === 0) {
    const label = [json['answer'], json['choice'], json['decision'], json['label'], json['prediction']].find((v) => typeof v === 'string') as string | undefined
    const p = num([json['probability'], json['confidence'], json['p'], json['score']].find((v) => num(v) !== undefined))
    if (label !== undefined && p !== undefined) {
      const id = optionFor(label, options, question.kind)
      if (id !== undefined) {
        const p1 = Math.min(1, Math.max(0, p))
        weights.set(id, p1)
        // The rest spread over the other options, so `best` still holds only when it is clearly ahead.
        const others = options.filter((option) => option.id !== id)
        for (const other of others) weights.set(other.id, (1 - p1) / Math.max(1, others.length))
      }
    }
  }
  const probabilities = normalise(weights)
  if (probabilities === undefined) return undefined
  if (question.kind === 'score') return { probabilities, score: expectedScore(probabilities) }
  return { probabilities }
}

function expectedScore(probabilities: Record<string, number>): number {
  let sum = 0
  for (const [digit, p] of Object.entries(probabilities)) sum += Number(digit) * p
  return sum / 10
}

/**
 * Probabilities from token log-probabilities: the first token that is not blank or punctuation, and the mass of its
 * alternatives on each option. Both shapes vLLM and OpenAI use (`logprobs.content[i].top_logprobs` lists, and the
 * older `logprobs.top_logprobs[i]` maps).
 */
export function probabilitiesFromLogprobs(choice: Record<string, unknown>, question: DecisionQuestion): { probabilities?: Record<string, number>; score?: number } | undefined {
  const logprobs = choice['logprobs']
  if (typeof logprobs !== 'object' || logprobs === null) return undefined
  const options = answerOptions(question)
  const positions: { token: string; alternatives: { token: string; logprob: number }[] }[] = []
  const content = (logprobs as { content?: unknown }).content
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as { token?: unknown; logprob?: unknown; top_logprobs?: unknown }
      const alternatives = Array.isArray(record.top_logprobs)
        ? record.top_logprobs
            .filter((alt): alt is { token: string; logprob: number } => typeof alt === 'object' && alt !== null && typeof (alt as { token?: unknown }).token === 'string' && typeof (alt as { logprob?: unknown }).logprob === 'number')
        : []
      if (typeof record.token === 'string') positions.push({ token: record.token, alternatives: alternatives.length > 0 ? alternatives : typeof record.logprob === 'number' ? [{ token: record.token, logprob: record.logprob }] : [] })
    }
  } else {
    const tokens = (logprobs as { tokens?: unknown }).tokens
    const tops = (logprobs as { top_logprobs?: unknown }).top_logprobs
    if (Array.isArray(tokens) && Array.isArray(tops)) {
      tokens.forEach((token, i) => {
        const top = tops[i]
        if (typeof token !== 'string' || typeof top !== 'object' || top === null) return
        positions.push({ token, alternatives: Object.entries(top as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number').map(([t, l]) => ({ token: t, logprob: l })) })
      })
    }
  }
  const first = positions.find((position) => /[A-Za-z0-9]/.test(position.token))
  if (first === undefined) return undefined
  const weights = new Map<string, number>()
  for (const alternative of first.alternatives) {
    const id = optionFor(alternative.token, options, question.kind)
    if (id !== undefined) weights.set(id, (weights.get(id) ?? 0) + Math.exp(alternative.logprob))
  }
  // "10" is often two tokens: "1" then "0". Mass on "1" followed by "0" is a ten, not a one.
  if (question.kind === 'score' && first.token.trim() === '1') {
    const next = positions[positions.indexOf(first) + 1]
    if (next !== undefined && next.token.trim() === '0' && weights.has('1')) {
      weights.set('10', (weights.get('10') ?? 0) + (weights.get('1') ?? 0))
      weights.delete('1')
    }
  }
  const probabilities = normalise(weights)
  if (probabilities === undefined) return undefined
  return question.kind === 'score' ? { probabilities, score: expectedScore(probabilities) } : { probabilities }
}

/** Reads a whole response body (already parsed) into a decision. Exported for the tests and the Test button. */
export function readDecision(body: unknown, question: DecisionQuestion, ms: number): Decision {
  const raw = JSON.stringify(body).slice(0, 2000)
  if (typeof body !== 'object' || body === null) return { ok: false, source: 'none', raw, error: 'The decision model returned no JSON body.', ms }
  const record = body as Record<string, unknown>
  const choice = Array.isArray(record['choices']) ? (record['choices'][0] as Record<string, unknown> | undefined) : undefined
  const message = choice?.['message'] as { content?: unknown } | undefined
  const text = typeof message?.content === 'string' ? message.content : typeof choice?.['text'] === 'string' ? (choice['text'] as string) : ''
  const finish = (found: { probabilities?: Record<string, number>; score?: number }, source: 'json' | 'logprobs'): Decision => {
    const probabilities = found.probabilities
    let best: Decision['best']
    if (probabilities !== undefined && question.kind !== 'score') {
      for (const [id, probability] of Object.entries(probabilities)) if (best === undefined || probability > best.probability) best = { id, probability }
    }
    return { ok: true, ...(probabilities !== undefined ? { probabilities } : {}), ...(best !== undefined ? { best } : {}), ...(found.score !== undefined ? { score: found.score } : {}), source, raw, ms }
  }
  // Beside `choices` (a router's own fields), then in the reply's text, then the token probabilities.
  const top = probabilitiesFromJson(record, question)
  if (top !== undefined) return finish(top, 'json')
  const inReply = jsonIn(text)
  const fromReply = inReply === undefined ? undefined : probabilitiesFromJson(inReply, question)
  if (fromReply !== undefined) return finish(fromReply, 'json')
  const fromTokens = choice === undefined ? undefined : probabilitiesFromLogprobs(choice, question)
  if (fromTokens !== undefined) return finish(fromTokens, 'logprobs')
  return {
    ok: false,
    source: 'none',
    raw,
    error: `The decision model answered${text.trim().length > 0 ? ` "${text.trim().slice(0, 80)}"` : ''} without probabilities: neither JSON scores nor token log-probabilities came back.`,
    ms,
  }
}

export interface DecisionModel {
  profile: ProviderProfile
  http: HttpClient
  auth: AuthStrategy
  /**
   * Where it is asked, on the profile's base URL (config `decisionModel.endpoint`): undefined is automatic - D3's
   * `/systemone`, then chat completions if that is not there; a path (`/d3/v1/systemone`) is D3's API at that path,
   * with no fallback; `chat` is chat completions only. An office gateway may put D3 at a path of its own.
   */
  endpoint?: string | undefined
}

/** Why an endpoint setting cannot be used, or undefined. A path on the profile's base URL, never another host. */
export function decisionEndpointProblem(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined || endpoint === '' || endpoint === 'chat') return undefined
  if (!endpoint.startsWith('/')) return 'The endpoint is a path on the base URL of the provider, starting with /, or "chat".'
  if (/:\/\/|\.\.|\s|\\|#|\?/.test(endpoint)) return 'The endpoint path may not hold "://", "..", spaces, a backslash, "?" or "#".'
  return undefined
}

/** A score question's levels, lowest first: D3 takes 2 to 10 named levels and answers a probability for each. */
export const SCORE_LEVELS = ['not at all', 'a little', 'partly', 'mostly', 'completely'] as const

/** Option keys D3 is given: readable (they are part of what it reads), unique, and mapped back to our ids. */
function optionKeys(options: readonly DecisionOption[]): Map<string, string> {
  const keys = new Map<string, string>()
  for (const option of options) {
    const base = option.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'option'
    let key = base
    for (let n = 2; keys.has(key); n += 1) key = `${base}_${String(n)}`
    keys.set(key, option.id)
  }
  return keys
}

/** The `/v1/systemone` request for one question, and how its option keys map back. */
export function systemOneRequest(model: string, question: DecisionQuestion): { body: Record<string, unknown>; keys: Map<string, string> } {
  const inputs = question.inputs ?? {}
  const state = [inputs.text !== undefined && inputs.text.trim().length > 0 ? inputs.text.slice(0, 24_000) : '', inputs.json !== undefined ? JSON.stringify(inputs.json).slice(0, 24_000) : '']
    .filter((part) => part.length > 0)
    .join('\n\n')
  let keys = new Map<string, string>()
  let asked: Record<string, unknown>
  if (question.kind === 'choice') {
    const options = (question.options ?? []).slice(0, 255)
    keys = optionKeys(options)
    const criteria: Record<string, string> = {}
    for (const [key, id] of keys) {
      const option = options.find((o) => o.id === id)
      criteria[key] = option === undefined ? key : `${option.label}${option.description !== undefined && option.description.length > 0 ? ` - ${option.description}` : ''}`
    }
    asked = { type: 'choice', instructions: question.question, criteria }
  } else if (question.kind === 'yesno') {
    asked = { type: 'noul', instructions: question.question }
  } else {
    asked = { type: 'score', instructions: question.question, criteria: [...SCORE_LEVELS] }
  }
  const images = (inputs.images ?? []).map((image) => `data:${image.mediaType};base64,${image.data}`)
  return {
    body: { model, state: state.length > 0 ? state : '(no input)', questions: { q: asked }, ...(images.length > 0 ? { images } : {}) },
    keys,
  }
}

/** A `structured_decision` read into a decision; undefined when the body is not one. */
export function readSystemOne(body: unknown, question: DecisionQuestion, keys: ReadonlyMap<string, string>, ms: number): Decision | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  // As D3 answers, or wrapped by a gateway under `data` or `result`.
  const record = body as Record<string, unknown>
  const wrapped = [record, record['data'], record['result']].find((candidate) => typeof candidate === 'object' && candidate !== null && typeof (candidate as { answers?: unknown }).answers === 'object')
  const answers = (wrapped as { answers?: unknown } | undefined)?.answers
  if (typeof answers !== 'object' || answers === null) return undefined
  const answer = ((answers as Record<string, unknown>)['q'] ?? Object.values(answers as Record<string, unknown>)[0]) as Record<string, unknown> | undefined
  if (answer === undefined || typeof answer !== 'object') return undefined
  const raw = JSON.stringify(body).slice(0, 2000)
  const given = typeof answer['probabilities'] === 'object' && answer['probabilities'] !== null ? (answer['probabilities'] as Record<string, unknown>) : {}
  const weights = new Map<string, number>()
  for (const [key, value] of Object.entries(given)) {
    const p = num(value)
    if (p === undefined) continue
    if (question.kind === 'choice') {
      const id = keys.get(key)
      if (id !== undefined) weights.set(id, p)
    } else if (question.kind === 'yesno') {
      const k = key.toLowerCase()
      if (k === 'yes' || k === 'no') weights.set(k, p)
    } else {
      weights.set(key, p)
    }
  }
  // A yes/no with only `noul` (the probability of yes).
  if (question.kind === 'yesno' && weights.size === 0) {
    const yes = num(answer['noul'])
    if (yes !== undefined) {
      weights.set('yes', yes)
      weights.set('no', 1 - yes)
    }
  }
  const probabilities = normalise(weights)
  if (probabilities === undefined) return { ok: false, source: 'systemone', raw, error: 'The decision model answered without probabilities for this question.', ms }
  if (question.kind === 'score') {
    // The expected level, 0 (the first) to 1 (the last); levels it did not name are ignored.
    let sum = 0
    let mass = 0
    for (const [level, p] of Object.entries(probabilities)) {
      const index = SCORE_LEVELS.indexOf(level as (typeof SCORE_LEVELS)[number])
      if (index < 0) continue
      sum += (index / (SCORE_LEVELS.length - 1)) * p
      mass += p
    }
    if (mass === 0) return { ok: false, source: 'systemone', raw, error: 'The decision model answered with levels it was not given.', ms }
    return { ok: true, probabilities, score: sum / mass, source: 'systemone', raw, ms }
  }
  let best: Decision['best']
  for (const [id, probability] of Object.entries(probabilities)) if (best === undefined || probability > best.probability) best = { id, probability }
  return { ok: true, probabilities, ...(best !== undefined ? { best } : {}), source: 'systemone', raw, ms }
}

/** Base URLs whose `/systemone` answered 404 or 405: asked as chat completions from then on. */
const CHAT_ONLY = new Set<string>()

/** One question to the decision model. Never throws: a failure is `ok: false` with the reason. */
export async function decide(model: DecisionModel, question: DecisionQuestion, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Decision> {
  const started = Date.now()
  const base = model.profile.baseUrl.replace(/\/+$/, '')
  const url = `${base}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort)
  const body: Record<string, unknown> = {
    model: model.profile.model,
    messages: decisionMessages(question),
    stream: false,
    temperature: 0,
    max_tokens: 32,
  }
  if (!NO_LOGPROBS.has(base)) {
    body['logprobs'] = true
    body['top_logprobs'] = 20
  }
  const send = async (): Promise<{ status: number; text: string }> => {
    const headers = await model.auth.resolveHeaders()
    const tls = await model.auth.tls?.()
    const response = await model.http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers, ...model.profile.headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      ...(tls !== undefined ? { tls } : {}),
    })
    return { status: response.status, text: await response.text() }
  }
  const post = async (target: string, payload: Record<string, unknown>): Promise<{ status: number; text: string }> => {
    let answer = await sendTo(target, payload)
    if (answer.status === 401 && model.auth.onUnauthorized !== undefined && (await model.auth.onUnauthorized())) answer = await sendTo(target, payload)
    return answer
  }
  const sendTo = async (target: string, payload: Record<string, unknown>): Promise<{ status: number; text: string }> => {
    const headers = await model.auth.resolveHeaders()
    const tls = await model.auth.tls?.()
    const response = await model.http.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers, ...model.profile.headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
      ...(tls !== undefined ? { tls } : {}),
    })
    return { status: response.status, text: await response.text() }
  }
  try {
    // D3's own API.
    const endpoint = model.endpoint === undefined || model.endpoint.trim() === '' ? undefined : model.endpoint.trim()
    const problem = decisionEndpointProblem(endpoint)
    if (problem !== undefined) return { ok: false, source: 'none', raw: '', error: problem, ms: Date.now() - started }
    if (endpoint !== 'chat' && (endpoint !== undefined || !CHAT_ONLY.has(base))) {
      const target = `${base}${endpoint ?? '/systemone'}`
      const request = systemOneRequest(model.profile.model, question)
      const answer = await post(target, request.body)
      // Automatic only: a deployment without D3's API is asked as chat completions from then on. A path that was set
      // is the one the user said - its 404 is reported, not worked around.
      if ((answer.status === 404 || answer.status === 405) && endpoint === undefined) {
        CHAT_ONLY.add(base)
      } else if (answer.status >= 400) {
        return { ok: false, source: 'none', raw: answer.text.slice(0, 2000), error: `The decision model at ${target} answered HTTP ${String(answer.status)}.`, ms: Date.now() - started }
      } else {
        let parsed: unknown
        try {
          parsed = JSON.parse(answer.text)
        } catch {
          return { ok: false, source: 'none', raw: answer.text.slice(0, 2000), error: 'The decision model did not answer with JSON.', ms: Date.now() - started }
        }
        return (
          readSystemOne(parsed, question, request.keys, Date.now() - started) ?? {
            ok: false,
            source: 'none',
            raw: answer.text.slice(0, 2000),
            error: `${target} answered, but not with a structured_decision.`,
            ms: Date.now() - started,
          }
        )
      }
    }
    let answer = await send()
    if (answer.status >= 400 && answer.status < 500 && answer.status !== 401 && body['logprobs'] !== undefined && /logprob/i.test(answer.text)) {
      NO_LOGPROBS.add(base)
      delete body['logprobs']
      delete body['top_logprobs']
      answer = await send()
    }
    if (answer.status === 401 && model.auth.onUnauthorized !== undefined && (await model.auth.onUnauthorized())) answer = await send()
    if (answer.status >= 400) {
      return { ok: false, source: 'none', raw: answer.text.slice(0, 2000), error: `The decision model at ${url} answered HTTP ${String(answer.status)}.`, ms: Date.now() - started }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(answer.text)
    } catch {
      return { ok: false, source: 'none', raw: answer.text.slice(0, 2000), error: 'The decision model did not answer with JSON.', ms: Date.now() - started }
    }
    return readDecision(parsed, question, Date.now() - started)
  } catch (error) {
    const reason = controller.signal.aborted && options.signal?.aborted !== true ? 'it did not answer in time' : error instanceof Error ? error.message : String(error)
    return { ok: false, source: 'none', raw: '', error: `Could not ask the decision model: ${reason}.`, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** Defaults for the thresholds; the user sets their own in Settings → Agents. */
export const DEFAULT_ROUTE_THRESHOLD = 0.75
export const DEFAULT_LOOP_THRESHOLD = 0.8

/**
 * A loop's verdict from a yes/no decision: met at or above the threshold, not met at or below its mirror, and no
 * verdict in between - the judge's own wording decides then, as it did before.
 */
export function loopVerdict(decision: Decision, threshold: number): { met: boolean; detail: string } | undefined {
  const yes = decision.probabilities?.['yes']
  if (!decision.ok || yes === undefined) return undefined
  if (yes >= threshold) return { met: true, detail: `decision model ${yes.toFixed(2)}` }
  if (yes <= 1 - threshold) return { met: false, detail: `decision model ${yes.toFixed(2)} that it is met` }
  return undefined
}
