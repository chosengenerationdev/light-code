import {
  ATLASSIAN_PRODUCTS,
  type AtlassianProductId,
  type AtlassianProductInfo,
  type AtlassianProductStatus,
  type AtlassianSettingsView,
} from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'

import { colors, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { Panel } from './Panel.js'

/**
 * Confluence, Jira and Bitbucket: one panel each, from one component and the product table in
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
  onSave: (product: AtlassianProductId, settings: AtlassianSettingsView, token: string | undefined) => void
  onClearToken: (product: AtlassianProductId) => void
  onTest: (product: AtlassianProductId) => void
}

export function AtlassianTab(props: AtlassianTabProps): ReactElement {
  return (
    <div>
      <p style={{ color: colors.muted, fontSize: 12, margin: '0 0 12px' }}>
        Data Center and Server sites, each with your own personal access token. Everything the
        assistant writes is shown to you first and is written as you. A product stays off, and its
        site is never contacted, until you switch it on.
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
            savedTick={props.savedTicks[info.id] ?? 0}
            test={props.tests[info.id]}
            testing={props.testing[info.id] === true}
            onSave={(settings, token) => props.onSave(info.id, settings, token)}
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
  onSave: (settings: AtlassianSettingsView, token: string | undefined) => void
  onClearToken: () => void
  onTest: () => void
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
  useEffect(() => {
    if (props.savedTick > 0) {
      setSaved(true)
      setToken('')
    }
  }, [props.savedTick])

  const dirty = JSON.stringify(draft) !== savedKey || token.trim().length > 0
  const set = (change: Partial<AtlassianSettingsView>): void => {
    setSaved(false)
    setDraft({ ...draft, ...change })
  }
  const id = (field: string): string => `lc-${info.id}-${field}`

  const summary = !props.settings.enabled
    ? 'Off'
    : props.settings.baseUrl.length === 0
      ? 'No site set'
      : props.hasToken
        ? props.settings.baseUrl
        : 'No token stored'

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

      <label htmlFor={id('token')} style={labelStyle()}>
        Personal access token
      </label>
      <input
        id={id('token')}
        type="password"
        value={token}
        autoComplete="off"
        placeholder={props.hasToken ? 'Stored — leave blank to keep it' : 'Paste a token'}
        onChange={(event) => {
          setSaved(false)
          setToken(event.target.value)
        }}
        style={textFieldStyle()}
      />
      <span style={hintStyle}>
        Create one in {info.label} under your profile → Personal Access Tokens. Kept in secure
        storage, never in the settings file, and never sent back to this panel.
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

      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          style={primaryButtonStyle(!dirty)}
          disabled={!dirty}
          onClick={() => props.onSave(draft, token.trim().length > 0 ? token.trim() : undefined)}
        >
          {saved && !dirty ? 'Saved' : 'Save'}
        </button>
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={props.testing || props.settings.baseUrl.length === 0 || !props.hasToken}
          title={
            props.settings.baseUrl.length === 0 || !props.hasToken
              ? 'Save the site address and a token first'
              : 'Checks the address, the certificate and the token, and says who it connects as'
          }
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
