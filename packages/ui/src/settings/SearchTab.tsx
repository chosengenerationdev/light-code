import type { SearchConnectionInput, SearchConnectionSummary } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { TrashIcon } from '../icons.js'
import {
  colors,
  fontFamily,
  iconButtonStyle,
  labelStyle,
  optionStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  selectStyle,
  textFieldStyle,
} from '../theme.js'
import { ScopeBadge } from './ScopeBadge.js'
import { SecretField } from './SecretField.js'

export interface SearchIndex {
  name: string
  docsCount?: number
  storeSize?: string
}

export interface SearchTabProps {
  connections: SearchConnectionSummary[]
  activeConnectionId: string | undefined
  indexes: SearchIndex[]
  indexesWarning?: string
  testResult?: { ok: boolean; detail: string }
  onSave: (connection: SearchConnectionInput) => void
  onDelete: (id: string) => void
  onSetActive: (id: string | undefined) => void
  onListIndexes: (connection: SearchConnectionInput) => void
  onTest: (connection: SearchConnectionInput) => void
}

const BLANK: SearchConnectionSummary = {
  id: '',
  label: '',
  url: '',
  hasUsername: false,
  hasPassword: false,
}

export function SearchTab(props: SearchTabProps): ReactElement {
  const [editing, setEditing] = useState<SearchConnectionSummary | undefined>(undefined)
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [defaultIndex, setDefaultIndex] = useState('')
  const [caFile, setCaFile] = useState('')
  const [skipVerify, setSkipVerify] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  // Resync when a different connection is opened, or when the host echoes a save back.
  useEffect(() => {
    const source = editing ?? BLANK
    setLabel(source.label)
    setUrl(source.url)
    setDefaultIndex(source.defaultIndex ?? '')
    setCaFile(source.caFile ?? '')
    setSkipVerify(source.rejectUnauthorized === false)
    setUsername('')
    setPassword('')
  }, [editing])

  const currentInput = (): SearchConnectionInput => ({
    ...(editing !== undefined && editing.id.length > 0 ? { id: editing.id } : {}),
    label,
    url,
    defaultIndex,
    caFile,
    ...(skipVerify ? { rejectUnauthorized: false } : {}),
    ...(username.length > 0 ? { username } : {}),
    ...(password.length > 0 ? { password } : {}),
  })

  if (editing !== undefined) {
    return (
      <div style={{ padding: 12, overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', color: colors.foreground }}>
          {editing.id.length === 0 ? 'Add OpenSearch connection' : 'Edit connection'}
        </h3>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="lc-os-label" style={labelStyle()}>
            Name
          </label>
          <input
            id="lc-os-label"
            type="text"
            value={label}
            placeholder="Production"
            onChange={(event) => setLabel(event.target.value)}
            style={textFieldStyle()}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="lc-os-url" style={labelStyle()}>
            Cluster URL
          </label>
          <input
            id="lc-os-url"
            type="text"
            value={url}
            placeholder="https://opensearch.internal:9200"
            onChange={(event) => setUrl(event.target.value)}
            style={textFieldStyle()}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="lc-os-user" style={labelStyle()}>
            Username
          </label>
          <input
            id="lc-os-user"
            type="text"
            value={username}
            placeholder={editing.hasUsername ? 'Set — type to replace' : ''}
            onChange={(event) => setUsername(event.target.value)}
            style={textFieldStyle()}
          />
        </div>

        <SecretField
          id="lc-os-password"
          label="Password"
          hasValue={editing.hasPassword}
          value={password}
          onChange={setPassword}
          placeholder="Stored in the OS keychain"
        />

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="lc-os-index" style={labelStyle()}>
            Default index
          </label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              id="lc-os-index"
              type="text"
              value={defaultIndex}
              placeholder="Used when the model names no index"
              onChange={(event) => setDefaultIndex(event.target.value)}
              style={textFieldStyle()}
            />
            <button type="button" style={secondaryButtonStyle()} onClick={() => props.onListIndexes(currentInput())}>
              List
            </button>
          </div>

          {props.indexes.length > 0 && (
            <select
              aria-label="Available indexes"
              value={props.indexes.some((index) => index.name === defaultIndex) ? defaultIndex : ''}
              onChange={(event) => {
                if (event.target.value.length > 0) setDefaultIndex(event.target.value)
              }}
              style={{ ...selectStyle(), width: '100%' }}
            >
              <option value="" style={optionStyle()}>
                Choose from {props.indexes.length} index(es)…
              </option>
              {props.indexes.map((index) => (
                <option key={index.name} value={index.name} style={optionStyle()}>
                  {index.name}
                  {index.docsCount !== undefined ? ` — ${index.docsCount.toLocaleString()} docs` : ''}
                  {index.storeSize !== undefined ? `, ${index.storeSize}` : ''}
                </option>
              ))}
            </select>
          )}

          {/* Typing an index by hand always works: `_cat/indices` is frequently denied to a
              low-privilege account that can still search perfectly well. */}
          {props.indexesWarning !== undefined && props.indexes.length === 0 && (
            <span style={{ color: colors.muted, fontSize: 11, display: 'block', marginTop: 4 }}>
              Could not list indexes ({props.indexesWarning}). Type the name instead.
            </span>
          )}
        </div>

        <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}`, marginBottom: 12 }}>
          <strong style={{ fontSize: 12, color: colors.foreground }}>Connection security</strong>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label htmlFor="lc-os-ca" style={labelStyle()}>
            CA certificate file
          </label>
          <input
            id="lc-os-ca"
            type="text"
            value={caFile}
            placeholder="corp-root.pem"
            onChange={(event) => setCaFile(event.target.value)}
            style={textFieldStyle()}
          />
          <span style={{ color: colors.muted, fontSize: 11 }}>
            Relative names resolve against the global certDir. Added to the built-in roots.
          </span>
        </div>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            style={{ marginTop: 2 }}
            checked={skipVerify}
            onChange={(event) => setSkipVerify(event.target.checked)}
          />
          <span style={{ color: colors.foreground }}>Skip certificate verification</span>
        </label>
        {skipVerify && (
          <p style={{ color: colors.error, fontSize: 11, margin: '0 0 12px', paddingLeft: 22 }}>
            Anyone able to intercept this connection can read and modify it, including the
            password. The CA file above is the safe fix.
          </p>
        )}

        <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}`, marginBottom: 12 }}>
          <button type="button" style={secondaryButtonStyle()} onClick={() => props.onTest(currentInput())}>
            Test Connection
          </button>
          {props.testResult !== undefined && (
            <div
              style={{
                marginTop: 8,
                fontSize: 12,
                color: props.testResult.ok ? 'var(--vscode-testing-iconPassed, #3fb950)' : colors.error,
              }}
            >
              {props.testResult.detail}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            style={primaryButtonStyle(false)}
            onClick={() => {
              props.onSave(currentInput())
              setEditing(undefined)
            }}
          >
            Save
          </button>
          <button type="button" style={secondaryButtonStyle()} onClick={() => setEditing(undefined)}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 12, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0, color: colors.foreground }}>Search</h3>
        <ScopeBadge scope="user" />
      </div>

      <p style={{ color: colors.muted, fontSize: 12, fontFamily, margin: '0 0 12px' }}>
        Lets the model search OpenSearch indexes your organisation already runs — logs,
        tickets, documentation. It can only read: nothing here can create, change or delete
        anything in a cluster.
      </p>

      {props.connections.length === 0 && (
        <p style={{ color: colors.muted, fontFamily }}>No connections yet.</p>
      )}

      {props.connections.map((connection) => {
        const isActive = connection.id === props.activeConnectionId
        return (
          <div
            key={connection.id}
            style={{
              padding: 10,
              marginBottom: 8,
              borderRadius: 4,
              border: `1px solid ${isActive ? colors.focusBorder : colors.border}`,
              background: isActive ? colors.assistantBubble : 'transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <strong>{connection.label}</strong>
              {isActive && <span style={{ color: colors.muted, fontSize: 11 }}>· active</span>}
            </div>
            <div style={{ color: colors.muted, fontSize: 12, marginBottom: 8 }}>
              {connection.url}
              {connection.defaultIndex !== undefined ? ` — ${connection.defaultIndex}` : ' — no default index'}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                style={secondaryButtonStyle()}
                onClick={() => props.onSetActive(isActive ? undefined : connection.id)}
              >
                {isActive ? 'Turn off' : 'Use in chat'}
              </button>
              <button type="button" style={secondaryButtonStyle()} onClick={() => setEditing(connection)}>
                Edit
              </button>
              <button
                type="button"
                title="Delete"
                aria-label="Delete"
                style={{ ...iconButtonStyle('secondary'), color: colors.error }}
                onClick={() => props.onDelete(connection.id)}
              >
                <TrashIcon />
              </button>
            </div>
          </div>
        )
      })}

      <button type="button" style={primaryButtonStyle(false)} onClick={() => setEditing({ ...BLANK })}>
        Add connection
      </button>

      {/* Stating the session rule where the choice is made, since "why did the tool vanish?"
          is otherwise a mystery. */}
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 16 }}>
        Search tools are offered only while a connection is active. Switching starts a fresh
        prompt, so change it between messages rather than mid-reply.
      </p>
    </div>
  )
}
