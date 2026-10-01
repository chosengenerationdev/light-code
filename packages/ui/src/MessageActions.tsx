import { clipQuote, reactionLabel, type MessageQuote, type Reaction } from '@light-code/core/browser'
import type { ReactElement, RefObject } from 'react'
import { colors, fontFamily } from './theme.js'

/**
 * Replying to, and reacting to, something the assistant said.
 *
 * Everything here ends up as words in the user's next turn (`agent/feedback.ts` in core says why
 * and writes them). This file only decides *what* was pointed at and shows what is waiting to go.
 */

/** What the message list needs to offer the actions. Absent, the list renders without them. */
export interface MessageFeedback {
  /** Reactions given in this conversation, by message key. */
  reactions: Record<string, Reaction>
  /** Keys whose reaction has not reached the assistant yet. Only those can be taken back. */
  pendingKeys: ReadonlySet<string>
  onReply: (quote: MessageQuote) => void
  onReact: (key: string, reaction: Reaction | undefined, quote: MessageQuote) => void
}

const REACTIONS: { reaction: Reaction; emoji: string }[] = [
  { reaction: 'up', emoji: '👍' },
  { reaction: 'down', emoji: '👎' },
  { reaction: 'focus', emoji: '🎯' },
]

/**
 * The selected text, when the selection lies inside this message; otherwise the whole message.
 *
 * Pointing at one sentence of a long reply is the case that makes this worth having — "this
 * part is wrong" about a whole answer leaves the model guessing which part.
 */
export function quoteFrom(container: HTMLElement | null, whole: string, source: MessageQuote['source']): MessageQuote {
  const selection = typeof window === 'undefined' ? null : window.getSelection()
  const selected = selection?.toString() ?? ''
  const inside =
    container !== null &&
    selection !== null &&
    selection.anchorNode !== null &&
    selected.trim().length > 0 &&
    container.contains(selection.anchorNode)
  return { excerpt: clipQuote(inside ? selected : whole), source }
}

const actionStyle = (active: boolean): React.CSSProperties => ({
  background: active ? colors.accentSoft : 'transparent',
  border: `1px solid ${active ? colors.accent : 'transparent'}`,
  borderRadius: 10,
  color: colors.muted,
  cursor: 'pointer',
  fontFamily,
  fontSize: 11,
  lineHeight: 1,
  padding: '3px 6px',
})

export function MessageActions(props: {
  messageKey: string
  content: string
  source: MessageQuote['source']
  /** The element holding the message, so a selection inside it can be quoted. */
  containerRef: RefObject<HTMLElement | null>
  feedback: MessageFeedback
}): ReactElement {
  const current = props.feedback.reactions[props.messageKey]
  const pending = props.feedback.pendingKeys.has(props.messageKey)
  const quote = (): MessageQuote => quoteFrom(props.containerRef.current, props.content, props.source)
  const what = props.source === 'reasoning' ? 'this thinking' : 'this reply'

  return (
    <div
      className="lc-message-actions"
      style={{ display: 'flex', gap: 2, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}
      // Keeps a text selection alive through the click, so "select a sentence, press Reply" works.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="lc-btn"
        title={`Reply to ${what} — select part of it first to quote just that part`}
        aria-label={`Reply to ${what}`}
        style={actionStyle(false)}
        onClick={() => props.feedback.onReply(quote())}
      >
        ↩ Reply
      </button>
      {REACTIONS.map(({ reaction, emoji }) => {
        const active = current === reaction
        // A delivered reaction is part of the conversation now; taking it back would only change
        // the button, not what the assistant was told.
        const locked = current !== undefined && !pending
        return (
          <button
            key={reaction}
            type="button"
            className="lc-btn"
            aria-pressed={active}
            disabled={locked && !active}
            title={
              locked
                ? active
                  ? `${reactionLabel(reaction)} — sent to the assistant`
                  : 'A reaction on this was already sent'
                : `${reactionLabel(reaction)}${props.source === 'reasoning' ? ' (about this thinking)' : ''}. Reaches the assistant with your next message, or at its next step if it is working.`
            }
            aria-label={reactionLabel(reaction)}
            style={{ ...actionStyle(active), opacity: locked && !active ? 0.4 : 1 }}
            onClick={() => {
              if (locked) return
              props.feedback.onReact(props.messageKey, active ? undefined : reaction, quote())
            }}
          >
            {emoji}
          </button>
        )
      })}
    </div>
  )
}

/** Above the composer: what the next message will point at, and reactions still to be sent. */
export function FeedbackBanner(props: {
  replyTo: MessageQuote | undefined
  onClearReply: () => void
  pendingCount: number
  isStreaming: boolean
}): ReactElement | null {
  if (props.replyTo === undefined && props.pendingCount === 0) return null
  return (
    <div style={{ padding: '6px 10px 0', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
      {props.replyTo !== undefined && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'flex-start',
            color: colors.muted,
            borderLeft: `2px solid ${colors.accent}`,
            paddingLeft: 6,
          }}
        >
          <span style={{ flex: 1, wordBreak: 'break-word' }}>
            <strong style={{ color: colors.foreground }}>
              ↩ Replying to {props.replyTo.source === 'reasoning' ? 'its thinking' : 'its reply'}:
            </strong>{' '}
            {clipQuote(props.replyTo.excerpt, 160)}
          </span>
          <button
            type="button"
            title="Stop replying to this"
            aria-label="Stop replying to this"
            onClick={props.onClearReply}
            style={{ background: 'transparent', border: 'none', color: colors.muted, cursor: 'pointer', padding: 0 }}
          >
            ×
          </button>
        </div>
      )}
      {props.pendingCount > 0 && (
        <div role="status" style={{ color: colors.muted }}>
          {props.pendingCount} reaction{props.pendingCount === 1 ? '' : 's'} will reach the assistant{' '}
          {props.isStreaming ? 'at its next step' : 'with your next message'}.
        </div>
      )}
    </div>
  )
}
