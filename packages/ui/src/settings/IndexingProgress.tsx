import type { ReactElement } from 'react'
import type { IndexingKind } from '@light-code/core/browser'
import { colors, secondaryButtonStyle } from '../theme.js'

export interface IndexingProgressState {
  kind: IndexingKind
  phase: string
  done?: number
  total?: number
  detail?: string
  running: boolean
}

export interface IndexingProgressProps {
  progress: IndexingProgressState | undefined
  onStop: () => void
}

/**
 * What a long-running index is doing, and the way to stop it.
 *
 * One component for every kind, because they are the same problem: something slow is happening,
 * the user cannot see it, and there was no way to change their mind. Written once so a new kind
 * of index gets the bar and the button without anyone remembering to add them.
 *
 * The bar is **indeterminate until a total is known**. A walk that has not finished counting has
 * no honest percentage, and inventing one — the usual reflex — produces a bar that reaches 90%
 * and stops, which is worse than no bar.
 */
export function IndexingProgress(props: IndexingProgressProps): ReactElement | null {
  const progress = props.progress
  if (progress === undefined) return null

  const determinate = progress.running && progress.total !== undefined && progress.total > 0
  const fraction = determinate ? Math.min(1, (progress.done ?? 0) / (progress.total ?? 1)) : 0

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: colors.muted, flex: 1, minWidth: 0 }}>
          {progress.phase}
          {determinate && ` — ${String(progress.done ?? 0)} of ${String(progress.total ?? 0)}`}
          {progress.detail !== undefined && ` · ${progress.detail}`}
        </span>
        {/*
          Only while it is running. A Stop button that lingers after the work finished invites a
          click that does nothing, which teaches people the button does not work.
        */}
        {progress.running && (
          <button type="button" style={secondaryButtonStyle()} onClick={props.onStop}>
            Stop
          </button>
        )}
      </div>

      {progress.running && (
        <div
          role="progressbar"
          aria-label={progress.phase}
          {...(determinate
            ? { 'aria-valuenow': Math.round(fraction * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }
            : {})}
          style={{
            height: 3,
            marginTop: 4,
            borderRadius: 2,
            background: colors.border,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: determinate ? `${String(Math.round(fraction * 100))}%` : '35%',
              background: colors.accent,
              transition: 'width 200ms linear',
              // Indeterminate work slides rather than sitting still, so a long silent phase does
              // not read as the whole thing having hung.
              ...(determinate ? {} : { animation: 'lc-indeterminate 1.2s ease-in-out infinite' }),
            }}
          />
        </div>
      )}
    </div>
  )
}
