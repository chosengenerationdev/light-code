import type { ConfluenceSettingsView } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'

import { colors, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { Panel } from './Panel.js'

/**
 * Setting up Confluence: the site, the default space, and a personal access token.
 *
 * The token is **write-only** (invariant 7). The field is always empty; the host only ever says
 * whether one is stored, and a blank field on save means "keep it". Removing it is its own button,
 * so saving a new space key can never wipe the token on the way past.
 */

export interface ConfluenceSectionProps {
  settings: ConfluenceSettingsView
  hasToken: boolean
  /** Bumped by the host after a successful save, so the button can say "Saved". */
  savedTick: number
  test: { ok: boolean; detail: string } | undefined
  testing: boolean
  onSave: (settings: ConfluenceSettingsView, token: string | undefined) => void
  onClearToken: () => void
  onTest: () => void
}

export function ConfluenceSection(props: ConfluenceSectionProps): ReactElement {
  const [draft, setDraft] = useState<ConfluenceSettingsView>(props.settings)
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)
  const savedKey = JSON.stringify(props.settings)
  // Resynced by value, so an unrelated message from the host does not discard a half-typed field.
  useEffect(() => setDraft(JSON.parse(savedKey) as ConfluenceSettingsView), [savedKey])
  useEffect(() => {
    if (props.savedTick > 0) {
      setSaved(true)
      setToken('')
    }
  }, [props.savedTick])

  const dirty = JSON.stringify(draft) !== savedKey || token.trim().length > 0
  const set = (change: Partial<ConfluenceSettingsView>): void => {
    setSaved(false)
    setDraft({ ...draft, ...change })
  }

  const summary = !props.settings.enabled
    ? 'Off'
    : props.settings.baseUrl.length === 0
      ? 'No site set'
      : props.hasToken
        ? props.settings.baseUrl
        : 'No token stored'

  return (
    <Panel id="tools.confluence" title="Confluence" summary={summary}>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 10px' }}>
        Lets the assistant search, read and write pages on your Confluence Data Center or Server
        site with your personal access token — including the images on a page, attached diagrams,
        and files. Every write is shown to you before anything is published. Off until you switch
        it on; nothing is contacted until then.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
        <span>Let the assistant use Confluence</span>
      </label>

      <label htmlFor="lc-confluence-url" style={labelStyle()}>
        Site address
      </label>
      <input
        id="lc-confluence-url"
        type="text"
        value={draft.baseUrl}
        spellCheck={false}
        placeholder="https://wiki.example.com/confluence"
        onChange={(event) => set({ baseUrl: event.target.value })}
        style={textFieldStyle()}
      />
      <span style={{ display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 10px' }}>
        The address you open Confluence at, including any path before <code>/display</code>.
      </span>

      <label htmlFor="lc-confluence-token" style={labelStyle()}>
        Personal access token
      </label>
      <input
        id="lc-confluence-token"
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
      <span style={{ display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 10px' }}>
        Create one in Confluence under your profile → Personal Access Tokens. Kept in secure
        storage, never in the settings file, and never sent back to this panel. Pages are written
        as you.
      </span>

      <label htmlFor="lc-confluence-space" style={labelStyle()}>
        Default space for new pages <span style={{ color: colors.muted, fontWeight: 400 }}>(space key)</span>
      </label>
      <input
        id="lc-confluence-space"
        type="text"
        value={draft.defaultSpace}
        spellCheck={false}
        placeholder="e.g. TEAM"
        onChange={(event) => set({ defaultSpace: event.target.value })}
        style={textFieldStyle()}
      />
      <span style={{ display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 10px' }}>
        The key shown in the space&rsquo;s address, e.g. <code>TEAM</code> in <code>/display/TEAM/…</code>.
        The assistant creates new pages here unless you ask for another space, and is told so.
      </span>

      <label htmlFor="lc-confluence-ca" style={labelStyle()}>
        CA certificate file <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
      </label>
      <input
        id="lc-confluence-ca"
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
