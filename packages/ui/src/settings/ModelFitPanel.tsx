import { useState, type ReactElement } from 'react'
import type { JuniorAssessment } from '@light-code/core/browser'
import { Select } from '../Select.js'
import { badgeStyle, colors, secondaryButtonStyle } from '../theme.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

/** One seat and the probes that speak to it, as the host computed it. */
export interface SeatFitView {
  role: string
  name: string
  probes: string[]
  lookFor: string
}

export interface ModelFitPanelProps {
  /** Everything assessed, newest first. */
  assessments: readonly JuniorAssessment[]
  /** Which seats the probes predict, and what to look for. Computed host-side. */
  seatFits: readonly SeatFitView[]
  /** What the expert seat needs, which no probe measures. */
  expertGuidance: string
  /** Who grades the answers, and whether they can. */
  assessor: { label: string; available: boolean } | undefined
  /** The profiles a model can be assessed through. */
  profiles: readonly { id: string; label: string }[]
  /** True while probes are running. */
  assessing: boolean
  /** How far through, for the same reason. */
  step: string | undefined
  onAssess: (profileId: string | undefined) => void
  onClear: (model: string, profileLabel: string) => void
}

/**
 * Which model belongs in which seat, decided from what the models did.
 *
 * ## Why this is not in the Expert tab any more
 *
 * It was, and it was unreachable for the people who need it most. The Expert tab is nested
 * inside the budget panel, which is hidden whenever no seat is held by the Claude CLI — so
 * somebody with four models on a gateway and no Claude at all could not open the one screen that
 * would tell them which model to put where. Cost and fitness are different questions; only one of
 * them is about Claude.
 *
 * ## Why the seat advice is here rather than in the verdict
 *
 * The verdict is one model's prose about another and says nothing about seats. The mapping from
 * probe to seat is reasoned about in `agents/seats.ts`, sent over as data, and shown beside the
 * evidence — so what to look for is on screen while the answers are being read, which is the
 * moment the decision is actually made.
 */
export function ModelFitPanel(props: ModelFitPanelProps): ReactElement {
  const [chosen, setChosen] = useState('')
  const [showFits, setShowFits] = useState(false)

  const canAssess = props.assessor?.available === true && !props.assessing

  return (
    <div
      style={{
        marginBottom: 16,
        border: `1px solid ${colors.border}`,
        borderRadius: 3,
        padding: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 12, color: colors.foreground }}>Which model suits which seat</strong>
      </div>

      <p style={{ color: colors.muted, fontSize: 11, margin: '6px 0 8px', lineHeight: 1.5 }}>
        A model answers five short probes and whoever is in the expert seat grades the actual
        answers — not the model&rsquo;s name, which would be a recollection rather than a
        measurement, and which says nothing about the gateway in front of it. Assess several and
        compare them.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 180, flex: 1 }}>
          <Select
            compact
            ariaLabel="Model to assess"
            value={chosen}
            onChange={setChosen}
            options={[
              { value: '', label: 'The model in the chat' },
              ...props.profiles.map((profile) => ({ value: profile.id, label: profile.label })),
            ]}
          />
        </div>
        <button
          type="button"
          style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '2px 8px' }}
          disabled={!canAssess}
          title={
            props.assessor?.available === true
              ? `Puts five short questions to that model, then has ${props.assessor.label} grade the answers.`
              : 'Assign somebody to the expert seat first — the assessment is its judgement, not ours.'
          }
          onClick={() => props.onAssess(chosen === '' ? undefined : chosen)}
        >
          Assess it
        </button>
      </div>

      {props.assessor !== undefined && (
        <p style={{ color: colors.muted, fontSize: 11, margin: '6px 0 0' }}>
          Graded by <strong>{props.assessor.label}</strong>
          {props.assessor.available ? '' : ' — which is not available'}.
        </p>
      )}

      {props.assessing && (
        <p style={{ color: colors.muted, fontSize: 11, margin: '6px 0 0' }}>
          {props.step ?? 'Working…'}
        </p>
      )}

      {props.assessments.map((assessment) => (
        <AssessmentView
          key={`${assessment.profileLabel}:${assessment.model}`}
          assessment={assessment}
          onClear={() => props.onClear(assessment.model, assessment.profileLabel)}
        />
      ))}

      <button
        type="button"
        style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px', marginTop: 10 }}
        onClick={() => setShowFits((value) => !value)}
      >
        {showFits ? 'Hide' : 'Show'} what each seat needs
      </button>

      {showFits && (
        <div style={{ marginTop: 8 }}>
          {props.seatFits.map((fit) => (
            <div key={fit.role} style={{ marginTop: 8, fontSize: 11 }}>
              <div style={{ color: colors.foreground }}>
                <strong>{fit.name}</strong>{' '}
                <span style={{ color: colors.muted }}>· read {fit.probes.join(', ')}</span>
              </div>
              <div style={{ color: colors.muted, lineHeight: 1.5 }}>{fit.lookFor}</div>
            </div>
          ))}
          <div style={{ marginTop: 8, fontSize: 11 }}>
            <div style={{ color: colors.foreground }}>
              <strong>Expert</strong>{' '}
              <span style={{ color: colors.muted }}>· no probe predicts this</span>
            </div>
            <div style={{ color: colors.muted, lineHeight: 1.5 }}>{props.expertGuidance}</div>
          </div>
          {/*
            The one rule that needs no measurement, and the one most easily got wrong: a model
            reviewing work it wrote agrees with itself, and an approving reviewer is worse than
            none because it gets believed.
          */}
          <div style={{ marginTop: 8, fontSize: 11, color: colors.muted, lineHeight: 1.5 }}>
            Whatever the answers say, do not put the same model in the programmer and reviewer
            seats. A model reviewing its own work agrees with itself.
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The verdict, and the evidence behind it.
 *
 * **The probe answers are shown, collapsed.** An assessment is one model's opinion of another,
 * and the only way for the user to judge whether it is fair is to read what the model actually
 * said. Hiding that would make it an oracle; showing it makes it an argument.
 */
function AssessmentView(props: {
  assessment: JuniorAssessment
  onClear: () => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const { assessment } = props

  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${colors.border}` }}>
      <div
        style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', fontSize: 11 }}
      >
        <span style={{ fontFamily: monospace, color: colors.foreground }}>{assessment.model}</span>
        <span style={{ color: colors.muted }}>
          via {assessment.profileLabel} · {new Date(assessment.assessedAt).toLocaleDateString()}
          {assessment.costUsd !== undefined ? ` · $${assessment.costUsd.toFixed(4)}` : ''}
        </span>
        <button
          type="button"
          aria-label={`Forget the assessment of ${assessment.model}`}
          style={{
            ...secondaryButtonStyle(),
            fontSize: 10,
            padding: '0 5px',
            marginLeft: 'auto',
          }}
          onClick={props.onClear}
        >
          Forget
        </button>
      </div>

      <div
        style={{
          whiteSpace: 'pre-wrap',
          fontSize: 11,
          color: colors.foreground,
          marginTop: 6,
          paddingLeft: 8,
          borderLeft: `2px solid ${colors.expert}`,
        }}
      >
        {assessment.verdict}
      </div>

      <button
        type="button"
        style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px', marginTop: 6 }}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide' : 'Show'} what it answered ({assessment.probes.length})
      </button>

      {open &&
        assessment.probes.map((probe) => (
          <div key={probe.id} style={{ marginTop: 8, fontSize: 11 }}>
            <div style={{ color: colors.foreground }}>
              {probe.measures}{' '}
              <span style={{ ...badgeStyle('neutral'), fontSize: 9 }}>{probe.id}</span>
            </div>
            <pre
              style={{
                margin: '3px 0 0',
                padding: 6,
                whiteSpace: 'pre-wrap',
                fontFamily: monospace,
                fontSize: 10,
                color: probe.error !== undefined ? colors.error : colors.muted,
                background: colors.inputBackground,
                borderRadius: 3,
              }}
            >
              {probe.error !== undefined
                ? `No answer — ${probe.error}`
                : probe.answer.trim() || '(empty)'}
            </pre>
          </div>
        ))}
    </div>
  )
}
