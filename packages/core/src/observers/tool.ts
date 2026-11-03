import { z } from 'zod'

import type { Tool, ToolResult } from '../tools/types.js'
import type { AuditIndex } from './auditIndex.js'
import { readAudit, type AuditQuery, type AuditRecord, type AuditRecordType } from './journal.js'

/**
 * Reading the Auditor's record back, for analysis later - asked for directly: "provide tools to agents to read
 * agent audit info for further analysis in future".
 *
 * Read group, and it reads only the record this user's own Auditor wrote: the local journal under their
 * storage folder, or their own OpenSearch index. Records come back as flat JSON rows, so a large answer
 * carries the truncation note's `dataframe` handle and any metric is SQL over rows nobody retyped (§12af).
 */

const TYPES = ['event', 'finding', 'alert', 'note', 'status'] as const

const schema = z.object({
  action: z
    .enum(['records', 'summary'])
    .default('summary')
    .describe('summary: counts by type, tool and day, every alert, the sessions. records: the matching records themselves, newest first.'),
  source: z
    .enum(['local', 'index'])
    .default('local')
    .describe('local: the journal on this machine (always there). index: your OpenSearch audit index, when one is configured - it also holds what your other machines recorded.'),
  hours: z.number().positive().max(24 * 3650).optional().describe('Only the last N hours. Overridden by from/until.'),
  from: z.string().optional().describe('ISO date or date-time, inclusive.'),
  until: z.string().optional().describe('ISO date or date-time, inclusive. A bare date means the end of that day.'),
  types: z.array(z.enum(TYPES)).optional().describe('event (what the agent did), finding (the Auditor\'s review), alert (dangerous or refused actions), note (the Anti Hallucinator\'s notes), status.'),
  tool: z.string().optional().describe('Only events of this exact tool name.'),
  contains: z.string().optional().describe('Text the record must contain (case-insensitive).'),
  session: z.string().optional().describe('One session id, from a summary.'),
  allWorkspaces: z.boolean().optional().describe('Every project audited on this machine, not only this one.'),
  limit: z.number().int().min(1).max(2000).optional().describe('Most records returned (default 200).'),
})

export type ReadAuditParams = z.infer<typeof schema>

function time(text: string | undefined, endOfDay: boolean): number | undefined {
  if (text === undefined || text.trim().length === 0) return undefined
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(text.trim())
  const parsed = Date.parse(bare ? `${text.trim()}T${endOfDay ? '23:59:59.999' : '00:00:00'}` : text)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** One flat row per record: what a table of audit history wants. */
export function auditRow(record: AuditRecord): Record<string, unknown> {
  const e = record.event
  const row: Record<string, unknown> = { at: new Date(record.at).toISOString(), type: record.type, session: record.session, project: record.project, user: record.user }
  if (record.task !== undefined) row['task'] = record.task
  if (e !== undefined) {
    row['kind'] = e.kind
    if ('tool' in e) row['tool'] = e.tool
    if (e.kind === 'approval') {
      row['decision'] = e.decision
      row['text'] = e.preview
    } else if (e.kind === 'toolResult') {
      row['ok'] = e.ok
      row['text'] = e.text
    } else if (e.kind === 'toolCall') row['text'] = e.args
    else if (e.kind === 'refused') row['text'] = e.reason
    else if (e.kind === 'turnEnd') {
      row['ending'] = e.ending
      if (e.error !== undefined) row['text'] = e.error
    } else row['text'] = e.text
    if (e.kind === 'turnStart') {
      row['mode'] = e.mode
      row['model'] = e.model
    }
  }
  if (record.finding !== undefined) {
    row['level'] = record.finding.risk
    row['text'] = [record.finding.summary, ...record.finding.concerns.map((c) => `concern: ${c}`)].join('\n')
  }
  if (record.alert !== undefined) {
    row['level'] = record.alert.level
    row['source'] = record.alert.source
    row['text'] = record.alert.message
  }
  if (record.note !== undefined) {
    row['level'] = record.note.severity
    row['text'] = record.note.note
  }
  if (record.status !== undefined) row['text'] = record.status
  return row
}

export function summariseAudit(records: readonly AuditRecord[]): Record<string, unknown> {
  const count = (key: (r: AuditRecord) => string | undefined): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const r of records) {
      const k = key(r)
      if (k !== undefined) out[k] = (out[k] ?? 0) + 1
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]))
  }
  const sessions = new Map<string, { first: number; last: number; records: number; project: string }>()
  for (const r of records) {
    const s = sessions.get(r.session) ?? { first: r.at, last: r.at, records: 0, project: r.project }
    s.first = Math.min(s.first, r.at)
    s.last = Math.max(s.last, r.at)
    s.records += 1
    sessions.set(r.session, s)
  }
  return {
    records: records.length,
    byType: count((r) => r.type),
    byTool: count((r) => (r.type === 'event' && r.event !== undefined && 'tool' in r.event && r.event.kind === 'toolCall' ? r.event.tool : undefined)),
    failedTools: count((r) => (r.event?.kind === 'toolResult' && !r.event.ok ? r.event.tool : undefined)),
    denied: count((r) => (r.event?.kind === 'approval' && r.event.decision === 'denied' ? r.event.tool : undefined)),
    byDay: count((r) => new Date(r.at).toISOString().slice(0, 10)),
    findingRisk: count((r) => r.finding?.risk),
    alerts: records.filter((r) => r.alert !== undefined).slice(0, 50).map(auditRow),
    notes: records.filter((r) => r.note !== undefined).slice(0, 20).map(auditRow),
    sessions: [...sessions.entries()].slice(0, 30).map(([id, s]) => ({ session: id, project: s.project, from: new Date(s.first).toISOString(), until: new Date(s.last).toISOString(), records: s.records })),
  }
}

export function createReadAuditTool(deps: { storageDir: string; workspace: string | undefined; workspaceId: string | undefined; index: () => AuditIndex | undefined }): Tool<ReadAuditParams> {
  return {
    name: 'read_audit_log',
    group: 'read',
    description:
      "Read the Auditor's record of what agents did in this project: every user request, reasoning step, tool call, approval (the literal action shown), " +
      "result and turn end, plus the Auditor's findings, alerts about dangerous or refused actions, and the Anti Hallucinator's notes. " +
      'Use action "summary" first (counts, alerts, sessions), then "records" with filters for detail. Rows are flat JSON, so a large answer can go to the dataframe tool.',
    parametersSchema: schema as unknown as z.ZodType<ReadAuditParams>,
    async execute(params): Promise<ToolResult> {
      const until = time(params.until, true)
      const from = time(params.from, false) ?? (params.hours !== undefined ? Date.now() - params.hours * 3_600_000 : undefined)
      if (params.from !== undefined && time(params.from, false) === undefined) return { content: `"${params.from}" is not a date.`, isError: true }
      if (params.until !== undefined && until === undefined) return { content: `"${params.until}" is not a date.`, isError: true }
      const query: AuditQuery = {
        ...(from !== undefined ? { from } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(params.types !== undefined ? { types: params.types as AuditRecordType[] } : {}),
        ...(params.tool !== undefined ? { tool: params.tool } : {}),
        ...(params.contains !== undefined ? { contains: params.contains } : {}),
        ...(params.session !== undefined ? { session: params.session } : {}),
        ...(params.allWorkspaces === true ? { allWorkspaces: true } : {}),
        limit: params.action === 'summary' ? 2000 : (params.limit ?? 200),
      }
      let records: AuditRecord[]
      let note: string
      if (params.source === 'index') {
        const index = deps.index()
        if (index === undefined) return { content: 'No OpenSearch audit index is configured here: use source "local", or connect OpenSearch in Settings → Search and switch on "Also record in OpenSearch" for the Auditor (Settings → Project).', isError: true }
        try {
          const found = await index.search(query, deps.workspaceId)
          records = found.records
          note = `From ${index.index}: ${String(records.length)} of ${String(found.total)} matching record(s).`
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true }
        }
      } else {
        const found = await readAudit(deps.storageDir, deps.workspace, query)
        records = found.records
        note = `From the journal on this machine: ${String(records.length)} record(s)${found.more > 0 ? `, and ${String(found.more)} more not returned (narrow the range or raise limit)` : ''}, from ${String(found.filesRead)} file(s).${found.unreadable.length > 0 ? ` Unreadable: ${found.unreadable.join('; ')}` : ''}`
      }
      if (records.length === 0) {
        return { content: `${note}\nNothing matched. The Auditor records only while it is switched on (Settings → Project → Auditor).` }
      }
      const body = params.action === 'summary' ? summariseAudit(records) : records.map(auditRow)
      return { content: `${note}\n${JSON.stringify(body, null, 2)}` }
    },
  }
}
