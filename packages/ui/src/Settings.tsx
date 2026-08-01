import { useEffect, useState, type ReactElement } from 'react'
import { colors, labelStyle, primaryButtonStyle, textFieldStyle } from './theme.js'

export interface SettingsProps {
  baseUrl: string
  model: string
  hasApiKey: boolean
  onSave: (baseUrl: string, model: string, apiKey: string) => void
}

export function Settings(props: SettingsProps): ReactElement {
  const [baseUrl, setBaseUrl] = useState(props.baseUrl)
  const [model, setModel] = useState(props.model)
  const [apiKey, setApiKey] = useState('')

  // `requestProfile` is fired asynchronously when this view opens, so the response
  // can arrive after this component has already mounted with empty props — `useState`'s
  // initial value only applies once and won't pick up a prop that changes afterward.
  useEffect(() => {
    setBaseUrl(props.baseUrl)
    setModel(props.model)
  }, [props.baseUrl, props.model])

  return (
    <div style={{ padding: 12, overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 12px', color: colors.foreground }}>Provider Settings</h3>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="lightcode-base-url" style={labelStyle()}>
          Base URL
        </label>
        <input
          id="lightcode-base-url"
          type="text"
          value={baseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(event) => setBaseUrl(event.target.value)}
          style={textFieldStyle()}
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="lightcode-model" style={labelStyle()}>
          Model
        </label>
        <input
          id="lightcode-model"
          type="text"
          value={model}
          placeholder="gpt-4o-mini"
          onChange={(event) => setModel(event.target.value)}
          style={textFieldStyle()}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <label htmlFor="lightcode-api-key" style={labelStyle()}>
          API key {props.hasApiKey ? '(set — leave blank to keep)' : '(optional)'}
        </label>
        <input
          id="lightcode-api-key"
          type="password"
          value={apiKey}
          placeholder={props.hasApiKey ? '••••••••' : 'sk-...'}
          onChange={(event) => setApiKey(event.target.value)}
          style={textFieldStyle()}
        />
      </div>

      <button type="button" style={primaryButtonStyle(false)} onClick={() => props.onSave(baseUrl, model, apiKey)}>
        Save
      </button>
    </div>
  )
}
