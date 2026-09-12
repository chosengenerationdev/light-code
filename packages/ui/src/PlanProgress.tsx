import type { CheckpointView } from '@light-code/core/browser'
import type { ReactElement } from 'react'
import { agentColors, colors } from './theme.js'

/**
 * The plan, as progress through it.
 *
 * ## Why the steps arrive rather than being parsed here
 *
 * The panel could split the plan text itself and save a protocol message. It must not: the
 * numbering is a *contract* — `plan_progress` takes those numbers and the assistant is given them
 * in its prompt — so a second implementation of "what are the steps" would eventually disagree
 * with the one the model is working to, and the symptom would be the user watching the wrong row
 * light up. `agent/checkpoints.ts` is the single owner and the host sends the result.
 *
 * ## Why a role colour is a claim worth being careful with
 *
 * A coloured row reads as "the reviewer did this". So the colours come from consultations that
 * actually ran during the step, recorded host-side, never from the assistant naming a role. A
 * step nobody was consulted on carries no chip at all, which is the honest rendering — inventing
 * "done by the assistant" would make the absence of help look like a contribution.
 */

export interface PlanProgressProps {
  plan: string
  checkpoints: CheckpointView[]
  onClose: () => void
  /** Opens the plan editor, so "this is wrong" has somewhere to go from here. */
  onEdit: () => void
}

const STATUS_LABEL: Record<CheckpointView['status'], string> = {
  done: 'Done',
  active: 'In progress',
  todo: 'Not started',
}

function StatusMark({ status }: { status: CheckpointView['status'] }): ReactElement {
  const common = { width: 14, height: 14, flex: '0 0 auto', marginTop: 2 } as const

  if (status === 'done') {
    return (
      <svg {...common} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill={colors.accent} />
        <path
          d="M4.5 8.2l2.3 2.3 4.7-4.7"
          fill="none"
          stroke={colors.accentContrast}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  if (status === 'active') {
    return (
      <svg {...common} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.4" fill="none" stroke={colors.accent} strokeWidth="1.6" />
        <circle cx="8" cy="8" r="3" fill={colors.accent} />
      </svg>
    )
  }

  return (
    <svg {...common} viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6.4"
        fill="none"
        stroke={colors.border}
        strokeWidth="1.6"
        strokeDasharray="2.5 2.5"
      />
    </svg>
  )
}

/**
 * A role on a step, in one of two meanings that must never look the same.
 *
 * `planned` is what the approved plan says should happen — an intention, and one the model wrote.
 * Solid is what actually happened: a consultation the host recorded while that step was open.
 * The whole value of the second is that nobody can assert it, so it is drawn as the stronger of
 * the two and the planned one is deliberately faint and dashed. Merging them would throw away
 * the only distinction worth having here.
 */
function RoleChip({ role, planned }: { role: string; planned?: boolean }): ReactElement {
  const palette = agentColors(role)
  return (
    <span
      title={
        planned === true
          ? `The plan says the ${role} should be involved in this step`
          : `${role} was consulted while this step was being worked`
      }
      style={{
        background: planned === true ? 'transparent' : palette.soft,
        color: palette.edge,
        border: `1px ${planned === true ? 'dashed' : 'solid'} ${palette.edge}`,
        opacity: planned === true ? 0.75 : 1,
        borderRadius: 999,
        padding: '0 6px',
        fontSize: 10,
        lineHeight: '15px',
        whiteSpace: 'nowrap',
      }}
    >
      {planned === true ? `${role}?` : role}
    </span>
  )
}

export function PlanProgress(props: PlanProgressProps): ReactElement {
  const done = props.checkpoints.filter((checkpoint) => checkpoint.status === 'done')
  const active = props.checkpoints.filter((checkpoint) => checkpoint.status === 'active')
  const remaining = props.checkpoints.filter((checkpoint) => checkpoint.status === 'todo')
  const next = active[0] ?? remaining[0]

  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        background: colors.inputBackground,
        padding: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <strong style={{ fontSize: 12 }}>Progress</strong>
        <span style={{ color: colors.muted, fontSize: 11, flex: 1 }}>
          {props.checkpoints.length > 0
            ? `${String(done.length)} of ${String(props.checkpoints.length)} steps complete`
            : 'This plan has no steps to track'}
        </span>
        <button type="button" style={linkButton()} onClick={props.onEdit}>
          Edit plan
        </button>
        <button type="button" style={linkButton()} onClick={props.onClose}>
          Close
        </button>
      </div>

      {props.checkpoints.length > 0 && (
        <div
          style={{
            height: 4,
            borderRadius: 999,
            background: colors.border,
            overflow: 'hidden',
            marginBottom: 8,
          }}
        >
          <div
            style={{
              width: `${String(Math.round((done.length / props.checkpoints.length) * 100))}%`,
              height: '100%',
              background: colors.accentGradient,
            }}
          />
        </div>
      )}

      {/*
        Steps on the left, the plan as written on the right — and `wrap`, because this renders in
        a VS Code sidebar that is routinely narrower than two columns can survive. Wrapping puts
        the steps above the prose rather than crushing both, which is the right order: the steps
        are what this panel is for.
      */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
        <ol
          style={{
            flex: '1 1 190px',
            minWidth: 0,
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {props.checkpoints.map((checkpoint) => (
            <li
              key={checkpoint.id}
              style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12 }}
            >
              <StatusMark status={checkpoint.status} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    color: checkpoint.status === 'todo' ? colors.muted : colors.foreground,
                    // Struck through rather than hidden: what has been done is most of what a
                    // progress view is for, and a list that shrank as work finished would be a
                    // list you could not check.
                    textDecoration: checkpoint.status === 'done' ? 'line-through' : 'none',
                    wordBreak: 'break-word',
                  }}
                >
                  <span style={{ color: colors.muted, marginRight: 4 }}>{checkpoint.index}.</span>
                  {checkpoint.text}
                </div>
                {(checkpoint.roles.length > 0 ||
                  checkpoint.plannedRoles.length > 0 ||
                  checkpoint.status !== 'todo') && (
                  <div
                    style={{
                      display: 'flex',
                      gap: 4,
                      marginTop: 2,
                      flexWrap: 'wrap',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ color: colors.muted, fontSize: 10 }}>
                      {STATUS_LABEL[checkpoint.status]}
                    </span>
                    {checkpoint.roles.map((role) => (
                      <RoleChip key={role} role={role} />
                    ))}
                    {/* Only the ones not yet confirmed: once a specialist has actually answered,
                        the intention is history and showing both says nothing extra. */}
                    {checkpoint.plannedRoles
                      .filter((role) => !checkpoint.roles.includes(role))
                      .map((role) => (
                        <RoleChip key={`planned-${role}`} role={role} planned />
                      ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>

        <div style={{ flex: '1 1 190px', minWidth: 0 }}>
          <div style={{ color: colors.muted, fontSize: 10, marginBottom: 3 }}>
            {next !== undefined
              ? `Next: step ${String(next.index)}`
              : props.checkpoints.length > 0
                ? 'Every step is complete'
                : 'The plan'}
          </div>
          <div
            className="lc-scroll"
            style={{
              maxHeight: 180,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 11,
              color: colors.muted,
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              padding: 6,
            }}
          >
            {props.plan}
          </div>
        </div>
      </div>
    </div>
  )
}

function linkButton(): React.CSSProperties {
  return {
    background: 'none',
    border: 'none',
    color: colors.muted,
    cursor: 'pointer',
    fontSize: 11,
    padding: '0 2px',
  }
}
