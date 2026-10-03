import type { AutosysGatewaySettings, AutosysGatewayView } from '@light-code/core/browser'
import type { ReactElement } from 'react'

import { colors, labelStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { SecretInput } from './CredentialPicker.js'

/**
 * AutoSys through an API gateway such as Apigee: a token from one URL, using a client id and
 * secret (over a client certificate where the gateway asks for one), sent to the AutoSys API at
 * the site address above. When on, it replaces the username and password.
 *
 * Secrets are write-only (invariant 7): the fields are always empty, the host only says whether
 * one is stored, and blank on save means "keep it".
 */

const hintStyle = { display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 10px' } as const

export function gatewayDraftFrom(view: AutosysGatewayView): AutosysGatewaySettings {
  const { hasClientSecret: _secret, hasPassphrase: _passphrase, ...settings } = view
  void _secret
  void _passphrase
  return settings
}

/**
 * The gateway fields, with no Save of their own: the AutoSys panel's one Save sends them with the
 * site address. Two Save buttons in one panel was the first design, and it was used as one would
 * expect — fill everything in, press the Save at the bottom — which stored the address and quietly
 * dropped the gateway, leaving Test connection asking for a password nobody had.
 */
export function AutosysGatewaySection(props: {
  draft: AutosysGatewaySettings
  onChange: (change: Partial<AutosysGatewaySettings>) => void
  secret: string
  onSecret: (value: string) => void
  passphrase: string
  onPassphrase: (value: string) => void
  hasClientSecret: boolean
  hasPassphrase: boolean
  onClearSecret: (which: 'clientSecret' | 'passphrase') => void
}): ReactElement {
  const draft = props.draft
  const set = (change: Partial<AutosysGatewaySettings>): void => {
    // Typing a token URL is the decision to use the gateway; leaving the box unticked would save
    // everything and use none of it. Ticked visibly, so it can still be unticked.
    if (change.tokenUrl !== undefined && change.tokenUrl.trim().length > 0 && draft.tokenUrl.trim().length === 0 && !draft.enabled) {
      props.onChange({ ...change, enabled: true })
      return
    }
    props.onChange(change)
  }

  const field = (
    key: keyof AutosysGatewaySettings,
    label: string,
    placeholder: string,
    hint?: string,
  ): ReactElement => (
    <div key={key}>
      <label htmlFor={`lc-autosys-gw-${key}`} style={labelStyle()}>
        {label}
      </label>
      <input
        id={`lc-autosys-gw-${key}`}
        type="text"
        value={draft[key] as string}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => set({ [key]: event.target.value } as Partial<AutosysGatewaySettings>)}
        style={textFieldStyle()}
      />
      {hint !== undefined && <span style={hintStyle}>{hint}</span>}
    </div>
  )

  return (
    <fieldset
      style={{ border: `1px solid ${colors.border}`, borderRadius: 6, padding: '8px 10px', margin: '12px 0' }}
    >
      <legend style={{ padding: '0 4px', fontSize: 12 }}>API gateway (Apigee)</legend>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
        <span>Sign in through the gateway instead of with a username and password</span>
      </label>
      <span style={hintStyle}>
        A token is requested from the token URL with the client id and secret, then sent with every call to
        the site address above. It is kept in memory only and renewed before it expires.
      </span>

      {field('tokenUrl', 'Token URL', 'https://gateway.example.com/oauth/token', 'Where the token is issued — usually a different address from the AutoSys API.')}
      {field('clientId', 'Client id', 'The client (application) name the gateway issued')}

      <label htmlFor="lc-autosys-gw-secret" style={labelStyle()}>
        Client secret
      </label>
      <SecretInput
        id="lc-autosys-gw-secret"
        value={props.secret}
        placeholder={props.hasClientSecret ? 'Stored — leave blank to keep it' : 'Paste the client secret'}
        onChange={props.onSecret}
      />
      <span style={hintStyle}>Kept in secure storage, never in the settings file.</span>

      {field('scope', 'Scope (optional)', 'Only if the gateway asks for one')}

      <span style={labelStyle()}>How the client id and secret are sent for the token</span>
      <div style={{ display: 'flex', gap: 14, margin: '4px 0 4px', fontSize: 12 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="radio"
            name="lc-autosys-gw-clientauth"
            checked={draft.clientAuthentication === 'body'}
            onChange={() => set({ clientAuthentication: 'body' })}
          />
          In the request body
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="radio"
            name="lc-autosys-gw-clientauth"
            checked={draft.clientAuthentication === 'header'}
            onChange={() => set({ clientAuthentication: 'header' })}
          />
          As a Basic authorization header
        </label>
      </div>
      <span style={hintStyle}>If the token request is refused with 401 and the secret is right, try the other one.</span>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 4px', cursor: 'pointer' }}>
        <input type="checkbox" checked={draft.sendBasic} onChange={(event) => set({ sendBasic: event.target.checked })} />
        <span>Also send the AutoSys username and password (HTTP Basic)</span>
      </label>
      <span style={hintStyle}>
        For a gateway that checks its own token and passes AutoSys&apos;s sign-in through. Uses the username and
        password entered above. The two go in different headers — one header cannot hold both.
      </span>
      {draft.sendBasic && (
        <>
          {field('basicHeaderName', 'Header for the username and password', 'Authorization')}
          {/* Said before saving, where it can still be fixed, rather than as a refusal afterwards. */}
          {(draft.basicHeaderName.trim() || 'Authorization').toLowerCase() === (draft.tokenHeaderName.trim() || 'Authorization').toLowerCase() && (
            <span role="alert" style={{ display: 'block', color: colors.error, fontSize: 11, margin: '-4px 0 10px' }}>
              The token and the username and password would both go in the {draft.basicHeaderName.trim() || 'Authorization'} header.
              Set the token&apos;s header under Advanced (for example x-apigee-token), or a different header here — your
              gateway team knows which the gateway expects.
            </span>
          )}
        </>
      )}

      <details style={{ margin: '4px 0 10px' }}>
        <summary style={{ cursor: 'pointer', fontSize: 12 }}>Client certificate</summary>
        <span style={hintStyle}>
          Leave empty to use the certificate in Settings → Network, as every other connection does. Name one
          here only if this gateway needs a different one. Paths are relative to the certificate folder in
          Settings → Network unless absolute.
        </span>
        {field('certFile', 'Certificate file', 'client.crt')}
        {field('keyFile', 'Private key file', 'client.key')}
        {field('pfxFile', 'Or a PFX bundle', 'client.pfx')}
        <label htmlFor="lc-autosys-gw-pass" style={labelStyle()}>
          Certificate passphrase (optional)
        </label>
        <input
          id="lc-autosys-gw-pass"
          type="password"
          autoComplete="off"
          value={props.passphrase}
          placeholder={props.hasPassphrase ? 'Stored — leave blank to keep it' : 'Only if the key is protected'}
          onChange={(event) => props.onPassphrase(event.target.value)}
          style={textFieldStyle()}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 4px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!draft.useGlobalClientCertificate}
            onChange={(event) => set({ useGlobalClientCertificate: !event.target.checked })}
          />
          <span>Do not send the Settings → Network certificate to this gateway</span>
        </label>
      </details>

      <details style={{ margin: '4px 0 10px' }}>
        <summary style={{ cursor: 'pointer', fontSize: 12 }}>Advanced — how the token is requested and sent</summary>
        <span style={hintStyle}>Leave blank for the usual defaults, which suit most gateways.</span>
        {field('grantType', 'Grant type', 'client_credentials')}
        {field('tokenPath', 'Token field in the response', 'access_token')}
        {field('expiresInPath', 'Expiry field in the response', 'expires_in')}
        {field('tokenHeaderName', 'Header the token is sent in', 'Authorization')}
        {field('tokenHeaderPrefix', 'Text before the token', 'Bearer')}
        <label htmlFor="lc-autosys-gw-headers" style={labelStyle()}>
          Extra headers on every AutoSys call
        </label>
        <textarea
          id="lc-autosys-gw-headers"
          rows={2}
          value={draft.extraHeaders}
          spellCheck={false}
          placeholder={'x-api-key: …\none per line, Name: value'}
          onChange={(event) => set({ extraHeaders: event.target.value })}
          style={{ ...textFieldStyle(), fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
        />
        <label htmlFor="lc-autosys-gw-params" style={labelStyle()}>
          Extra token request parameters
        </label>
        <textarea
          id="lc-autosys-gw-params"
          rows={2}
          value={draft.extraTokenParams}
          spellCheck={false}
          placeholder={'audience=autosys\none per line, key=value'}
          onChange={(event) => set({ extraTokenParams: event.target.value })}
          style={{ ...textFieldStyle(), fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
        />
      </details>

      {(props.hasClientSecret || props.hasPassphrase) && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {props.hasClientSecret && (
            <button type="button" style={secondaryButtonStyle()} onClick={() => props.onClearSecret('clientSecret')}>
              Remove client secret
            </button>
          )}
          {props.hasPassphrase && (
            <button type="button" style={secondaryButtonStyle()} onClick={() => props.onClearSecret('passphrase')}>
              Remove passphrase
            </button>
          )}
        </div>
      )}
    </fieldset>
  )
}
