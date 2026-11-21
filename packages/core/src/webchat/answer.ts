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

/** Finds how the answer is carried in a captured reply. `exclude`: text that is not the answer (the question sent). */
export function findAnswer(responseText: string, contentType: string | undefined, exclude: string): { spec: WebChatResponseSpec; answer: string } | undefined {
  /*
   * Not the question sent: text that is the phrase and nothing more (the request echoed back). A reply that *mentions*
   * the phrase is still the reply - models usually do ("I'm not sure what light-code-capture-… means"), and skipping
   * it read the reply's id as the answer, found against the real chrome-devtools-mcp.
   */
  const notQuestion = (text: string): boolean => text.trim().length > 0 && text.split(exclude).join('').replace(/[\s"'`.,:;!?()[\]{}-]/g, '').length >= 3
  const events = (contentType ?? '').includes('event-stream') || /^data:/m.test(responseText) ? sseEvents(responseText) : undefined
  if (events !== undefined && events.length > 0) {
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
    let best: { spec: WebChatResponseSpec; answer: string } | undefined
    for (const entry of byPath.values()) {
      const cumulative = entry.values.length > 1 && entry.values.every((value, i) => i === 0 || value.startsWith(entry.values[i - 1] ?? ''))
      const answer = cumulative ? (entry.values.at(-1) ?? '') : entry.values.join('')
      if (!notQuestion(answer)) continue
      if (best === undefined || answer.length > best.answer.length) best = { spec: { kind: 'sse', path: entry.path, mode: cumulative ? 'cumulative' : 'delta' }, answer }
    }
    return best
  }
  try {
    const document = JSON.parse(responseText) as unknown
    const found: { path: Path; text: string }[] = []
    leaves(document, [], found)
    const best = found.filter((leaf) => notQuestion(leaf.text)).sort((a, b) => b.text.length - a.text.length)[0]
    return best === undefined ? undefined : { spec: { kind: 'json', path: best.path }, answer: best.text }
  } catch {
    return notQuestion(responseText) ? { spec: { kind: 'text' }, answer: responseText } : undefined
  }
}

/** The answer in a reply, read the way the capture found. Undefined when it is not where it was. */
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
  if (values.length === 0) return undefined
  return spec.mode === 'cumulative' ? values.at(-1) : values.join('')
}
