import type { Schedule, ScheduleTrigger, ScheduleToolInfo } from '@light-code/core/browser'
import { describeNextRun, describeTrigger, riskyGroupsIn } from '@light-code/core/browser'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronIcon, CopyIcon, PauseIcon, PlayIcon, TrashIcon } from '../icons.js'
import { activeMentionQuery, insertMention } from '../mentions.js'
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
  /**
   * Every skill that exists right now, so a schedule can be told which ones apply to it.
   *
   * The chat finds skills with `search_docs`; a schedule names them instead, because its tool
   * list may not include `search_docs` and there is nobody watching to notice.
   */
  skills: { name: string; description: string }[]
  onSave: (schedule: Schedule) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onToggle: (id: string, enabled: boolean) => void
  onRunNow: (id: string) => void
  runningId?: string | undefined
  /**
   * `@` file mentions in the prompt, plumbed exactly as the composer's are.
   *
   * They already *resolve* at run time — a scheduled prompt goes through the same
   * `resolveMentions` path as a typed one — so this is the autocomplete, not the feature.
   * Without it you have to know and type the path exactly, and a typo silently becomes
   * ordinary prose rather than a file.
   */
  mentionCandidates: string[]
  onQueryMentions: (query: string) => void
  /** Opens a past run's transcript in an editor tab, where a long one is actually readable. */
  onOpenRun: (taskId: string, title: string) => void
  /** Whether the timer is alive, and when it last checked. */
  scheduler?: { running: boolean; lastTickAt?: number } | undefined
  onRestartScheduler: () => void
  /** Omitting the id clears every schedule's runs. */
  onClearRuns: (id?: string) => void
  /** Removes one run, identified by when it started. */
  onDeleteRun: (id: string, at: number) => void
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
  const [expanded, setExpanded] = useState<string | undefined>(undefined)

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
        skills={props.skills}
        mentionCandidates={props.mentionCandidates}
        onQueryMentions={props.onQueryMentions}
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

      {/*
        The scheduler's own state, shown rather than assumed.
        A schedule that quietly never fires looks identical to one that is not due yet, which
        is precisely how the last failure went unnoticed. The last-checked time is the tell.
      */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          padding: '6px 8px',
          borderRadius: 6,
          fontSize: 11,
          border: `1px solid ${props.scheduler?.running === false ? colors.error : colors.border}`,
          color: props.scheduler?.running === false ? colors.error : colors.muted,
        }}
      >
        <span>
          {props.scheduler?.running === false
            ? 'The scheduler is not running — nothing will fire.'
            : `Scheduler running${
                props.scheduler?.lastTickAt === undefined
                  ? ' — first check within a minute'
                  : `, last checked ${new Date(props.scheduler.lastTickAt).toLocaleTimeString()}`
              }`}
        </span>
        <button
          type="button"
          style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px', marginLeft: 'auto' }}
          title="Stop and start the timer. Safe at any time; a run already in progress is unaffected."
          onClick={props.onRestartScheduler}
        >
          Restart
        </button>
      </div>

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
                  {/*
                    The copy is paused and has no run history: a clone is made to be changed,
                    and one that fired on the original's schedule before anyone had edited it
                    would run something nobody finished writing.
                  */}
                  <button
                    type="button"
                    title="Duplicate this schedule. The copy is paused so you can edit it first."
                    aria-label="Duplicate"
                    style={iconButtonStyle('ghost')}
                    onClick={() => props.onDuplicate(schedule.id)}
                  >
                    <CopyIcon />
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
              </div>

              {(schedule.runs ?? []).length > 0 && (
                <button
                  type="button"
                  className="lc-btn"
                  aria-expanded={expanded === schedule.id}
                  onClick={() => setExpanded(expanded === schedule.id ? undefined : schedule.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    marginTop: 4,
                    padding: '2px 4px 2px 0',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 6,
                    color: colors.muted,
                    cursor: 'pointer',
                    fontFamily,
                    fontSize: 11,
                  }}
                >
                  <span
                    style={{
                      display: 'flex',
                      transform: expanded === schedule.id ? 'rotate(90deg)' : 'none',
                      transition: 'transform 190ms cubic-bezier(0.22, 0.85, 0.28, 1)',
                    }}
                  >
                    <ChevronIcon />
                  </span>
                  {(schedule.runs ?? []).length} run{(schedule.runs ?? []).length === 1 ? '' : 's'}
                </button>
              )}
              {expanded === schedule.id && (schedule.runs ?? []).length > 0 && (
                <button
                  type="button"
                  style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px', marginLeft: 18 }}
                  title="Forget this schedule's runs. The transcripts themselves stay in History."
                  onClick={() => props.onClearRuns(schedule.id)}
                >
                  Clear these runs
                </button>
              )}

              {expanded === schedule.id &&
                (schedule.runs ?? []).map((run, index) => (
                  <div
                    key={`${String(run.at)}-${String(index)}`}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 6,
                      padding: '3px 0 3px 18px',
                      fontSize: 11,
                      color: colors.muted,
                    }}
                  >
                    <span
                      title={run.result}
                      style={{ color: run.result === 'error' ? colors.error : colors.accent, flexShrink: 0 }}
                    >
                      {run.result === 'error' ? '✗' : '✓'}
                    </span>
                    <span style={{ flexShrink: 0 }}>{new Date(run.at).toLocaleString()}</span>
                    {run.durationMs !== undefined && (
                      <span style={{ flexShrink: 0 }}>{(run.durationMs / 1000).toFixed(1)}s</span>
                    )}
                    {run.summary !== undefined && (
                      <span
                        style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={run.summary}
                      >
                        {run.summary}
                      </span>
                    )}
                    {/*
                      Opens in an editor tab rather than the sidebar. A run's transcript is a
                      document — read, scrolled, searched — and an editor does all of that far
                      better than a panel a third the width.
                    */}
                    {run.taskId !== undefined && (
                      <button
                        type="button"
                        style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px', marginLeft: 'auto' }}
                        title="Open this run's full transcript in an editor tab"
                        onClick={() =>
                          props.onOpenRun(
                            run.taskId as string,
                            `${schedule.name} — ${new Date(run.at).toLocaleString()}`,
                          )
                        }
                      >
                        Log
                      </button>
                    )}
                    <button
                      type="button"
                      style={{
                        ...secondaryButtonStyle(),
                        fontSize: 10,
                        padding: '1px 6px',
                        ...(run.taskId === undefined ? { marginLeft: 'auto' } : {}),
                      }}
                      title="Remove this run from the log"
                      aria-label="Delete this run"
                      onClick={() => props.onDeleteRun(schedule.id, run.at)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
        <button type="button" style={primaryButtonStyle(false)} onClick={() => setEditing(blank())}>
          New schedule
        </button>
        {props.schedules.some((schedule) => (schedule.runs ?? []).length > 0) && (
          <button
            type="button"
            style={secondaryButtonStyle()}
            title="Forget every schedule's run history. The transcripts stay in History and are deleted from there."
            onClick={() => props.onClearRuns()}
          >
            Clear all run logs
          </button>
        )}
      </div>
    </div>
  )
}

function ScheduleEditor(props: {
  schedule: Schedule
  tools: ScheduleToolInfo[]
  skills: { name: string; description: string }[]
  mentionCandidates: string[]
  onQueryMentions: (query: string) => void
  onSave: (schedule: Schedule) => void
  onCancel: () => void
}): ReactElement {
  const [draft, setDraft] = useState<Schedule>(props.schedule)
  const [filter, setFilter] = useState('')
  /*
   * Selected tools stay listed whatever the filter says.
   *
   * Without this, typing a search hides what you already ticked, and the count at the bottom
   * disagrees with the visible list — which reads as the filter having deselected them. What
   * a schedule may do must never be ambiguous.
   */
  const [showSelectedOnly, setShowSelectedOnly] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | undefined>(undefined)
  const [highlighted, setHighlighted] = useState(0)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const showingMentions = mentionQuery !== undefined && props.mentionCandidates.length > 0

  // In a ref so the effect depends only on the query. Depending on the callback would fire a
  // workspace lookup on every parent render, which is most keystrokes.
  const queryMentionsRef = useRef(props.onQueryMentions)
  queryMentionsRef.current = props.onQueryMentions

  useEffect(() => {
    if (mentionQuery === undefined) return
    // Debounced for the same reason as the composer: `findFiles` over a large repository is
    // not free, and the query changes on every keystroke inside a mention.
    const timer = setTimeout(() => queryMentionsRef.current(mentionQuery), 120)
    return () => clearTimeout(timer)
  }, [mentionQuery])

  const syncMentions = (value: string, caret: number): void => {
    setMentionQuery(activeMentionQuery(value, caret))
    setHighlighted(0)
  }

  const chooseMention = (candidate: string): void => {
    const textarea = promptRef.current
    const caret = textarea?.selectionStart ?? draft.prompt.length
    const inserted = insertMention(draft.prompt, caret, candidate)
    if (inserted === undefined) return

    set({ prompt: inserted.text })
    setMentionQuery(undefined)
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }

  const set = (patch: Partial<Schedule>): void => setDraft((current) => ({ ...current, ...patch }))
  const setTrigger = (patch: Partial<ScheduleTrigger>): void =>
    setDraft((current) => ({ ...current, trigger: { ...current.trigger, ...patch } as ScheduleTrigger }))

  const risky = riskyGroupsIn(props.tools, draft.allowedTools)
  const valid = draft.name.trim().length > 0 && draft.prompt.trim().length > 0

  const needle = filter.trim().toLowerCase()
  const matches = (tool: ScheduleToolInfo): boolean => {
    const selected = draft.allowedTools.includes(tool.name)
    if (showSelectedOnly && !selected) return false
    if (needle.length === 0) return true
    // Selected tools survive the filter, so a search never appears to untick anything.
    if (selected) return true
    // Underscores are searched as spaces too: "create page" should find confluence__create_page.
    const haystack = `${tool.name} ${tool.name.replace(/[_-]+/g, ' ')} ${tool.description}`.toLowerCase()
    return needle.split(/\s+/).every((term) => haystack.includes(term))
  }

  const grouped = new Map<string, ScheduleToolInfo[]>()
  for (const tool of props.tools) {
    // Control tools are always available and are not a choice, so listing them would imply
    // ticking them changed something.
    if (tool.group === 'always') continue
    if (!matches(tool)) continue
    const bucket = grouped.get(tool.group) ?? []
    bucket.push(tool)
    grouped.set(tool.group, bucket)
  }

  const visible = [...grouped.values()].flat()
  const selectableNow = visible.filter((tool) => !draft.allowedTools.includes(tool.name))

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
        ref={promptRef}
        value={draft.prompt}
        rows={4}
        placeholder="Read @src/app.ts and tell me if anything looks wrong."
        onChange={(event) => {
          set({ prompt: event.target.value })
          syncMentions(event.target.value, event.target.selectionStart)
        }}
        onKeyDown={(event) => {
          if (!showingMentions) return
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setHighlighted((current) => (current + 1) % props.mentionCandidates.length)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setHighlighted(
              (current) => (current - 1 + props.mentionCandidates.length) % props.mentionCandidates.length,
            )
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            // Enter would otherwise insert a newline mid-mention, leaving a broken path behind.
            event.preventDefault()
            const candidate = props.mentionCandidates[highlighted]
            if (candidate !== undefined) chooseMention(candidate)
          } else if (event.key === 'Escape') {
            setMentionQuery(undefined)
          }
        }}
        style={{ ...textFieldStyle(), marginBottom: 4, resize: 'vertical', fontFamily }}
      />

      {showingMentions && (
        <div
          role="listbox"
          aria-label="Workspace files"
          className="lc-scroll"
          style={{
            maxHeight: 150,
            overflowY: 'auto',
            border: `1px solid ${colors.accent}`,
            borderRadius: 8,
            marginBottom: 6,
          }}
        >
          {props.mentionCandidates.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              // mousedown, not click: click fires after blur, which closes the list first.
              onMouseDown={(event) => {
                event.preventDefault()
                chooseMention(candidate)
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '4px 10px',
                background: index === highlighted ? colors.accent : 'transparent',
                border: 'none',
                color: index === highlighted ? colors.accentContrast : colors.foreground,
                cursor: 'pointer',
                fontFamily: monospace,
                fontSize: 11,
              }}
            >
              {candidate}
            </button>
          ))}
        </div>
      )}

      <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginBottom: 12 }}>
        Sent exactly as if you had typed it, including <code style={{ fontFamily: monospace }}>@</code> file
        mentions — their contents are attached when the schedule runs, not now. Nobody can answer a
        follow-up question, so ask for something it can finish alone.
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

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={filter}
          spellCheck={false}
          aria-label="Filter tools"
          placeholder="Filter by name or description…"
          onChange={(event) => setFilter(event.target.value)}
          style={{ ...textFieldStyle(), flex: 1, minWidth: 140 }}
        />
        <button
          type="button"
          aria-pressed={showSelectedOnly}
          title="Show only what this schedule may use"
          onClick={() => setShowSelectedOnly(!showSelectedOnly)}
          style={{
            ...secondaryButtonStyle(),
            fontSize: 11,
            background: showSelectedOnly ? colors.accent : colors.secondaryButtonBackground,
            color: showSelectedOnly ? colors.accentContrast : colors.secondaryButtonForeground,
          }}
        >
          {draft.allowedTools.length} selected
        </button>
      </div>

      {/*
        Acts on the *filtered* set only, and says so. A bare "select all" against forty hidden
        MCP tools is exactly the accident this whole picker exists to prevent.
      */}
      {needle.length > 0 && selectableNow.length > 0 && (
        <button
          type="button"
          style={{ ...secondaryButtonStyle(), fontSize: 11, marginBottom: 8 }}
          onClick={() =>
            set({ allowedTools: [...draft.allowedTools, ...selectableNow.map((tool) => tool.name)] })
          }
        >
          Select the {selectableNow.length} shown
        </button>
      )}

      {/*
        Listed read-only rather than hidden. They were omitted on the grounds that ticking them
        changes nothing — true, but it left no way to answer "can this schedule notify me?"
        except by reading the source.
      */}
      <div style={{ marginBottom: 10 }}>
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginBottom: 4 }}>
          Always available
        </span>
        {props.tools
          .filter((tool) => tool.group === 'always')
          .map((tool) => (
            <label
              key={tool.name}
              title="Always available to every schedule — it performs no work on the workspace."
              style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4, opacity: 0.75 }}
            >
              <input type="checkbox" checked disabled style={{ marginTop: 3 }} />
              <span>
                <span style={{ display: 'block', fontFamily: monospace, fontSize: 11 }}>{tool.name}</span>
                <span style={{ display: 'block', color: colors.muted, fontSize: 10 }}>{tool.description}</span>
              </span>
            </label>
          ))}
      </div>

      {visible.length === 0 && (
        <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 10px' }}>
          {showSelectedOnly ? 'Nothing selected yet.' : `No tool matches "${filter.trim()}".`}
        </p>
      )}

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
        Skills, chosen the same way tools are — and for the same reason. What differs is the
        default: an unticked *tool* is withheld, but a schedule that has never been edited has
        no skill list at all, and that means "all of them". Taking knowledge away from a job
        that was working, on upgrade, would be the worse failure by a distance.
      */}
      {props.skills.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <span style={labelStyle()}>What it should know</span>
          <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
            {draft.allowedSkills === undefined ? (
              <>
                All {props.skills.length} {props.skills.length === 1 ? 'skill is' : 'skills are'}{' '}
                included. Tick a few to narrow it — useful when a run only touches one area and
                the rest is prompt it pays for every time.
              </>
            ) : (
              <>
                Only the ticked skills are put in this run&rsquo;s prompt. Unlike the chat, a
                schedule does not search for them — it may not have <code>search_docs</code>, and
                nobody is watching if it comes up empty.
              </>
            )}
          </p>

          {draft.allowedSkills !== undefined && (
            <button
              type="button"
              style={{ ...secondaryButtonStyle(), fontSize: 11, marginBottom: 8 }}
              onClick={() => {
                const next = { ...draft }
                delete next.allowedSkills
                setDraft(next)
              }}
            >
              Include all of them again
            </button>
          )}

          {props.skills.map((skill) => {
            const chosen = draft.allowedSkills === undefined || draft.allowedSkills.includes(skill.name)
            return (
              <label
                key={skill.name}
                style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  data-skill={skill.name}
                  checked={chosen}
                  onChange={() => {
                    // The first untick has to materialise the list, since "undefined" means
                    // everything — starting from the full set is what makes that one click
                    // mean "all but this" rather than "only this".
                    const current = draft.allowedSkills ?? props.skills.map((entry) => entry.name)
                    set({
                      allowedSkills: chosen
                        ? current.filter((name) => name !== skill.name)
                        : [...current, skill.name],
                    })
                  }}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <span style={{ display: 'block', fontFamily: monospace, fontSize: 11 }}>{skill.name}</span>
                  <span style={{ display: 'block', color: colors.muted, fontSize: 10 }}>{skill.description}</span>
                </span>
              </label>
            )
          })}
        </div>
      )}

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
