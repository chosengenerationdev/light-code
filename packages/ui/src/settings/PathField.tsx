import type { ReactElement } from 'react'
import { colors, fieldErrorStyle, labelStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

/**
 * How a path field asks for a native picker.
 *
 * A webview cannot open one, so this goes to the host and the answer comes back keyed by
 * `purpose`. Threading a callback through every settings component instead would mean each
 * one owning its own request/response plumbing for the same dialog.
 */
export interface BrowseRequest {
  purpose: string
  kind: 'file' | 'folder'
  extensions?: string[]
}

export interface PathFieldProps {
  id: string
  label: string
  value: string
  placeholder?: string
  hint?: string
  error?: string
  /** Omit to render a plain text field with no Browse button. */
  browse?: BrowseRequest
  onBrowse?: (request: BrowseRequest) => void
  onChange: (value: string) => void
  /** Extra control rendered beside Browse, e.g. Detect. */
  children?: React.ReactNode
}

/**
 * A path input with a Browse button.
 *
 * The text field stays editable rather than being replaced by the picker: a path can be on
 * a UNC share, inside a container, or simply already on the clipboard, and a
 * picker-only field would make those impossible to enter.
 */
export function PathField(props: PathFieldProps): ReactElement {
  const browse = props.browse
  return (
    <div style={{ marginBottom: 10 }}>
      <label htmlFor={props.id} style={labelStyle()}>
        {props.label}
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          id={props.id}
          type="text"
          value={props.value}
          spellCheck={false}
          placeholder={props.placeholder ?? ''}
          onChange={(event) => props.onChange(event.target.value)}
          style={{
            ...textFieldStyle(),
            fontFamily: monospace,
            ...(props.error !== undefined ? { borderColor: colors.error } : {}),
          }}
        />
        {browse !== undefined && props.onBrowse !== undefined && (
          <button
            type="button"
            style={secondaryButtonStyle()}
            title={browse.kind === 'folder' ? 'Choose a folder' : 'Choose a file'}
            onClick={() => props.onBrowse?.(browse)}
          >
            Browse
          </button>
        )}
        {props.children}
      </div>
      {props.error !== undefined ? (
        <span style={fieldErrorStyle()}>{props.error}</span>
      ) : (
        props.hint !== undefined && (
          <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>{props.hint}</span>
        )
      )}
    </div>
  )
}
