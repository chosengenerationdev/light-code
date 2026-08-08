import type { ApigeeSummary, CertSummary, ModelCapabilityInput } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { colors, fontFamily, labelStyle, textFieldStyle } from '../theme.js'
import { SecretField } from './SecretField.js'

export type AuthType = 'none' | 'apiKey' | 'apigeeMtls'

export interface AdvancedAuthSectionProps {
  authType: AuthType
  onAuthTypeChange: (value: AuthType) => void

  apigee: ApigeeSummary
  onApigeeChange: (value: ApigeeSummary) => void
  clientSecret: string
  onClientSecretChange: (value: string) => void
  hasClientSecret: boolean

  certs: CertSummary
  onCertsChange: (value: CertSummary) => void
  certPassphrase: string
  onCertPassphraseChange: (value: string) => void
  hasCertPassphrase: boolean

  capabilities: ModelCapabilityInput
  onCapabilitiesChange: (value: ModelCapabilityInput) => void
}

function TextRow(props: {
  id: string
  label: string
  value: string | undefined
  placeholder?: string
  hint?: string
  onChange: (value: string) => void
}): ReactElement {
  return (
    <div style={{ marginBottom: 10 }}>
      <label htmlFor={props.id} style={labelStyle()}>
        {props.label}
      </label>
      <input
        id={props.id}
        type="text"
        value={props.value ?? ''}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        style={textFieldStyle()}
      />
      {props.hint !== undefined && (
        <span style={{ color: colors.muted, fontSize: 11, display: 'block', marginTop: 2 }}>{props.hint}</span>
      )}
    </div>
  )
}

function NumberRow(props: {
  id: string
  label: string
  value: number | undefined
  placeholder: string
  onChange: (value: number | undefined) => void
}): ReactElement {
  return (
    <div style={{ marginBottom: 10 }}>
      <label htmlFor={props.id} style={labelStyle()}>
        {props.label}
      </label>
      <input
        id={props.id}
        type="number"
        value={props.value ?? ''}
        placeholder={props.placeholder}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10)
          props.onChange(Number.isNaN(parsed) ? undefined : parsed)
        }}
        style={textFieldStyle()}
      />
    </div>
  )
}

function Disclosure(props: { title: string; children: ReactElement | ReactElement[] }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          background: 'transparent',
          border: 'none',
          color: colors.foreground,
          fontFamily,
          fontSize: 12,
          padding: 0,
          cursor: 'pointer',
        }}
      >
        {open ? '▾' : '▸'} {props.title}
      </button>
      {open && <div style={{ marginTop: 8, paddingLeft: 12 }}>{props.children}</div>}
    </div>
  )
}

/**
 * The Advanced half of provider config: mutual-TLS auth and model-capability overrides.
 *
 * `apigeeMtls` **replaces** the API key rather than supplementing it (§10), which is why
 * this is a single auth-type choice rather than an extra set of fields — the two can never both be
 * live, and the UI should make that impossible rather than merely discouraged.
 */
export function AdvancedAuthSection(props: AdvancedAuthSectionProps): ReactElement {
  const setApigee = (patch: Partial<ApigeeSummary>): void => props.onApigeeChange({ ...props.apigee, ...patch })
  const setCerts = (patch: Partial<CertSummary>): void => props.onCertsChange({ ...props.certs, ...patch })

  return (
    <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
      <div style={{ marginBottom: 12 }}>
        <label htmlFor="lc-auth-type" style={labelStyle()}>
          Authentication
        </label>
        <select
          id="lc-auth-type"
          value={props.authType}
          onChange={(event) => props.onAuthTypeChange(event.target.value as AuthType)}
          style={textFieldStyle()}
        >
          <option value="apiKey">API key</option>
          <option value="apigeeMtls">Mutual TLS + OAuth (Apigee)</option>
          <option value="none">None</option>
        </select>
      </div>

      {props.authType === 'apigeeMtls' && (
        <>
          <div style={{ marginBottom: 12 }}>
            <strong style={{ fontSize: 12, color: colors.foreground }}>Client certificate</strong>
            <p style={{ color: colors.muted, fontSize: 11, margin: '4px 0 8px' }}>
              Must live outside the workspace — a repository must not be able to read or replace your key material.
              Filenames resolve against the directory; absolute paths override it.
            </p>
          </div>

          <TextRow
            id="lc-cert-dir"
            label="Certificate directory"
            value={props.certs.certDir}
            placeholder="C:\\Users\\you\\certs"
            hint="Leave blank to use the global certDir from config."
            onChange={(value) => setCerts({ certDir: value })}
          />
          <TextRow
            id="lc-cert-file"
            label="Certificate file"
            value={props.certs.certFile}
            placeholder="client.crt"
            onChange={(value) => setCerts({ certFile: value })}
          />
          <TextRow
            id="lc-key-file"
            label="Private key file"
            value={props.certs.keyFile}
            placeholder="client.key"
            onChange={(value) => setCerts({ keyFile: value })}
          />
          <TextRow
            id="lc-pfx-file"
            label="PFX bundle (instead of certificate + key)"
            value={props.certs.pfxFile}
            placeholder="client.pfx"
            hint="Corporate Windows PKI usually issues a .pfx."
            onChange={(value) => setCerts({ pfxFile: value })}
          />
          <TextRow
            id="lc-ca-file"
            label="Extra CA bundle"
            value={props.certs.caFile}
            placeholder="corp-root.pem"
            hint="Needed when your network intercepts TLS. NODE_EXTRA_CA_CERTS also works."
            onChange={(value) => setCerts({ caFile: value })}
          />
          <SecretField
            id="lc-cert-passphrase"
            label="Key / PFX passphrase"
            hasValue={props.hasCertPassphrase}
            value={props.certPassphrase}
            onChange={props.onCertPassphraseChange}
            placeholder="Leave blank if the key is not encrypted"
          />

          <div style={{ marginBottom: 12 }}>
            <strong style={{ fontSize: 12, color: colors.foreground }}>Token endpoint</strong>
          </div>

          <TextRow
            id="lc-token-url"
            label="Token URL"
            value={props.apigee.tokenUrl}
            placeholder="https://gateway.example.com/oauth/token"
            hint="Defaults to the base URL's origin + /oauth/token."
            onChange={(value) => setApigee({ tokenUrl: value })}
          />
          <TextRow
            id="lc-client-id"
            label="Client ID"
            value={props.apigee.clientId}
            onChange={(value) => setApigee({ clientId: value })}
          />
          <SecretField
            id="lc-client-secret"
            label="Client secret"
            hasValue={props.hasClientSecret}
            value={props.clientSecret}
            onChange={props.onClientSecretChange}
            placeholder="Stored in the OS keychain"
          />
          <TextRow
            id="lc-scope"
            label="Scope"
            value={props.apigee.scope}
            placeholder="(optional)"
            onChange={(value) => setApigee({ scope: value })}
          />

          <Disclosure title="Token response and header mapping">
            <TextRow
              id="lc-grant-type"
              label="Grant type"
              value={props.apigee.grantType}
              placeholder="client_credentials"
              onChange={(value) => setApigee({ grantType: value })}
            />
            <TextRow
              id="lc-token-path"
              label="Token path in response"
              value={props.apigee.tokenPath}
              placeholder="access_token"
              hint="Dotted path, e.g. data.jwt if your gateway nests it."
              onChange={(value) => setApigee({ tokenPath: value })}
            />
            <TextRow
              id="lc-expires-path"
              label="Expiry path in response"
              value={props.apigee.expiresInPath}
              placeholder="expires_in"
              onChange={(value) => setApigee({ expiresInPath: value })}
            />
            <TextRow
              id="lc-token-header"
              label="Header name"
              value={props.apigee.tokenHeaderName}
              placeholder="Authorization"
              onChange={(value) => setApigee({ tokenHeaderName: value })}
            />
            <TextRow
              id="lc-token-prefix"
              label="Header prefix"
              value={props.apigee.tokenHeaderPrefix}
              placeholder="Bearer "
              onChange={(value) => setApigee({ tokenHeaderPrefix: value })}
            />
            <NumberRow
              id="lc-fallback-expiry"
              label="Fallback expiry (seconds)"
              value={props.apigee.fallbackExpirySeconds}
              placeholder="3600"
              onChange={(value) => setApigee({ ...(value !== undefined ? { fallbackExpirySeconds: value } : {}) })}
            />
            <NumberRow
              id="lc-refresh-skew"
              label="Refresh skew (seconds)"
              value={props.apigee.refreshSkewSeconds}
              placeholder="60"
              onChange={(value) => setApigee({ ...(value !== undefined ? { refreshSkewSeconds: value } : {}) })}
            />
          </Disclosure>
        </>
      )}

      <Disclosure title="Model capability overrides">
        <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
          Only needed when your gateway renames models so Light Code cannot recognise them.
        </p>
        <NumberRow
          id="lc-context-window"
          label="Context window (tokens)"
          value={props.capabilities.contextWindow}
          placeholder="from the built-in table"
          onChange={(value) => {
            // Clearing the field must remove the key entirely, not store 0 — an absent
            // override is what falls back to the built-in table.
            const rest = { ...props.capabilities }
            delete rest.contextWindow
            props.onCapabilitiesChange(value !== undefined ? { ...rest, contextWindow: value } : rest)
          }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={props.capabilities.supportsVision ?? false}
            onChange={(event) =>
              props.onCapabilitiesChange({ ...props.capabilities, supportsVision: event.target.checked })
            }
          />
          Supports images
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={props.capabilities.supportsTools ?? true}
            onChange={(event) =>
              props.onCapabilitiesChange({ ...props.capabilities, supportsTools: event.target.checked })
            }
          />
          Supports tool calling
        </label>
      </Disclosure>
    </div>
  )
}
