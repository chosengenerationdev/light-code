import type { ReactElement } from 'react'
import { colors, fontFamily } from './theme.js'

export interface DisplayMessage {
  role: 'user' | 'assistant'
  content: string
  /** True while an assistant message is still streaming in. */
  pending?: boolean
}

export interface MessageListProps {
  messages: DisplayMessage[]
  error: string | undefined
}

function MessageBlock(props: { role: DisplayMessage['role']; content: string }): ReactElement {
  const isAssistant = props.role === 'assistant'
  return (
    <div
      style={{
        padding: '8px 12px',
        margin: '6px 8px',
        borderRadius: 4,
        background: isAssistant ? colors.assistantBubble : 'transparent',
        border: isAssistant ? 'none' : `1px solid ${colors.border}`,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      <div style={{ color: colors.muted, fontSize: 11, marginBottom: 4, fontFamily }}>
        {isAssistant ? 'Assistant' : 'You'}
      </div>
      {props.content}
    </div>
  )
}

export function MessageList(props: MessageListProps): ReactElement {
  return (
    <div role="log" aria-live="polite">
      {props.messages.map((message, index) => (
        <MessageBlock key={index} role={message.role} content={message.content} />
      ))}
      {props.error !== undefined && (
        <div role="alert" style={{ padding: '8px 12px', margin: '6px 8px', color: colors.error }}>
          Error: {props.error}
        </div>
      )}
    </div>
  )
}
