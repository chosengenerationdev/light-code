import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomically } from '../usage/events.js'

/**
 * The codebase's memory: short corrections and guidance the user gave the agent, kept so they apply in every later chat.
 *
 * Asked for: "a memory db to remember whatever short corrections or important guidance user gives to agent, anti
 * hallucinatory should watch for it and track the points in memory db; in future it should correct or redirect agent
 * based on it". The Anti Hallucinator proposes entries from what the user says (`remember` in its reply); the user sees,
 * edits and removes them in Settings -> Project -> Memory; every chat's agent is given them, and the Anti Hallucinator is
 * told them so it can redirect the agent when it is about to go against one.
 *
 * **Outside the repository**, beside the codebase instructions and for their reason: a repository able to write here
 * could plant standing instructions in every chat. One file per codebase, shared by its chats (Fire Code's
 * `codebaseDir`), written whole and re-read before every change, so two chats adding at once both land.
 */

export interface MemoryEntry {
  id: string
  /** One short imperative sentence. */
  text: string
  /** What the user said that it came from, when it came from a chat. */
  from?: string
  /** Who added it. */
  by: 'anti-hallucinator' | 'you'
  at: number
  /** How often the Anti Hallucinator has redirected the agent with it. */
  uses: number
  lastUsed?: number
}

/**
 * Kept in the file. Asked: "what if memory grows? it eventually will never read old messages?" - nothing is deleted for
 * size until this many, an entry the user added never is, and past it the least-used of the Anti Hallucinator's go first.
 */
export const MEMORY_LIMIT = 500
export const MEMORY_TEXT_LIMIT = 300
/** What one request is given at most: past this, the entries most relevant to the request (`selectMemory`). */
export const MEMORY_SHOWN_CHARS = 6_000
export const MEMORY_SHOWN_MAX = 40

/** The memory file for a codebase: Fire Code's codebase folder, else filed under the workspace in storage. */
export function memoryPath(options: { codebaseDir?: string | undefined; storageDir: string; workspaceRoot: string | undefined }): string | undefined {
  if (options.codebaseDir !== undefined) return path.join(options.codebaseDir, 'memory', 'memory.json')
  if (options.workspaceRoot === undefined) return undefined
  const resolved = path.resolve(options.workspaceRoot)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12)
  const slug = path.basename(resolved).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  return path.join(options.storageDir, 'codebases', `${slug}-${digest}`, 'memory.json')
}

function valid(entry: unknown): entry is MemoryEntry {
  if (entry === null || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  return typeof e['id'] === 'string' && typeof e['text'] === 'string' && typeof e['at'] === 'number'
}

/** The entries, oldest first. Never throws: a missing or damaged file is an empty memory. */
export async function readMemory(file: string | undefined): Promise<MemoryEntry[]> {
  if (file === undefined) return []
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { entries?: unknown }
    return Array.isArray(parsed.entries)
      ? parsed.entries.filter(valid).map((e) => ({ ...e, uses: typeof e.uses === 'number' ? e.uses : 0, by: e.by === 'you' ? 'you' : 'anti-hallucinator' }))
      : []
  } catch {
    return []
  }
}

/** Changes run one at a time per file within this process; the file is re-read inside, so other processes' writes land. */
const queues = new Map<string, Promise<unknown>>()
async function change(file: string, apply: (entries: MemoryEntry[]) => MemoryEntry[]): Promise<MemoryEntry[]> {
  const previous = queues.get(file) ?? Promise.resolve()
  const next = previous.then(async () => {
    const entries = apply(await readMemory(file))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeFileAtomically(file, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
    return entries
  })
  queues.set(file, next.catch(() => undefined))
  return next
}

/** Words of a sentence, for "is this the same point again". */
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
}

/** The same point as one already kept: the same words, or nearly all of the shorter's words in the longer. */
export function samePoint(a: string, b: string): boolean {
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase()
  const [small, large] = x.size <= y.size ? [x, y] : [y, x]
  let shared = 0
  for (const word of small) if (large.has(word)) shared += 1
  return shared / small.size >= 0.8
}

/** Adds points not already kept; returns the ones added. The oldest unused go first once the memory is full. */
export async function addMemory(file: string, points: readonly { text: string; from?: string | undefined; by: MemoryEntry['by'] }[]): Promise<MemoryEntry[]> {
  const added: MemoryEntry[] = []
  await change(file, (entries) => {
    for (const point of points) {
      const text = point.text.trim().replace(/\s+/g, ' ').slice(0, MEMORY_TEXT_LIMIT)
      if (text.length < 4 || entries.some((entry) => samePoint(entry.text, text))) continue
      const entry: MemoryEntry = { id: randomUUID().slice(0, 8), text, by: point.by, at: Date.now(), uses: 0, ...(point.from !== undefined && point.from.trim() !== '' ? { from: point.from.trim().slice(0, 500) } : {}) }
      entries.push(entry)
      added.push(entry)
    }
    while (entries.length > MEMORY_LIMIT) {
      // The Anti Hallucinator's least-used, oldest first; never one the user added.
      const candidates = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.by !== 'you')
      if (candidates.length === 0) break
      candidates.sort((a, b) => a.entry.uses - b.entry.uses || a.entry.at - b.entry.at)
      entries.splice(candidates[0]!.index, 1)
    }
    return entries
  })
  return added
}

export async function editMemory(file: string, id: string, text: string): Promise<void> {
  await change(file, (entries) => entries.map((entry) => (entry.id === id ? { ...entry, text: text.trim().slice(0, MEMORY_TEXT_LIMIT) } : entry)).filter((entry) => entry.text.length > 0))
}

export async function deleteMemory(file: string, id: string): Promise<void> {
  await change(file, (entries) => entries.filter((entry) => entry.id !== id))
}

/** Counts a redirect by these entries (by the numbers the Anti Hallucinator was shown, M1 = the first). */
export async function noteMemoryUsed(file: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await change(file, (entries) => entries.map((entry) => (ids.includes(entry.id) ? { ...entry, uses: entry.uses + 1, lastUsed: Date.now() } : entry)))
}

/**
 * The entries one request is given. All of them while they fit (`MEMORY_SHOWN_CHARS`, `MEMORY_SHOWN_MAX`); past that, the
 * most relevant to the request - by the reranker's `scores` when there is one, else shared words - with a little weight
 * for entries the user added and ones that redirected the agent before. Relevance decides, not age: an old entry about
 * this request is given, a new one about something else waits. Kept in their stored order.
 */
export function selectMemory(entries: readonly MemoryEntry[], request: string, scores?: readonly number[]): { shown: MemoryEntry[]; left: number } {
  const size = entries.reduce((sum, entry) => sum + entry.text.length + 3, 0)
  if (size <= MEMORY_SHOWN_CHARS && entries.length <= MEMORY_SHOWN_MAX) return { shown: [...entries], left: 0 }
  const asked = words(request)
  const overlap = (text: string): number => {
    const own = words(text)
    if (own.size === 0 || asked.size === 0) return 0
    let shared = 0
    for (const word of own) if (asked.has(word)) shared += 1
    return shared / own.size
  }
  const ranked = entries
    .map((entry, index) => ({ entry, index, score: (scores?.[index] ?? overlap(entry.text)) + (entry.by === 'you' ? 0.05 : 0) + Math.min(entry.uses, 5) * 0.02 }))
    .sort((a, b) => b.score - a.score || b.entry.at - a.entry.at)
  const chosen: { entry: MemoryEntry; index: number }[] = []
  let used = 0
  for (const candidate of ranked) {
    if (chosen.length >= MEMORY_SHOWN_MAX) break
    const cost = candidate.entry.text.length + 3
    if (used + cost > MEMORY_SHOWN_CHARS) continue
    chosen.push(candidate)
    used += cost
  }
  chosen.sort((a, b) => a.index - b.index)
  return { shown: chosen.map((c) => c.entry), left: entries.length - chosen.length }
}

/** The memory as the agent is given it: a section after the codebase instructions. Empty when there is none. */
export function renderMemoryForAgent(entries: readonly MemoryEntry[], left = 0): string {
  if (entries.length === 0) return ''
  return [
    '## Remembered guidance',
    '',
    'The user told you these in earlier chats on this codebase, and they still apply. Follow them as you would the user\'s own words; when one conflicts with what the user asks now, the user\'s request now wins - say that you are setting the remembered point aside.',
    ...(left > 0 ? [`(These are the ones that bear on this request; ${String(left)} more are remembered for other work.)`] : []),
    '',
    ...entries.map((entry) => `- ${entry.text}`),
  ].join('\n')
}

/** The memory as the Anti Hallucinator is shown it, numbered so its reply can name the ones it used. */
export function renderMemoryForGuard(entries: readonly MemoryEntry[]): string {
  return entries.length === 0
    ? 'The memory is empty.'
    : ['The memory (guidance the user gave in earlier chats):', ...entries.map((entry, index) => `M${String(index + 1)}: ${entry.text}`)].join('\n')
}
