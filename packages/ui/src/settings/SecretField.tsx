import { useState, type ReactElement } from 'react'
import { labelStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

export interface SecretFieldProps {
  id: string
  label: string
  /** Whether a value is already stored — never the value itself (invariant 7). */
  hasValue: boolean
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /**
   * Set when the value is read from the environment rather than stored.
   *
   * Shown because "Set" alone would be a lie of omission here: nothing is stored, and if the
   * variable is missing at launch the credential is simply absent. Naming it is what makes that
   * diagnosable without opening the config file.
   */
  envVar?: string
}

/**
 * Write-only: "Set — replace?". The UI never receives a stored secret value back from
 * the host, only whether one exists — see CLAUDE.md §2b/§15.
 */
export function SecretField(props: SecretFieldProps): ReactElement {
  const [replacing, setReplacing] = useState(!props.hasValue)

  if (!replacing) {
    return (
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle()}>{props.label}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{props.envVar === undefined ? 'Set' : `From $${props.envVar}`}</span>
          <button type="button" style={secondaryButtonStyle()} onClick={() => setReplacing(true)}>
            Replace
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <label htmlFor={props.id} style={labelStyle()}>
        {props.label}
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          id={props.id}
          type="password"
          value={props.value}
          placeholder={props.placeholder ?? 'sk-...'}
          onChange={(event) => props.onChange(event.target.value)}
          style={textFieldStyle()}
        />
        {props.hasValue && (
          <button
            type="button"
            style={secondaryButtonStyle()}
            onClick={() => {
              props.onChange('')
              setReplacing(false)
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
