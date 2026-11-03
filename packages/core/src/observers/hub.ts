import { redact } from '../logging/redact.js'
import type { RiskyCommandRule } from '../approval/riskyCommands.js'
import type { AuditIndex } from './auditIndex.js'
import { auditVerdict, capEvent, dangerSignals, guardVerdict, type GuardVerdict, type ObservedEvent } from './events.js'
import { AuditJournal, type AuditRecord } from './journal.js'
import type { ObserverAgent, ObserverRole, ObserverStatus } from './process.js'

/**
 * Where the bridge reports what the main agent does, and where the Auditor and the Anti Hallucinator are fed
 * from. One per bridge (a window, or one Fire Code chat).
 *
 * The parts that matter most do not depend on any model: the journal is written here, and the dangerous-
 * and-not-allowed checks (`dangerSignals`) run here and notify at once. The observer processes add
 * judgement on top - a finding, a risk level, a note for the agent - and their absence or failure costs
 * only that.
 */

export interface ObserverSettings {
  auditor: { enabled: boolean; recordReasoning: boolean; notify: boolean }
  guard: { enabled: boolean }
}

export interface ObserverHubDeps {
  storageDir: string
  workspace: string
  /** `workspaceAuditFolder(workspace)`: the id records carry. */
  workspaceId: string
  session: string
  user: () => string
  project: () => string
  task: () => string | undefined
  secretValues: () => readonly string[]
  riskyRules: () => readonly RiskyCommandRule[]
  /** A desktop notification in Fire Code, a warning toast in VS Code. */
  notify: (message: string) => void
  log: (message: string) => void
  /** Posted to the panel: statuses changed, or a note or alert arrived. */
  changed: () => void
  /** The user's audit index, when OpenSearch is configured; undefined otherwise. */
  index: () => AuditIndex | undefined
  /** Starts an observer process, or says why it cannot run here. */
  startAgent: (role: ObserverRole, hooks: { onResult: (reply: unknown, raw: string) => void; onStatus: (status: ObserverStatus) => void }) => Promise<ObserverAgent | { problem: string }>
}

const NOTIFY_GAP_MS = 20_000
const INDEX_BATCH = 50
const INDEX_EVERY_MS = 10_000
const INDEX_MAX_QUEUED = 2_000

export interface ObserverPanelState {
  settings: ObserverSettings
  auditor?: ObserverStatus
  guard?: ObserverStatus
  /** Why an enabled observer is not running, when it is not. */
  auditorProblem?: string
  guardProblem?: string
  journalFolder: string
  index?: { name: string; queued: number; written: number; lastError?: string }
  /** Newest first. */
  alerts: { at: number; level: string; message: string }[]
  notes: { at: number; note: string; severity: string; delivered: boolean }[]
}

export class ObserverHub {
  private settings: ObserverSettings = { auditor: { enabled: false, recordReasoning: true, notify: true }, guard: { enabled: false } }
  private readonly journal: AuditJournal
  private auditor: ObserverAgent | undefined
  private guard: ObserverAgent | undefined
  private auditorStatus: ObserverStatus | undefined
  private guardStatus: ObserverStatus | undefined
  private auditorProblem: string | undefined
  private guardProblem: string | undefined
  /** Bumped on every configure, so a start that finishes after a newer configure is discarded. */
  private epoch = 0
  private pendingNotes: GuardVerdict[] = []
  private notes: ObserverPanelState['notes'] = []
  private alerts: ObserverPanelState['alerts'] = []
  private lastNotifyAt = 0
  private suppressed = 0
  private indexQueue: AuditRecord[] = []
  private indexWritten = 0
  private indexError: string | undefined
  private indexTimer: ReturnType<typeof setInterval> | undefined
  private indexing = false
  private journalError = false

  constructor(private readonly deps: ObserverHubDeps) {
    this.journal = new AuditJournal(deps.storageDir, deps.workspace, deps.session)
  }

  get journalFolder(): string {
    return this.journal.folder
  }

  /** Applies settings; starts or stops each observer to match. Safe to call on every settings load. */
  async configure(next: ObserverSettings): Promise<void> {
    const previous = this.settings
    this.settings = next
    const epoch = ++this.epoch
    if (next.auditor.enabled && this.indexTimer === undefined) {
      this.indexTimer = setInterval(() => void this.flushIndex(), INDEX_EVERY_MS)
      this.indexTimer.unref?.()
    }
    if (!next.auditor.enabled && this.indexTimer !== undefined) {
      clearInterval(this.indexTimer)
      this.indexTimer = undefined
      void this.flushIndex()
    }
    await this.align('auditor', previous.auditor.enabled, next.auditor.enabled, epoch)
    await this.align('guard', previous.guard.enabled, next.guard.enabled, epoch)
    this.deps.changed()
  }

  /** Stops and restarts both, e.g. after their model was changed. */
  async restart(): Promise<void> {
    this.stopAgent('auditor')
    this.stopAgent('guard')
    const epoch = ++this.epoch
    await this.align('auditor', false, this.settings.auditor.enabled, epoch)
    await this.align('guard', false, this.settings.guard.enabled, epoch)
    this.deps.changed()
  }

  private stopAgent(role: ObserverRole): void {
    if (role === 'auditor') {
      this.auditor?.stop()
      this.auditor = undefined
      this.auditorStatus = undefined
    } else {
      this.guard?.stop()
      this.guard = undefined
      this.guardStatus = undefined
      this.pendingNotes = []
    }
  }

  private async align(role: ObserverRole, was: boolean, now: boolean, epoch: number): Promise<void> {
    const running = role === 'auditor' ? this.auditor : this.guard
    if (!now) {
      this.stopAgent(role)
      if (role === 'auditor') this.auditorProblem = undefined
      else this.guardProblem = undefined
      return
    }
    if (running !== undefined && was) return
    const started = await this.deps.startAgent(role, {
      onResult: (reply, raw) => this.onReply(role, reply, raw),
      onStatus: (status) => {
        if (role === 'auditor') this.auditorStatus = status
        else this.guardStatus = status
        this.deps.changed()
      },
    })
    if (epoch !== this.epoch) {
      if (!('problem' in started)) started.stop()
      return
    }
    if ('problem' in started) {
      if (role === 'auditor') this.auditorProblem = started.problem
      else this.guardProblem = started.problem
      return
    }
    if (role === 'auditor') {
      this.auditor = started
      this.auditorProblem = undefined
    } else {
      this.guard = started
      this.guardProblem = undefined
    }
    started.start()
  }

  /** One thing the main agent did. Cheap when both observers are off. */
  event(raw: ObservedEvent): void {
    const { auditor, guard } = this.settings
    if (!auditor.enabled && !guard.enabled) return
    const secrets = this.deps.secretValues()
    const event = redactEvent(capEvent(raw), secrets)
    if (auditor.enabled) {
      if (event.kind !== 'reasoning' || auditor.recordReasoning) {
        this.record({ type: 'event', event })
        this.auditor?.send(event)
      }
      for (const signal of dangerSignals(event, this.deps.riskyRules())) {
        this.alert(signal.level, signal.message, 'rules', signal.notify)
      }
    }
    if (guard.enabled) this.guard?.send(event)
    // The end of a turn is when the auditor's batch is due and the guard has the whole step.
    if (event.kind === 'turnEnd') this.auditor?.flush()
  }

  /** Notes for the main agent, taken once: they join its conversation at the next step. */
  takeNotes(): GuardVerdict[] {
    const taken = this.pendingNotes
    this.pendingNotes = []
    if (taken.length > 0) {
      for (const note of this.notes) if (taken.some((t) => t.note === note.note)) note.delivered = true
      this.deps.changed()
    }
    return taken
  }

  /** The panel's view. */
  panel(indexName: string | undefined): ObserverPanelState {
    return {
      settings: this.settings,
      ...(this.auditorStatus !== undefined ? { auditor: this.auditorStatus } : {}),
      ...(this.guardStatus !== undefined ? { guard: this.guardStatus } : {}),
      ...(this.auditorProblem !== undefined ? { auditorProblem: this.auditorProblem } : {}),
      ...(this.guardProblem !== undefined ? { guardProblem: this.guardProblem } : {}),
      journalFolder: this.journal.folder,
      ...(indexName !== undefined ? { index: { name: indexName, queued: this.indexQueue.length, written: this.indexWritten, ...(this.indexError !== undefined ? { lastError: this.indexError } : {}) } } : {}),
      alerts: this.alerts.slice(0, 20),
      notes: this.notes.slice(0, 20),
    }
  }

  async dispose(): Promise<void> {
    this.stopAgent('auditor')
    this.stopAgent('guard')
    if (this.indexTimer !== undefined) clearInterval(this.indexTimer)
    this.indexTimer = undefined
    await this.flushIndex()
    await this.journal.flushed()
  }

  /** For tests. */
  flushed(): Promise<void> {
    return this.journal.flushed()
  }

  private onReply(role: ObserverRole, reply: unknown, raw: string): void {
    if (role === 'auditor') {
      const verdict = auditVerdict(reply)
      if (verdict === undefined) {
        if (raw.length > 0) this.record({ type: 'status', status: `The Auditor's reply was not the JSON it was asked for: ${raw.slice(0, 500)}` })
        return
      }
      this.record({ type: 'finding', finding: verdict })
      this.auditor?.remember(`${verdict.risk} risk: ${verdict.summary}`)
      if (verdict.alert !== undefined) this.alert(verdict.risk === 'high' ? 'high' : 'medium', verdict.alert, 'auditor', true)
      else if (verdict.risk === 'high') this.alert('high', verdict.concerns[0] ?? verdict.summary, 'auditor', true)
      return
    }
    const note = guardVerdict(reply)
    if (note === undefined) return
    // The same note twice in a row is a reviewer repeating itself, not new information.
    if (this.pendingNotes.some((n) => n.note === note.note) || this.notes[0]?.note === note.note) return
    this.pendingNotes.push(note)
    if (this.pendingNotes.length > 5) this.pendingNotes.shift()
    this.notes.unshift({ at: Date.now(), note: note.note, severity: note.severity, delivered: false })
    this.notes = this.notes.slice(0, 50)
    this.guard?.remember(note.note)
    if (this.settings.auditor.enabled) this.record({ type: 'note', note })
    this.deps.changed()
  }

  private alert(level: 'medium' | 'high', message: string, source: 'rules' | 'auditor', notify: boolean): void {
    this.record({ type: 'alert', alert: { level, message, source } })
    this.alerts.unshift({ at: Date.now(), level, message })
    this.alerts = this.alerts.slice(0, 50)
    this.deps.changed()
    if (!notify || !this.settings.auditor.notify) return
    const now = Date.now()
    // Not a notification per event: a run of alerts becomes one, saying how many were held back.
    if (now - this.lastNotifyAt < NOTIFY_GAP_MS) {
      this.suppressed += 1
      return
    }
    const more = this.suppressed > 0 ? ` (and ${String(this.suppressed)} more since the last notice)` : ''
    this.suppressed = 0
    this.lastNotifyAt = now
    this.deps.notify(`Auditor: ${message}${more}`)
  }

  private record(partial: Omit<AuditRecord, 'v' | 'at' | 'session' | 'workspace' | 'project' | 'user'>): void {
    const task = this.deps.task()
    const record: AuditRecord = {
      v: 1,
      at: Date.now(),
      session: this.deps.session,
      workspace: this.deps.workspaceId,
      project: this.deps.project(),
      user: this.deps.user(),
      ...(task !== undefined ? { task } : {}),
      ...partial,
    }
    void this.journal.append(record, (error) => {
      if (this.journalError) return
      this.journalError = true
      this.deps.log(`audit journal: could not write to ${this.journal.folder}: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (this.deps.index() !== undefined) {
      this.indexQueue.push(record)
      if (this.indexQueue.length > INDEX_MAX_QUEUED) this.indexQueue.splice(0, this.indexQueue.length - INDEX_MAX_QUEUED)
      if (this.indexQueue.length >= INDEX_BATCH) void this.flushIndex()
    }
  }

  private async flushIndex(): Promise<void> {
    const index = this.deps.index()
    if (index === undefined || this.indexing || this.indexQueue.length === 0) return
    this.indexing = true
    const batch = this.indexQueue.slice(0, 500)
    try {
      this.indexWritten += await index.write(batch)
      this.indexQueue.splice(0, batch.length)
      if (this.indexError !== undefined) {
        this.indexError = undefined
        this.deps.changed()
      }
    } catch (error) {
      // Kept and tried again on the next timer; the local journal already has every record.
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.indexError) this.deps.log(`audit index: ${message}`)
      this.indexError = message
      this.deps.changed()
    } finally {
      this.indexing = false
    }
  }
}

function redactEvent(event: ObservedEvent, secrets: readonly string[]): ObservedEvent {
  const r = (text: string): string => redact(text, secrets)
  switch (event.kind) {
    case 'turnStart':
    case 'reasoning':
    case 'assistant':
      return { ...event, text: r(event.text) }
    case 'toolCall':
      return { ...event, args: r(event.args) }
    case 'approval':
      return { ...event, preview: r(event.preview) }
    case 'refused':
      return { ...event, reason: r(event.reason) }
    case 'toolResult':
      return { ...event, text: r(event.text) }
    case 'turnEnd':
      return event.error === undefined ? event : { ...event, error: r(event.error) }
  }
}
