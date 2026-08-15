import type { ReactElement } from 'react'
import { ExpertIcon } from './icons.js'
import { colors, fontFamily } from './theme.js'

export interface ExpertSpendProps {
  usd: number
  consultations: number
  /** Consultations the CLI reported no price for. */
  unpriced: number
  /** 0..1 against the nearer per-chat limit. Absent when nothing is capped. */
  usage?: number
  /** True once the expert has stopped being offered for this chat. */
  exhausted?: boolean
}

/**
 * What the expert has cost in this chat.
 *
 * Shown while the money is being spent rather than only in a settings tab afterwards — the
 * whole point of the junior/expert arrangement is spending less, and a number nobody sees
 * cannot be managed (§12b).
 *
 * **A meter, not a control.** Setting the budget lives in the chat header beside the mode
 * selector (`ExpertBudget`), because that is where the decision belongs and because a small
 * grey figure down here did not read as something clickable. Two places to change one setting
 * is worse than one.
 *
 * **Scoped to the current chat, and the tooltip says so.** Reconstructing a resumed task's
 * historical spend would mean parsing dollar figures back out of stored transcript text, which
 * breaks the moment that wording changes. A figure that is definitely "this chat, since you
 * opened it" is more useful than one that is quietly incomplete.
 *
 * Hidden at zero consultations: a persistent "$0.0000" would be noise for the majority of
 * users, who never enable the expert at all — and the header now carries the budget, so
 * nothing is lost by waiting until there is something to report.
 */
export function ExpertSpend(props: ExpertSpendProps): ReactElement | null {
  if (props.consultations === 0) return null

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

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 12px',
        borderTop: `1px solid ${colors.border}`,
        color: colors.muted,
        fontFamily,
        fontSize: 11,
        flexShrink: 0,
      }}
      title={`${String(props.consultations)} expert ${plural} in this chat.${detail}${
        props.exhausted === true
          ? ' The budget for this chat has been reached — raise it from the header, or start a new chat.'
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

      <span style={{ marginLeft: 'auto', color: props.exhausted === true ? colors.error : undefined }}>
        {props.exhausted === true ? 'budget reached' : `${String(props.consultations)} ${plural}`}
        {props.unpriced > 0 ? ' *' : ''}
      </span>
    </div>
  )
}
