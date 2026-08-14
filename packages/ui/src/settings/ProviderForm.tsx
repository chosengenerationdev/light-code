import {
  providerPresets,
  validateProviderForm,
  type ApigeeSummary,
  type CertSummary,
  type ConnectionTlsInput,
  type FieldError,
  type ModelCapabilityInput,
  type ProfileInput,
  type TestConnectionStep,
  type WireFormat,
} from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { Select } from '../Select.js'
import { colors, fieldErrorStyle, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { AdvancedAuthSection, type AuthType } from './AdvancedAuthSection.js'
import { ModelSelect } from './ModelSelect.js'
import { SecretField } from './SecretField.js'
import { TestConnectionPanel } from './TestConnectionPanel.js'

export interface ProviderFormValues {
  id?: string
  label: string
  wireFormat: WireFormat
  baseUrl: string
  model: string
  authType: AuthType
  hasApiKey: boolean
  hasClientSecret: boolean
  hasCertPassphrase: boolean
  apigee?: ApigeeSummary
  certs?: CertSummary
  modelCapabilities?: ModelCapabilityInput
  connectionTls?: ConnectionTlsInput
}

export interface ProviderFormProps {
  initial: ProviderFormValues
  onSave: (input: ProfileInput) => void
  onCancel: () => void
  /** Ask the host to fetch the catalogue for the profile as currently typed. */
  onRequestModels: (input: ProfileInput) => void
  onTestConnection: (input: ProfileInput) => void
  models: string[]
  modelsWarning?: string
  modelsLoading: boolean
  testRunning: boolean
  testResult?: { ok: boolean; steps: TestConnectionStep[] }
}

export function ProviderForm(props: ProviderFormProps): ReactElement {
  const [label, setLabel] = useState(props.initial.label)
  const [wireFormat, setWireFormat] = useState<WireFormat>(props.initial.wireFormat)
  const [baseUrl, setBaseUrl] = useState(props.initial.baseUrl)
  const [model, setModel] = useState(props.initial.model)
  const [apiKey, setApiKey] = useState('')
  const [authType, setAuthType] = useState<AuthType>(props.initial.authType)
  const [apigee, setApigee] = useState<ApigeeSummary>(props.initial.apigee ?? {})
  const [clientSecret, setClientSecret] = useState('')
  const [certs, setCerts] = useState<CertSummary>(props.initial.certs ?? {})
  const [certPassphrase, setCertPassphrase] = useState('')
  const [capabilities, setCapabilities] = useState<ModelCapabilityInput>(props.initial.modelCapabilities ?? {})
  const [connectionTls, setConnectionTls] = useState<ConnectionTlsInput>(props.initial.connectionTls ?? {})
  const [errors, setErrors] = useState<FieldError[]>([])
  /** Prevents a re-fetch every time focus leaves the URL field without it having changed. */
  const [lastFetchedUrl, setLastFetchedUrl] = useState<string | undefined>(undefined)

  const errorFor = (path: string): string | undefined => errors.find((e) => e.path === path)?.message

  const applyPreset = (presetId: string): void => {
    const preset = providerPresets.find((p) => p.id === presetId)
    if (preset === undefined) return
    setWireFormat(preset.wireFormat)
    setBaseUrl(preset.baseUrl)
    if (label.trim().length === 0) setLabel(preset.label)
  }

  /**
   * The form's current state as a `ProfileInput`. Used for Save, Refresh Models, and Test
   * Connection alike, so all three see exactly the same configuration — testing something
   * other than what would be saved is the one thing that would make the button useless.
   */
  const currentInput = (): ProfileInput => ({
    ...(props.initial.id !== undefined ? { id: props.initial.id } : {}),
    label,
    wireFormat,
    baseUrl,
    model,
    authType,
    apiKey,
    ...(authType === 'apigeeMtls' ? { apigee, clientSecret, certs, certPassphrase } : {}),
    ...(Object.keys(capabilities).length > 0 ? { modelCapabilities: capabilities } : {}),
    ...(connectionTls.caFile !== undefined || connectionTls.rejectUnauthorized !== undefined
      ? { connectionTls }
      : {}),
  })

  /**
   * Fetches the catalogue once the base URL looks usable, so the list is simply there
   * rather than behind a button nobody knows to press.
   *
   * Fires on **blur, not on every keystroke**, and only for a URL that actually parses.
   * That matters: the request carries the API key, and firing mid-typing would send it to
   * whatever prefix happened to be in the field at the time.
   */
  const maybeAutoFetchModels = (): void => {
    const url = baseUrl.trim()
    if (url === lastFetchedUrl || url.length === 0) return
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
    } catch {
      return
    }
    // A profile with no credential yet would just 401; wait until there is one to send.
    const hasCredential = authType === 'none' || apiKey.trim().length > 0 || props.initial.hasApiKey || authType === 'apigeeMtls'
    if (!hasCredential) return

    setLastFetchedUrl(url)
    props.onRequestModels(currentInput())
  }

  const submit = (): void => {
    const fieldErrors = validateProviderForm({ label, wireFormat, baseUrl, model })
    setErrors(fieldErrors)
    if (fieldErrors.length > 0) return
    props.onSave(currentInput())
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
        <Select
          id="lc-preset"
          // Deliberately never shows a selection: applying a preset fills the fields below,
          // and leaving it stuck on the last one would imply the form still tracks it.
          value=""
          placeholder="Choose a preset…"
          onChange={applyPreset}
          style={{ width: '100%' }}
          options={providerPresets.map((preset) => ({ value: preset.id, label: preset.label }))}
        />
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
          onBlur={maybeAutoFetchModels}
          style={textFieldStyle()}
        />
        {errorFor('baseUrl') !== undefined && <span style={fieldErrorStyle()}>{errorFor('baseUrl')}</span>}
      </div>

      <ModelSelect
        value={model}
        onChange={setModel}
        models={props.models}
        {...(props.modelsWarning !== undefined ? { warning: props.modelsWarning } : {})}
        loading={props.modelsLoading}
        onRefresh={() => props.onRequestModels(currentInput())}
        {...(errorFor('model') !== undefined ? { error: errorFor('model') } : {})}
        capabilities={capabilities}
        onCapabilitiesChange={setCapabilities}
      />

      {authType === 'apiKey' && (
        <div onBlur={maybeAutoFetchModels}>
          <SecretField id="lc-api-key" label="API key" hasValue={props.initial.hasApiKey} value={apiKey} onChange={setApiKey} />
        </div>
      )}

      <AdvancedAuthSection
        authType={authType}
        onAuthTypeChange={setAuthType}
        apigee={apigee}
        onApigeeChange={setApigee}
        clientSecret={clientSecret}
        onClientSecretChange={setClientSecret}
        hasClientSecret={props.initial.hasClientSecret}
        certs={certs}
        onCertsChange={setCerts}
        certPassphrase={certPassphrase}
        onCertPassphraseChange={setCertPassphrase}
        hasCertPassphrase={props.initial.hasCertPassphrase}
        connectionTls={connectionTls}
        onConnectionTlsChange={setConnectionTls}
      />

      <TestConnectionPanel
        running={props.testRunning}
        {...(props.testResult !== undefined ? { result: props.testResult } : { result: undefined })}
        onRun={() => props.onTestConnection(currentInput())}
      />

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
