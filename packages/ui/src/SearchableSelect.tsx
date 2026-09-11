import { useMemo, useState, type ReactElement } from 'react'

import { colors, textFieldStyle } from './theme.js'

export interface SearchableOption {
  value: string
  label?: string
  /** One line under the label. A tool's description is what makes it pickable at all. */
  hint?: string
  /** A heading this option sits under, e.g. "Python tools". Options are shown in group order. */
  group?: string
}

export interface SearchableSelectProps {
  options: readonly SearchableOption[]
  value: string
  onChange: (next: string) => void
  ariaLabel: string
  /** Shown when nothing matches the filter. */
  emptyText?: string
  /** Kept low enough that the box appears before scanning starts to hurt. */
  filterThreshold?: number
}

/**
 * Picking one thing from a list that may be long, with a search box.
 *
 * ## Why not `Select`
 *
 * `Select` is a popup listbox, right for a handful of fixed choices — a wire format, a theme. It
 * has no filter and no room for a description, and this list is every callable tool: a handful on
 * a bare install, well past forty with a few MCP servers attached, and unusable without both.
 *
 * ## Why not `MultiSelect`
 *
 * That one solves the same *scale* problem and its reasoning is the same, but for choosing
 * several: checkboxes, and All/None buttons that would be meaningless here. Bending it into
 * doing one would mean a mode flag through a component whose whole documented behaviour is about
 * the many case.
 *
 * ## Why filtering never changes the selection
 *
 * `MultiSelect`'s rule, and it matters as much here: a choice that vanished because you typed
 * would be a setting silently withdrawn. The chosen option is always shown, whatever is typed.
 */
export function SearchableSelect(props: SearchableSelectProps): ReactElement {
  const [filter, setFilter] = useState('')
  const threshold = props.filterThreshold ?? 8

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle.length === 0) return props.options
    return props.options.filter(
      (option) =>
        // The current choice survives any filter — see above.
        option.value === props.value ||
        option.value.toLowerCase().includes(needle) ||
        (option.label ?? '').toLowerCase().includes(needle) ||
        (option.hint ?? '').toLowerCase().includes(needle),
    )
  }, [props.options, props.value, filter])

  /** Groups in first-seen order, so the caller controls the ordering by ordering its options. */
  const grouped = useMemo(() => {
    const groups = new Map<string, SearchableOption[]>()
    for (const option of visible) {
      const key = option.group ?? ''
      groups.set(key, [...(groups.get(key) ?? []), option])
    }
    return [...groups.entries()]
  }, [visible])

  return (
    <div>
      {props.options.length > threshold && (
        <input
          type="text"
          value={filter}
          spellCheck={false}
          placeholder={`Search ${String(props.options.length)} tools…`}
          aria-label={`Filter ${props.ariaLabel}`}
          onChange={(event) => setFilter(event.target.value)}
          style={{ ...textFieldStyle(), marginBottom: 6 }}
        />
      )}

      <div
        className="lc-scroll"
        role="radiogroup"
        aria-label={props.ariaLabel}
        style={{
          maxHeight: 240,
          overflowY: 'auto',
          border: `1px solid ${colors.border}`,
          borderRadius: 4,
          padding: 6,
        }}
      >
        {visible.length === 0 ? (
          <span style={{ color: colors.muted, fontSize: 11 }}>
            {props.emptyText ?? 'Nothing matches.'}
          </span>
        ) : (
          grouped.map(([group, options]) => (
            <div key={group}>
              {group.length > 0 && (
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    color: colors.muted,
                    margin: '6px 0 2px',
                  }}
                >
                  {group}
                </div>
              )}
              {options.map((option) => (
                <label
                  key={option.value}
                  title={option.hint ?? option.value}
                  style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '3px 0', cursor: 'pointer' }}
                >
                  <input
                    type="radio"
                    name={props.ariaLabel}
                    checked={props.value === option.value}
                    onChange={() => props.onChange(option.value)}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12, overflowWrap: 'anywhere' }}>
                      {option.label ?? option.value}
                    </span>
                    {option.hint !== undefined && option.hint.length > 0 && (
                      <span
                        style={{
                          display: 'block',
                          color: colors.muted,
                          fontSize: 11,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {option.hint}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
