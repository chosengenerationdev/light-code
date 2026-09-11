import { type ReactElement } from 'react'

import { colors, labelStyle, monospaceFamily, secondaryButtonStyle, textFieldStyle } from '../theme.js'

export interface AuthHeaderInput {
  name: string
  valueRef: string
  prefix?: string | undefined
}

export interface HeaderAuthFieldsProps {
  headers: AuthHeaderInput[]
  onChange: (next: AuthHeaderInput[]) => void
}

/**
 * A gateway that authenticates on a fixed header, with no API key.
 *
 * ## Why a list rather than one pair
 *
 * A gateway of this shape frequently wants more than one — a key and a tenant, a token and a
 * product id — and the version that took a single name and value would have needed replacing the
 * first time somebody hit that. Adding a row costs nothing; discovering the field cannot express
 * your gateway costs a release.
 *
 * ## What the value box actually holds
 *
 * A *reference*, once saved. Type a literal and it is written to secure storage and replaced by a
 * pointer, because the profile lives in the config file and §15 is explicit that a credential
 * never does — it would be exported, read by anything that can read the workspace, and printed by
 * anything that logs config. Type `env:NAME` and it stays exactly that: the credential remains
 * wherever the launching process put it, and is read fresh on every request.
 *
 * Which is why a saved row shows the reference rather than the value. It is not being coy — the
 * panel has never been sent the value, and cannot be (invariant 7).
 */
export function HeaderAuthFields(props: HeaderAuthFieldsProps): ReactElement {
  const set = (index: number, patch: Partial<AuthHeaderInput>): void => {
    props.onChange(props.headers.map((header, at) => (at === index ? { ...header, ...patch } : header)))
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 10px' }}>
        For a gateway that authenticates on a header it expects rather than on an API key. Each
        value is stored in secure storage and the profile keeps only a pointer &mdash; or write{' '}
        <code style={{ fontFamily: monospaceFamily }}>env:API_TOKEN</code> to read it from the
        environment on every request, without storing it at all.
      </p>

      {props.headers.map((header, index) => (
        <div
          key={index}
          style={{ border: `1px solid ${colors.border}`, borderRadius: 4, padding: 8, marginBottom: 8 }}
        >
          <label htmlFor={`lc-hdr-name-${String(index)}`} style={labelStyle()}>
            Header
          </label>
          <input
            id={`lc-hdr-name-${String(index)}`}
            type="text"
            value={header.name}
            spellCheck={false}
            placeholder="X-Gateway-Key"
            onChange={(event) => set(index, { name: event.target.value })}
            style={{ ...textFieldStyle(), fontFamily: monospaceFamily }}
          />

          <label htmlFor={`lc-hdr-value-${String(index)}`} style={labelStyle()}>
            Value
          </label>
          <input
            id={`lc-hdr-value-${String(index)}`}
            type={header.valueRef.startsWith('env:') || header.valueRef.startsWith('profile:') ? 'text' : 'password'}
            value={header.valueRef}
            spellCheck={false}
            placeholder="the value, or env:API_TOKEN"
            onChange={(event) => set(index, { valueRef: event.target.value })}
            style={{ ...textFieldStyle(), fontFamily: monospaceFamily }}
          />
          {header.valueRef.startsWith('profile:') && (
            <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: -10, marginBottom: 10 }}>
              Stored securely. Replace this to change it &mdash; the value itself never comes back
              to this panel.
            </span>
          )}
          {header.valueRef.startsWith('env:') && (
            <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: -10, marginBottom: 10 }}>
              Read from that environment variable on every request. It must be exported before
              Light Code starts.
            </span>
          )}

          <label htmlFor={`lc-hdr-prefix-${String(index)}`} style={labelStyle()}>
            Prefix <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            id={`lc-hdr-prefix-${String(index)}`}
            type="text"
            value={header.prefix ?? ''}
            spellCheck={false}
            placeholder="Bearer "
            onChange={(event) =>
              set(index, { prefix: event.target.value.length === 0 ? undefined : event.target.value })
            }
            style={{ ...textFieldStyle(), fontFamily: monospaceFamily }}
          />
          {/*
            Said because a trailing space is invisible and is the difference between a working
            header and a 401 that reads as a bad credential.
          */}
          <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: -10, marginBottom: 10 }}>
            Put in front of the value. Include the trailing space if there should be one &mdash;
            <code style={{ fontFamily: monospaceFamily }}>&ldquo;Bearer &rdquo;</code>, not{' '}
            <code style={{ fontFamily: monospaceFamily }}>&ldquo;Bearer&rdquo;</code>.
          </span>

          {props.headers.length > 1 && (
            <button
              type="button"
              style={secondaryButtonStyle()}
              onClick={() => props.onChange(props.headers.filter((_, at) => at !== index))}
            >
              Remove this header
            </button>
          )}
        </div>
      ))}

      <button
        type="button"
        style={secondaryButtonStyle()}
        onClick={() => props.onChange([...props.headers, { name: '', valueRef: '' }])}
      >
        Add another header
      </button>
    </div>
  )
}
