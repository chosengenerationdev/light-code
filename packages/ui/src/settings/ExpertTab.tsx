import { useEffect, useState, type ReactElement } from 'react'
import { Select } from '../Select.js'
import { colors, fontFamily, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { PathField, type BrowseRequest } from './PathField.js'
import { ScopeBadge } from './ScopeBadge.js'

/** Sentinel for the free-text escape hatch, kept out of the value space. */
const CUSTOM = '__custom__'

/**
 * Tier aliases rather than pinned ids: the CLI resolves `sonnet` to whatever the current
 * Sonnet release is, so this list does not go stale every time a model ships. An empty
 * value means "whatever the CLI is already configured to use", which is the right default.
 */
const EXPERT_MODELS = [
  { value: '', label: "The CLI's own default" },
  { value: 'opus', label: 'Opus — strongest, most expensive' },
  { value: 'sonnet', label: 'Sonnet — balanced' },
  { value: 'haiku', label: 'Haiku — fastest and cheapest' },
] as const

export interface ExpertState {
  enabled: boolean
  available: boolean
  path: string
  version?: string
  reason?: string
  model?: string
  maxSpendUsd: number
  maxConsultations: number
}

export interface ExpertTabProps {
  expert: ExpertState | undefined
  /** Native picker, for when detection cannot find it and typing the path is guesswork. */
  onBrowse?: (request: BrowseRequest) => void
  pickedPath?: { purpose: string; path: string } | undefined
  /** Re-runs detection. The probe spawns a process, so it is never automatic on a timer. */
  onRecheck: () => void
  onSave: (
    enabled: boolean,
    path: string,
    model: string,
    limits: { maxSpendUsd: number; maxConsultations: number },
  ) => void
}

/**
 * The Claude CLI as a consulting expert for a cheaper primary model.
 *
 * The tab leads with what it costs, because that is the decision the user is actually
 * making. "Reduce Claude spend" only works if consultations stay rare, and the surest way
 * to make them rare is to be honest about the trade rather than presenting a free upgrade.
 */
export function ExpertTab(props: ExpertTabProps): ReactElement {
  const [enabled, setEnabled] = useState(props.expert?.enabled ?? false)
  const [path, setPath] = useState(props.expert?.path ?? 'claude')
  const [model, setModel] = useState(props.expert?.model ?? '')
  // Kept as strings so the fields can be emptied while typing. An empty field means no limit,
  // which is the same thing zero means — a numeric state would force a 0 in as soon as you
  // cleared it, and the field would fight you.
  const [maxSpend, setMaxSpend] = useState(String(props.expert?.maxSpendUsd ?? 0))
  const [maxCalls, setMaxCalls] = useState(String(props.expert?.maxConsultations ?? 0))

  // Resync when the host answers — the tab can mount before the response arrives, which is
  // the same race that made the very first settings screen look like it lost your data.
  useEffect(() => {
    if (props.expert === undefined) return
    setEnabled(props.expert.enabled)
    setPath(props.expert.path)
    setModel(props.expert.model ?? '')
    setMaxSpend(String(props.expert.maxSpendUsd))
    setMaxCalls(String(props.expert.maxConsultations))
  }, [props.expert])

  /*
   * A path chosen from the picker lands in the field rather than being saved outright: the user
   * still has to press Save, which keeps one way of committing a change rather than two.
   */
  useEffect(() => {
    if (props.pickedPath?.purpose === 'expert.path') setPath(props.pickedPath.path)
  }, [props.pickedPath])

  const numeric = (value: string): number => {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  const detected = props.expert?.available === true

  return (
    <div style={{ padding: 12, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0, color: colors.foreground }}>Expert</h3>
        <ScopeBadge scope="user" />
      </div>

      <p style={{ color: colors.muted, fontSize: 12, fontFamily, margin: '0 0 12px' }}>
        Lets your everyday model consult Claude on hard problems — planning a change across
        several files, diagnosing a bug it has already failed to fix, or weighing two designs.
        It decides when the question is worth it, and each consultation appears in the
        transcript with what it cost.
      </p>

      <div
        style={{
          padding: 8,
          marginBottom: 12,
          borderRadius: 3,
          border: `1px solid ${detected ? colors.border : colors.error}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 12, color: detected ? colors.foreground : colors.error }}>
            {props.expert === undefined
              ? 'Checking…'
              : detected
                ? `Found: ${props.expert.version ?? props.expert.path}`
                : 'Claude CLI not found'}
          </div>
          {/*
            Always offered, including while it says "Checking…". Detection runs a program, and a
            program can hang however carefully it is bounded — so there has to be a way out that
            is not "reload the window".
          */}
          <button
            type="button"
            style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px', marginLeft: 'auto' }}
            title="Look for the Claude CLI again"
            onClick={props.onRecheck}
          >
            Re-check
          </button>
        </div>
        {props.expert !== undefined && !detected && (
          <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>
            {props.expert.reason ?? 'Install it with: npm install -g @anthropic-ai/claude-code'}
          </div>
        )}
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 12, fontSize: 12 }}>
        <input
          type="checkbox"
          style={{ marginTop: 2 }}
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span style={{ color: colors.foreground }}>
          Enable Claude as the expert
          <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 2 }}>
            Consultations are billed to your Claude account at its usual rates. Off by
            default; nothing runs and nothing is spent until you turn this on.
          </span>
        </span>
      </label>

      {/*
        Browse matters here more than on most path fields. Detection runs a program, and when
        that comes back empty — or hangs — the alternative is asking someone to remember where
        npm put a shim. Pointing at the file is the answer that always works.
      */}
      <PathField
        id="lc-expert-path"
        label="Command"
        value={path}
        placeholder="claude"
        hint={
          'Found on PATH by default. If detection cannot find it, browse to the executable — on ' +
          'Windows that is usually claude.cmd in %APPDATA%\\npm.'
        }
        browse={{ purpose: 'expert.path', kind: 'file' }}
        {...(props.onBrowse !== undefined ? { onBrowse: props.onBrowse } : {})}
        onChange={setPath}
      />

      <div style={{ marginBottom: 16 }}>
        <label htmlFor="lc-expert-model" style={labelStyle()}>
          Model (optional)
        </label>
        <Select
          id="lc-expert-model"
          value={EXPERT_MODELS.some((option) => option.value === model) ? model : CUSTOM}
          onChange={(value) => setModel(value === CUSTOM ? '' : value)}
          style={{ width: '100%', marginBottom: 6 }}
          options={[
            ...EXPERT_MODELS.map((option) => ({ value: option.value, label: option.label })),
            { value: CUSTOM, label: 'Something else…' },
          ]}
        />

        {/* Free text stays available whatever the list says — the CLI accepts ids this list
            cannot know about, and §9's rule is that a dropdown never becomes the only way in. */}
        {!EXPERT_MODELS.some((option) => option.value === model) && (
          <input
            type="text"
            value={model}
            placeholder="e.g. claude-sonnet-4-5-20250929"
            onChange={(event) => setModel(event.target.value)}
            style={textFieldStyle()}
          />
        )}
        <span style={{ color: colors.muted, fontSize: 11 }}>
          Aliases track the newest release of that tier. A smaller model makes consultations
          cheaper, at some cost to their quality.
        </span>
      </div>

      {/*
        The cap is per task, matching the expert session's own scope. A total that never resets
        becomes something the user clears rather than something that protects them.
      */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
        <label style={labelStyle()}>Budget per task</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: colors.muted, fontSize: 11 }}>Stop after</span>
          <input
            type="number"
            min="0"
            step="0.25"
            value={maxSpend}
            onChange={(event) => setMaxSpend(event.target.value)}
            aria-label="Maximum spend per task in dollars"
            style={{ ...textFieldStyle(), width: 90 }}
          />
          <span style={{ color: colors.muted, fontSize: 11 }}>dollars, or</span>
          <input
            type="number"
            min="0"
            step="1"
            value={maxCalls}
            onChange={(event) => setMaxCalls(event.target.value)}
            aria-label="Maximum consultations per task"
            style={{ ...textFieldStyle(), width: 70 }}
          />
          <span style={{ color: colors.muted, fontSize: 11 }}>consultations — whichever comes first.</span>
        </div>
        <span style={{ color: colors.muted, fontSize: 11 }}>
          0 means no limit. When a limit is reached the expert stops being offered for that task
          and the assistant carries on alone; starting a new task resets it. A count limit is
          worth setting even if you set a spend limit, because the CLI does not always report a
          price and an unpriced consultation still costs money.
        </span>
      </div>

      <div
        style={{
          padding: 8,
          marginBottom: 16,
          borderRadius: 3,
          border: `1px solid ${colors.border}`,
          color: colors.muted,
          fontSize: 11,
        }}
      >
        <strong style={{ color: colors.foreground }}>What the expert may do:</strong> read and
        search this workspace, so it can gather its own context. It cannot edit files or run
        commands. Every change still goes through Light Code&rsquo;s own tools and your
        approval, so nothing reaches your repository without passing the usual prompt.
      </div>

      <button type="button" style={primaryButtonStyle(false)}         onClick={() =>
          props.onSave(enabled, path.trim(), model.trim(), {
            maxSpendUsd: numeric(maxSpend),
            maxConsultations: Math.round(numeric(maxCalls)),
          })
        }
      >
        Save
      </button>
    </div>
  )
}
