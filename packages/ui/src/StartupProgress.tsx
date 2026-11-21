import { useEffect, useState, type ReactElement } from 'react'

import { colors, fontFamily } from './theme.js'

/**
 * What the chat is still getting ready, over the message box - asked for after chats took more than 90 seconds to
 * start with nothing saying why: "can we show some progress bar over chat input, that explains what we are waiting
 * on?". Each item is named with how long it has taken so far; the bar goes when nothing is left. A message sent
 * meanwhile waits for what it needs and then goes.
 */
export interface StartupProgressProps {
  /** `full`: the whole text, when the label's paths were shortened - shown on hover. */
  waiting: readonly { label: string; since: number; full?: string | undefined }[]
}

function seconds(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000))
  return s < 60 ? `${String(s)} s` : `${String(Math.floor(s / 60))} min ${String(s % 60)} s`
}

export function StartupProgress(props: StartupProgressProps): ReactElement | null {
  const [now, setNow] = useState(() => Date.now())
  const active = props.waiting.length > 0
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  if (!active) return null
  return (
    <div role="status" aria-live="polite" style={{ padding: '6px 12px', borderTop: `1px solid ${colors.border}`, fontFamily, fontSize: 11, color: colors.muted }}>
      <div style={{ marginBottom: 4 }}>
        Getting this chat ready - a message sent now waits for it:{' '}
        {props.waiting.map((item, index) => (
          <span key={item.label}>
            {index > 0 ? ', ' : ''}
            <span style={{ color: colors.foreground }} title={item.full ?? item.label}>{item.label}</span> ({seconds(item.since, now)})
          </span>
        ))}
      </div>
      <div style={{ position: 'relative', height: 3, overflow: 'hidden', borderRadius: 2, background: colors.border }}>
        <div className="lc-startup-bar" style={{ position: 'absolute', top: 0, bottom: 0, width: '35%', background: colors.accent, borderRadius: 2 }} />
      </div>
    </div>
  )
}
