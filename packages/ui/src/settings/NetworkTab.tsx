import type { NetworkSettingsInput, NetworkSettingsSummary } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { colors, fontFamily, primaryButtonStyle } from '../theme.js'
import { PathField, type BrowseRequest } from './PathField.js'
import { SecretField } from './SecretField.js'

export interface NetworkTabProps {
  settings: NetworkSettingsSummary | undefined
  onSave: (settings: NetworkSettingsInput) => void
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

      <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: colors.muted, margin: '24px 0 12px' }}>
        Trust
      </h3>

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

      <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: colors.muted, margin: '24px 0 12px' }}>
        Client certificate
      </h3>
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" style={primaryButtonStyle(false)} onClick={save}>
          Save
        </button>
        {saved && <span style={{ fontSize: 12, color: colors.muted }}>Saved.</span>}
      </div>
    </div>
  )
}
