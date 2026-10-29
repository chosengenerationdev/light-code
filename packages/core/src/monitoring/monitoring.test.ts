import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Tool, ToolExecutionContext } from '../tools/types.js'
import { monitorToolRefusal, type MonitoringChannel } from './channel.js'
import { createMonitorCheckToolTool, createMonitorControlTool, createMonitorCreateTool, monitorBlock, monitorSkillBody } from './tools.js'
import { checkMonitorRows, describeRowsCheck, MONITOR_TOOL_TEMPLATE } from './rowsCheck.js'

const tool = (name: string, group: Tool['group']): Tool =>
  ({ name, group, description: '', parametersSchema: z.object({}), execute: async () => ({ content: '' }) }) as Tool

describe('which tools a monitor may run unattended', () => {
  it('reading tools, MCP tools and approved Python tools - never anything that changes things', () => {
    expect(monitorToolRefusal(tool('read_file', 'read'), 'read_file')).toBeUndefined()
    expect(monitorToolRefusal(tool('server__query', 'mcp'), 'server__query')).toBeUndefined()
    expect(monitorToolRefusal(tool('py__jobs', 'command'), 'py__jobs')).toBeUndefined()
    expect(monitorToolRefusal(tool('execute_command', 'command'), 'execute_command')).toMatch(/runs commands/)
    expect(monitorToolRefusal(tool('write_to_file', 'edit'), 'write_to_file')).toMatch(/not a reading tool/)
    expect(monitorToolRefusal(tool('autosys_send_event', 'command'), 'autosys_send_event')).toMatch(/unattended/)
    expect(monitorToolRefusal(undefined, 'py__gone')).toMatch(/no tool called/)
  })
})

const params = {
  name: 'batch',
  title: 'Overnight batch',
  summary: 'Red when a job fails.',
  every: '15m',
  source: { sqlite: 'C:\\data\\jobs.db', sql: 'select * from jobs' },
  rules: [{ level: 'red' as const, when: { column: 'status', op: '==', value: 'FAILURE' } }],
}

describe('monitor_create', () => {
  it('writes a skill whose monitor block holds the spec and nothing else', () => {
    const block = monitorBlock(params)
    expect(JSON.parse(block)).toEqual({ title: 'Overnight batch', summary: 'Red when a job fails.', every: '15m', source: params.source, rules: params.rules })
    const body = monitorSkillBody(params, block)
    expect(body).toContain('```monitor\n' + block + '\n```')
  })

  it('writes nothing when the engine cannot read the monitor', async () => {
    let written = false
    const channel: MonitoringChannel = { request: async () => Promise.reject(new Error('"every" must be between one minute and a week.')) }
    const writeSkill = { name: 'write_skill', group: 'edit', description: '', parametersSchema: z.object({}), execute: async () => ((written = true), { content: 'ok' }) } as unknown as Parameters<typeof createMonitorCreateTool>[0]['writeSkill']
    const create = createMonitorCreateTool({ channel, writeSkill, runTool: async () => ({ content: '' }) })
    const result = await create.execute({ ...params, every: '10s' }, {} as ToolExecutionContext)
    expect(result.isError).toBe(true)
    expect(written).toBe(false)
  })

  it('approves on this machine only the block the user approved, after writing it', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = []
    const channel: MonitoringChannel = {
      request: async (op, args) => {
        calls.push([op, args])
        if (op === 'list') return { teamReady: true }
        if (op === 'evaluate') return { level: 'green', meaning: 'All clear', headline: 'All clear', rows: 2, columns: [], alerts: [], sourceKind: 'sqlite' }
        return {}
      },
    }
    const writeSkill = { name: 'write_skill', group: 'edit', description: '', parametersSchema: z.object({}), execute: async () => ({ content: 'Recorded the skill.' }) } as unknown as Parameters<typeof createMonitorCreateTool>[0]['writeSkill']
    await createMonitorCreateTool({ channel, writeSkill, runTool: async () => ({ content: '' }) }).execute(params, {} as ToolExecutionContext)
    expect(calls.find(([op]) => op === 'approve')?.[1]).toEqual({ name: 'batch', block: monitorBlock(params) })
    expect(calls.map(([op]) => op)).toContain('run')
  })
})

describe('a tool written for monitoring', () => {
  const evaluate = (columns: string[]) => async (op: string) =>
    op === 'evaluate' ? { level: 'green', meaning: 'All clear', headline: 'x', rows: 2, columns: columns.map((key) => ({ key })), alerts: [], sourceKind: 'tool' } : {}
  const writeSkill = (onWrite: () => void) =>
    ({ name: 'write_skill', group: 'edit', description: '', parametersSchema: z.object({}), execute: async () => (onWrite(), { content: 'ok' }) }) as unknown as Parameters<typeof createMonitorCreateTool>[0]['writeSkill']
  const toolParams = { ...params, source: { tool: 'py__jobs' }, tryOnly: true }

  it('is tried without saving, and the result shows what Fire Code reads', async () => {
    let written = false
    let ran = ''
    const create = createMonitorCreateTool({ channel: { request: evaluate(['job', 'status']) }, writeSkill: writeSkill(() => (written = true)), runTool: async (name) => ((ran = name), { content: '[{"job":"A","status":"OK"}]' }) })
    const result = await create.execute(toolParams, {} as ToolExecutionContext)
    expect(written).toBe(false)
    expect(ran).toBe('py__jobs')
    expect(result.content).toContain('columns: job, status')
    expect(result.content).not.toContain('not records')
  })

  it('that answers in prose is told the format to return', async () => {
    const create = createMonitorCreateTool({ channel: { request: evaluate(['line']) }, writeSkill: writeSkill(() => undefined), runTool: async () => ({ content: 'All jobs fine' }) })
    const result = await create.execute(toolParams, {} as ToolExecutionContext)
    expect(result.content).toContain('not records')
    expect(result.content).toContain('LIST OF DICTS')
  })
})

describe('checking a monitoring tool strictly', () => {
  it('passes a list of flat records and says what to give monitor_create', () => {
    const check = checkMonitorRows(JSON.stringify([
      { job: 'A', status: 'OK', minutes: 12, lastStart: '2026-10-25T14:05:00Z' },
      { job: 'B', status: 'FAILURE', minutes: 3, lastStart: '2026-10-25T14:06:00Z' },
    ]))
    expect(check.verdict).toBe('pass')
    expect(check.suggestedKey).toBe('job')
    const text = describeRowsCheck(check)
    expect(text).toContain('PASS')
    expect(text).toContain('"key": "job"')
    expect(text).toContain('{"key":"minutes","format":"number"}')
    expect(text).toContain('{"key":"lastStart","format":"datetime"}')
  })

  it('warns about numbers as text, dates rules cannot read the same everywhere, and fields that come and go', () => {
    const check = checkMonitorRows(JSON.stringify([
      { host: 'a', free: '1,250 MB', at: '10/25/2026 14:05' },
      { host: 'b', free: '900 MB' },
    ]))
    expect(check.verdict).toBe('warn')
    expect(check.warnings.join('\n')).toMatch(/"free" holds numbers as text/)
    expect(check.warnings.join('\n')).toMatch(/"at" has dates like/)
    expect(check.warnings.join('\n')).toMatch(/"at" is missing from 1 of 2 rows/)
  })

  it('fails prose, a single object, and a failure returned as data', () => {
    expect(checkMonitorRows('All jobs are fine').verdict).toBe('fail')
    expect(checkMonitorRows(JSON.stringify({ job: 'A' })).problems[0]).toMatch(/LIST of dicts/)
    expect(checkMonitorRows(JSON.stringify({ error: 'login refused' })).problems[0]).toMatch(/RAISE/)
    expect(checkMonitorRows(JSON.stringify([{ error: 'timeout' }])).problems.join(' ')).toMatch(/RAISE/)
    expect(checkMonitorRows(JSON.stringify([1, 2])).problems[0]).toMatch(/not dicts/)
  })

  it('reads a Python tool answer with printed output after it', () => {
    expect(checkMonitorRows('[{"job": "A"}]\n\n--- stdout ---\nconnecting...').verdict).toBe('pass')
  })
})

describe('a team monitor', () => {
  it('is refused, writing nothing, when the team has no OpenSearch history', async () => {
    let written = false
    const channel: MonitoringChannel = { request: async (op) => (op === 'list' ? { teamReady: false, teamProblem: 'choose an OpenSearch connection' } : {}) }
    const writeSkill = { name: 'write_skill', group: 'edit', description: '', parametersSchema: z.object({}), execute: async () => ((written = true), { content: 'ok' }) } as unknown as Parameters<typeof createMonitorCreateTool>[0]['writeSkill']
    const result = await createMonitorCreateTool({ channel, writeSkill, runTool: async () => ({ content: '' }) }).execute({ ...params, audience: 'team' }, {} as ToolExecutionContext)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/OpenSearch/)
    expect(written).toBe(false)
  })

  it('is made personal when nobody said who it is for and the team has no history - nothing to configure', async () => {
    let audience: unknown
    const channel: MonitoringChannel = {
      request: async (op) => {
        if (op === 'list') return { teamReady: false, teamProblem: 'choose an OpenSearch connection' }
        if (op === 'evaluate') return { level: 'green', meaning: 'All clear', headline: 'All clear', rows: 0, columns: [], alerts: [], sourceKind: 'sqlite' }
        return {}
      },
    }
    const writeSkill = {
      name: 'write_skill',
      group: 'edit',
      description: '',
      parametersSchema: z.object({}),
      execute: async (p: { audience?: unknown }) => ((audience = p.audience), { content: 'Recorded the skill.' }),
    } as unknown as Parameters<typeof createMonitorCreateTool>[0]['writeSkill']
    const result = await createMonitorCreateTool({ channel, writeSkill, runTool: async () => ({ content: '' }) }).execute(params, {} as ToolExecutionContext)
    expect(result.isError).toBeUndefined()
    expect(audience).toBe('me')
    expect(result.content).toMatch(/Personal \(only on this computer\)/)
  })

  it('keeps the author\'s advice in the block', () => {
    const block = JSON.parse(monitorBlock({ ...params, runbook: 'Owned by payments ops.', rules: [{ level: 'red' as const, when: { column: 'status', op: '==', value: 'FAILURE' }, advice: 'Rerun it once; if it fails again call ops.' }] })) as { runbook: string; rules: { advice: string }[] }
    expect(block.runbook).toBe('Owned by payments ops.')
    expect(block.rules[0]?.advice).toMatch(/Rerun it once/)
  })
})

describe('monitor_control', () => {
  it('shows the alerts it would acknowledge, read now', async () => {
    const channel: MonitoringChannel = {
      request: async () => ({ record: { evaluation: { alerts: [{ id: '0|A|status', level: 'red', message: 'A failed' }, { id: '0|B|status', level: 'red', message: 'B failed' }] } } }),
    }
    const control = createMonitorControlTool({ channel, writeSkill: {} as never, runTool: async () => ({ content: '' }) })
    const preview = await control.preview!({ action: 'ack', name: 'batch', ids: ['0|B|status'] }, {} as ToolExecutionContext)
    expect(preview.kind === 'text' ? preview.text : '').toContain('B failed')
    expect(preview.kind === 'text' ? preview.text : '').not.toContain('A failed')
  })
})

describe('the template a monitoring tool starts from', () => {
  it('calls another tool with keyword arguments - a dict was a TypeError before the call left the tool', () => {
    expect(MONITOR_TOOL_TEMPLATE).toContain('light_code.call_tool("server__query_jobs", pattern=pattern)')
    expect(MONITOR_TOOL_TEMPLATE).not.toMatch(/call_tool\("[^"]+",\s*\{/)
  })

  it('advises Polars, and the check says whether it is installed', async () => {
    expect(MONITOR_TOOL_TEMPLATE).toContain('df.to_dicts()')
    const rows = '[{"job": "A", "status": "OK", "minutes": 3}]'
    const check = (has: boolean | undefined) =>
      createMonitorCheckToolTool({ channel: { request: async () => ({}) }, writeSkill: {} as never, runTool: async () => ({ content: rows }), hasModule: async () => has })
    expect((await check(true).execute({ tool: 'py__jobs' }, {} as ToolExecutionContext)).content).toMatch(/Polars is installed/)
    expect((await check(false).execute({ tool: 'py__jobs' }, {} as ToolExecutionContext)).content).toMatch(/Polars is not installed/)
  })
})
