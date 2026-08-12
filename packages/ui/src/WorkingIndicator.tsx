import { useEffect, useState, type ReactElement } from 'react'
import { colors, fontFamily } from './theme.js'

export interface WorkingIndicatorProps {
  /** What is happening right now, e.g. "Running read_file". Defaults to "Thinking". */
  label?: string
}

/**
 * Something moving while the model works.
 *
 * There is otherwise dead air between sending and the first token — several seconds on a
 * slow gateway, longer for a reasoning model — during which the panel looks frozen and the
 * honest question "did that send?" has no answer on screen.
 *
 * **Animated in JavaScript rather than CSS.** The webview's CSP is `default-src 'none'`
 * with no `style-src` exception, which is deliberate (CLAUDE.md §2b: styling goes through
 * React's `style` prop, so it never needs one). A `<style>` element carrying `@keyframes`
 * would be blocked, so the frames are driven by a timer instead.
 */
export function WorkingIndicator(props: WorkingIndicatorProps): ReactElement {
  const [frame, setFrame] = useState(0)
  const [startedAt] = useState(() => Date.now())
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => current + 1)
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 400)
    return () => clearInterval(timer)
  }, [startedAt])

  // Three dots filling and emptying. Rendered at a fixed width so the label does not
  // shuffle sideways each frame.
  const filled = (frame % 4) as 0 | 1 | 2 | 3
  const dots = '•'.repeat(filled).padEnd(3, ' ')

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={props.label ?? 'Working'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        margin: '6px 8px',
        color: colors.muted,
        fontFamily,
        fontSize: 12,
        fontStyle: 'italic',
      }}
    >
      <span style={{ letterSpacing: 2, minWidth: 26 }}>{dots}</span>
      <span>{props.label ?? 'Thinking'}</span>
      {/* Only after a few seconds: on a fast reply the number appears and vanishes, which
          is more distracting than useful. On a slow one it is the reassurance. */}
      {elapsed >= 3 && <span style={{ marginLeft: 'auto' }}>{elapsed}s</span>}
    </div>
  )
}
