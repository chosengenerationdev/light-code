import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_RISKY_COMMANDS } from '../approval/riskyCommands.js'
import { auditVerdict, dangerSignals, guardVerdict, isObserverNote, noteForAgent, previewText, type ObservedEvent } from './events.js'
import { ObserverHub, type ObserverHubDeps } from './hub.js'
import { AuditJournal, pruneAudit, readAudit, workspaceAuditFolder } from './journal.js'
import { ObserverAgent, type ObserverStatus } from './process.js'
import { createReadAuditTool } from './tool.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'lc-observers-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const at = 1_760_000_000_000

describe('danger signals', () => {
  it('flags an approved risky command and notifies, but only records a refused one', () => {
    const preview = previewText({ kind: 'command', command: 'git push --force origin main', cwd: 'C:/rm -rf/x' })
    const ran = dangerSignals({ kind: 'approval', at, tool: 'execute_command', decision: 'approved', preview }, DEFAULT_RISKY_COMMANDS)
    expect(ran).toHaveLength(1)
    expect(ran[0]).toMatchObject({ level: 'high', notify: true })
    const refused = dangerSignals({ kind: 'approval', at, tool: 'execute_command', decision: 'denied', preview }, DEFAULT_RISKY_COMMANDS)
    expect(refused[0]).toMatchObject({ level: 'medium', notify: false })
  })

  it('does not read the working folder as part of the command', () => {
    const preview = previewText({ kind: 'command', command: 'git status', cwd: 'C:/work/push --force' })
    expect(dangerSignals({ kind: 'approval', at, tool: 'execute_command', decision: 'approved', preview }, DEFAULT_RISKY_COMMANDS)).toEqual([])
  })

  it("recognises Light Code's own refusals by their wording", () => {
    const denied: ObservedEvent = { kind: 'toolResult', at, tool: 'read_file', ok: false, text: 'Access to "C:/Users/x/.ssh/id_rsa" is denied — it holds keys, passwords or credentials.' }
    expect(dangerSignals(denied, [])[0]).toMatchObject({ level: 'high', notify: true })
    const mode: ObservedEvent = { kind: 'refused', at, tool: 'write_to_file', reason: '"write_to_file" is not available in Ask mode.' }
    expect(dangerSignals(mode, [])).toHaveLength(1)
    expect(dangerSignals({ kind: 'toolResult', at, tool: 'read_file', ok: false, text: 'File not found' }, [])).toEqual([])
  })

  it('flags an approved write outside the workspace', () => {
    expect(dangerSignals({ kind: 'approval', at, tool: 'write_to_file', decision: 'approved', preview: 'x', outsideWorkspace: true }, [])[0]?.notify).toBe(true)
  })
})

describe('verdicts', () => {
  it('accepts only what the Auditor was asked for', () => {
    expect(auditVerdict({ summary: 's', risk: 'catastrophic', concerns: ['a', 3] })).toEqual({ summary: 's', risk: 'none', concerns: ['a'] })
    expect(auditVerdict({ summary: '', concerns: [] })).toBeUndefined()
    expect(auditVerdict('text')).toBeUndefined()
  })

  it('takes a note only when the guard says note', () => {
    expect(guardVerdict({ verdict: 'ok', note: 'x' })).toBeUndefined()
    expect(guardVerdict({ verdict: 'note', note: '  ' })).toBeUndefined()
    expect(guardVerdict({ verdict: 'note', note: 'You never read a.ts', severity: 'high' })).toEqual({ note: 'You never read a.ts', severity: 'high' })
  })

  it('labels a note so nothing mistakes it for the user, and keeps each point on one line', () => {
    const text = noteForAgent([{ note: 'line one\nline two', severity: 'high' }])
    expect(isObserverNote(text)).toBe(true)
    expect(text).toContain('- (important) line one line two')
    expect(isObserverNote('please read a.ts')).toBe(false)
  })
})

describe('journal', () => {
  it('writes one file per session and day, and reads it back newest first with filters', async () => {
    const one = new AuditJournal(dir, 'D:/Work/App', 's1')
    const two = new AuditJournal(dir, 'd:/work/app', 's2')
    expect(one.folder).toBe(two.folder)
    const base = { v: 1 as const, workspace: workspaceAuditFolder('D:/Work/App'), project: 'p', user: 'u' }
    await one.append({ ...base, at, type: 'event', session: 's1', event: { kind: 'toolCall', at, tool: 'read_file', args: '{"path":"a.ts"}' } }, () => undefined)
    await two.append({ ...base, at: at + 1000, type: 'alert', session: 's2', alert: { level: 'high', message: 'refused', source: 'rules' } }, () => undefined)
    expect((await readdir(one.folder)).length).toBe(2)
    const all = await readAudit(dir, 'D:/Work/App', {})
    expect(all.records.map((r) => r.type)).toEqual(['alert', 'event'])
    expect((await readAudit(dir, 'D:/Work/App', { tool: 'read_file' })).records).toHaveLength(1)
    expect((await readAudit(dir, 'D:/Work/App', { types: ['alert'] })).records).toHaveLength(1)
    expect((await readAudit(dir, 'D:/Work/App', { contains: 'A.TS' })).records).toHaveLength(1)
    expect((await readAudit(dir, 'D:/Other', {})).records).toHaveLength(0)
    expect((await readAudit(dir, 'D:/Other', { allWorkspaces: true })).records).toHaveLength(2)
  })

  it('prunes whole day files past retention and keeps the rest', async () => {
    const journal = new AuditJournal(dir, 'D:/w', 's')
    const base = { v: 1 as const, workspace: 'w', project: 'p', user: 'u', session: 's', type: 'status' as const, status: 'x' }
    await journal.append({ ...base, at: at - 100 * 86_400_000 }, () => undefined)
    await journal.append({ ...base, at }, () => undefined)
    expect(await pruneAudit(dir, 90, at)).toBe(1)
    expect((await readAudit(dir, 'D:/w', {})).records).toHaveLength(1)
  })
})

/** A stand-in for `fire-fs watch`: records what it is sent, and answers as the test says. */
class FakeWatch {
  readonly sent: Record<string, unknown>[] = []
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly child: ChildProcessWithoutNullStreams
  constructor() {
    const emitter = new EventEmitter() as unknown as ChildProcessWithoutNullStreams
    Object.assign(emitter, { stdin: this.stdin, stdout: this.stdout, stderr: this.stderr, kill: () => this.exit(1) })
    this.child = emitter
    let buffer = ''
    this.stdin.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        this.sent.push(JSON.parse(buffer.slice(0, i)) as Record<string, unknown>)
        buffer = buffer.slice(i + 1)
      }
    })
  }
  say(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }
  exit(code: number): void {
    this.stdin.destroy()
    ;(this.child as unknown as EventEmitter).emit('close', code)
  }
}

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('observer process supervision', () => {
  function agent(fakes: FakeWatch[], results: unknown[] = [], auth: boolean[] = []): ObserverAgent {
    return new ObserverAgent({
      exe: 'fire-fs.exe',
      role: 'guard',
      system: 'SYS',
      window: 1000,
      model: { wire: 'openai', baseUrl: 'https://gw.example/v1', model: 'm' },
      resolveAuth: (force) => {
        auth.push(force)
        return Promise.resolve({ Authorization: 'Bearer t' })
      },
      onResult: (reply) => results.push(reply),
      onStatus: () => undefined,
      log: () => undefined,
      start: () => {
        const fake = new FakeWatch()
        fakes.push(fake)
        return fake.child
      },
    })
  }

  it('starts with the role and model, answers auth from the strategy, and passes results on', async () => {
    const fakes: FakeWatch[] = []
    const results: unknown[] = []
    const auth: boolean[] = []
    const a = agent(fakes, results, auth)
    a.start()
    a.send({ kind: 'toolResult', at, tool: 't', ok: true, text: 'x' })
    await tick()
    expect(fakes[0]!.sent[0]).toMatchObject({ type: 'start', role: 'guard', system: 'SYS', handoff: '' })
    expect(fakes[0]!.sent[1]).toMatchObject({ type: 'event' })
    fakes[0]!.say({ type: 'needAuth', id: 4, force: true })
    await tick()
    expect(auth).toEqual([true])
    expect(fakes[0]!.sent.at(-1)).toEqual({ type: 'auth', id: 4, headers: { Authorization: 'Bearer t' } })
    fakes[0]!.say({ type: 'result', reply: { verdict: 'note', note: 'n', state: 'notes so far' } })
    await tick()
    expect(results).toHaveLength(1)
    a.stop()
  })

  it('hands off to a new process with its notes and the events the old one had not reviewed', async () => {
    const fakes: FakeWatch[] = []
    const a = agent(fakes)
    a.start()
    a.remember('earlier finding')
    fakes[0]!.say({ type: 'result', reply: { state: 'goal: fix login' } })
    await tick()
    fakes[0]!.say({ type: 'handoff', state: 'goal: fix login; done step 1', tokens: 800, pending: [{ kind: 'assistant', at, text: 'unreviewed' }] })
    await tick()
    // Sent after the handoff and before the new process: it must wait for the new one, not go to the old.
    a.send({ kind: 'toolCall', at, tool: 'later', args: '{}' })
    fakes[0]!.exit(0)
    await tick()
    expect(fakes).toHaveLength(2)
    const start = fakes[1]!.sent[0]!
    expect(start['type']).toBe('start')
    expect(start['handoff']).toContain('goal: fix login; done step 1')
    expect(start['handoff']).toContain('earlier finding')
    expect(fakes[1]!.sent.slice(1).map((m) => (m['event'] as { kind: string }).kind)).toEqual(['assistant', 'toolCall'])
    expect(a.current.handoffs).toBe(1)
    a.stop()
  })

  it('restarts a process that dies, and gives up after five starts in ten minutes', async () => {
    const fakes: FakeWatch[] = []
    const statuses: ObserverStatus[] = []
    const a = new ObserverAgent({
      exe: 'x',
      role: 'auditor',
      system: '',
      window: 1000,
      model: { wire: 'openai', baseUrl: 'https://a', model: 'm' },
      resolveAuth: () => Promise.resolve({}),
      onResult: () => undefined,
      onStatus: (s) => statuses.push(s),
      log: () => undefined,
      start: () => {
        const fake = new FakeWatch()
        fakes.push(fake)
        return fake.child
      },
    })
    a.start()
    for (let i = 0; i < 6; i += 1) {
      await tick(5)
      fakes.at(-1)!.exit(1)
    }
    await tick()
    expect(fakes).toHaveLength(5)
    expect(statuses.at(-1)!.state).toBe('failed')
  })

  it('does not restart after a fatal error (a profile it cannot call)', async () => {
    const fakes: FakeWatch[] = []
    const a = agent(fakes)
    a.start()
    fakes[0]!.say({ type: 'error', fatal: true, message: 'cannot call vscode-lm' })
    await tick()
    fakes[0]!.exit(0)
    await tick()
    expect(fakes).toHaveLength(1)
    expect(a.current.state).toBe('failed')
  })
})

describe('hub', () => {
  function hub(overrides: Partial<ObserverHubDeps> = {}, notified: string[] = []): ObserverHub {
    return new ObserverHub({
      storageDir: dir,
      workspace: 'D:/w',
      workspaceId: workspaceAuditFolder('D:/w'),
      session: 'sess',
      user: () => 'alice',
      project: () => 'proj',
      task: () => 'task-1',
      secretValues: () => ['s3cr3t-value'],
      riskyRules: () => DEFAULT_RISKY_COMMANDS,
      notify: (m) => notified.push(m),
      log: () => undefined,
      changed: () => undefined,
      index: () => undefined,
      startAgent: () => Promise.resolve({ problem: 'no model in this test' }),
      ...overrides,
    })
  }

  it('records nothing while both are off', async () => {
    const h = hub()
    h.event({ kind: 'turnStart', at, text: 'hi', mode: 'Code', model: 'm' })
    await h.flushed()
    expect((await readAudit(dir, 'D:/w', {})).records).toHaveLength(0)
  })

  it('records every event with secrets removed, even with no model, and alerts at once', async () => {
    const notified: string[] = []
    const h = hub({}, notified)
    await h.configure({ auditor: { enabled: true, recordReasoning: false, notify: true }, guard: { enabled: false } })
    h.event({ kind: 'turnStart', at, text: 'use key s3cr3t-value', mode: 'Code', model: 'm' })
    h.event({ kind: 'reasoning', at, text: 'thinking' })
    h.event({ kind: 'toolResult', at, tool: 'read_file', ok: false, text: 'Access to "C:/k.pem" is denied.' })
    await h.flushed()
    const records = (await readAudit(dir, 'D:/w', {})).records
    expect(records.map((r) => r.type).sort()).toEqual(['alert', 'event', 'event'])
    expect(JSON.stringify(records)).not.toContain('s3cr3t-value')
    expect(records.every((r) => r.task === 'task-1' && r.user === 'alice' && r.project === 'proj')).toBe(true)
    expect(notified).toHaveLength(1)
    expect(h.panel(undefined).auditorProblem).toBe('no model in this test')
    await h.dispose()
  })

  it('holds a run of alerts into one notice', async () => {
    const notified: string[] = []
    const h = hub({}, notified)
    await h.configure({ auditor: { enabled: true, recordReasoning: true, notify: true }, guard: { enabled: false } })
    for (let i = 0; i < 3; i += 1) h.event({ kind: 'refused', at, tool: 'x', reason: '"x" is not available in Ask mode.' })
    await h.dispose()
    expect(notified).toHaveLength(1)
  })

  it("hands the guard's notes to the agent once, and drops a repeated one", async () => {
    let onResult: ((reply: unknown, raw: string) => void) | undefined
    const fake = { start: () => undefined, stop: () => undefined, send: () => undefined, flush: () => undefined, remember: () => undefined } as unknown as ObserverAgent
    const h = hub({
      startAgent: (_role, hooks) => {
        onResult = hooks.onResult
        return Promise.resolve(fake)
      },
    })
    await h.configure({ auditor: { enabled: false, recordReasoning: true, notify: true }, guard: { enabled: true } })
    onResult!({ verdict: 'note', note: 'You claimed tests passed; the result shows 2 failures.' }, '')
    onResult!({ verdict: 'note', note: 'You claimed tests passed; the result shows 2 failures.' }, '')
    onResult!({ verdict: 'ok' }, '')
    expect(h.takeNotes()).toHaveLength(1)
    expect(h.takeNotes()).toHaveLength(0)
    expect(h.panel(undefined).notes[0]?.delivered).toBe(true)
    await h.dispose()
  })
})

describe('read_audit_log', () => {
  it('summarises and returns flat rows', async () => {
    const journal = new AuditJournal(dir, 'D:/w', 's')
    const base = { v: 1 as const, workspace: 'w', project: 'p', user: 'u', session: 's' }
    await journal.append({ ...base, at, type: 'event', event: { kind: 'toolCall', at, tool: 'execute_command', args: '{"command":"npm test"}' } }, () => undefined)
    await journal.append({ ...base, at: at + 1, type: 'event', event: { kind: 'approval', at, tool: 'execute_command', decision: 'denied', preview: '$ npm test' } }, () => undefined)
    await journal.append({ ...base, at: at + 2, type: 'alert', alert: { level: 'high', message: 'refused path', source: 'rules' } }, () => undefined)
    const tool = createReadAuditTool({ storageDir: dir, workspace: 'D:/w', workspaceId: undefined, index: () => undefined })
    const summary = await tool.execute({ action: 'summary', source: 'local' }, {} as never)
    expect(summary.content).toContain('"execute_command": 1')
    expect(summary.content).toContain('refused path')
    const rows = await tool.execute({ action: 'records', source: 'local', types: ['event'] }, {} as never)
    const parsed = JSON.parse(rows.content.slice(rows.content.indexOf('['))) as Record<string, unknown>[]
    expect(parsed[0]).toMatchObject({ kind: 'approval', decision: 'denied', text: '$ npm test' })
    const index = await tool.execute({ action: 'summary', source: 'index' }, {} as never)
    expect(index.isError).toBe(true)
    const bad = await tool.execute({ action: 'summary', source: 'local', from: 'yesterday-ish' }, {} as never)
    expect(bad.isError).toBe(true)
    expect(await readFile(path.join(journal.folder, (await readdir(journal.folder))[0]!), 'utf8')).toContain('npm test')
  })
})
