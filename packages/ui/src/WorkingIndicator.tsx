import { useEffect, useState, type ReactElement } from 'react'
import { colors, fontFamily } from './theme.js'

export interface WorkingIndicatorProps {
  /** What is happening right now, e.g. "Running read_file". Defaults to "Thinking". */
  label?: string
  /**
   * Tints the dots in the expert's colour while a consultation is in flight.
   *
   * A consultation is the slowest thing the agent does and the only one that spends money
   * at a second provider, so "who is working" is worth showing during the wait rather than
   * only in the result afterwards.
   */
  variant?: 'default' | 'expert'
}

/**
 * Something moving while the model works.
 *
 * There is otherwise dead air between sending and the first token — several seconds on a
 * slow gateway, longer for a reasoning model — during which the panel looks frozen and the
 * honest question "did that send?" has no answer on screen.
 *
 * **The dots are CSS now, not a timer.** This used to repaint every 400ms because a `<style>`
 * element carrying `@keyframes` would have been blocked by the webview's `default-src 'none'`
 * CSP. `styles.ts` adopts a *constructable* stylesheet instead, which is CSSOM and so is not
 * subject to `style-src` at all — the animation runs on the compositor for free, and React
 * now re-renders once a second for the elapsed counter rather than 2.5 times.
 *
 * Shaped like a messaging app's typing indicator on purpose: it is the one progress idiom
 * nobody has to learn.
 */
export function WorkingIndicator(props: WorkingIndicatorProps): ReactElement {
  const [startedAt] = useState(() => Date.now())
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={props.label ?? 'Working'}
      className="lc-fade-up"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '2px 12px',
        // Left-aligned under the assistant's bubbles: it is the assistant that is working.
        margin: '4px 10px 4px 40px',
        color: colors.muted,
        fontFamily,
        fontSize: 12,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          padding: '6px 9px',
          borderRadius: '12px 12px 12px 4px',
          background: colors.assistantBubble,
        }}
      >
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="lc-dot"
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: props.variant === 'expert' ? colors.expert : colors.accent,
              display: 'block',
            }}
          />
        ))}
      </span>
      <span style={{ fontStyle: 'italic' }}>{props.label ?? 'Thinking'}</span>
      {/* Only after a few seconds: on a fast reply the number appears and vanishes, which
          is more distracting than useful. On a slow one it is the reassurance. */}
      {elapsed >= 3 && <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{elapsed}s</span>}
    </div>
  )
}
