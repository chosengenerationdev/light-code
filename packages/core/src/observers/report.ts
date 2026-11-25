import type { AuditRecord } from './journal.js'

/**
 * What happened in a task, from the Auditor's record: who took part (asked for: "Auditor should be able to provide a
 * report on what roles models taken place to implement a task") and everything Light Code did behind the scenes,
 * request by request (asked for: "what are all the things happened behind the scene, like how reranking model was used
 * and how decision model was used etc, so that user can review if things happened in the way he wanted to or not").
 * Read from what was recorded as it happened - each request's model and mode, each specialist with its model, the
 * decision model's choices with their probabilities, the reranker's reorderings, the memory, retries, reviews - never
 * from what the agent said it did.
 */

export interface RolesReport {
  task?: string
  from?: number
  until?: number
  requests: number
  main: { model: string; mode: string; requests: number }[]
  specialists: { role: string; name: string; model: string; consultations: number; failed: number; seconds: number; readOnly: number }[]
  decisions: { purpose: string; count: number }[]
  participants: Record<string, string>
  reviews: { findings: number; alerts: number; notes: number }
  tools: { tool: string; calls: number }[]
  /** Request by request, everything that happened behind the scenes, in order. */
  timeline: { at: number; request: string; lines: string[] }[]
}

const LINES_PER_REQUEST = 40

export function rolesReport(records: readonly AuditRecord[]): RolesReport {
  const main = new Map<string, { model: string; mode: string; requests: number }>()
  const specialists = new Map<string, RolesReport['specialists'][number]>()
  const decisions = new Map<string, number>()
  const tools = new Map<string, number>()
  const participants: Record<string, string> = {}
  const timeline: RolesReport['timeline'] = []
  const line = (at: number, text: string): void => {
    let current = timeline.at(-1)
    if (current === undefined) {
      current = { at, request: '(before the first request)', lines: [] }
      timeline.push(current)
    }
    if (current.lines.length < LINES_PER_REQUEST) current.lines.push(text)
    else if (current.lines.length === LINES_PER_REQUEST) current.lines.push('… (more not shown - read_audit_log with action records has them all)')
  }
  let requests = 0
  let from: number | undefined
  let until: number | undefined
  const reviews = { findings: 0, alerts: 0, notes: 0 }

  for (const record of [...records].sort((a, b) => a.at - b.at)) {
    from = from === undefined ? record.at : Math.min(from, record.at)
    until = until === undefined ? record.at : Math.max(until, record.at)
    if (record.finding !== undefined) {
      reviews.findings += 1
      if (record.finding.risk !== 'none') line(record.at, `Auditor (${record.finding.risk} risk): ${record.finding.summary.slice(0, 200)}`)
    }
    if (record.alert !== undefined) {
      reviews.alerts += 1
      line(record.at, `Alert (${record.alert.level}): ${record.alert.message.slice(0, 200)}`)
    }
    if (record.note !== undefined) {
      reviews.notes += 1
      line(record.at, `Anti Hallucinator: ${record.note.note.slice(0, 240)}`)
    }
    const e = record.event
    if (e === undefined) continue
    if (e.kind === 'turnStart') {
      requests += 1
      const key = `${e.model}|${e.mode}`
      const entry = main.get(key) ?? { model: e.model, mode: e.mode, requests: 0 }
      entry.requests += 1
      main.set(key, entry)
      for (const [who, model] of Object.entries(e.participants ?? {})) participants[who] = model
      timeline.push({ at: record.at, request: e.text.replace(/\s+/g, ' ').slice(0, 120), lines: [`${e.model}, ${e.mode} mode`] })
    } else if (e.kind === 'consultation') {
      const key = `${e.role}|${e.model}`
      const entry = specialists.get(key) ?? { role: e.role, name: e.name, model: e.model, consultations: 0, failed: 0, seconds: 0, readOnly: 0 }
      entry.consultations += 1
      if (!e.ok) entry.failed += 1
      if (e.readOnly === true) entry.readOnly += 1
      entry.seconds += Math.round(e.ms / 1000)
      specialists.set(key, entry)
      line(record.at, `Consulted ${e.name} (${e.model})${e.readOnly === true ? ', read-only' : ''} - ${String(Math.round(e.ms / 1000))} s${e.ok ? '' : ', failed'}`)
    } else if (e.kind === 'decision') {
      decisions.set(e.purpose, (decisions.get(e.purpose) ?? 0) + 1)
      const best = Object.entries(e.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0]
      line(record.at, `Decision model - ${e.purpose}: ${e.outcome}${best !== undefined ? ` (${best[0]} ${best[1].toFixed(2)})` : ''}`)
    } else if (e.kind === 'behind') {
      line(record.at, e.summary)
    } else if (e.kind === 'toolCall') {
      tools.set(e.tool, (tools.get(e.tool) ?? 0) + 1)
    } else if (e.kind === 'approval' && e.decision === 'denied') {
      line(record.at, `You denied ${e.tool}`)
    } else if (e.kind === 'refused') {
      line(record.at, `Refused: ${e.tool} - ${e.reason.slice(0, 160)}`)
    }
  }
  const task = records.find((record) => record.task !== undefined)?.task
  return {
    ...(task !== undefined ? { task } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(until !== undefined ? { until } : {}),
    requests,
    main: [...main.values()].sort((a, b) => b.requests - a.requests),
    specialists: [...specialists.values()].sort((a, b) => b.consultations - a.consultations),
    decisions: [...decisions.entries()].map(([purpose, count]) => ({ purpose, count })).sort((a, b) => b.count - a.count),
    participants,
    reviews,
    tools: [...tools.entries()].map(([tool, calls]) => ({ tool, calls })).sort((a, b) => b.calls - a.calls).slice(0, 15),
    timeline,
  }
}

/** The report as Markdown, for the chat and the Auditor panel. */
export function renderRolesReport(report: RolesReport, title = 'What happened in this task'): string {
  if (report.requests === 0 && report.specialists.length === 0 && report.timeline.length === 0) {
    return `## ${title}\n\nNothing recorded for it. The Auditor records only while it is switched on (Settings → Project → Auditor).`
  }
  const when = (at: number | undefined): string => (at === undefined ? '?' : new Date(at).toLocaleString())
  const lines = [`## ${title}`, '', `${String(report.requests)} request(s), ${when(report.from)} to ${when(report.until)}.`, '', '### Main agent', '', '| Model | Mode | Requests |', '| --- | --- | --- |']
  for (const entry of report.main) lines.push(`| ${entry.model} | ${entry.mode} | ${String(entry.requests)} |`)
  lines.push('', '### Specialists consulted', '')
  if (report.specialists.length === 0) lines.push('None.')
  else {
    lines.push('| Role | Model | Consultations | Failed | Time |', '| --- | --- | --- | --- | --- |')
    for (const s of report.specialists) lines.push(`| ${s.name}${s.readOnly > 0 ? ' (read-only step)' : ''} | ${s.model} | ${String(s.consultations)} | ${String(s.failed)} | ${String(s.seconds)} s |`)
  }
  const others = Object.entries(report.participants)
  if (others.length > 0 || report.decisions.length > 0) {
    lines.push('', '### Also involved', '')
    for (const [who, model] of others) lines.push(`- ${who}: ${model}`)
    for (const d of report.decisions) lines.push(`- decision model - ${d.purpose}: ${String(d.count)} time(s)`)
  }
  lines.push('', `Reviews: ${String(report.reviews.findings)} Auditor finding(s), ${String(report.reviews.alerts)} alert(s), ${String(report.reviews.notes)} Anti Hallucinator note(s).`)
  if (report.tools.length > 0) lines.push('', `Tools used most: ${report.tools.map((t) => `${t.tool} (${String(t.calls)})`).join(', ')}.`)
  if (report.timeline.length > 0) {
    lines.push('', '### Behind the scenes, request by request')
    for (const entry of report.timeline) {
      lines.push('', `**${new Date(entry.at).toLocaleTimeString()} - ${entry.request}**`)
      for (const text of entry.lines) lines.push(`- ${text}`)
    }
  }
  return lines.join('\n')
}
