import type { Schedule, ScheduleTrigger, ScheduleToolInfo } from '@light-code/core/browser'
import { describeNextRun, describeTrigger, riskyGroupsIn } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { PauseIcon, PlayIcon, TrashIcon } from '../icons.js'
import { Select } from '../Select.js'
import {
  badgeStyle,
  colors,
  fontFamily,
  iconButtonStyle,
  labelStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  textFieldStyle,
} from '../theme.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface SchedulesTabProps {
  schedules: Schedule[]
  /** Every tool that exists right now — built-in, MCP and Python alike. */
  tools: ScheduleToolInfo[]
  onSave: (schedule: Schedule) => void
  onDelete: (id: string) => void
  onToggle: (id: string, enabled: boolean) => void
  onRunNow: (id: string) => void
  runningId?: string | undefined
}

const GROUP_LABELS: Record<string, string> = {
  read: 'Reading',
  edit: 'Editing files',
  command: 'Running commands',
  mcp: 'MCP servers',
  always: 'Always available',
}

function blank(): Schedule {
  return {
    id: '',
    name: '',
    prompt: '',
    trigger: { kind: 'daily', hour: 9, minute: 0 },
    enabled: true,
    // Nothing selected. A schedule runs unattended, so every capability it has must be an
    // explicit decision rather than something inherited by default.
    allowedTools: [],
  }
}

/**
 * Prompts that run on their own.
 *
 * The tool picker is the security surface, not a convenience. A scheduled run has nobody to
 * approve anything, so what it may do is decided here, once, in the open — and the default is
 * nothing. Every tool is listed, including MCP and Python ones, because the alternative is
 * granting whole groups and a schedule that may post to one endpoint should not thereby be
 * able to delete from another.
 */
export function SchedulesTab(props: SchedulesTabProps): ReactElement {
  const [editing, setEditing] = useState<Schedule | undefined>(undefined)
  const [now, setNow] = useState(Date.now())

  // The "next run" column is a countdown; without this it freezes at whatever it said when
  // the tab opened, which reads as a stuck scheduler.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  if (editing !== undefined) {
    return (
      <ScheduleEditor
        schedule={editing}
        tools={props.tools}
        onCancel={() => setEditing(undefined)}
        onSave={(next) => {
          props.onSave(next)
          setEditing(undefined)
        }}
      />
    )
  }

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily, fontSize: 13, color: colors.foreground }}>
      <h3 style={{ margin: '0 0 4px' }}>Schedules</h3>
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 0 }}>
        A prompt that runs on its own and leaves a normal task you can read afterwards. Each one
        can use only the tools you tick — nobody is present to approve anything while it runs.
      </p>
      <p style={{ color: colors.muted, fontSize: 11 }}>
        Schedules only fire while VS Code is open. One that came due while it was closed runs
        shortly after you next open it, once — not repeatedly to catch up.
      </p>

      {props.schedules.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 12, marginTop: 14 }}>None yet.</p>
      ) : (
        <div style={{ marginTop: 12 }}>
          {props.schedules.map((schedule) => (
            <div key={schedule.id} style={{ padding: '8px 0', borderBottom: `1px solid ${colors.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 12 }}>{schedule.name}</strong>
                {schedule.allowedTools.length === 0 ? (
                  <span style={{ ...badgeStyle(), fontSize: 9 }} title="Can answer, but cannot use any tool">
                    no tools
                  </span>
                ) : (
                  <span style={{ ...badgeStyle(), fontSize: 9 }}>
                    {schedule.allowedTools.length} {schedule.allowedTools.length === 1 ? 'tool' : 'tools'}
                  </span>
                )}
                {riskyGroupsIn(props.tools, schedule.allowedTools).length > 0 && (
                  <span
                    style={{ ...badgeStyle('warning'), fontSize: 9 }}
                    title="This schedule can change things without anyone watching"
                  >
                    can act
                  </span>
                )}

                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    title={props.runningId === schedule.id ? 'Running now' : 'Run now'}
                    aria-label="Run now"
                    disabled={props.runningId === schedule.id}
                    style={iconButtonStyle('ghost', props.runningId === schedule.id)}
                    onClick={() => props.onRunNow(schedule.id)}
                  >
                    <PlayIcon />
                  </button>
                  <button
                    type="button"
                    title={schedule.enabled ? 'Pause — keeps its history' : 'Resume'}
                    aria-label={schedule.enabled ? 'Pause' : 'Resume'}
                    style={iconButtonStyle('ghost')}
                    onClick={() => props.onToggle(schedule.id, !schedule.enabled)}
                  >
                    {schedule.enabled ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <button
                    type="button"
                    title="Edit"
                    aria-label="Edit"
                    style={secondaryButtonStyle()}
                    onClick={() => setEditing(schedule)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    title="Delete this schedule"
                    aria-label="Delete this schedule"
                    style={iconButtonStyle('ghost')}
                    onClick={() => props.onDelete(schedule.id)}
                  >
                    <TrashIcon />
                  </button>
                </span>
              </div>

              <div style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>
                {describeTrigger(schedule.trigger)} · {describeNextRun(schedule, now)}
                {schedule.lastRunAt !== undefined && (
                  <>
                    {' · last '}
                    <span style={{ color: schedule.lastResult === 'error' ? colors.error : colors.muted }}>
                      {schedule.lastResult ?? 'ok'}
                    </span>{' '}
                    {new Date(schedule.lastRunAt).toLocaleString()}
                  </>
                )}
              </div>
              {schedule.lastSummary !== undefined && (
                <div style={{ color: colors.muted, fontSize: 11, marginTop: 2, fontStyle: 'italic' }}>
                  {schedule.lastSummary}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <button type="button" style={{ ...primaryButtonStyle(false), marginTop: 14 }} onClick={() => setEditing(blank())}>
        New schedule
      </button>
    </div>
  )
}

function ScheduleEditor(props: {
  schedule: Schedule
  tools: ScheduleToolInfo[]
  onSave: (schedule: Schedule) => void
  onCancel: () => void
}): ReactElement {
  const [draft, setDraft] = useState<Schedule>(props.schedule)

  const set = (patch: Partial<Schedule>): void => setDraft((current) => ({ ...current, ...patch }))
  const setTrigger = (patch: Partial<ScheduleTrigger>): void =>
    setDraft((current) => ({ ...current, trigger: { ...current.trigger, ...patch } as ScheduleTrigger }))

  const risky = riskyGroupsIn(props.tools, draft.allowedTools)
  const valid = draft.name.trim().length > 0 && draft.prompt.trim().length > 0

  const grouped = new Map<string, ScheduleToolInfo[]>()
  for (const tool of props.tools) {
    // Control tools are always available and are not a choice, so listing them would imply
    // ticking them changed something.
    if (tool.group === 'always') continue
    const bucket = grouped.get(tool.group) ?? []
    bucket.push(tool)
    grouped.set(tool.group, bucket)
  }

  const toggle = (name: string): void =>
    set({
      allowedTools: draft.allowedTools.includes(name)
        ? draft.allowedTools.filter((entry) => entry !== name)
        : [...draft.allowedTools, name],
    })

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily, fontSize: 13, color: colors.foreground }}>
      <h3 style={{ margin: '0 0 12px' }}>{props.schedule.id === '' ? 'New schedule' : 'Edit schedule'}</h3>

      <label style={labelStyle()} htmlFor="lc-sched-name">
        Name
      </label>
      <input
        id="lc-sched-name"
        type="text"
        value={draft.name}
        placeholder="Morning build check"
        onChange={(event) => set({ name: event.target.value })}
        style={{ ...textFieldStyle(), marginBottom: 12 }}
      />

      <label style={labelStyle()} htmlFor="lc-sched-prompt">
        Prompt
      </label>
      <textarea
        id="lc-sched-prompt"
        value={draft.prompt}
        rows={4}
        placeholder="Read the latest build log and tell me if anything failed."
        onChange={(event) => set({ prompt: event.target.value })}
        style={{ ...textFieldStyle(), marginBottom: 4, resize: 'vertical', fontFamily }}
      />
      <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginBottom: 12 }}>
        Sent exactly as if you had typed it. Nobody can answer a follow-up question, so ask for
        something it can finish alone.
      </span>

      <span style={labelStyle()}>When</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Select
          compact
          value={draft.trigger.kind}
          ariaLabel="How often"
          onChange={(kind) =>
            set({
              trigger:
                kind === 'interval'
                  ? { kind: 'interval', everyMinutes: 60 }
                  : kind === 'daily'
                    ? { kind: 'daily', hour: 9, minute: 0 }
                    : { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
            })
          }
          options={[
            { value: 'interval', label: 'Every…' },
            { value: 'daily', label: 'Daily at…' },
            { value: 'weekly', label: 'On days…' },
          ]}
        />

        {draft.trigger.kind === 'interval' ? (
          <>
            <input
              type="number"
              min={1}
              value={draft.trigger.everyMinutes}
              aria-label="Minutes between runs"
              onChange={(event) => setTrigger({ everyMinutes: Math.max(1, Number(event.target.value) || 1) })}
              style={{ ...textFieldStyle(), width: 80 }}
            />
            <span style={{ color: colors.muted, fontSize: 11 }}>minutes</span>
          </>
        ) : (
          <input
            type="time"
            aria-label="Time of day"
            value={`${String(draft.trigger.hour).padStart(2, '0')}:${String(draft.trigger.minute).padStart(2, '0')}`}
            onChange={(event) => {
              const [hour, minute] = event.target.value.split(':').map(Number)
              setTrigger({ hour: hour ?? 9, minute: minute ?? 0 })
            }}
            style={{ ...textFieldStyle(), width: 110 }}
          />
        )}
      </div>

      {draft.trigger.kind === 'weekly' && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, day) => {
            const on = draft.trigger.kind === 'weekly' && draft.trigger.days.includes(day)
            return (
              <button
                key={label}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  if (draft.trigger.kind !== 'weekly') return
                  const days = on ? draft.trigger.days.filter((d) => d !== day) : [...draft.trigger.days, day]
                  // Never empty: a weekly schedule with no days would never fire, and the
                  // schema rejects it anyway — better to refuse the last removal here.
                  if (days.length > 0) setTrigger({ days })
                }}
                style={{
                  ...secondaryButtonStyle(),
                  fontSize: 11,
                  padding: '3px 8px',
                  background: on ? colors.accent : colors.secondaryButtonBackground,
                  color: on ? colors.accentContrast : colors.secondaryButtonForeground,
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}

      <span style={labelStyle()}>What it may use</span>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
        Nothing is ticked to begin with. A tool you do not tick is not offered to the run at all,
        so a server added later never widens an existing schedule.
      </p>

      {[...grouped.entries()].map(([group, tools]) => (
        <div key={group} style={{ marginBottom: 10 }}>
          <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginBottom: 4 }}>
            {GROUP_LABELS[group] ?? group}
          </span>
          {tools.map((tool) => (
            <label
              key={tool.name}
              style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={draft.allowedTools.includes(tool.name)}
                onChange={() => toggle(tool.name)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ display: 'block', fontFamily: monospace, fontSize: 11 }}>{tool.name}</span>
                <span style={{ display: 'block', color: colors.muted, fontSize: 10 }}>{tool.description}</span>
              </span>
            </label>
          ))}
        </div>
      ))}

      {/*
        The warning the plan asks for, shown only when it applies. Unattended execution plus
        anything that writes or runs is a direct prompt-injection path: the job reads a file or
        a page, the text contains instructions, and the model acts on them with nobody watching.
      */}
      {risky.length > 0 && (
        <p
          style={{
            color: colors.error,
            fontSize: 11,
            border: `1px solid ${colors.error}`,
            borderRadius: 8,
            padding: 8,
            margin: '4px 0 12px',
          }}
        >
          This schedule can act on its own — you have allowed {risky.join(' and ')}. If anything it
          reads contains instructions, it may follow them with nobody watching. Grant this only for
          content you trust.
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          type="button"
          style={primaryButtonStyle(!valid)}
          disabled={!valid}
          onClick={() => props.onSave({ ...draft, name: draft.name.trim(), prompt: draft.prompt.trim() })}
        >
          Save
        </button>
        <button type="button" style={secondaryButtonStyle()} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
