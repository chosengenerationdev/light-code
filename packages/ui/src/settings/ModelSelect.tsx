import { lookupModelCapabilities } from '@light-code/core/browser'
import { type ReactElement } from 'react'
import { colors, fieldErrorStyle, labelStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

export interface ModelSelectProps {
  value: string
  onChange: (value: string) => void
  /** Catalogue from the provider, empty until Refresh is pressed or if the gateway 404s. */
  models: string[]
  /** Why the catalogue is empty. Informational — never blocks entry. */
  warning?: string | undefined
  loading: boolean
  onRefresh: () => void
  error?: string | undefined
}

/**
 * A dropdown *and* a text field, never one or the other. §9 is explicit that gateways
 * frequently return their own catalogue or 404 the endpoint, so free-text entry is always
 * available and the dropdown is never a hard dependency — it only fills the text field in.
 */
export function ModelSelect(props: ModelSelectProps): ReactElement {
  const capabilities = props.value.trim().length > 0 ? lookupModelCapabilities(props.value.trim()) : undefined

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
          <option value="">Choose from {props.models.length} available model(s)…</option>
          {props.models.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      )}

      {props.warning !== undefined && props.models.length === 0 && (
        <span style={{ ...fieldErrorStyle(), color: colors.muted }}>{props.warning}</span>
      )}
      {props.error !== undefined && <span style={fieldErrorStyle()}>{props.error}</span>}

      {capabilities !== undefined && (
        <div style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>
          {capabilities.known ? (
            <>
              {capabilities.contextWindow.toLocaleString()} token context
              {capabilities.supportsVision ? ' · vision' : ''}
              {capabilities.supportsTools ? ' · tools' : ' · no tool support'}
            </>
          ) : (
            <>
              Unrecognised model id — assuming {capabilities.contextWindow.toLocaleString()} tokens, no vision. Override
              below if that is wrong.
            </>
          )}
        </div>
      )}
    </div>
  )
}
