import type { WebChatResponseSpec } from './setup.js'

/**
 * Where a chat's answer is inside its response, found once from the captured reply and then read the same way every
 * time. Plain code, no model: the longest text in the reply (a JSON document), or the text the events add up to
 * (server-sent events), is the answer - and the user sees what was read before confirming the capture.
 */

type Path = (string | number)[]

function leaves(value: unknown, path: Path, out: { path: Path; text: string }[]): void {
  if (typeof value === 'string') {
    out.push({ path, text: value })
    return
  }
  if (Array.isArray(value)) value.forEach((item, index) => leaves(item, [...path, index], out))
  else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) leaves(item, [...path, key], out)
}

const keyOf = (path: Path): string => JSON.stringify(path)

function at(value: unknown, path: Path): unknown {
  let current = value
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string | number, unknown>)[part]
  }
  return current
}

/** The JSON documents in a server-sent-events body; undefined when the body is not one. */
export function sseEvents(text: string): unknown[] | undefined {
  const lines = text.split(/\r?\n/)
  const data = lines.filter((line) => line.startsWith('data:'))
  if (data.length === 0) return undefined
  const events: unknown[] = []
  for (const line of data) {
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    try {
      events.push(JSON.parse(payload))
    } catch {
      // A data line that is not JSON (a keep-alive, a plain word): skipped.
    }
  }
  return events
}

/** Text with no whitespace and only name-like characters: an event type, a status, an id - not prose. */
const nameLike = (text: string): boolean => /^[A-Za-z0-9_.:/#@+-]*$/.test(text)

/**
 * A field that labels the events rather than carrying the answer: present in (nearly) every event, with name-like values
 * that differ between events - `type` in `{"type":"chat_id"} {"type":"progress"} ... {"type":"finish"}`. Joined, those
 * values are a long string with no spaces, which "the longest text" once took for the answer (reported from real use).
 */
function labelsEvents(values: string[], eventCount: number): boolean {
  if (values.length < 2 || values.length < eventCount * 0.8) return false
  return values.every(nameLike) && new Set(values).size > 1
}

/**
 * The values of one field across the events, as one text: the last when each extends the one before (cumulative), the
 * last when it repeats everything before it (deltas followed by the whole answer), otherwise all of them joined (deltas).
 */
function combine(values: string[], mode: 'delta' | 'cumulative'): string {
  if (mode === 'cumulative') return values.at(-1) ?? ''
  if (values.length > 1) {
    const before = values.slice(0, -1).join('')
    const last = values.at(-1) ?? ''
    if (before.trim().length > 0 && last.trim() === before.trim()) return last
  }
  return values.join('')
}

function sseFields(events: unknown[]): { path: Path; values: string[] }[] {
  const byPath = new Map<string, { path: Path; values: string[] }>()
  for (const event of events) {
    const found: { path: Path; text: string }[] = []
    leaves(event, [], found)
    for (const leaf of found) {
      const entry = byPath.get(keyOf(leaf.path)) ?? { path: leaf.path, values: [] }
      entry.values.push(leaf.text)
      byPath.set(keyOf(leaf.path), entry)
    }
  }
  return [...byPath.values()]
}

const isProse = (text: string): boolean => /\s/.test(text.trim())

/**
 * How much a text looks like an answer: prose (2) over a plain word (1) over an id (0) - a value mixing letters and
 * digits with no space (`7c1e9a2b`, a UUID), or any value of a field named like one (`chat_id`, `id`). A one-word
 * answer ("ready") must not lose to the chat's id just because the id is longer.
 */
function answerRank(text: string, path: Path): number {
  const key = String(path.filter((part) => typeof part === 'string').at(-1) ?? '')
  if (/(^|_|-)id$|Id$|^uuid$/i.test(key)) return 0
  if (isProse(text)) return 2
  if (/\d/.test(text) && /^[A-Za-z0-9_-]+$/.test(text.trim())) return 0
  return 1
}

/**
 * The best answer among the events' fields. Prose (text with a space in it) beats name-like text, then longer beats
 * shorter; a field that labels the events is never the answer.
 */
function bestSse(events: unknown[], accept: (text: string) => boolean): { spec: WebChatResponseSpec; answer: string } | undefined {
  let best: { spec: WebChatResponseSpec; answer: string; rank: number } | undefined
  for (const entry of sseFields(events)) {
    if (labelsEvents(entry.values, events.length)) continue
    const cumulative = entry.values.length > 1 && entry.values.every((value, i) => i === 0 || value.startsWith(entry.values[i - 1] ?? ''))
    const mode = cumulative ? 'cumulative' : 'delta'
    const answer = combine(entry.values, mode)
    if (!accept(answer)) continue
    const rank = answerRank(answer, entry.path)
    if (best === undefined || rank > best.rank || (rank === best.rank && answer.length > best.answer.length)) {
      best = { spec: { kind: 'sse', path: entry.path, mode }, answer, rank }
    }
  }
  return best === undefined ? undefined : { spec: best.spec, answer: best.answer }
}

/** Finds how the answer is carried in a captured reply. `exclude`: text that is not the answer (the question sent). */
export function findAnswer(responseText: string, contentType: string | undefined, exclude: string): { spec: WebChatResponseSpec; answer: string } | undefined {
  /*
   * Not the question sent: text that is the phrase and nothing more (the request echoed back). A reply that *mentions*
   * the phrase is still the reply - models usually do ("I'm not sure what light-code-capture-… means"), and skipping
   * it read the reply's id as the answer, found against the real chrome-devtools-mcp.
   */
  const notQuestion = (text: string): boolean => text.trim().length > 0 && text.split(exclude).join('').replace(/[\s"'`.,:;!?()[\]{}-]/g, '').length >= 3
  const events = (contentType ?? '').includes('event-stream') || /^data:/m.test(responseText) ? sseEvents(responseText) : undefined
  if (events !== undefined && events.length > 0) return bestSse(events, notQuestion)
  try {
    const document = JSON.parse(responseText) as unknown
    const found: { path: Path; text: string }[] = []
    leaves(document, [], found)
    const best = found
      .filter((leaf) => notQuestion(leaf.text))
      .sort((a, b) => answerRank(b.text, b.path) - answerRank(a.text, a.path) || b.text.length - a.text.length)[0]
    return best === undefined ? undefined : { spec: { kind: 'json', path: best.path }, answer: best.text }
  } catch {
    return notQuestion(responseText) ? { spec: { kind: 'text' }, answer: responseText } : undefined
  }
}

/**
 * The answer in a reply, read the way the capture found. Undefined when it is not where it was. A capture saved before
 * event labels were recognised may point at one (`type`); that reply is read afresh instead, so it need not be captured
 * again.
 */
export function readAnswer(responseText: string, spec: WebChatResponseSpec): string | undefined {
  if (spec.kind === 'text') return responseText
  if (spec.kind === 'json') {
    try {
      const value = at(JSON.parse(responseText), spec.path ?? [])
      return typeof value === 'string' ? value : undefined
    } catch {
      return undefined
    }
  }
  const events = sseEvents(responseText) ?? []
  const values = events.map((event) => at(event, spec.path ?? [])).filter((value): value is string => typeof value === 'string')
  if (labelsEvents(values, events.length)) return bestSse(events, (text) => text.trim().length > 0)?.answer
  if (values.length === 0) return undefined
  return combine(values, spec.mode === 'cumulative' ? 'cumulative' : 'delta')
}

/**
 * What a reply is made of, without its text: for events, how many and each field with how often it appears and how many
 * characters it carries in all - so a wrong answer can be diagnosed from the Test button without showing the reply.
 */
export function replyShape(responseText: string): string {
  const events = /^data:/m.test(responseText) ? sseEvents(responseText) : undefined
  if (events !== undefined && events.length > 0) {
    const fields = sseFields(events).map((entry) => {
      const chars = entry.values.reduce((sum, value) => sum + value.length, 0)
      return `${entry.path.join('.')} ×${String(entry.values.length)} (${String(chars)} chars${labelsEvents(entry.values, events.length) ? ', event labels' : ''})`
    })
    return `${String(events.length)} events; fields: ${fields.join(', ')}`
  }
  try {
    const found: { path: Path; text: string }[] = []
    leaves(JSON.parse(responseText) as unknown, [], found)
    return `JSON; text fields: ${found.map((leaf) => `${leaf.path.join('.')} (${String(leaf.text.length)} chars)`).join(', ')}`
  } catch {
    return `plain text, ${String(responseText.length)} chars`
  }
}
