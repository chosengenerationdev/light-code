import { useEffect, useState, type ReactElement } from 'react'
import { ExpertIcon } from './icons.js'
import { colors, fontFamily, secondaryButtonStyle, textFieldStyle } from './theme.js'

export interface ExpertSpendProps {
  usd: number
  consultations: number
  /** Consultations the CLI reported no price for. */
  unpriced: number
  /** 0..1 against the nearer per-chat limit. Absent when nothing is capped. */
  usage?: number
  /** True once the expert has stopped being offered for this chat. */
  exhausted?: boolean
  /** The limits in force, from Settings or a per-chat override. 0 means no limit. */
  maxSpendUsd: number
  maxConsultations: number
  /** True when this chat is overriding the configured default. */
  overridden: boolean
  /** Whether the expert is switched on and actually runnable. */
  enabled: boolean
  /** Omitting both clears the override and returns to the configured default. */
  onSetLimits: (limits: { maxSpendUsd?: number; maxConsultations?: number }) => void
}

/**
 * What the expert has cost in this chat, and what it is allowed to cost.
 *
 * Shown while the money is being spent rather than only in a settings tab afterwards — the
 * whole point of the junior/expert arrangement is spending less, and a number nobody sees
 * cannot be managed (§12b).
 *
 * **Scoped to the current chat, and the tooltip says so.** Reconstructing a resumed task's
 * historical spend would mean parsing dollar figures back out of stored transcript text, which
 * breaks the moment that wording changes. A figure that is definitely "this chat, since you
 * opened it" is more useful than one that is quietly incomplete.
 *
 * Shown whenever the expert is enabled, not only once money has been spent. A budget is most
 * useful *before* the first consultation, and someone who never turns the expert on never sees
 * this row at all — which was the original reason for hiding it at zero.
 */
export function ExpertSpend(props: ExpertSpendProps): ReactElement | null {
  const [editing, setEditing] = useState(false)
  const [spend, setSpend] = useState(String(props.maxSpendUsd))
  const [calls, setCalls] = useState(String(props.maxConsultations))

  // The host is the authority: a limit changed in Settings, or cleared with a new chat, has to
  // land here rather than leaving stale numbers behind in a closed editor.
  useEffect(() => {
    setSpend(String(props.maxSpendUsd))
    setCalls(String(props.maxConsultations))
  }, [props.maxSpendUsd, props.maxConsultations])

  if (!props.enabled && props.consultations === 0) return null

  const plural = props.consultations === 1 ? 'consultation' : 'consultations'
  const detail =
    props.unpriced > 0
      ? ` ${String(props.unpriced)} of them reported no cost, so the total is at least this much.`
      : ''

  /*
   * Amber before the wall, not only at it. The point of the meter is that someone notices
   * before the assistant is cut off mid-task, which is the moment it is least welcome.
   */
  const near = props.usage !== undefined && props.usage >= 0.8
  const barColor = props.exhausted === true ? colors.error : near ? colors.warning : colors.expert

  const numeric = (value: string): number => {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  const apply = (): void => {
    props.onSetLimits({ maxSpendUsd: numeric(spend), maxConsultations: Math.round(numeric(calls)) })
    setEditing(false)
  }

  const limitLabel =
    props.maxSpendUsd === 0 && props.maxConsultations === 0
      ? 'no limit'
      : [
          props.maxSpendUsd > 0 ? `$${props.maxSpendUsd.toFixed(2)}` : undefined,
          props.maxConsultations > 0 ? `${String(props.maxConsultations)} calls` : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(' / ')

  return (
    <div
      style={{
        borderTop: `1px solid ${colors.border}`,
        color: colors.muted,
        fontFamily,
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 12px' }}
        title={`${String(props.consultations)} expert ${plural} in this chat.${detail}${
          props.exhausted === true
            ? ' The budget for this chat has been reached, so the expert is no longer offered.'
            : ''
        } Starting a new chat resets the spend and any override.`}
      >
        <span style={{ display: 'flex', color: colors.expert }}>
          <ExpertIcon size={11} />
        </span>
        <span>
          Expert:{' '}
          <span style={{ color: colors.foreground, fontVariantNumeric: 'tabular-nums' }}>
            {/* Four decimals because a single consultation is cents — rounding to two would
                show $0.01 for everything and hide the difference the session resume makes. */}
            ${props.usd.toFixed(4)}
          </span>{' '}
          this chat
        </span>

        {props.usage !== undefined && (
          <span
            aria-hidden
            style={{
              width: 46,
              height: 3,
              borderRadius: 2,
              background: colors.border,
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${String(Math.round(props.usage * 100))}%`,
                background: barColor,
                transition: 'width 240ms ease',
              }}
            />
          </span>
        )}

        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: props.exhausted === true ? colors.error : undefined }}>
            {props.exhausted === true ? 'budget reached' : `${String(props.consultations)} ${plural}`}
            {props.unpriced > 0 ? ' *' : ''}
          </span>
          {/*
            Labelled "Raise budget" once it is spent, not just showing the number.
            The moment someone wants more budget is the moment the assistant has just been cut
            off, and hunting for a small grey figure is the wrong thing to ask of them then.
          */}
          <button
            type="button"
            style={{
              ...secondaryButtonStyle(),
              fontSize: 10,
              padding: '1px 6px',
              ...(props.exhausted === true ? { borderColor: colors.error, color: colors.error } : {}),
            }}
            title={
              props.exhausted === true
                ? 'Raise the budget for this chat and carry on. Takes effect on the next consultation, without starting a new chat.'
                : props.overridden
                  ? 'Budget for this chat only, overriding Settings. Click to change or clear it.'
                  : 'Set a budget for this chat only. The default comes from Settings → Expert.'
            }
            onClick={() => setEditing((open) => !open)}
          >
            {props.exhausted === true ? 'Raise budget' : limitLabel}
            {props.overridden && props.exhausted !== true ? ' •' : ''}
          </button>
        </span>
      </div>

      {editing && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            padding: '4px 12px 6px',
          }}
        >
          <span>Stop after</span>
          <input
            type="number"
            min="0"
            step="0.25"
            value={spend}
            aria-label="Maximum spend for this chat, in dollars"
            onChange={(event) => setSpend(event.target.value)}
            style={{ ...textFieldStyle(), width: 76, fontSize: 11, padding: '1px 4px' }}
          />
          <span>dollars, or</span>
          <input
            type="number"
            min="0"
            step="1"
            value={calls}
            aria-label="Maximum consultations for this chat"
            onChange={(event) => setCalls(event.target.value)}
            style={{ ...textFieldStyle(), width: 60, fontSize: 11, padding: '1px 4px' }}
          />
          <span>calls. 0 means no limit.</span>
          <button
            type="button"
            style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
            onClick={apply}
          >
            Apply to this chat
          </button>
          {props.overridden && (
            <button
              type="button"
              style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
              title="Go back to the limit configured in Settings → Expert"
              onClick={() => {
                props.onSetLimits({})
                setEditing(false)
              }}
            >
              Use the default
            </button>
          )}
        </div>
      )}
    </div>
  )
}
