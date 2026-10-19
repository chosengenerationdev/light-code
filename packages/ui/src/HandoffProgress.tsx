import type { ReactElement } from 'react'
import { colors, fontFamily, secondaryButtonStyle } from './theme.js'

/**
 * While a handoff is written: what is happening, how much of the note exists, and a way out.
 *
 * Asked for directly - writing the note takes as long as a long reply, and a button that goes quiet for
 * that long reads as hung. The bar moves continuously and the character count climbs as the model writes.
 */
export type HandoffPhase = 'gathering' | 'writing' | 'starting' | 'done' | 'failed' | 'cancelled'

const STEPS: { phase: HandoffPhase; label: string }[] = [
  { phase: 'gathering', label: 'Saving this chat and collecting what was done' },
  { phase: 'writing', label: 'The assistant is writing the handoff' },
  { phase: 'starting', label: 'Starting the new chat' },
]

export function HandoffProgress(props: {
  phase: HandoffPhase
  written?: number | undefined
  message?: string | undefined
  onCancel: () => void
  onDismiss: () => void
}): ReactElement {
  const finished = props.phase === 'failed' || props.phase === 'cancelled'
  const current = STEPS.findIndex((step) => step.phase === props.phase)
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        margin: '8px 12px',
        padding: '10px 12px',
        border: `1px solid ${props.phase === 'failed' ? colors.error : colors.border}`,
        borderRadius: 8,
        fontFamily,
        fontSize: 12,
        background: colors.inputBackground,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {props.phase === 'failed' ? 'The handoff did not complete' : props.phase === 'cancelled' ? 'Handoff cancelled' : 'Starting a new chat with a handoff'}
      </div>
      {finished ? (
        <div style={{ color: props.phase === 'failed' ? colors.error : colors.muted, marginBottom: 8 }}>
          {props.message ?? 'This chat is unchanged.'}
        </div>
      ) : (
        <>
          <ol style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            {STEPS.map((step, index) => (
              <li key={step.phase} style={{ color: index <= current ? colors.foreground : colors.muted, fontWeight: index === current ? 600 : 400 }}>
                {index < current ? '✓ ' : ''}
                {step.label}
                {step.phase === 'writing' && index === current && props.written !== undefined && props.written > 0
                  ? ` - ${props.written.toLocaleString()} characters so far`
                  : ''}
              </li>
            ))}
          </ol>
          <div
            aria-hidden="true"
            className="lc-handoff-bar"
            style={{ position: 'relative', height: 4, borderRadius: 2, overflow: 'hidden', background: colors.border, marginBottom: 8 }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                width: '35%',
                borderRadius: 2,
                background: colors.accent,
                animation: 'lc-handoff-slide 1.2s ease-in-out infinite',
              }}
            />
          </div>
        </>
      )}
      <button type="button" style={secondaryButtonStyle()} onClick={finished ? props.onDismiss : props.onCancel}>
        {finished ? 'Close' : 'Cancel'}
      </button>
    </div>
  )
}
