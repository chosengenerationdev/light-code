import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AuditJournal, workspaceAuditFolder, type AuditRecord } from './journal.js'
import { renderRolesReport, rolesReport } from './report.js'
import { createReadAuditTool } from './tool.js'

/** Asked for: "Auditor should be able to provide a report on what roles models taken place to implement a task". */

const at = Date.UTC(2026, 10, 24, 9)
const base = { v: 1 as const, workspace: workspaceAuditFolder('D:/w'), project: 'p', user: 'u', session: 's' }

function records(task: string): AuditRecord[] {
  return [
    { ...base, task, at, type: 'event', event: { kind: 'turnStart', at, text: 'build it', mode: 'Agent team', model: 'qwen3-32b', participants: { 'decision model': 'd3', Auditor: 'gpt-4o' } } },
    { ...base, task, at: at + 1, type: 'event', event: { kind: 'consultation', at, role: 'tester', name: 'Tester', model: 'gemini-pro', ms: 12_400, ok: true } },
    { ...base, task, at: at + 2, type: 'event', event: { kind: 'consultation', at, role: 'tester', name: 'Tester', model: 'gemini-pro', ms: 3_000, ok: false } },
    { ...base, task, at: at + 3, type: 'event', event: { kind: 'consultation', at, role: 'reviewer', name: 'Reviewer', model: 'Claude CLI', ms: 40_000, ok: true, readOnly: true } },
    { ...base, task, at: at + 4, type: 'event', event: { kind: 'decision', at, purpose: 'Agent team routing', question: 'q', outcome: 'tester' } },
    { ...base, task, at: at + 5, type: 'event', event: { kind: 'toolCall', at, tool: 'apply_diff', args: '{}' } },
    { ...base, task, at: at + 6, type: 'note', note: { note: 'check the test result', severity: 'low' } },
    { ...base, task, at: at + 7, type: 'event', event: { kind: 'behind', at, area: 'reranker', summary: 'Tool and skill search: the reranker (bge) reordered 30 candidates - first run_tests (0.93).' } },
  ]
}

describe('the roles report', () => {
  it('says which model did what, from the record', () => {
    const report = rolesReport(records('t1'))
    expect(report.main).toEqual([{ model: 'qwen3-32b', mode: 'Agent team', requests: 1 }])
    expect(report.specialists[0]).toMatchObject({ name: 'Tester', model: 'gemini-pro', consultations: 2, failed: 1, seconds: 15 })
    expect(report.participants).toEqual({ 'decision model': 'd3', Auditor: 'gpt-4o' })
    const text = renderRolesReport(report)
    expect(text).toContain('| Tester | gemini-pro | 2 | 1 | 15 s |')
    expect(text).toContain('| Reviewer (read-only step) | Claude CLI | 1 | 0 | 40 s |')
    expect(text).toContain('- decision model - Agent team routing: 1 time(s)')
    expect(text).toContain('1 Anti Hallucinator note(s)')
    // Asked for: what happened behind the scenes - the decision model's choices, the reranker, in order.
    expect(text).toContain('### Behind the scenes, request by request')
    expect(text).toContain('- Decision model - Agent team routing: tester')
    expect(text).toContain('- Tool and skill search: the reranker (bge) reordered 30 candidates - first run_tests (0.93).')
    expect(text.indexOf('Consulted Tester')).toBeLessThan(text.indexOf('the reranker (bge)'))
  })

  it('says so when nothing was recorded', () => {
    expect(renderRolesReport(rolesReport([]))).toContain('records only while it is switched on')
  })
})

describe('read_audit_log roles', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'lc-roles-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reports on this chat's task only", async () => {
    const journal = new AuditJournal(dir, 'D:/w', 's')
    for (const record of [...records('this-chat'), ...records('another-chat').map((r) => ({ ...r, event: r.event?.kind === 'turnStart' ? { ...r.event, model: 'other-model' } : r.event }))]) {
      await journal.append(record as AuditRecord, () => undefined)
    }
    await journal.flushed()
    const tool = createReadAuditTool({ storageDir: dir, workspace: 'D:/w', workspaceId: workspaceAuditFolder('D:/w'), index: () => undefined, task: () => 'this-chat' })
    const result = await tool.execute({ action: 'roles', source: 'local' }, {} as never)
    expect(result.content).toContain('qwen3-32b')
    expect(result.content).not.toContain('other-model')
  })

  it('needs a task', async () => {
    const tool = createReadAuditTool({ storageDir: dir, workspace: 'D:/w', workspaceId: undefined, index: () => undefined, task: () => undefined })
    expect((await tool.execute({ action: 'roles', source: 'local' }, {} as never)).isError).toBe(true)
  })
})
