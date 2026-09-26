import { useState, type ReactElement, type ReactNode } from 'react'

import { colors, fontFamily } from '../theme.js'

/**
 * One collapsible section of a settings tab.
 *
 * Asked for because the tabs had grown into long columns of unrelated sections: "UI become very
 * complicated, can you change each section to collapsible panels in all the tabs? this should
 * match with appearance theme".
 *
 * ## Theme
 *
 * Only the tokens in `theme.ts` — the editor's own colours for surface, border and text, and the
 * user's accent (Settings → Appearance) for the open panel's edge and chevron. So a panel follows
 * light, dark, high contrast and a chosen accent with nothing of its own to keep in step.
 *
 * ## Collapsed means hidden, not gone
 *
 * The body stays mounted and is hidden. Unmounting it would throw away whatever was half-typed in
 * a form the moment somebody tidied the tab, which is exactly the loss §19's "a saved value looked
 * lost" bugs were about.
 *
 * ## Remembered per panel
 *
 * Open or closed is kept per `id` in this webview's storage, so a tab comes back the way it was
 * left. Storage can be unavailable (a locked-down webview); then the default simply applies.
 */

export interface PanelProps {
  /** Stable across releases: it keys the remembered open/closed state. */
  id: string
  title: string
  /** One line beside the title, visible while closed — "3 servers", "Off", "Connected". */
  summary?: ReactNode
  /** Open the first time the tab is shown. Default false. */
  defaultOpen?: boolean
  /**
   * Shown open whatever it was left as, while true — for a panel where something is in progress
   * (an import waiting for a choice). A chooser appearing inside a closed panel would be a click
   * that seemed to do nothing.
   */
  forceOpen?: boolean
  children: ReactNode
}

const STORAGE_PREFIX = 'lc.panel.'

function remembered(id: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(STORAGE_PREFIX + id)
    return value === null ? fallback : value === '1'
  } catch {
    return fallback
  }
}

function remember(id: string, open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + id, open ? '1' : '0')
  } catch {
    // Unavailable storage costs only the memory of it, never the panel.
  }
}

export function Panel(props: PanelProps): ReactElement {
  const [chosen, setOpen] = useState(() => remembered(props.id, props.defaultOpen === true))
  const open = chosen || props.forceOpen === true
  const bodyId = `lc-panel-${props.id}`

  return (
    <section
      style={{
        margin: '10px 0',
        border: `1px solid ${colors.border}`,
        // The accent marks the open one, so the eye finds where it is working.
        borderLeft: `3px solid ${open ? colors.accent : colors.border}`,
        borderRadius: 6,
        background: colors.background,
        fontFamily,
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          setOpen(!open)
          remember(props.id, !open)
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 10px',
          background: 'transparent',
          border: 'none',
          color: colors.foreground,
          cursor: 'pointer',
          fontFamily,
          fontSize: 13,
          textAlign: 'left',
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 10,
            color: open ? colors.accent : colors.muted,
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms ease',
          }}
        >
          ▶
        </span>
        <span style={{ fontWeight: 600 }}>{props.title}</span>
        {props.summary !== undefined && (
          <span
            style={{
              marginLeft: 'auto',
              color: colors.muted,
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '55%',
            }}
          >
            {props.summary}
          </span>
        )}
      </button>
      <div id={bodyId} hidden={!open} style={{ padding: '0 10px 10px' }}>
        {props.children}
      </div>
    </section>
  )
}
