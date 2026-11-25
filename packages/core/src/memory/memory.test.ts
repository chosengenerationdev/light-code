import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_RISKY_COMMANDS } from '../approval/riskyCommands.js'
import { guardMemory } from '../observers/events.js'
import { ObserverHub } from '../observers/hub.js'
import { workspaceAuditFolder } from '../observers/journal.js'
import type { ObserverAgent } from '../observers/process.js'
import { guardPrompt } from '../observers/prompts.js'
import { addMemory, deleteMemory, editMemory, memoryPath, noteMemoryUsed, readMemory, renderMemoryForAgent, renderMemoryForGuard, samePoint, selectMemory } from './store.js'

/**
 * Asked for: "a memory db to remember whatever short corrections or important guidance user gives to agent, anti
 * hallucinatory should watch for it and track the points in memory db; in future it should correct or redirect agent
 * based on it".
 */

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'lc-memory-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the memory file', () => {
  it('is one per codebase, outside the repository', () => {
    expect(memoryPath({ codebaseDir: path.join(dir, 'cb'), storageDir: dir, workspaceRoot: 'D:/x' })).toBe(path.join(dir, 'cb', 'memory', 'memory.json'))
    const a = memoryPath({ storageDir: dir, workspaceRoot: 'D:/work/alpha' })
    const b = memoryPath({ storageDir: dir, workspaceRoot: 'D:/work/beta' })
    expect(a).not.toBe(b)
    expect(a?.startsWith(dir)).toBe(true)
  })

  it('keeps new points, not the same point twice, and edits and removes', async () => {
    const file = path.join(dir, 'memory.json')
    const added = await addMemory(file, [
      { text: 'Always run the tests with -x before saying they pass.', from: 'please always use -x', by: 'anti-hallucinator' },
      { text: 'Never edit files under generated/.', by: 'you' },
    ])
    expect(added).toHaveLength(2)
    // The same point in other words is not kept again.
    expect(await addMemory(file, [{ text: 'Run the tests with -x always before saying they pass', by: 'anti-hallucinator' }])).toHaveLength(0)
    const entries = await readMemory(file)
    expect(entries.map((e) => e.text)).toEqual(['Always run the tests with -x before saying they pass.', 'Never edit files under generated/.'])
    expect(entries[0]?.from).toBe('please always use -x')
    await editMemory(file, entries[1]!.id, 'Never edit files under generated/ or dist/.')
    await noteMemoryUsed(file, [entries[0]!.id])
    await deleteMemory(file, entries[1]!.id)
    const after = await readMemory(file)
    expect(after).toHaveLength(1)
    expect(after[0]?.uses).toBe(1)
  })

  it('lands every point when two chats add at once', async () => {
    const file = path.join(dir, 'memory.json')
    await Promise.all([addMemory(file, [{ text: 'Use the staging API host.', by: 'you' }]), addMemory(file, [{ text: 'Answer in British English.', by: 'you' }])])
    expect((await readMemory(file)).map((e) => e.text).sort()).toEqual(['Answer in British English.', 'Use the staging API host.'])
  })

  // Asked: "what if memory grows? it eventually will never read old messages?"
  it('gives a request everything while it fits, and past that the entries that bear on it - however old', () => {
    const entry = (id: string, text: string, at: number, extra: Partial<{ by: 'you'; uses: number }> = {}) => ({ id, text, by: 'anti-hallucinator' as const, at, uses: 0, ...extra })
    const few = [entry('a', 'Use -x for tests.', 1)]
    expect(selectMemory(few, 'anything')).toEqual({ shown: few, left: 0 })
    const many = Array.from({ length: 60 }, (_, i) => entry(String(i), `Unrelated guidance number ${String(i)} about deployment pipelines and release notes.`, 1000 + i))
    // The oldest entry, about the parser, is the one this request needs.
    many.unshift(entry('old', 'The date parser must accept ISO week dates.', 0))
    const picked = selectMemory(many, 'Fix the date parser for week dates')
    expect(picked.shown[0]?.id).toBe('old')
    expect(picked.shown.length).toBeLessThanOrEqual(40)
    expect(picked.left).toBe(many.length - picked.shown.length)
    // A reranker's scores decide when given.
    const scores = many.map((e) => (e.id === '7' ? 0.99 : 0.01))
    expect(selectMemory(many, 'x', scores).shown.map((e) => e.id)).toContain('7')
    expect(renderMemoryForAgent(picked.shown, picked.left)).toContain(`${String(picked.left)} more are remembered`)
  })

  it('never deletes an entry the user added to make room', async () => {
    const file = path.join(dir, 'memory.json')
    await addMemory(file, [{ text: 'Keep the user entry forever please.', by: 'you' }])
    const points = Array.from({ length: 505 }, (_, i) => ({ text: `alpha${String(i)} beta${String(i)} gamma${String(i)}`, by: 'anti-hallucinator' as const }))
    await addMemory(file, points)
    const entries = await readMemory(file)
    expect(entries).toHaveLength(500)
    expect(entries.some((e) => e.by === 'you')).toBe(true)
  })

  it('reads a missing or damaged file as an empty memory', async () => {
    expect(await readMemory(path.join(dir, 'none.json'))).toEqual([])
    expect(await readMemory(undefined)).toEqual([])
  })

  it('tells points apart that share only a few words', () => {
    expect(samePoint('Never edit generated files', 'Never edit the generated files')).toBe(true)
    expect(samePoint('Never edit generated files', 'Always run the tests')).toBe(false)
  })

  it('is given to the agent after its instructions, and numbered for the Anti Hallucinator', () => {
    const entries = [{ id: 'a', text: 'Use -x.', by: 'you' as const, at: 1, uses: 0 }]
    expect(renderMemoryForAgent(entries)).toContain('## Remembered guidance')
    expect(renderMemoryForAgent([])).toBe('')
    expect(renderMemoryForGuard(entries)).toContain('M1: Use -x.')
  })
})

describe('the Anti Hallucinator and the memory', () => {
  it('is told its memory duties only when the memory is on', () => {
    const on = guardPrompt({ workspace: 'w', project: 'p', memory: true })
    expect(on).toContain('"remember": []')
    expect(on).toContain('M1, M2')
    expect(guardPrompt({ workspace: 'w', project: 'p' })).not.toContain('"remember"')
  })

  it('reads what to remember and which entries a note rested on', () => {
    expect(guardMemory({ verdict: 'ok', remember: ['Use -x for tests.', 'x', 7], applied: ['M2', 3, 'bogus'] })).toEqual({ remember: ['Use -x for tests.'], applied: [2, 3] })
    expect(guardMemory({ verdict: 'ok' })).toEqual({ remember: [], applied: [] })
  })

  it('shows the memory with the request when it changed, and keeps what it proposes with the user\'s words', async () => {
    const sent: { kind: string; text?: string }[] = []
    let onResult: ((reply: unknown, raw: string) => void) | undefined
    const fake = {
      start: () => undefined,
      stop: () => undefined,
      send: (event: { kind: string; text?: string }) => sent.push(event),
      pin: (event: { kind: string; text?: string } | undefined) => (event !== undefined ? sent.push(event) : undefined),
      flush: () => undefined,
      remember: () => undefined,
    } as unknown as ObserverAgent
    const remembered: { points: string[]; from: string }[] = []
    const used: number[][] = []
    const hub = new ObserverHub({
      storageDir: dir,
      workspace: 'D:/w',
      workspaceId: workspaceAuditFolder('D:/w'),
      session: 's',
      user: () => 'alice',
      project: () => 'p',
      task: () => 't',
      secretValues: () => [],
      riskyRules: () => DEFAULT_RISKY_COMMANDS,
      notify: () => undefined,
      log: () => undefined,
      changed: () => undefined,
      index: () => undefined,
      startAgent: (_role, hooks) => {
        onResult = hooks.onResult
        return Promise.resolve(fake)
      },
      remember: (points, from) => remembered.push({ points, from }),
      memoryUsed: (numbers) => used.push(numbers),
    })
    await hub.configure({ auditor: { enabled: false, recordReasoning: true, notify: true }, guard: { enabled: true } })
    hub.setMemory('M1: Use -x.')
    hub.event({ kind: 'turnStart', at: 1, text: 'From now on always answer in British English.', mode: 'Auto', model: 'm' })
    hub.setMemory('M1: Use -x.')
    hub.event({ kind: 'turnStart', at: 2, text: 'next', mode: 'Auto', model: 'm' })
    // Pinned once; not again until it changes.
    expect(sent.map((e) => e.kind)).toEqual(['memory', 'turnStart', 'turnStart'])
    hub.setMemory('M1: Use -x.\nM2: British English.')
    hub.event({ kind: 'turnStart', at: 3, text: 'and again', mode: 'Auto', model: 'm' })
    expect(sent.at(-2)).toMatchObject({ kind: 'memory', text: 'M1: Use -x.\nM2: British English.' })

    onResult!({ verdict: 'note', note: 'The user asked to remember: use -x.', remember: ['Answer in British English.'], applied: ['M1'] }, '')
    expect(remembered).toEqual([{ points: ['Answer in British English.'], from: 'and again' }])
    expect(used).toEqual([[1]])
    expect(hub.takeNotes()).toHaveLength(1)
    await hub.dispose()
  })
})
