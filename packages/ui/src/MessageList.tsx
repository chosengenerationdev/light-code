import type { ToolCallSummary, TranscriptEntry } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { AgentIcon, CheckIcon, CrossIcon, ExpertIcon, SpinnerIcon, UserIcon } from './icons.js'
import { colors, fontFamily } from './theme.js'

/**
 * A `TranscriptEntry` plus the one piece of state that only exists live. Defined as an
 * extension of the shared protocol type rather than a parallel shape, so a restored task
 * renders through exactly the same path as a streaming one.
 */
export type DisplayMessage =
  | (Extract<TranscriptEntry, { kind: 'text' }> & {
      /** True while an assistant message is still streaming in. */
      pending?: boolean
    })
  | (Extract<TranscriptEntry, { kind: 'reasoning' }> & { pending?: boolean })
  | Extract<TranscriptEntry, { kind: 'tool' }>

export interface MessageListProps {
  messages: DisplayMessage[]
  error: string | undefined
}

function TextBlock(props: { role: 'user' | 'assistant'; content: string; expertInformed?: boolean | undefined }): ReactElement {
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
      {/* Icon rather than a repeated "Assistant" / "You" label: the same two words on every
          message are noise once you know the layout. The word survives as the tooltip. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: colors.muted, marginBottom: 4, fontFamily }}>
        <span title={isAssistant ? 'Assistant' : 'You'} aria-label={isAssistant ? 'Assistant' : 'You'} style={{ display: 'flex' }}>
          {isAssistant ? <AgentIcon /> : <UserIcon />}
        </span>
        {props.expertInformed === true && (
          <span
            title="Informed by an expert consultation"
            aria-label="Informed by an expert consultation"
            style={{ display: 'flex', color: colors.focusBorder }}
          >
            <ExpertIcon size={12} />
          </span>
        )}
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
function ToolBlock(props: { toolCall: ToolCallSummary; expertInformed?: boolean | undefined }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const { toolCall } = props
  const pending = toolCall.result === undefined
  const isConsultation = toolCall.name === 'ask_expert'

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
        {/* The consultation itself gets the expert mark; work that merely followed one gets
            it in a quieter position, so the two are distinguishable. */}
        {isConsultation && (
          <span title="Expert consultation" aria-label="Expert consultation" style={{ display: 'flex', color: colors.focusBorder }}>
            <ExpertIcon />
          </span>
        )}
        <span style={{ fontFamily: monospace }}>{toolCall.name}</span>
        {!isConsultation && props.expertInformed === true && (
          <span
            title="Following expert advice"
            aria-label="Following expert advice"
            style={{ display: 'flex', color: colors.focusBorder }}
          >
            <ExpertIcon size={12} />
          </span>
        )}
        {/* Status as an icon; the word is the tooltip. */}
        <span
          title={pending ? 'Running' : toolCall.isError === true ? 'Failed' : 'Done'}
          aria-label={pending ? 'Running' : toolCall.isError === true ? 'Failed' : 'Done'}
          style={{
            display: 'flex',
            marginLeft: 'auto',
            color: toolCall.isError === true ? colors.error : pending ? colors.muted : 'var(--vscode-testing-iconPassed, #3fb950)',
          }}
        >
          {pending ? <SpinnerIcon /> : toolCall.isError === true ? <CrossIcon /> : <CheckIcon />}
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

/**
 * The model's own reasoning, where the provider exposes it: DeepSeek's `reasoning_content`,
 * Anthropic's `thinking`, Gemini's thought parts.
 *
 * Collapsed by default and visually quieter than the answer, because it is working-out
 * rather than output — useful when you want to know *why* it did something, noise when you
 * do not. Expanding is sticky per block, so a long trace does not force scrolling past it.
 */
function ReasoningBlock(props: { content: string; pending?: boolean | undefined }): ReactElement {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{ margin: '4px 8px' }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          border: 'none',
          color: colors.muted,
          cursor: 'pointer',
          padding: '2px 0',
          fontFamily,
          fontSize: 11,
          fontStyle: 'italic',
        }}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span>{props.pending === true ? 'Thinking…' : 'Thought process'}</span>
      </button>
      {expanded && (
        <pre
          style={{
            margin: '2px 0 0 14px',
            padding: 8,
            borderLeft: `2px solid ${colors.border}`,
            color: colors.muted,
            fontFamily: monospace,
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {props.content}
        </pre>
      )}
    </div>
  )
}

export function MessageList(props: MessageListProps): ReactElement {
  return (
    <div role="log" aria-live="polite">
      {props.messages.map((message, index) =>
        message.kind === 'tool' ? (
          <ToolBlock key={index} toolCall={message.toolCall} expertInformed={message.expertInformed} />
        ) : message.kind === 'reasoning' ? (
          <ReasoningBlock key={index} content={message.content} pending={message.pending} />
        ) : (
          <TextBlock key={index} role={message.role} content={message.content} expertInformed={message.expertInformed} />
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
