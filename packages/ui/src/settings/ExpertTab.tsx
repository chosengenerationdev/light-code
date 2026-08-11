import { useEffect, useState, type ReactElement } from 'react'
import { colors, fontFamily, labelStyle, optionStyle, primaryButtonStyle, selectStyle, textFieldStyle } from '../theme.js'
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
}

export interface ExpertTabProps {
  expert: ExpertState | undefined
  onSave: (enabled: boolean, path: string, model: string) => void
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

  // Resync when the host answers — the tab can mount before the response arrives, which is
  // the same race that made the very first settings screen look like it lost your data.
  useEffect(() => {
    if (props.expert === undefined) return
    setEnabled(props.expert.enabled)
    setPath(props.expert.path)
    setModel(props.expert.model ?? '')
  }, [props.expert])

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
        <div style={{ fontSize: 12, color: detected ? colors.foreground : colors.error }}>
          {props.expert === undefined
            ? 'Checking…'
            : detected
              ? `Found: ${props.expert.version ?? props.expert.path}`
              : 'Claude CLI not found'}
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

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="lc-expert-path" style={labelStyle()}>
          Command
        </label>
        <input
          id="lc-expert-path"
          type="text"
          value={path}
          placeholder="claude"
          onChange={(event) => setPath(event.target.value)}
          style={textFieldStyle()}
        />
        <span style={{ color: colors.muted, fontSize: 11 }}>
          Found on PATH by default. Use an absolute path for a non-standard install.
        </span>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label htmlFor="lc-expert-model" style={labelStyle()}>
          Model (optional)
        </label>
        <select
          id="lc-expert-model"
          value={EXPERT_MODELS.some((option) => option.value === model) ? model : CUSTOM}
          onChange={(event) => setModel(event.target.value === CUSTOM ? '' : event.target.value)}
          style={{ ...selectStyle(), width: '100%', marginBottom: 6 }}
        >
          {EXPERT_MODELS.map((option) => (
            <option key={option.value} value={option.value} style={optionStyle()}>
              {option.label}
            </option>
          ))}
          <option value={CUSTOM} style={optionStyle()}>
            Something else…
          </option>
        </select>

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

      <button type="button" style={primaryButtonStyle(false)} onClick={() => props.onSave(enabled, path.trim(), model.trim())}>
        Save
      </button>
    </div>
  )
}
