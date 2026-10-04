import { createContext, useContext, type CSSProperties, type ReactElement } from 'react'
import { credentialChoices, describePointer, isCredentialPointer, type CredentialSummary } from '@light-code/core/browser'
import { Select } from '../Select.js'
import { colors, secondaryButtonStyle, textFieldStyle } from '../theme.js'

/**
 * Saved credentials, where the host has them (Fire Code). `undefined` everywhere else - the VS
 * Code extension, a plain Node host - and then no picker is drawn at all, so nothing changes there.
 */
export const CredentialsContext = createContext<CredentialSummary[] | undefined>(undefined)

/**
 * "Use a saved credential" beside a secret field.
 *
 * Picking one hands the field a pointer (`credential:<id>#<field>`), saved like any typed value; the
 * host resolves it whenever the secret is read, so replacing the credential in Fire Code updates every
 * place that uses it. Labels only - no value ever reaches this page (invariant 7).
 */
export function CredentialPicker(props: {
  onPick: (pointer: string) => void
  id?: string
  /** Draw nothing, rather than the "none saved yet" line, when there are none - for repeated rows. */
  quiet?: boolean
}): ReactElement | null {
  const credentials = useContext(CredentialsContext)
  if (credentials === undefined) return null
  if (credentials.length === 0) {
    if (props.quiet === true) return null
    return (
      <span style={{ display: 'block', marginTop: 4, color: colors.muted, fontSize: 11 }}>
        No saved credentials yet — add them in Fire Code&rsquo;s Credentials to pick one here.
      </span>
    )
  }
  return (
    <div style={{ marginTop: 6 }}>
      <Select
        value=""
        compact
        placeholder="Use a saved credential…"
        ariaLabel="Use a saved credential"
        options={credentialChoices(credentials).map((choice) => ({ value: choice.pointer, label: choice.label }))}
        onChange={props.onPick}
        {...(props.id !== undefined ? { id: props.id } : {})}
      />
    </div>
  )
}

/**
 * What a field shows instead of a password box when its value is a saved credential: which one,
 * and a way to type a value instead. A pointer is not a secret, so naming it is fine.
 */
export function CredentialInUse(props: { pointer: string; onClear: () => void }): ReactElement {
  const credentials = useContext(CredentialsContext) ?? []
  const label = describePointer(props.pointer, credentials)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span
        style={{
          padding: '3px 10px',
          borderRadius: 999,
          border: `1px solid ${colors.accent}`,
          color: colors.foreground,
          fontSize: 12,
        }}
      >
        🔑 {label ?? 'A saved credential that no longer exists'}
      </span>
      <button type="button" style={secondaryButtonStyle()} onClick={props.onClear}>
        Type a value instead
      </button>
    </div>
  )
}

export { isCredentialPointer }

/** `${secret:credential:…}` references inside a typed value, as an MCP header or variable holds. */
export function credentialsMentioned(text: string, credentials: readonly CredentialSummary[]): string[] {
  return [...text.matchAll(/\$\{secret:(credential:[^}]+)\}/g)]
    .map((match) => describePointer(match[1] as string, credentials))
    .filter((label): label is string => label !== undefined)
}

/**
 * A saved credential put into a typed value as `${secret:…}`: after the text when it ends in a
 * space (so "Bearer " stays in front of the token), in place of it otherwise.
 */
export function withCredential(current: string, pointer: string): string {
  const reference = `\${secret:${pointer}}`
  return /\s$/.test(current) ? current + reference : reference
}

/**
 * A password box that can also take a saved credential - for the secret fields that are not a
 * `SecretField` (DevOps tokens, S3 keys, the AutoSys gateway, Python variables). Outside Fire Code it is
 * exactly the password box it replaces.
 */
export function SecretInput(props: {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  style?: CSSProperties
  ariaLabel?: string
}): ReactElement {
  if (isCredentialPointer(props.value)) {
    return <CredentialInUse pointer={props.value} onClear={() => props.onChange('')} />
  }
  return (
    <>
      <input
        {...(props.id !== undefined ? { id: props.id } : {})}
        type="password"
        value={props.value}
        autoComplete="off"
        spellCheck={false}
        {...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}
        {...(props.ariaLabel !== undefined ? { 'aria-label': props.ariaLabel } : {})}
        onChange={(event) => props.onChange(event.target.value)}
        style={props.style ?? textFieldStyle()}
      />
      <CredentialPicker onPick={props.onChange} />
    </>
  )
}
