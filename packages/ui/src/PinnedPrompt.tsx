import type { ReactElement } from 'react'
import { UserIcon } from './icons.js'
import { colors, fontFamily } from './theme.js'

export interface PinnedPromptProps {
  text: string
  /** Scrolls the real message back into view, so the pin is a way back rather than a dead end. */
  onReveal: () => void
}

/**
 * The question you asked, kept in view while you read the answer.
 *
 * A long reply pushes the prompt off the top of a narrow sidebar within a few lines, and from
 * then on the transcript is an answer to something you have to scroll up to recall. Pinning it
 * costs one line and removes that entirely.
 *
 * **Shown only once the real message has scrolled out of view** — see `Chat.tsx`. Rendering it
 * unconditionally would print the same sentence twice whenever the conversation is short
 * enough to fit, which is most of them.
 *
 * Clamped to two lines rather than truncated to one: a pasted stack trace should not occupy
 * half the panel, but a two-sentence question is common and reads badly cut off mid-word.
 */
export function PinnedPrompt(props: PinnedPromptProps): ReactElement {
  return (
    <button
      type="button"
      onClick={props.onReveal}
      title="Scroll back to this message"
      aria-label={`Your message: ${props.text}. Scroll back to it.`}
      className="lc-fade-up"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        border: 'none',
        borderBottom: `1px solid ${colors.border}`,
        // Deliberately not the accent gradient the real bubble uses. This is a reference to a
        // message, not the message — dressing it identically would read as a duplicate.
        background: colors.background,
        color: colors.muted,
        cursor: 'pointer',
        fontFamily,
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          borderRadius: '50%',
          flexShrink: 0,
          marginTop: 1,
          background: colors.accentSoft,
          color: colors.accent,
        }}
      >
        <UserIcon size={10} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          // Two lines, then an ellipsis. `-webkit-line-clamp` is the only thing that does this
          // without measuring text, and the webview is Chromium.
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {props.text}
      </span>
    </button>
  )
}
