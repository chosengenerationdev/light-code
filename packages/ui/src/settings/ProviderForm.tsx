import { providerPresets, validateProviderForm, type FieldError, type ProfileInput, type WireFormat } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { colors, fieldErrorStyle, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { SecretField } from './SecretField.js'

export interface ProviderFormValues {
  id?: string
  label: string
  wireFormat: WireFormat
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export interface ProviderFormProps {
  initial: ProviderFormValues
  onSave: (input: ProfileInput) => void
  onCancel: () => void
}

export function ProviderForm(props: ProviderFormProps): ReactElement {
  const [label, setLabel] = useState(props.initial.label)
  const [wireFormat, setWireFormat] = useState<WireFormat>(props.initial.wireFormat)
  const [baseUrl, setBaseUrl] = useState(props.initial.baseUrl)
  const [model, setModel] = useState(props.initial.model)
  const [apiKey, setApiKey] = useState('')
  const [errors, setErrors] = useState<FieldError[]>([])

  const errorFor = (path: string): string | undefined => errors.find((e) => e.path === path)?.message

  const applyPreset = (presetId: string): void => {
    const preset = providerPresets.find((p) => p.id === presetId)
    if (preset === undefined) return
    setWireFormat(preset.wireFormat)
    setBaseUrl(preset.baseUrl)
    if (label.trim().length === 0) setLabel(preset.label)
  }

  const submit = (): void => {
    const fieldErrors = validateProviderForm({ label, wireFormat, baseUrl, model })
    setErrors(fieldErrors)
    if (fieldErrors.length > 0) return
    props.onSave({
      ...(props.initial.id !== undefined ? { id: props.initial.id } : {}),
      label,
      wireFormat,
      baseUrl,
      model,
      apiKey,
    })
  }

  return (
    <div style={{ padding: 12, overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 12px', color: colors.foreground }}>
        {props.initial.id === undefined ? 'Add Provider' : 'Edit Provider'}
      </h3>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="lc-preset" style={labelStyle()}>
          Preset
        </label>
        <select id="lc-preset" defaultValue="" onChange={(event) => applyPreset(event.target.value)} style={textFieldStyle()}>
          <option value="" disabled>
            Choose a preset…
          </option>
          {providerPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="lc-label" style={labelStyle()}>
          Label
        </label>
        <input id="lc-label" type="text" value={label} onChange={(event) => setLabel(event.target.value)} style={textFieldStyle()} />
        {errorFor('label') !== undefined && <span style={fieldErrorStyle()}>{errorFor('label')}</span>}
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="lc-base-url" style={labelStyle()}>
          Base URL
        </label>
        <input
          id="lc-base-url"
          type="text"
          value={baseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(event) => setBaseUrl(event.target.value)}
          style={textFieldStyle()}
        />
        {errorFor('baseUrl') !== undefined && <span style={fieldErrorStyle()}>{errorFor('baseUrl')}</span>}
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="lc-model" style={labelStyle()}>
          Model
        </label>
        <input
          id="lc-model"
          type="text"
          value={model}
          placeholder="gpt-4o-mini"
          onChange={(event) => setModel(event.target.value)}
          style={textFieldStyle()}
        />
        {errorFor('model') !== undefined && <span style={fieldErrorStyle()}>{errorFor('model')}</span>}
      </div>

      <SecretField id="lc-api-key" label="API key" hasValue={props.initial.hasApiKey} value={apiKey} onChange={setApiKey} />

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={primaryButtonStyle(false)} onClick={submit}>
          Save
        </button>
        <button type="button" style={secondaryButtonStyle()} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
