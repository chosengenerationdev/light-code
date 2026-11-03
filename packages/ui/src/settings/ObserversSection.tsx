import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

import { DEFAULT_AUDITOR_INSTRUCTIONS, DEFAULT_GUARD_INSTRUCTIONS, MAX_INSTRUCTIONS, type HostToUiMessage, type ObserverStatus, type ObserversMessage, type Transport, type UiToHostMessage } from '@light-code/core/browser'

import { Select } from '../Select.js'
import { disabledWhen } from '../disabledWhen.js'
import { badgeStyle, colors, labelStyle, monospaceFamily, primaryButtonStyle, secondaryButtonStyle } from '../theme.js'
import { Panel } from './Panel.js'

/**
 * Settings → Project: the Auditor and the Anti Hallucinator (`observers/` in core).
 *
 * Self-contained - it talks to the host through the transport itself, like the usage tab - so the Project
 * tab's props are not threaded through App. Saved for the open project, like the rest of this tab.
 */

type Draft = {
  auditor: { enabled: boolean; profileId: string; recordReasoning: boolean; notify: boolean; opensearch: boolean; prompt: string }
  guard: { enabled: boolean; profileId: string; prompt: string }
}

function draftFrom(message: ObserversMessage): Draft {
  const a = message.config.auditor ?? {}
  const g = message.config.antiHallucination ?? {}
  return {
    auditor: { enabled: a.enabled === true, profileId: a.profileId ?? '', recordReasoning: a.recordReasoning !== false, notify: a.notify !== false, opensearch: a.opensearch !== false, prompt: a.prompt ?? DEFAULT_AUDITOR_INSTRUCTIONS },
    guard: { enabled: g.enabled === true, profileId: g.profileId ?? '', prompt: g.prompt ?? DEFAULT_GUARD_INSTRUCTIONS },
  }
}

/** Written back whole, keeping any field this panel does not edit (storeId, retentionDays). */
function toConfig(draft: Draft, stored: ObserversMessage['config']): unknown {
  const a = draft.auditor
  const g = draft.guard
  return {
    auditor: {
      ...stored.auditor,
      enabled: a.enabled,
      ...(a.profileId !== '' ? { profileId: a.profileId } : { profileId: undefined }),
      recordReasoning: a.recordReasoning,
      notify: a.notify,
      opensearch: a.opensearch,
      // The shipped text is stored as absence, so a later improvement to it reaches everyone who never edited it.
      prompt: a.prompt.trim() === DEFAULT_AUDITOR_INSTRUCTIONS || a.prompt.trim().length === 0 ? undefined : a.prompt,
    },
    antiHallucination: {
      enabled: g.enabled,
      ...(g.profileId !== '' ? { profileId: g.profileId } : {}),
      ...(g.prompt.trim() !== DEFAULT_GUARD_INSTRUCTIONS && g.prompt.trim().length > 0 ? { prompt: g.prompt } : {}),
    },
  }
}

const hint = { display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 10px' } as const

function Check(props: { id: string; checked: boolean; onChange: (value: boolean) => void; children: ReactNode; unavailable?: { reason: string } | undefined }): ReactElement {
  return (
    <label htmlFor={props.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', margin: '6px 0', opacity: props.unavailable !== undefined ? 0.6 : 1 }} title={props.unavailable?.reason}>
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        {...disabledWhen([props.unavailable !== undefined, props.unavailable?.reason ?? ''])}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>{props.children}</span>
    </label>
  )
}

/** The instructions an observer follows, editable; the reply format is added after them and is not shown here. */
function PromptEditor(props: { id: string; value: string; fallback: string; onChange: (value: string) => void }): ReactElement {
  const edited = props.value.trim() !== props.fallback
  return (
    <details style={{ margin: '6px 0' }}>
      <summary style={{ cursor: 'pointer', fontSize: 12 }}>Instructions{edited ? ' (edited)' : ''}</summary>
      <textarea
        id={props.id}
        aria-label="Instructions"
        value={props.value}
        rows={9}
        spellCheck={false}
        maxLength={MAX_INSTRUCTIONS}
        onChange={(event) => props.onChange(event.target.value)}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: monospaceFamily, fontSize: 11, marginTop: 4, background: colors.inputBackground, color: colors.inputForeground, border: `1px solid ${colors.inputBorder}`, borderRadius: 4, padding: 6 }}
      />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          style={secondaryButtonStyle()}
          {...disabledWhen([!edited, 'These are the shipped instructions already.'])}
          onClick={() => props.onChange(props.fallback)}
        >
          Reset to default
        </button>
        <span style={{ color: colors.muted, fontSize: 11 }}>The reply format and its running notes are always added after these, so the handoff keeps working.</span>
      </div>
    </details>
  )
}

function describe(status: ObserverStatus | undefined, problem: string | undefined, enabled: boolean): { text: string; tone: 'neutral' | 'warning' } {
  if (!enabled) return { text: 'Off', tone: 'neutral' }
  if (problem !== undefined) return { text: problem, tone: 'warning' }
  if (status === undefined) return { text: 'Starting…', tone: 'neutral' }
  const usage = status.tokens !== undefined ? ` · context ${String(Math.round((status.tokens / status.window) * 100))}% of ${String(Math.round(status.window / 1000))}k` : ''
  const handoffs = status.handoffs > 0 ? ` · handed off ${String(status.handoffs)}×` : ''
  const process = `process ${String(status.generation)}${status.pid !== undefined ? ` (pid ${String(status.pid)})` : ''}`
  if (status.state === 'failed') return { text: `Stopped: ${status.lastError ?? 'unknown error'}`, tone: 'warning' }
  if (status.state === 'retrying') return { text: `Retrying - ${status.lastError ?? ''}`, tone: 'warning' }
  return { text: `${status.state === 'running' ? 'Running' : status.state === 'starting' ? 'Starting' : 'Stopped'} · ${process}${usage}${handoffs}`, tone: 'neutral' }
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString()
}

export function ObserversSection(props: { transport: Transport }): ReactElement {
  const { transport } = props
  const [message, setMessage] = useState<ObserversMessage | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [saved, setSaved] = useState<string>('')
  // The same, readable from the message handler, which is subscribed once.
  const savedRef = useRef('')
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    const unsubscribe = transport.onMessage((raw) => {
      const incoming = raw as HostToUiMessage
      if (incoming.type === 'observers') {
        setMessage(incoming)
        const fresh = draftFrom(incoming)
        const key = JSON.stringify(fresh)
        // A status update must not overwrite what is being edited: the draft follows the stored settings only
        // when they changed, or when nothing has been edited since the last save.
        const stale = key !== savedRef.current
        setDraft((current) => (current === undefined || stale ? fresh : current))
        savedRef.current = key
        setSaved(key)
        setError(undefined)
      } else if (incoming.type === 'observersError') {
        setError(incoming.message)
      }
    })
    transport.post({ type: 'requestObservers' } satisfies UiToHostMessage)
    return unsubscribe
  }, [transport])

  if (message === undefined || draft === undefined) return <p style={{ color: colors.muted }}>Loading the Auditor and Anti Hallucinator…</p>
  if (!message.hasWorkspace) return <></>

  const dirty = JSON.stringify(draft) !== saved
  const profileOptions = [
    { value: '', label: 'No model', detail: 'Choose one' },
    ...message.profiles.map((p) => ({ value: p.id, label: p.label, detail: p.usable ? p.model : `${p.model} - not usable here (GitHub Copilot runs only inside VS Code)`, disabled: !p.usable })),
  ]
  const auditor = describe(message.state.auditor, message.state.auditorProblem, message.state.settings.auditor.enabled)
  const guard = describe(message.state.guard, message.state.guardProblem, message.state.settings.guard.enabled)
  const save = (): void => transport.post({ type: 'saveObservers', observers: toConfig(draft, message.config) } satisfies UiToHostMessage)
  const set = (change: (d: Draft) => Draft): void => setDraft((d) => (d === undefined ? d : change(d)))
  const noHelper = message.helper ? undefined : 'The Rust helper here has no "watch" (it comes with Fire Code and the Windows VS Code extension). Recording still works; reviews need it.'
  const saveBar = (
    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
      <button type="button" style={primaryButtonStyle(!dirty)} {...disabledWhen([!dirty, 'Nothing has changed since the last save.'])} onClick={save}>
        Save for this project
      </button>
      <button
        type="button"
        style={secondaryButtonStyle()}
        {...disabledWhen([!message.state.settings.auditor.enabled && !message.state.settings.guard.enabled, 'Neither is switched on.'], { enabledTitle: 'Stop both processes and start them again with empty contexts.' })}
        onClick={() => transport.post({ type: 'restartObservers' } satisfies UiToHostMessage)}
      >
        Restart processes
      </button>
    </div>
  )

  return (
    <>
      <Panel id="project.auditor" title="Auditor" summary={message.state.settings.auditor.enabled ? 'On' : 'Off'} defaultOpen>
        <span style={hint}>
          Records everything the agent does in this project - your requests, its reasoning, every tool call, every approval with the literal action you
          were shown, every result - and tells you when it tries something dangerous or refused. Its own model reviews each batch in a separate process with
          its own context, and hands off to a fresh process before that context fills.
        </span>
        <Check id="obs-audit-on" checked={draft.auditor.enabled} onChange={(v) => set((d) => ({ ...d, auditor: { ...d.auditor, enabled: v } }))}>
          Audit this project
        </Check>
        <label htmlFor="obs-audit-model" style={labelStyle()}>
          Model that reviews
        </label>
        <Select
          id="obs-audit-model"
          value={draft.auditor.profileId}
          options={profileOptions}
          onChange={(v) => set((d) => ({ ...d, auditor: { ...d.auditor, profileId: v } }))}
          {...(noHelper !== undefined ? { title: noHelper } : {})}
        />
        <span style={hint}>Without a model it records and checks the rules below, and nothing reviews the record.</span>
        <PromptEditor id="obs-audit-prompt" value={draft.auditor.prompt} fallback={DEFAULT_AUDITOR_INSTRUCTIONS} onChange={(v) => set((d) => ({ ...d, auditor: { ...d.auditor, prompt: v } }))} />
        <Check id="obs-audit-reasoning" checked={draft.auditor.recordReasoning} onChange={(v) => set((d) => ({ ...d, auditor: { ...d.auditor, recordReasoning: v } }))}>
          Record the agent&apos;s reasoning too
        </Check>
        <Check id="obs-audit-notify" checked={draft.auditor.notify} onChange={(v) => set((d) => ({ ...d, auditor: { ...d.auditor, notify: v } }))}>
          Notify me when it does something dangerous or not allowed (a Windows notification in Fire Code)
        </Check>
        <Check
          id="obs-audit-index"
          checked={draft.auditor.opensearch && message.opensearch}
          onChange={(v) => set((d) => ({ ...d, auditor: { ...d.auditor, opensearch: v } }))}
          unavailable={message.opensearch ? undefined : { reason: 'Connect OpenSearch in Settings → Search first.' }}
        >
          Also record in my own OpenSearch index{message.state.index !== undefined ? <> (<code style={{ fontFamily: monospaceFamily }}>{message.state.index.name}</code>)</> : null}
        </Check>
        <div style={{ fontSize: 12, lineHeight: 1.7, marginTop: 6 }}>
          <div>
            Status: <span style={badgeStyle(auditor.tone)}>{auditor.text}</span>
          </div>
          <div>
            Journal on this machine: <code style={{ fontFamily: monospaceFamily, wordBreak: 'break-all' }}>{message.state.journalFolder}</code>{' '}
            <button type="button" style={secondaryButtonStyle()} onClick={() => transport.post({ type: 'openAuditFolder' } satisfies UiToHostMessage)}>
              Open newest
            </button>
          </div>
          {message.state.index !== undefined ? (
            <div>
              Index: {String(message.state.index.written)} written, {String(message.state.index.queued)} waiting
              {message.state.index.lastError !== undefined ? <span style={{ color: colors.warning }}> - {message.state.index.lastError}</span> : null}
            </div>
          ) : null}
          <div style={{ color: colors.muted }}>Agents can read this record with the read_audit_log tool, for analysis later.</div>
        </div>
        {message.state.alerts.length > 0 ? (
          <div style={{ marginTop: 8 }}>
            <strong>Recent alerts</strong>
            <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 12 }}>
              {message.state.alerts.map((alert, i) => (
                <li key={`${String(alert.at)}-${String(i)}`} style={{ color: alert.level === 'high' ? colors.error : colors.foreground }}>
                  {time(alert.at)} - {alert.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {saveBar}
      </Panel>

      <Panel id="project.antiHallucinator" title="Anti Hallucinator" summary={message.state.settings.guard.enabled ? 'On' : 'Off'} defaultOpen>
        <span style={hint}>
          Watches the agent&apos;s reasoning and results as it works, and when it states something the evidence does not support, drifts from what you asked,
          or loops, sends it a short note at its next step - marked as the reviewer&apos;s, never as yours, and granting no permission. Runs in its own process
          with its own context, handed off to a fresh one near the limit.
        </span>
        <Check id="obs-guard-on" checked={draft.guard.enabled} onChange={(v) => set((d) => ({ ...d, guard: { ...d.guard, enabled: v } }))}>
          Keep the agent focused in this project
        </Check>
        <label htmlFor="obs-guard-model" style={labelStyle()}>
          Model that watches
        </label>
        <Select id="obs-guard-model" value={draft.guard.profileId} options={profileOptions} onChange={(v) => set((d) => ({ ...d, guard: { ...d.guard, profileId: v } }))} />
        <PromptEditor id="obs-guard-prompt" value={draft.guard.prompt} fallback={DEFAULT_GUARD_INSTRUCTIONS} onChange={(v) => set((d) => ({ ...d, guard: { ...d.guard, prompt: v } }))} />
        <span style={hint}>A model at least as capable as the one doing the work catches more; a fast one keeps up better. Each step costs it one request.</span>
        <div style={{ fontSize: 12, marginTop: 6 }}>
          Status: <span style={badgeStyle(guard.tone)}>{guard.text}</span>
        </div>
        {message.state.notes.length > 0 ? (
          <div style={{ marginTop: 8 }}>
            <strong>Recent notes</strong>
            <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 12 }}>
              {message.state.notes.map((note, i) => (
                <li key={`${String(note.at)}-${String(i)}`}>
                  {time(note.at)} {note.delivered ? '' : '(waiting for the next step) '}- {note.note}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {error !== undefined ? <div style={{ color: colors.error, fontSize: 12, marginTop: 6 }}>{error}</div> : null}
        {saveBar}
      </Panel>
    </>
  )
}
