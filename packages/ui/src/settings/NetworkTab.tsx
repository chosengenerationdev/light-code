import type { NetworkSettingsInput, NetworkSettingsSummary } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { colors, fontFamily, primaryButtonStyle } from '../theme.js'
import { PathField, type BrowseRequest } from './PathField.js'
import { SecretField } from './SecretField.js'
import { Panel } from './Panel.js'

export interface NetworkTabProps {
  settings: NetworkSettingsSummary | undefined
  onSave: (settings: NetworkSettingsInput) => void
  onSaveProxy: (proxy: { http: string; https: string; noProxy: string }) => void
  onBrowse: (request: BrowseRequest) => void
  pickedPath: { purpose: string; path: string } | undefined
}

const hint: React.CSSProperties = {
  fontFamily,
  fontSize: 11,
  color: colors.muted,
  marginTop: -12,
  marginBottom: 16,
  lineHeight: 1.5,
}

function Field(props: {
  id: string
  label: string
  value: string
  placeholder: string
  hint?: string
  browse?: BrowseRequest
  onBrowse?: (request: BrowseRequest) => void
  onChange: (value: string) => void
}): ReactElement {
  return (
    <div style={{ marginBottom: props.hint !== undefined ? 0 : 16 }}>
      <PathField
        id={props.id}
        label={props.label}
        value={props.value}
        placeholder={props.placeholder}
        {...(props.browse !== undefined ? { browse: props.browse } : {})}
        {...(props.onBrowse !== undefined ? { onBrowse: props.onBrowse } : {})}
        onChange={props.onChange}
      />
      {props.hint !== undefined && <div style={hint}>{props.hint}</div>}
    </div>
  )
}

/**
 * The proxy `http_request` goes through. Its own panel and its own Save: the TLS Save sends TLS only, so
 * neither can wipe the other. The boxes take the URL as people write it, login included; the host moves
 * the password into secret storage, and the box comes back showing the user name only.
 */
function ProxyPanel(props: { settings: NetworkSettingsSummary | undefined; onSave: NetworkTabProps['onSaveProxy'] }): ReactElement {
  const proxy = props.settings?.proxy
  const [http, setHttp] = useState('')
  const [https, setHttps] = useState('')
  const [noProxy, setNoProxy] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setHttp(proxy?.http ?? '')
    setHttps(proxy?.https ?? '')
    setNoProxy(proxy?.noProxy ?? '')
  }, [proxy?.http, proxy?.https, proxy?.noProxy])
  const stored = (has: boolean | undefined, value: string): string | undefined =>
    has === true && value.trim().length > 0 && !/:[^/@]*@/.test(value.replace(/^https?:\/\//, '')) ? 'Password stored - leave it out of the address to keep it.' : undefined
  const field = (id: string, label: string, value: string, set: (v: string) => void, placeholder: string, note?: string): ReactElement => (
    <div style={{ marginBottom: 12 }}>
      <label htmlFor={id} style={{ display: 'block', fontFamily, fontSize: 12, marginBottom: 4 }}>
        {label}
      </label>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => {
          set(event.target.value)
          setSaved(false)
        }}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 12, padding: '4px 6px', background: colors.inputBackground, color: colors.inputForeground, border: `1px solid ${colors.inputBorder}`, borderRadius: 2 }}
      />
      {note !== undefined && <div style={{ ...hint, marginTop: 2, marginBottom: 0 }}>{note}</div>}
    </div>
  )
  return (
    <Panel id="network.proxy" title="Proxy for API calls" summary={proxy?.http !== undefined || proxy?.https !== undefined ? 'Set' : 'None'}>
      <p style={{ ...hint, marginTop: 0 }}>
        Used by <code>http_request</code> (the assistant calling an API). Write the login into the address, e.g.{' '}
        <code>http://user:password@proxy.corp:8080</code> - the password is moved into secret storage and never written to
        settings. HTTP is for http:// APIs and HTTPS for https:// ones; both are usually the same proxy.
      </p>
      {field('net-proxy-http', 'HTTP proxy', http, setHttp, 'http://user:password@proxy.corp:8080', stored(proxy?.httpHasPassword, http))}
      {field('net-proxy-https', 'HTTPS proxy', https, setHttps, 'http://user:password@proxy.corp:8080', stored(proxy?.httpsHasPassword, https))}
      {field('net-proxy-none', 'No proxy for', noProxy, setNoProxy, '.corp.internal, localhost, 10.0.0.0', 'Comma-separated hosts or domains reached directly.')}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          style={primaryButtonStyle(false)}
          onClick={() => {
            props.onSave({ http, https, noProxy })
            setSaved(true)
          }}
        >
          Save proxy
        </button>
        {props.settings?.proxyError !== undefined ? (
          <span style={{ fontSize: 12, color: colors.error }}>{props.settings.proxyError}</span>
        ) : (
          saved && <span style={{ fontSize: 12, color: colors.muted }}>Saved.</span>
        )}
      </div>
    </Panel>
  )
}

/**
 * TLS material every connection inherits — the gateway, OpenSearch, the embedder, the
 * Apigee token endpoint.
 *
 * This exists because a corporate machine has one intercepting root and often one machine
 * certificate, and entering them once per connection is three chances to forget one.
 * Anything set on an individual provider or cluster still wins; a CA set there is added to
 * this one rather than replacing it.
 */
export function NetworkTab(props: NetworkTabProps): ReactElement {
  const settings = props.settings
  const [certDir, setCertDir] = useState('')
  const [caFile, setCaFile] = useState('')
  const [certFile, setCertFile] = useState('')
  const [keyFile, setKeyFile] = useState('')
  const [pfxFile, setPfxFile] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [verify, setVerify] = useState(true)
  const [saved, setSaved] = useState(false)

  // Resynced from props rather than seeded once: `useState(prop)` only reads its argument
  // at mount, and the host's reply can arrive after this component renders.
  useEffect(() => {
    if (settings === undefined) return
    setCertDir(settings.certDir ?? '')
    setCaFile(settings.tls.caFile ?? '')
    setCertFile(settings.tls.certFile ?? '')
    setKeyFile(settings.tls.keyFile ?? '')
    setPfxFile(settings.tls.pfxFile ?? '')
    setVerify(settings.tls.rejectUnauthorized !== false)
    setPassphrase('')
    setSaved(false)
  }, [settings])

  // Keyed on `purpose` rather than focus: the native dialog takes focus while it is open,
  // so there is nothing reliable to return to.
  useEffect(() => {
    const picked = props.pickedPath
    if (picked === undefined) return
    const setter = {
      'net.certDir': setCertDir,
      'net.caFile': setCaFile,
      'net.certFile': setCertFile,
      'net.keyFile': setKeyFile,
      'net.pfxFile': setPfxFile,
    }[picked.purpose]
    setter?.(picked.path)
  }, [props.pickedPath])

  const usingPfx = pfxFile.trim().length > 0

  function save(): void {
    props.onSave({
      certDir,
      tls: {
        caFile,
        certFile: usingPfx ? '' : certFile,
        keyFile: usingPfx ? '' : keyFile,
        pfxFile,
        ...(verify ? {} : { rejectUnauthorized: false }),
      },
      // Absent leaves the stored value alone; the field is only sent when typed into.
      ...(passphrase.length > 0 ? { passphrase } : {}),
    })
    setSaved(true)
  }

  return (
    <div style={{ padding: 16, fontFamily, fontSize: 13, color: colors.foreground }}>
      <p style={{ ...hint, marginTop: 0, marginBottom: 20 }}>
        Applies to every connection Light Code makes. A provider profile or search cluster can still
        set its own — an extra CA there is added to this one, and its own client certificate replaces
        this one for that connection only.
      </p>

      <Panel id="network.trust" title="Trust" summary={verify ? (caFile.length > 0 ? caFile : 'Built-in roots') : 'Verification off'} defaultOpen>
      <Field
        id="net-certdir"
        browse={{ purpose: 'net.certDir', kind: 'folder' }}
        onBrowse={props.onBrowse}
        label="Certificate directory"
        value={certDir}
        placeholder="C:\Users\you\certs"
        hint="Filenames below resolve against this. Absolute paths ignore it. Must be outside the workspace, and everything it holds is hidden from file-reading tools."
        onChange={setCertDir}
      />

      <Field
        id="net-ca"
        browse={{ purpose: 'net.caFile', kind: 'file', extensions: ['pem','crt','cer','ca-bundle'] }}
        onBrowse={props.onBrowse}
        label="CA certificate"
        value={caFile}
        placeholder="corporate-root.pem"
        hint="Added to the built-in roots, not a replacement for them — public sites keep working."
        onChange={setCaFile}
      />

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={verify}
          onChange={(event) => setVerify(event.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>Verify server certificates</span>
      </label>
      {!verify && (
        <div style={{ ...hint, color: 'var(--vscode-editorWarning-foreground, inherit)', marginTop: 4 }}>
          Off means any certificate is accepted, so an interception cannot be distinguished from the
          real server. Use it to confirm a diagnosis, then add the CA above instead.
        </div>
      )}

      </Panel>

      <Panel
        id="network.clientCertificate"
        title="Client certificate"
        summary={usingPfx ? pfxFile : certFile.length > 0 ? certFile : 'None'}
      >
      <p style={{ ...hint, marginTop: 0 }}>
        Presented to every connection that does not supply its own. A certificate identifies you, so
        it goes to each host you have configured — set it on the individual profile instead if that
        is not what you want.
      </p>

      <Field
        id="net-pfx"
        browse={{ purpose: 'net.pfxFile', kind: 'file', extensions: ['pfx','p12'] }}
        onBrowse={props.onBrowse}
        label="PFX bundle"
        value={pfxFile}
        placeholder="client.pfx"
        hint="Windows PKI usually issues one of these. Supplied instead of a certificate and key."
        onChange={setPfxFile}
      />

      {!usingPfx && (
        <>
          <Field
            id="net-cert"
        browse={{ purpose: 'net.certFile', kind: 'file', extensions: ['crt','pem','cer'] }}
        onBrowse={props.onBrowse}
            label="Certificate"
            value={certFile}
            placeholder="client.crt"
            onChange={setCertFile}
          />
          <Field id="net-key"
        browse={{ purpose: 'net.keyFile', kind: 'file', extensions: ['key','pem'] }}
        onBrowse={props.onBrowse} label="Private key" value={keyFile} placeholder="client.key" onChange={setKeyFile} />
        </>
      )}

      <SecretField
        id="net-passphrase"
        label="Key passphrase"
        hasValue={settings?.hasPassphrase ?? false}
        value={passphrase}
        onChange={setPassphrase}
        placeholder="Leave blank if the key is not encrypted"
      />
      </Panel>

      {/* One Save for both panels: they are one block of settings, written together. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" style={primaryButtonStyle(false)} onClick={save}>
          Save
        </button>
        {saved && <span style={{ fontSize: 12, color: colors.muted }}>Saved.</span>}
      </div>

      <div style={{ marginTop: 20 }}>
        <ProxyPanel settings={settings} onSave={props.onSaveProxy} />
      </div>
    </div>
  )
}
