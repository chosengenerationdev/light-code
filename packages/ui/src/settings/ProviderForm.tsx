import { HeaderAuthFields, type AuthHeaderInput } from './HeaderAuthFields.js'
import type { TokenCommandInput } from '@light-code/core/browser'
import type { BrowseRequest } from './PathField.js'
import { TokenCommandFields } from './TokenCommandFields.js'
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
  /** The configured token command, so the form can render and round-trip it. */
  tokenCommand?: TokenCommandInput | undefined
  authHeaders?: AuthHeaderInput[] | undefined
  /** Set when the key comes from the environment. The variable's name, not its value. */
  apiKeyEnvVar?: string | undefined
  hasClientSecret: boolean
  hasCertPassphrase: boolean
  apigee?: ApigeeSummary
  certs?: CertSummary
  modelCapabilities?: ModelCapabilityInput
  connectionTls?: ConnectionTlsInput
  thinking?: { level: 'off' | 'low' | 'medium' | 'high'; style?: 'effort' | 'qwen' }
}

export interface ProviderFormProps {
  initial: ProviderFormValues
  /** The shared browse dialog, keyed by purpose. Absent where the host has no picker (§19). */
  onBrowse?: ((request: BrowseRequest) => void) | undefined
  pickedPath?: { purpose: string; path: string } | undefined
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
  /*
   * Seeded from the profile rather than started empty: a command is not a secret, so unlike the
   * API key the form *can* be shown what is configured — and a form that cannot see the current
   * value can only replace it.
   */
  const [authHeaders, setAuthHeaders] = useState<AuthHeaderInput[]>(
    props.initial.authHeaders ?? [{ name: '', valueRef: '' }],
  )
  const [tokenCommand, setTokenCommand] = useState<TokenCommandInput>(
    props.initial.tokenCommand ?? { command: ['python', ''] },
  )
  const [authType, setAuthType] = useState<AuthType>(props.initial.authType)
  const [apigee, setApigee] = useState<ApigeeSummary>(props.initial.apigee ?? {})
  const [clientSecret, setClientSecret] = useState('')
  const [certs, setCerts] = useState<CertSummary>(props.initial.certs ?? {})
  const [certPassphrase, setCertPassphrase] = useState('')
  const [capabilities, setCapabilities] = useState<ModelCapabilityInput>(props.initial.modelCapabilities ?? {})
  /*
   * Thinking, and which parameter carries it.
   *
   * Empty level means send nothing at all, which is what every request did before the setting
   * existed and the only value that cannot break a gateway nobody has tested against.
   */
  const [thinkingLevel, setThinkingLevel] = useState<string>(props.initial.thinking?.level ?? '')
  const [thinkingStyle, setThinkingStyle] = useState<'effort' | 'qwen'>(
    props.initial.thinking?.style ?? 'effort',
  )
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
    ...(authType === 'tokenCommand' ? { tokenCommand } : {}),
    ...(authType === 'header' ? { authHeaders } : {}),
    ...(authType === 'apigeeMtls' ? { apigee, clientSecret, certs, certPassphrase } : {}),
    ...(Object.keys(capabilities).length > 0 ? { modelCapabilities: capabilities } : {}),
    ...(thinkingLevel === ''
      ? {}
      : {
          thinking: {
            level: thinkingLevel as 'off' | 'low' | 'medium' | 'high',
            // Only consulted for the OpenAI wire format; the others spell it unambiguously, and
            // storing a style against them would be a setting that reads as if it did something.
            ...(wireFormat === 'openai' ? { style: thinkingStyle } : {}),
          },
        }),
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
    const hasCredential: boolean =
      authType === 'none' ||
      apiKey.trim().length > 0 ||
      props.initial.hasApiKey ||
      authType === 'apigeeMtls' ||
      // A named header with a value is a credential, even though no key box was filled in.
      (authType === 'header' &&
        authHeaders.some((header) => header.name.trim().length > 0 && header.valueRef.trim().length > 0)) ||
      // A script that has been named is a credential, even though nothing was typed into a key box.
      (authType === 'tokenCommand' &&
        tokenCommand.command.filter((part: string) => part.trim().length > 0).length > 0)
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

      {/*
        How hard this model thinks.

        This lived in config and nowhere else for a release - the mechanism was complete and
        unreachable, which from the outside is the same as not having it. The `style` half is why
        it had to surface: "OpenAI-compatible" is not one thing, and the two spellings are not
        interchangeable. Sending the wrong one is a 400 on every request.
      */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
        <label style={labelStyle()}>Thinking</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 150, flex: 1 }}>
            <Select
              compact
              ariaLabel="Thinking level"
              value={thinkingLevel}
              onChange={setThinkingLevel}
              options={[
                { value: '', label: 'Send nothing (default)' },
                { value: 'off', label: 'Off' },
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
              ]}
            />
          </div>
          {wireFormat === 'openai' && thinkingLevel !== '' && (
            <div style={{ minWidth: 210, flex: 1 }}>
              <Select
                compact
                ariaLabel="Thinking parameter"
                value={thinkingStyle}
                onChange={(value) => setThinkingStyle(value as 'effort' | 'qwen')}
                options={[
                  { value: 'effort', label: 'as reasoning_effort' },
                  { value: 'qwen', label: 'as enable_thinking (Qwen)' },
                ]}
              />
            </div>
          )}
        </div>
        <span style={{ color: colors.muted, fontSize: 11, lineHeight: 1.5 }}>
          {thinkingLevel === ''
            ? 'Nothing is sent, which is how every profile behaved before this existed. Set it only against a gateway you know accepts it.'
            : wireFormat !== 'openai'
              ? 'This wire format spells thinking one way, so there is nothing to choose.'
              : thinkingStyle === 'effort'
                ? 'Sends reasoning_effort. Right for OpenAI and most gateways fronting a reasoning model.'
                : 'Sends chat_template_kwargs.enable_thinking, which vLLM and SGLang expose for Qwen3 and its relatives. On or off only \u2014 the level is not a depth dial here.'}
        </span>
      </div>

      {authType === 'header' && <HeaderAuthFields headers={authHeaders} onChange={setAuthHeaders} />}

      {authType === 'tokenCommand' && (
        <TokenCommandFields
          value={tokenCommand}
          onChange={setTokenCommand}
          {...(props.onBrowse === undefined ? {} : { onBrowse: props.onBrowse })}
          {...(props.pickedPath === undefined ? {} : { pickedPath: props.pickedPath })}
        />
      )}

      {authType === 'apiKey' && (
        <div onBlur={maybeAutoFetchModels}>
          <SecretField
            id="lc-api-key"
            label="API key"
            hasValue={props.initial.hasApiKey}
            value={apiKey}
            onChange={setApiKey}
            {...(props.initial.apiKeyEnvVar === undefined ? {} : { envVar: props.initial.apiKeyEnvVar })}
          />
          {/*
            Said where the key is typed, because it is not discoverable anywhere else.

            A parent process that launches Light Code — a Streamlit app, a wrapper script — often
            already holds the credential, and the environment is the only thing it can hand a
            child. Without this the user pastes a token their own launcher already has, by hand,
            and it goes stale the moment it rotates.
          */}
          <span
            style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: -10, marginBottom: 16 }}
          >
            Enter <code style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>env:API_TOKEN</code> to read the key from
            that environment variable instead of storing it. It is read fresh on every request, and
            must be exported before Light Code starts &mdash; a child process cannot see a variable
            its parent set afterwards.
          </span>
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
