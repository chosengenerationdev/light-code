import { useMemo, useState, type ReactElement } from 'react'
import { colors, textFieldStyle } from './theme.js'

export interface MultiSelectOption {
  value: string
  label?: string
  /** One line under the label. Used for a tool's description, which is what makes it pickable. */
  hint?: string
}

export interface MultiSelectProps {
  options: readonly MultiSelectOption[]
  selected: readonly string[]
  onChange: (next: string[]) => void
  ariaLabel: string
  /** Kept low enough that the box appears before scrolling starts to hurt. */
  filterThreshold?: number
}

/**
 * Picking several things from a list that may be long.
 *
 * Built for "which tools may this scheduled job use", where the list is every tool registered —
 * a handful on a bare install and well past forty with a few MCP servers attached. The user
 * asked the question that decides the design: *"will it come with a search box to select as
 * well? else it will be difficult when there are many tools"*. It will, and it has to.
 *
 * ## Why the filter is conditional
 *
 * A search box over six checkboxes is furniture. It appears once the list is long enough that
 * scanning it costs something, and not before.
 *
 * ## Why filtering never changes the selection
 *
 * Typing narrows what is *shown*, never what is *chosen* — a selection that vanished because
 * you typed would be a permission silently withdrawn, and you would not find out until the job
 * failed at 3am. "All" and "None" act on the visible set only, and say so, because acting on
 * the hidden ones is the same surprise wearing a different hat.
 */
export function MultiSelect(props: MultiSelectProps): ReactElement {
  const [filter, setFilter] = useState('')
  const threshold = props.filterThreshold ?? 8
  const showFilter = props.options.length > threshold

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle.length === 0) return props.options
    return props.options.filter((option) => {
      const label = (option.label ?? option.value).toLowerCase()
      return (
        label.includes(needle) ||
        option.value.toLowerCase().includes(needle) ||
        (option.hint ?? '').toLowerCase().includes(needle)
      )
    })
  }, [props.options, filter])

  const selected = useMemo(() => new Set(props.selected), [props.selected])

  const toggle = (value: string): void => {
    const next = new Set(selected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    // Ordered as offered, so the answer does not depend on the order things were clicked.
    props.onChange(props.options.map((option) => option.value).filter((entry) => next.has(entry)))
  }

  const setVisible = (chosen: boolean): void => {
    const next = new Set(selected)
    for (const option of visible) {
      if (chosen) next.add(option.value)
      else next.delete(option.value)
    }
    props.onChange(props.options.map((option) => option.value).filter((entry) => next.has(entry)))
  }

  const bulkStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    color: colors.accent,
    cursor: 'pointer',
    fontSize: 11,
    padding: 0,
  }

  return (
    <div role="group" aria-label={props.ariaLabel}>
      {showFilter && (
        <input
          type="text"
          value={filter}
          spellCheck={false}
          placeholder={`Filter ${String(props.options.length)} options…`}
          aria-label={`Filter ${props.ariaLabel}`}
          onChange={(event) => setFilter(event.target.value)}
          style={{ ...textFieldStyle(), marginBottom: 6 }}
        />
      )}

      <div
        className="lc-scroll"
        style={{
          maxHeight: 220,
          overflowY: 'auto',
          border: `1px solid ${colors.border}`,
          borderRadius: 4,
          padding: 6,
        }}
      >
        {visible.length === 0 ? (
          <span style={{ color: colors.muted, fontSize: 12 }}>Nothing matches &ldquo;{filter.trim()}&rdquo;.</span>
        ) : (
          visible.map((option) => (
            <label
              key={option.value}
              style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', padding: '3px 2px' }}
            >
              <input
                type="checkbox"
                checked={selected.has(option.value)}
                onChange={() => toggle(option.value)}
                style={{ marginTop: 2 }}
              />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12 }}>{option.label ?? option.value}</span>
                {option.hint !== undefined && (
                  <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>{option.hint}</span>
                )}
              </span>
            </label>
          ))
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
        <span style={{ color: colors.muted, fontSize: 11 }}>
          {selected.size === 0 ? 'None selected' : `${String(selected.size)} selected`}
        </span>
        {visible.length > 0 && (
          <>
            {/*
              Named for the visible set rather than "Select all". With a filter active they are
              different sets, and the label is the only thing that says which one is meant.
            */}
            <button type="button" style={bulkStyle} onClick={() => setVisible(true)}>
              {filter.trim().length > 0 ? `All ${String(visible.length)} shown` : 'All'}
            </button>
            <button type="button" style={bulkStyle} onClick={() => setVisible(false)}>
              {filter.trim().length > 0 ? 'None shown' : 'None'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
