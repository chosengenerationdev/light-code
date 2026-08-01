import { useState, type ReactElement } from 'react'
import { SendIcon, StopIcon } from './icons.js'
import { colors, fontFamily, iconButtonStyle } from './theme.js'

export interface ComposerProps {
  isStreaming: boolean
  onSend: (text: string) => void
  onCancel: () => void
}

export function Composer(props: ComposerProps): ReactElement {
  const [text, setText] = useState('')

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    props.onSend(trimmed)
    setText('')
  }

  const canSend = text.trim().length > 0 && !props.isStreaming

  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'flex-end',
        padding: 8,
        borderTop: `1px solid ${colors.border}`,
        flexShrink: 0,
      }}
    >
      <textarea
        value={text}
        disabled={props.isStreaming}
        rows={2}
        placeholder="Message Light Code..."
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
        style={{
          flex: 1,
          resize: 'vertical',
          background: colors.inputBackground,
          color: colors.inputForeground,
          border: `1px solid ${colors.inputBorder}`,
          borderRadius: 2,
          padding: '6px 8px',
          fontFamily,
          fontSize: 13,
        }}
      />
      {props.isStreaming ? (
        <button type="button" title="Cancel" aria-label="Cancel" style={iconButtonStyle('secondary')} onClick={props.onCancel}>
          <StopIcon />
        </button>
      ) : (
        <button
          type="button"
          title="Send"
          aria-label="Send"
          style={iconButtonStyle('primary', !canSend)}
          disabled={!canSend}
          onClick={submit}
        >
          <SendIcon />
        </button>
      )}
    </div>
  )
}
