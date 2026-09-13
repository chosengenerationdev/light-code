import { useEffect, useState, type ReactElement } from 'react'
import { Select } from '../Select.js'
import {
  describePricing,
  type ExpertPricing,
  type ExpertSavings,
  type JuniorAssessment,
} from '@light-code/core/browser'
import { SavingsPanel } from './SavingsPanel.js'
import {
  colors,
  fontFamily,
  labelStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  textFieldStyle,
} from '../theme.js'
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
  /** Undefined until a consultation has revealed whether this plan prices calls. */
  reportsCost?: boolean
  /** What a consultation costs here, once measured. */
  pricing?: ExpertPricing
  /** Set while a measurement is running. */
  measuringStep?: string
  /** Whether the session cache is refreshed while a task is open. */
  keepAlive?: boolean
  /** The assessment of the model now in the chat, when one has been made. */
  assessment?: JuniorAssessment
  /** Every model assessed, newest first. Rendered by the Agents tab, not here. */
  assessments?: JuniorAssessment[]
  seatFits?: { role: string; name: string; probes: string[]; lookFor: string }[]
  expertGuidance?: string
  assessor?: { label: string; available: boolean }
  assessing?: boolean
  assessmentStep?: string
  /** What Junior mode has cost and avoided. Absent before the log has been read. */
  savings?: ExpertSavings
}

export interface ExpertTabProps {
  expert: ExpertState | undefined
  /** Native picker, for when detection cannot find it and typing the path is guesswork. */
  onBrowse?: (request: BrowseRequest) => void
  pickedPath?: { purpose: string; path: string } | undefined
  /** Re-runs detection. The probe spawns a process, so it is never automatic on a timer. */
  onRecheck: () => void
  /** Runs two real consultations to learn what they cost here. */
  onMeasureCost: () => void
  onClearPricing: () => void
  onSetKeepAlive: (enabled: boolean) => void
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
/**
 * The Claude CLI expert: detection, the path, and everything about what it costs.
 *
 * Nested inside the Agents tab, and only where a budget applies. It briefly had a sibling — a
 * cut-down panel for a provider-backed expert on the Node host — which the Agents tab then
 * superseded outright: the expert is a *role*, and which model sits in it is one picker among
 * five. Two panels for one idea is the drift this project pays for most often, so the sibling
 * went rather than being kept in step.
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
        Lets your everyday model consult Claude on hard problems — planning a change across several
        files, diagnosing a bug it has already failed to fix, or weighing two designs. It decides
        when the question is worth it, and each consultation appears in the transcript with what it
        cost.
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
            style={{
              ...secondaryButtonStyle(),
              fontSize: 10,
              padding: '1px 6px',
              marginLeft: 'auto',
            }}
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

      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 6,
          marginBottom: 12,
          fontSize: 12,
        }}
      >
        <input
          type="checkbox"
          style={{ marginTop: 2 }}
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span style={{ color: colors.foreground }}>
          Enable Claude as the expert
          <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 2 }}>
            Consultations are billed to your Claude account at its usual rates. Off by default;
            nothing runs and nothing is spent until you turn this on.
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
          <span style={{ color: colors.muted, fontSize: 11 }}>
            consultations — whichever comes first.
          </span>
        </div>

        {/*
          What this plan actually does about pricing, learned from real consultations rather than
          asked for — asking means making a call, and the first call is the expensive one.

          It matters because a spend cap cannot bind where nothing is priced: the total stays at
          zero and the limit is never reached. A cap that silently never fires is worse than no cap
          at all, because it is believed.
        */}
        {/*
          Measured, not assumed. The published figures came from one plan on one day, and an
          enterprise agreement or a subscription can report something else entirely — or nothing.
          Those numbers are what the budget is set from and what the expert is told when it plans
          to fit, so being wrong about them is not cosmetic.
        */}
        <div
          style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}
        >
          <button
            type="button"
            style={secondaryButtonStyle()}
            disabled={props.expert?.available !== true || props.expert.measuringStep !== undefined}
            onClick={props.onMeasureCost}
          >
            {props.expert?.measuringStep !== undefined
              ? 'Measuring…'
              : 'Measure what a consultation costs'}
          </button>
          {props.expert?.pricing !== undefined && (
            <button type="button" style={secondaryButtonStyle()} onClick={props.onClearPricing}>
              Clear
            </button>
          )}
        </div>

        {props.expert?.measuringStep !== undefined && (
          <p style={{ color: colors.muted, fontSize: 11, margin: '6px 0 0' }}>
            {props.expert.measuringStep}
          </p>
        )}

        {/*
          Said before it is spent. A tool that quietly bills you to tell you about billing would be
          an unusually poor joke — and two calls is the minimum, because one sample cannot show the
          ratio between a cold session and a resumed one, which is the number that actually
          matters.
        */}
        {props.expert?.measuringStep === undefined && props.expert?.pricing === undefined && (
          <p style={{ color: colors.muted, fontSize: 11, margin: '6px 0 0' }}>
            This makes <strong>two real consultations</strong> — one cold, one resumed — and costs
            what they cost. It is the only way to learn the price here, and the ratio between the
            two is what the budget advice depends on.
          </p>
        )}

        {props.expert?.pricing !== undefined && (
          <p style={{ color: colors.muted, fontSize: 11, margin: '6px 0 0' }}>
            {describePricing(props.expert.pricing)}{' '}
            <span style={{ opacity: 0.75 }}>
              Measured {new Date(props.expert.pricing.measuredAt).toLocaleDateString()}. The expert
              is told these numbers so it plans in them.
            </span>
          </p>
        )}

        {/*
          Placed directly under the measurement it depends on, so the reader meets the price
          before the figure derived from it. Above the budget controls, because what the mode has
          already avoided is the argument for what to spend next.
        */}
        <SavingsPanel savings={props.expert?.savings} />

        {/*
          Spending with nobody at the screen, so it is off by default and says plainly what it
          does. The cost is counted in the meter — a background timer whose spending did not show
          up anywhere is the version of this feature nobody should trust.
        */}
        <label
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            margin: '12px 0 0',
            cursor: props.expert?.available === true ? 'pointer' : 'not-allowed',
            opacity: props.expert?.available === true ? 1 : 0.55,
          }}
        >
          <input
            type="checkbox"
            checked={props.expert?.keepAlive === true}
            disabled={props.expert?.available !== true}
            onChange={(event) => props.onSetKeepAlive(event.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            <span style={{ display: 'block', fontSize: 13 }}>
              Keep the session warm during a task
            </span>
            <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
              The expert&rsquo;s cache lasts an hour, so a long break means the next consultation
              pays full price again. This sends one trivial consultation every fifty minutes while a
              task has a session open — roughly a fiftieth of the cold start it avoids.{' '}
              <strong>It spends while you are away</strong>, so it is counted in the meter like
              anything else. It never starts a session, and stops when the budget is spent or the
              task ends.
            </span>
          </span>
        </label>

        {props.expert?.reportsCost === false && (
          <p style={{ color: colors.error, fontSize: 11, margin: '6px 0 0' }}>
            <strong>Your plan does not report a cost per consultation</strong>, so the spending
            limit above can never be reached — the running total stays at zero. Use the consultation
            limit instead; it is checked first and works on any plan.
          </p>
        )}
        {props.expert !== undefined && props.expert.reportsCost === undefined && (
          <p style={{ color: colors.muted, fontSize: 11, margin: '6px 0 0' }}>
            Whether the spending limit can apply depends on your plan reporting a cost. That is
            settled by the first consultation, and this will say so once it has.
          </p>
        )}
        <span style={{ color: colors.muted, fontSize: 11 }}>
          0 means no limit. When a limit is reached the expert stops being offered for that task and
          the assistant carries on alone; starting a new task resets it. A count limit is worth
          setting even if you set a spend limit, because the CLI does not always report a price and
          an unpriced consultation still costs money.
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
        commands. Every change still goes through Light Code&rsquo;s own tools and your approval, so
        nothing reaches your repository without passing the usual prompt.
      </div>

      <button
        type="button"
        style={primaryButtonStyle(false)}
        onClick={() =>
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
