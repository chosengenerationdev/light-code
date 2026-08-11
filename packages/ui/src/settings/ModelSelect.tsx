import { resolveModelCapabilities, type ModelCapabilityInput } from '@light-code/core/browser'
import { type ReactElement } from 'react'
import { colors, fieldErrorStyle, labelStyle, optionStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

export interface ModelSelectProps {
  value: string
  onChange: (value: string) => void
  /** Catalogue from the provider, fetched automatically and on demand. */
  models: string[]
  /** Why the catalogue is empty. Informational — never blocks entry. */
  warning?: string | undefined
  loading: boolean
  onRefresh: () => void
  error?: string | undefined
  /** Per-profile corrections, edited inline rather than hidden behind a disclosure. */
  capabilities: ModelCapabilityInput
  onCapabilitiesChange: (value: ModelCapabilityInput) => void
}

/**
 * A dropdown *and* a text field, never one or the other. §9 is explicit that gateways
 * frequently return their own catalogue or 404 the endpoint, so free-text entry is always
 * available and the dropdown is never a hard dependency — it only fills the text field in.
 */
export function ModelSelect(props: ModelSelectProps): ReactElement {
  const trimmed = props.value.trim()
  const resolved = trimmed.length > 0 ? resolveModelCapabilities(trimmed, props.capabilities) : undefined

  const setCapability = (patch: ModelCapabilityInput): void =>
    props.onCapabilitiesChange({ ...props.capabilities, ...patch })

  const clearContextWindow = (): void => {
    const rest = { ...props.capabilities }
    delete rest.contextWindow
    props.onCapabilitiesChange(rest)
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <label htmlFor="lc-model" style={labelStyle()}>
        Model
      </label>

      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input
          id="lc-model"
          type="text"
          value={props.value}
          placeholder="gpt-4o-mini"
          onChange={(event) => props.onChange(event.target.value)}
          style={textFieldStyle()}
        />
        <button type="button" style={secondaryButtonStyle()} onClick={props.onRefresh} disabled={props.loading}>
          {props.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {props.models.length > 0 && (
        <select
          aria-label="Choose from the gateway's catalogue"
          value={props.models.includes(props.value) ? props.value : ''}
          onChange={(event) => {
            if (event.target.value.length > 0) props.onChange(event.target.value)
          }}
          style={textFieldStyle()}
        >
          <option value="" style={optionStyle()}>Choose from {props.models.length} available model(s)…</option>
          {props.models.map((id) => (
            <option key={id} value={id} style={optionStyle()}>
              {id}
            </option>
          ))}
        </select>
      )}

      {props.warning !== undefined && props.models.length === 0 && (
        <span style={{ ...fieldErrorStyle(), color: colors.muted }}>{props.warning}</span>
      )}
      {props.error !== undefined && <span style={fieldErrorStyle()}>{props.error}</span>}

      {resolved !== undefined && (
        <div style={{ marginTop: 6, padding: 8, border: `1px solid ${colors.border}`, borderRadius: 3 }}>
          <div style={{ color: colors.muted, fontSize: 11, marginBottom: 6 }}>
            {resolved.known
              ? 'Capabilities for this model. Edit any of them if your deployment differs.'
              : 'Unrecognised model id — these are conservative guesses. Correct them here.'}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <label htmlFor="lc-context-window" style={{ ...labelStyle(), marginBottom: 0, flex: 1 }}>
              Context window (tokens)
            </label>
            <input
              id="lc-context-window"
              type="number"
              min={1}
              value={props.capabilities.contextWindow ?? resolved.contextWindow}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10)
                if (Number.isNaN(parsed) || parsed <= 0) clearContextWindow()
                else setCapability({ contextWindow: parsed })
              }}
              style={{ ...textFieldStyle(), width: 130, flex: 'none' }}
            />
            {props.capabilities.contextWindow !== undefined && (
              // The built-in value is not otherwise recoverable once overridden.
              <button type="button" style={secondaryButtonStyle()} onClick={clearContextWindow} title="Use the built-in value">
                Reset
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.foreground }}>
              <input
                type="checkbox"
                checked={resolved.supportsVision}
                onChange={(event) => setCapability({ supportsVision: event.target.checked })}
              />
              Accepts images
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.foreground }}>
              <input
                type="checkbox"
                checked={resolved.supportsTools}
                onChange={(event) => setCapability({ supportsTools: event.target.checked })}
              />
              Supports tool calling
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
