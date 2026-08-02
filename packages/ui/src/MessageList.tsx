import type { ToolCallSummary } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { colors, fontFamily } from './theme.js'

export type DisplayMessage =
  | {
      kind: 'text'
      role: 'user' | 'assistant'
      content: string
      /** True while an assistant message is still streaming in. */
      pending?: boolean
    }
  | { kind: 'tool'; toolCall: ToolCallSummary }

export interface MessageListProps {
  messages: DisplayMessage[]
  error: string | undefined
}

function TextBlock(props: { role: 'user' | 'assistant'; content: string }): ReactElement {
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

const monospace = 'var(--vscode-editor-font-family, monospace)'

/**
 * Shows the literal tool name, arguments, and result — ground truth, never the model's
 * description of what it intends to do (invariant 8). Collapsed by default to keep the
 * transcript readable; this is a visibility surface, not the Phase 4 approval gate.
 */
function ToolBlock(props: { toolCall: ToolCallSummary }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const { toolCall } = props
  const pending = toolCall.result === undefined

  return (
    <div
      style={{
        margin: '6px 8px',
        borderRadius: 4,
        border: `1px solid ${toolCall.isError === true ? colors.error : colors.border}`,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '6px 10px',
          background: 'transparent',
          border: 'none',
          color: colors.foreground,
          cursor: 'pointer',
          fontFamily,
          fontSize: 12,
          textAlign: 'left',
        }}
      >
        <span style={{ color: colors.muted }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ fontFamily: monospace }}>{toolCall.name}</span>
        <span style={{ color: toolCall.isError === true ? colors.error : colors.muted, marginLeft: 'auto' }}>
          {pending ? 'running…' : toolCall.isError === true ? 'failed' : 'done'}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: '0 10px 8px', fontSize: 12, fontFamily: monospace }}>
          <div style={{ color: colors.muted, marginBottom: 2 }}>Arguments</div>
          <pre style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{toolCall.arguments}</pre>
          {toolCall.result !== undefined && (
            <>
              <div style={{ color: colors.muted, marginBottom: 2 }}>Result</div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflowY: 'auto' }}>
                {toolCall.result}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function MessageList(props: MessageListProps): ReactElement {
  return (
    <div role="log" aria-live="polite">
      {props.messages.map((message, index) =>
        message.kind === 'tool' ? (
          <ToolBlock key={index} toolCall={message.toolCall} />
        ) : (
          <TextBlock key={index} role={message.role} content={message.content} />
        ),
      )}
      {props.error !== undefined && (
        <div role="alert" style={{ padding: '8px 12px', margin: '6px 8px', color: colors.error }}>
          Error: {props.error}
        </div>
      )}
    </div>
  )
}
