import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { ChevronIcon } from './icons.js'
import { colors, fontFamily, selectStyle } from './theme.js'

/**
 * A dropdown that actually obeys the theme.
 *
 * ## Why this is not a `<select>`
 *
 * It was one, and the popup kept rendering with the system highlight — a blue row in a purple
 * UI. The closed control was themeable, and so was each `<option>`'s background, but the
 * *selected row's* highlight is painted by the browser's own popup widget. Chromium ignores
 * `background-color` on `option:checked` there, and the inset-box-shadow trick that works for
 * a `size > 1` list box does not reach a dropdown popup. macOS is worse again: it draws the
 * list with the system appearance and ignores CSS entirely.
 *
 * There is no CSS answer to that, so this renders its own listbox. That also fixes macOS,
 * which the previous approach explicitly could not.
 *
 * ## Positioned `fixed`, deliberately
 *
 * An absolutely-positioned popup is clipped by any scrolling ancestor, and this renders
 * inside the settings scroll pane *and* at the very bottom of the composer. `fixed` escapes
 * clipping entirely; the cost is that it must be re-measured, so it closes on scroll rather
 * than drifting away from its button. It also flips above the button when there is not enough
 * room below — in a sidebar, the composer's dropdowns have nothing but a few pixels beneath
 * them.
 */

export interface SelectOption {
  value: string
  label: string
  /** Rendered under the label, quieter. Used for a model id beside a profile name. */
  detail?: string
  disabled?: boolean
}

export interface SelectProps {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  /** Shown when nothing matches `value`. */
  placeholder?: string
  compact?: boolean
  disabled?: boolean
  title?: string
  ariaLabel?: string
  style?: CSSProperties
  id?: string
}

interface Position {
  left: number
  top: number
  width: number
  /** Opening upward changes which corner is squared off, so the popup points at its button. */
  above: boolean
}

const MAX_POPUP_HEIGHT = 260

export function Select(props: SelectProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const [position, setPosition] = useState<Position | undefined>(undefined)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selectedIndex = props.options.findIndex((option) => option.value === props.value)
  const selected = selectedIndex >= 0 ? props.options[selectedIndex] : undefined

  const measure = (): void => {
    const button = buttonRef.current
    if (button === null) return
    const rect = button.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom
    const above = below < Math.min(MAX_POPUP_HEIGHT, props.options.length * 28 + 8) && rect.top > below
    setPosition({
      left: rect.left,
      top: above ? rect.top : rect.bottom,
      width: rect.width,
      above,
    })
  }

  // Layout effect so the popup is placed before paint; a frame at the wrong position reads
  // as a flicker in the corner of the eye.
  // Runs on open only. `measure` reads refs and props at call time, so it does not need to
  // be a dependency — and re-measuring on every render would fight the scroll-to-close above.
  useLayoutEffect(() => {
    if (open) measure()
  }, [open])

  useEffect(() => {
    if (!open) return

    const close = (): void => setOpen(false)
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target !== null && (buttonRef.current?.contains(target) === true || listRef.current?.contains(target) === true)) {
        return
      }
      close()
    }
    // Capture, so a scroll inside the settings pane closes it too rather than only the window.
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  /** Keeps the highlighted row in view when arrowing past the visible window. */
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, open])

  const openList = (): void => {
    setHighlighted(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  const choose = (index: number): void => {
    const option = props.options[index]
    if (option === undefined || option.disabled === true) return
    props.onChange(option.value)
    setOpen(false)
    // Focus goes back to the trigger, or a keyboard user is dropped at the top of the page.
    buttonRef.current?.focus()
  }

  const step = (delta: number): void => {
    if (props.options.length === 0) return
    let next = highlighted
    // Skips disabled entries rather than landing on one and doing nothing on Enter.
    for (let attempt = 0; attempt < props.options.length; attempt++) {
      next = (next + delta + props.options.length) % props.options.length
      if (props.options[next]?.disabled !== true) break
    }
    setHighlighted(next)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (props.disabled === true) return

    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openList()
      }
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      step(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      step(-1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setHighlighted(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setHighlighted(props.options.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(highlighted)
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false)
    }
  }

  const label = selected?.label ?? props.placeholder ?? ''

  return (
    <>
      <button
        ref={buttonRef}
        id={props.id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={props.ariaLabel}
        title={props.title}
        disabled={props.disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        style={{
          ...selectStyle(props.compact),
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          textAlign: 'left',
          cursor: props.disabled === true ? 'default' : 'pointer',
          opacity: props.disabled === true ? 0.6 : 1,
          ...props.style,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: selected === undefined ? colors.muted : colors.inputForeground,
          }}
        >
          {label}
        </span>
        <span
          aria-hidden="true"
          style={{
            display: 'flex',
            flexShrink: 0,
            color: colors.muted,
            // Points down when closed, up when open — the state is readable at a glance.
            transform: open ? 'rotate(-90deg)' : 'rotate(90deg)',
            transition: 'transform 190ms cubic-bezier(0.22, 0.85, 0.28, 1)',
          }}
        >
          <ChevronIcon size={props.compact === true ? 10 : 12} />
        </span>
      </button>

      {open && position !== undefined && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={props.ariaLabel}
          className="lc-scroll lc-fade-up"
          style={{
            position: 'fixed',
            left: position.left,
            width: Math.max(position.width, 160),
            ...(position.above ? { bottom: window.innerHeight - position.top + 4 } : { top: position.top + 4 }),
            maxHeight: MAX_POPUP_HEIGHT,
            overflowY: 'auto',
            zIndex: 1000,
            background: colors.inputBackground,
            border: `1px solid ${colors.accent}`,
            borderRadius: 8,
            boxShadow: `0 6px 20px rgba(0, 0, 0, 0.35), 0 0 0 3px ${colors.accentSoft}`,
            padding: 3,
            fontFamily,
          }}
        >
          {props.options.length === 0 && (
            <div style={{ padding: '6px 8px', color: colors.muted, fontSize: 12 }}>Nothing to choose from</div>
          )}
          {props.options.map((option, index) => {
            const isSelected = option.value === props.value
            const isHighlighted = index === highlighted
            return (
              <div
                key={option.value}
                role="option"
                data-index={index}
                aria-selected={isSelected}
                aria-disabled={option.disabled === true}
                onPointerEnter={() => option.disabled !== true && setHighlighted(index)}
                // pointerdown, not click: click lands after the outside-press handler has
                // already closed the list.
                onPointerDown={(event) => {
                  event.preventDefault()
                  choose(index)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: props.compact === true ? '4px 8px' : '6px 8px',
                  borderRadius: 6,
                  cursor: option.disabled === true ? 'default' : 'pointer',
                  opacity: option.disabled === true ? 0.5 : 1,
                  // The whole point of the component: this highlight is ours, in the accent,
                  // rather than the platform's blue.
                  background: isHighlighted ? colors.accent : 'transparent',
                  color: isHighlighted ? colors.accentContrast : colors.inputForeground,
                  fontSize: props.compact === true ? 11 : 13,
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {option.label}
                  {option.detail !== undefined && (
                    <span
                      style={{
                        marginLeft: 6,
                        opacity: 0.7,
                        // Inherits the highlight's contrast colour, so it stays legible on
                        // the accent rather than staying muted-grey on purple.
                        color: 'inherit',
                      }}
                    >
                      {option.detail}
                    </span>
                  )}
                </span>
                {isSelected && (
                  <span
                    aria-hidden="true"
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: isHighlighted ? colors.accentContrast : colors.accent,
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
