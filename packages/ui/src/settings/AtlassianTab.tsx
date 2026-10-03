import {
  ATLASSIAN_PRODUCTS,
  type AtlassianProductId,
  type AtlassianProductInfo,
  type AtlassianProductStatus,
  type AtlassianSettingsView,
  type AutosysGatewaySettings,
  type AutosysGatewayView,
} from '@light-code/core/browser'
import { AutosysGatewaySection, gatewayDraftFrom } from './AutosysGateway.js'
import { useEffect, useState, type ReactElement } from 'react'

import { colors, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { Panel } from './Panel.js'
import { SecretInput } from './CredentialPicker.js'

/**
 * Confluence, Jira, Bitbucket and Jenkins: one panel each, from one component and the product table in
 * core, so the panel can never offer a default the host does not save.
 *
 * Each token is **write-only** (invariant 7). The field is always empty; the host only ever says
 * whether one is stored, and a blank field on save means "keep it". Removing it is its own button,
 * so saving a new default can never wipe the token on the way past.
 */

export interface AtlassianTabProps {
  /** Undefined until the host has answered; the panels then say they are loading. */
  products: Record<AtlassianProductId, AtlassianProductStatus> | undefined
  /** Bumped per product by the host after a successful save, so its button can say "Saved". */
  savedTicks: Partial<Record<AtlassianProductId, number>>
  tests: Partial<Record<AtlassianProductId, { ok: boolean; detail: string }>>
  testing: Partial<Record<AtlassianProductId, boolean>>
  onSave: (
    product: AtlassianProductId,
    settings: AtlassianSettingsView,
    token: string | undefined,
    gateway?: GatewaySave | undefined,
  ) => void
  onClearToken: (product: AtlassianProductId) => void
  onTest: (product: AtlassianProductId) => void
  onClearGatewaySecret?: (which: 'clientSecret' | 'passphrase') => void
}

/** The AutoSys gateway fields, sent with the panel's one Save. Secrets blank mean "keep". */
export interface GatewaySave {
  settings: AutosysGatewaySettings
  clientSecret?: string | undefined
  passphrase?: string | undefined
}

export function AtlassianTab(props: AtlassianTabProps): ReactElement {
  return (
    <div>
      <p style={{ color: colors.muted, fontSize: 12, margin: '0 0 12px' }}>
        Confluence, Jira and Bitbucket (Data Center and Server), Jenkins and AutoSys, each with your own
        credential. Everything the assistant writes, and every build it starts, is shown to you first and
        happens as you. A site stays off, and is never contacted, until you switch it on.
      </p>
      {ATLASSIAN_PRODUCTS.map((info) => {
        const status = props.products?.[info.id]
        if (status === undefined) {
          return (
            <Panel key={info.id} id={`atlassian.${info.id}`} title={info.label} summary="Loading…">
              <span style={{ color: colors.muted, fontSize: 12 }}>Loading…</span>
            </Panel>
          )
        }
        return (
          <AtlassianSection
            key={info.id}
            info={info}
            settings={status.settings}
            hasToken={status.hasToken}
            gateway={status.gateway}
            onClearGatewaySecret={props.onClearGatewaySecret}
            savedTick={props.savedTicks[info.id] ?? 0}
            test={props.tests[info.id]}
            testing={props.testing[info.id] === true}
            onSave={(settings, token, gateway) => props.onSave(info.id, settings, token, gateway)}
            onClearToken={() => props.onClearToken(info.id)}
            onTest={() => props.onTest(info.id)}
          />
        )
      })}
    </div>
  )
}

export interface AtlassianSectionProps {
  info: AtlassianProductInfo
  settings: AtlassianSettingsView
  hasToken: boolean
  savedTick: number
  test: { ok: boolean; detail: string } | undefined
  testing: boolean
  onSave: (settings: AtlassianSettingsView, token: string | undefined, gateway?: GatewaySave | undefined) => void
  onClearToken: () => void
  onTest: () => void
  /** AutoSys only. */
  gateway?: AutosysGatewayView | undefined
  onClearGatewaySecret?: ((which: 'clientSecret' | 'passphrase') => void) | undefined
}

const hintStyle = { display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 10px' } as const

export function AtlassianSection(props: AtlassianSectionProps): ReactElement {
  const { info } = props
  const [draft, setDraft] = useState<AtlassianSettingsView>(props.settings)
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)
  const savedKey = JSON.stringify(props.settings)
  // Resynced by value, so an unrelated message from the host does not discard a half-typed field.
  useEffect(() => setDraft(JSON.parse(savedKey) as AtlassianSettingsView), [savedKey])
  /*
   * The gateway's fields live here, not in their own section, so the panel's one Save carries
   * them. Resynced by value like the rest.
   */
  const gatewayKey = props.gateway === undefined ? '' : JSON.stringify(gatewayDraftFrom(props.gateway))
  const [gatewayDraft, setGatewayDraft] = useState<AutosysGatewaySettings | undefined>(
    props.gateway === undefined ? undefined : gatewayDraftFrom(props.gateway),
  )
  const [clientSecret, setClientSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  useEffect(() => setGatewayDraft(gatewayKey === '' ? undefined : (JSON.parse(gatewayKey) as AutosysGatewaySettings)), [gatewayKey])

  useEffect(() => {
    if (props.savedTick > 0) {
      setSaved(true)
      setToken('')
      setClientSecret('')
      setPassphrase('')
    }
  }, [props.savedTick])

  const gatewayDirty =
    gatewayDraft !== undefined && (JSON.stringify(gatewayDraft) !== gatewayKey || clientSecret.length > 0 || passphrase.length > 0)
  const dirty = JSON.stringify(draft) !== savedKey || token.trim().length > 0 || gatewayDirty
  const set = (change: Partial<AtlassianSettingsView>): void => {
    setSaved(false)
    setDraft({ ...draft, ...change })
  }
  const id = (field: string): string => `lc-${info.id}-${field}`

  // Through a gateway the password is not used; what has to be stored is the client secret.
  const viaGateway = props.gateway?.enabled === true
  const credentialStored = viaGateway ? props.gateway?.hasClientSecret === true : props.hasToken
  const summary = !props.settings.enabled
    ? 'Off'
    : props.settings.baseUrl.length === 0
      ? 'No site set'
      : credentialStored
        ? `${props.settings.baseUrl}${viaGateway ? ' (via gateway)' : ''}`
        : viaGateway
          ? 'No client secret stored'
          : 'No token stored'

  // Test runs against what is saved, so it says precisely what is missing from that.
  const testBlocked: string | undefined = dirty
    ? 'Save your changes first — Test connection uses the saved settings.'
    : props.settings.baseUrl.length === 0
      ? 'Save the site address first.'
      : viaGateway
        ? props.gateway?.hasClientSecret !== true
          ? 'Enter the gateway client secret and save.'
          : props.gateway.sendBasic && (!props.hasToken || (props.settings.defaults['username'] ?? '').trim().length === 0)
            ? 'Enter the AutoSys username and password and save — the gateway is set to pass them on.'
            : undefined
        : props.hasToken
          ? undefined
          : props.gateway !== undefined
            ? 'Enter the password and save — or, for the API gateway, tick "Sign in through the gateway" below and save.'
            : `Enter the ${info.tokenLabel.toLowerCase()} and save.`

  return (
    <Panel id={`atlassian.${info.id}`} title={info.label} summary={summary}>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 10px' }}>
        Lets the assistant {info.does}.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
        <span>Let the assistant use {info.label}</span>
      </label>

      <label htmlFor={id('url')} style={labelStyle()}>
        Site address
      </label>
      <input
        id={id('url')}
        type="text"
        value={draft.baseUrl}
        spellCheck={false}
        placeholder={info.sitePlaceholder}
        onChange={(event) => set({ baseUrl: event.target.value })}
        style={textFieldStyle()}
      />
      <span style={hintStyle}>The address you open {info.label} at, including any path after the host name.</span>

      {viaGateway && (
        <span style={hintStyle}>
          {props.gateway?.sendBasic === true
            ? 'Signing in through the API gateway below, which also passes on this username and password.'
            : 'Signing in through the API gateway below — the username and password are not used.'}
        </span>
      )}
      <label htmlFor={id('token')} style={labelStyle()}>
        {info.tokenLabel}
      </label>
      <SecretInput
        id={id('token')}
        value={token}
        placeholder={props.hasToken ? 'Stored — leave blank to keep it' : 'Paste a token'}
        onChange={(value) => {
          setSaved(false)
          setToken(value)
        }}
      />
      <span style={hintStyle}>
        {info.tokenHint}
      </span>

      {info.defaults.map((field) => (
        <div key={field.key}>
          <label htmlFor={id(field.key)} style={labelStyle()}>
            {field.label} <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            id={id(field.key)}
            type="text"
            value={draft.defaults[field.key] ?? ''}
            spellCheck={false}
            placeholder={field.placeholder}
            onChange={(event) => set({ defaults: { ...draft.defaults, [field.key]: event.target.value } })}
            style={textFieldStyle()}
          />
          <span style={hintStyle}>{field.hint}</span>
        </div>
      ))}

      <label htmlFor={id('ca')} style={labelStyle()}>
        CA certificate file <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
      </label>
      <input
        id={id('ca')}
        type="text"
        value={draft.caFile}
        spellCheck={false}
        placeholder="Only if the site uses a certificate Settings → Network does not already trust"
        onChange={(event) => set({ caFile: event.target.value })}
        style={textFieldStyle()}
      />

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 4px', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={!draft.rejectUnauthorized}
          onChange={(event) => set({ rejectUnauthorized: !event.target.checked })}
        />
        <span>Skip certificate verification</span>
      </label>
      {!draft.rejectUnauthorized && (
        <span role="alert" style={{ display: 'block', color: colors.error, fontSize: 11, marginBottom: 6 }}>
          Anything between you and the site could read and change the traffic — including your
          token — without you knowing. Use the CA certificate field instead if you can.
        </span>
      )}

      {props.gateway !== undefined && gatewayDraft !== undefined && props.onClearGatewaySecret !== undefined && (
        <AutosysGatewaySection
          draft={gatewayDraft}
          onChange={(change) => {
            setSaved(false)
            setGatewayDraft({ ...gatewayDraft, ...change })
          }}
          secret={clientSecret}
          onSecret={(value) => {
            setSaved(false)
            setClientSecret(value)
          }}
          passphrase={passphrase}
          onPassphrase={(value) => {
            setSaved(false)
            setPassphrase(value)
          }}
          hasClientSecret={props.gateway.hasClientSecret}
          hasPassphrase={props.gateway.hasPassphrase}
          onClearSecret={props.onClearGatewaySecret}
        />
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          style={primaryButtonStyle(!dirty)}
          disabled={!dirty}
          onClick={() =>
            props.onSave(
              draft,
              token.trim().length > 0 ? token.trim() : undefined,
              gatewayDirty && gatewayDraft !== undefined
                ? {
                    settings: gatewayDraft,
                    ...(clientSecret.trim().length > 0 ? { clientSecret: clientSecret.trim() } : {}),
                    ...(passphrase.length > 0 ? { passphrase } : {}),
                  }
                : undefined,
            )
          }
        >
          {saved && !dirty ? 'Saved' : 'Save'}
        </button>
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={props.testing || testBlocked !== undefined}
          title={testBlocked ?? 'Checks the address, the certificate and the credential, and says who it connects as'}
          onClick={props.onTest}
        >
          {props.testing ? 'Testing…' : 'Test connection'}
        </button>
        {props.hasToken && (
          <button type="button" style={secondaryButtonStyle()} onClick={props.onClearToken}>
            Remove token
          </button>
        )}
      </div>
      {/*
        Said on the page, not only in the tooltip: "save the token first" when the problem is an
        unticked gateway or an unsaved form sent somebody round in circles.
      */}
      {testBlocked !== undefined && !props.testing && (
        <span style={{ display: 'block', marginTop: 6, fontSize: 11, color: colors.muted }}>{testBlocked}</span>
      )}
      {props.test !== undefined && (
        <span
          role="status"
          style={{ display: 'block', marginTop: 8, fontSize: 12, color: props.test.ok ? colors.accent : colors.error }}
        >
          {props.test.ok ? '✓ ' : '✗ '}
          {props.test.detail}
        </span>
      )}
    </Panel>
  )
}
