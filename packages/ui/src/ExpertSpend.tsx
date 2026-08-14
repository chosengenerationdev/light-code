import type { ReactElement } from 'react'
import { ExpertIcon } from './icons.js'
import { colors, fontFamily } from './theme.js'

export interface ExpertSpendProps {
  usd: number
  consultations: number
  /** Consultations the CLI reported no price for. */
  unpriced: number
}

/**
 * What the expert has cost since this task was opened.
 *
 * Shown while the money is being spent rather than only in a settings tab afterwards — the
 * whole point of the junior/expert arrangement is spending less, and a number nobody sees
 * cannot be managed (§12b).
 *
 * **Scoped to the current task, and the tooltip says so.** Reconstructing a resumed task's
 * historical spend would mean parsing dollar figures back out of stored transcript text,
 * which breaks the moment that wording changes. A figure that is definitely "this task, since
 * you opened it" is more useful than one that is quietly incomplete.
 *
 * Hidden entirely at zero consultations: a persistent "$0.0000" on every session would be
 * noise for the majority of users, who never enable the expert at all.
 */
export function ExpertSpend(props: ExpertSpendProps): ReactElement | null {
  if (props.consultations === 0) return null

  const plural = props.consultations === 1 ? 'consultation' : 'consultations'
  const detail =
    props.unpriced > 0
      ? ` ${props.unpriced} of them reported no cost, so the total is at least this much.`
      : ''

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
      title={`${props.consultations} expert ${plural} since this task was opened.${detail} Starting a new task resets this.`}
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
        this task
      </span>
      <span style={{ marginLeft: 'auto' }}>
        {props.consultations} {plural}
        {props.unpriced > 0 ? ' *' : ''}
      </span>
    </div>
  )
}
