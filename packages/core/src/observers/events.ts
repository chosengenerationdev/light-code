import { matchRiskyCommand, type RiskyCommandRule } from '../approval/riskyCommands.js'

/**
 * What the Auditor and the Anti Hallucinator see of the main agent: one event per thing it did.
 *
 * Built from the loop's own callbacks (`agent/loop.ts`), never from the model's description of what it
 * is doing - an approval event carries the literal preview the user was shown (invariant 8), and a tool
 * result carries what the tool returned. Text is capped here, once, so the journal, the index and the
 * observer processes all get the same record.
 */
export type ObservedEvent =
  | { kind: 'turnStart'; at: number; text: string; mode: string; model: string }
  | { kind: 'reasoning'; at: number; text: string }
  | { kind: 'assistant'; at: number; text: string }
  | { kind: 'toolCall'; at: number; tool: string; args: string }
  | { kind: 'approval'; at: number; tool: string; decision: 'approved' | 'denied'; preview: string; outsideWorkspace?: boolean }
  | { kind: 'refused'; at: number; tool: string; reason: string }
  | { kind: 'toolResult'; at: number; tool: string; ok: boolean; text: string }
  | { kind: 'turnEnd'; at: number; ending: 'done' | 'question' | 'error' | 'cancelled'; error?: string }

/** Per field, in characters. Reasoning and results are where the volume is. */
export const EVENT_LIMITS = { text: 8_000, reasoning: 6_000, args: 4_000, preview: 4_000, result: 3_000 } as const

export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${String(text.length - max)} more characters not recorded]`
}

/** The event with every text field capped. */
export function capEvent(event: ObservedEvent): ObservedEvent {
  switch (event.kind) {
    case 'turnStart':
      return { ...event, text: cap(event.text, EVENT_LIMITS.text) }
    case 'reasoning':
      return { ...event, text: cap(event.text, EVENT_LIMITS.reasoning) }
    case 'assistant':
      return { ...event, text: cap(event.text, EVENT_LIMITS.text) }
    case 'toolCall':
      return { ...event, args: cap(event.args, EVENT_LIMITS.args) }
    case 'approval':
      return { ...event, preview: cap(event.preview, EVENT_LIMITS.preview) }
    case 'refused':
      return { ...event, reason: cap(event.reason, EVENT_LIMITS.result) }
    case 'toolResult':
      return { ...event, text: cap(event.text, EVENT_LIMITS.result) }
    case 'turnEnd':
      return event.error === undefined ? event : { ...event, error: cap(event.error, EVENT_LIMITS.result) }
  }
}

export type DangerLevel = 'medium' | 'high'

export interface DangerSignal {
  level: DangerLevel
  /** One sentence for a notification and the journal. */
  message: string
  /** Whether the user should be told now. A denial they made themselves is recorded, not announced. */
  notify: boolean
}

/** The refusals Light Code itself makes, by their exact wording (`tools/paths.ts`, `fs/confine.ts`, `agent/loop.ts`). */
const REFUSALS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /Access to "[^"]*" is denied/, what: 'tried to reach a path on the deny list (keys, passwords or credentials, or a folder it may not read)' },
  { pattern: /resolves outside the workspace root/, what: 'tried to reach a path outside the workspace' },
  { pattern: /is not available in .+ mode\./, what: 'called a tool the current mode does not allow' },
]

/**
 * What in one event is dangerous and not allowed - deterministic, so the alert does not wait for, or depend
 * on, the Auditor's model. The model's own judgement adds to these (`auditVerdict`); it never removes one.
 */
export function dangerSignals(event: ObservedEvent, riskyRules: readonly RiskyCommandRule[]): DangerSignal[] {
  const found: DangerSignal[] = []
  if (event.kind === 'approval') {
    // The first line only: the second is the working folder, and a folder's name is not the command.
    const command = event.preview.startsWith('$ ') ? event.preview.slice(2).split('\n')[0] : undefined
    const risky = command !== undefined ? matchRiskyCommand(command, riskyRules) : undefined
    if (risky !== undefined) {
      found.push(
        event.decision === 'approved'
          ? { level: 'high', message: `The agent ran a command marked risky ("${risky.matched}"): ${cap(command ?? '', 200)}`, notify: true }
          : { level: 'medium', message: `The agent asked to run a command marked risky ("${risky.matched}") and it was refused.`, notify: false },
      )
    }
    if (event.outsideWorkspace === true && event.decision === 'approved') {
      found.push({ level: 'medium', message: `The agent changed a file outside the workspace with ${event.tool}; Rollback cannot undo it.`, notify: true })
    }
    if (event.decision === 'denied' && risky === undefined) {
      found.push({ level: 'medium', message: `${event.tool} was refused permission.`, notify: false })
    }
  }
  if (event.kind === 'refused' || (event.kind === 'toolResult' && !event.ok)) {
    const text = event.kind === 'refused' ? event.reason : event.text
    for (const refusal of REFUSALS) {
      if (refusal.pattern.test(text)) found.push({ level: 'high', message: `The agent ${refusal.what} (${event.tool}).`, notify: true })
    }
  }
  return found
}

/** The literal preview an approval showed, as one string - what the user approved, not what the model said. */
export function previewText(preview: { kind: 'command'; command: string; cwd: string } | { kind: 'diff'; path: string; before: string; after: string } | { kind: 'text'; text: string }): string {
  if (preview.kind === 'command') return `$ ${preview.command}\n(in ${preview.cwd})`
  if (preview.kind === 'diff') return `${preview.path}\n--- before (${String(preview.before.length)} characters)\n+++ after (${String(preview.after.length)} characters)\n${cap(preview.after, 2_000)}`
  return preview.text
}

/** The Auditor's reply, checked: anything else it says is ignored rather than trusted. */
export interface AuditVerdict {
  summary: string
  risk: 'none' | 'low' | 'medium' | 'high'
  concerns: string[]
  alert?: string
}

export function auditVerdict(reply: unknown): AuditVerdict | undefined {
  if (typeof reply !== 'object' || reply === null) return undefined
  const r = reply as Record<string, unknown>
  const summary = typeof r['summary'] === 'string' ? cap(r['summary'], 2_000) : ''
  const risk = r['risk'] === 'low' || r['risk'] === 'medium' || r['risk'] === 'high' ? r['risk'] : 'none'
  const concerns = Array.isArray(r['concerns']) ? r['concerns'].filter((c): c is string => typeof c === 'string' && c.trim().length > 0).slice(0, 10).map((c) => cap(c, 500)) : []
  const alert = typeof r['alert'] === 'string' && r['alert'].trim().length > 0 ? cap(r['alert'].trim(), 500) : undefined
  if (summary.length === 0 && concerns.length === 0 && alert === undefined) return undefined
  return { summary, risk, concerns, ...(alert !== undefined ? { alert } : {}) }
}

/** The Anti Hallucinator's reply: a note for the agent, or nothing to say. */
export interface GuardVerdict {
  note: string
  severity: 'low' | 'high'
}

export function guardVerdict(reply: unknown): GuardVerdict | undefined {
  if (typeof reply !== 'object' || reply === null) return undefined
  const r = reply as Record<string, unknown>
  if (r['verdict'] !== 'note') return undefined
  const note = typeof r['note'] === 'string' ? r['note'].trim() : ''
  if (note.length === 0) return undefined
  return { note: cap(note, 800), severity: r['severity'] === 'high' ? 'high' : 'low' }
}

/**
 * The first line of every note. Owned here, because everything that asks "did the user type this" must skip a
 * note: `http_request` lets the model reach only hosts the user's own messages name, so a note counted as the
 * user's words could authorise a host nobody typed.
 */
export const OBSERVER_NOTE_PREFIX = '[Anti Hallucinator - an automatic reviewer the user switched on, not a message from the user]'

export function isObserverNote(content: string): boolean {
  return content.startsWith(OBSERVER_NOTE_PREFIX)
}

/**
 * How a note reaches the main agent: a user message that says plainly nobody typed it.
 *
 * Advisory and nothing more. It grants no permission - acting on it still goes through the approval gate -
 * and it is not the user's word, so the agent is told to weigh it against the evidence, not obey it.
 */
export function noteForAgent(notes: readonly GuardVerdict[]): string {
  const lines = notes.map((n) => `- ${n.severity === 'high' ? '(important) ' : ''}${n.note.replace(/\s*\n\s*/g, ' ')}`)
  return [
    OBSERVER_NOTE_PREFIX,
    'It watched your last steps and raises:',
    ...lines,
    'Check this against the evidence (tool results, files you read). If it is right, correct course; if it is wrong, carry on. It grants no permission.',
  ].join('\n')
}
