import type { ToolCallSummary, TranscriptEntry } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { AgentIcon, CheckIcon, ChevronIcon, CrossIcon, ExpertIcon, SpinnerIcon, UserIcon } from './icons.js'
import { MarkdownView } from './MarkdownView.js'
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

/**
 * A chat bubble, sided like a messaging app: the assistant on the left, you on the right.
 *
 * The side does the work the old "Assistant" / "You" labels did, which is why there is no
 * label — who said what is legible from across the room. The avatar stays because a wall of
 * bubbles with no anchor is harder to skim than it looks, and it carries the expert marker.
 *
 * `maxWidth: 85%` is what makes it read as a conversation rather than as full-width blocks
 * with a tint; a bubble that spans the pane has no side.
 */
function TextBlock(props: {
  role: 'user' | 'assistant'
  content: string
  expertInformed?: boolean | undefined
  /** Marks the newest user message, so Chat can tell whether it is still on screen. */
  isLatestPrompt?: boolean
}): ReactElement {
  const isAssistant = props.role === 'assistant'

  const avatar = (
    <span
      title={isAssistant ? 'Assistant' : 'You'}
      aria-label={isAssistant ? 'Assistant' : 'You'}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: '50%',
        flexShrink: 0,
        marginTop: 2,
        // The assistant wears the accent; you get the editor's own surface. Reinforces the
        // side rather than competing with it.
        background: isAssistant ? colors.accentGradient : colors.secondaryButtonBackground,
        color: isAssistant ? colors.accentContrast : colors.muted,
        border: isAssistant ? 'none' : `1px solid ${colors.border}`,
      }}
    >
      {isAssistant ? <AgentIcon size={12} /> : <UserIcon size={12} />}
    </span>
  )

  return (
    <div
      className={isAssistant ? 'lc-in-left' : 'lc-in-right'}
      {...(props.isLatestPrompt === true ? { 'data-lc-latest-prompt': 'true' } : {})}
      style={{
        display: 'flex',
        gap: 8,
        margin: '8px 10px',
        // Reversed for you, so the avatar sits on the outside on both sides.
        flexDirection: isAssistant ? 'row' : 'row-reverse',
        alignItems: 'flex-start',
      }}
    >
      {avatar}
      <div
        className="lc-bubble"
        style={{
          maxWidth: '85%',
          padding: '8px 12px',
          background: isAssistant ? colors.assistantBubble : colors.accentGradient,
          color: isAssistant ? colors.foreground : colors.accentContrast,
          // The squared-off corner points at the speaker — the tail, without drawing one.
          borderRadius: isAssistant ? '14px 14px 14px 4px' : '14px 14px 4px 14px',
          boxShadow: isAssistant ? 'none' : `0 1px 8px ${colors.accentRing}`,
          /*
           * Only the user's side keeps `pre-wrap`. An assistant reply is rendered markdown, and
           * each block sets its own spacing — leaving it here would double every blank line.
           */
          ...(isAssistant ? {} : { whiteSpace: 'pre-wrap' as const }),
          wordBreak: 'break-word',
          fontFamily,
        }}
      >
        {/*
          * A marker, not a costume. These are the *primary* model's words, written after it
          * consulted the expert — so the message keeps its own bubble and gains a small
          * attribution line. Painting it in Claude's colour would claim Claude wrote it.
          */}
        {props.expertInformed === true && (
          <span
            title="Written after consulting the expert. These are not Claude's words — expand the ask_expert block above for those."
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginBottom: 5,
              fontSize: 10,
              letterSpacing: 0.2,
              padding: '1px 6px 1px 4px',
              borderRadius: 8,
              background: isAssistant ? colors.expertSoft : 'rgba(255, 255, 255, 0.18)',
              color: isAssistant ? colors.expert : colors.accentContrast,
            }}
          >
            <ExpertIcon size={11} />
            informed by expert
          </span>
        )}
        {/*
          * Rendered for the assistant, left alone for you.
          *
          * Formatting what the user typed would be surprising: they can see their own message
          * and did not ask for their asterisks to disappear. The model, on the other hand,
          * writes markdown whether or not anything renders it.
          */}
        {isAssistant ? <MarkdownView text={props.content} /> : props.content}
      </div>
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

  /*
   * A consultation is the one block whose *result* is another model's words, so it is the one
   * block that gets the expert's colour rather than Light Code's. Everything else here —
   * including a tool call that merely followed the expert's advice — stays neutral, because
   * dressing the primary model's own work in Claude's colour would misattribute it.
   */
  const edge = toolCall.isError === true ? colors.error : isConsultation ? colors.expert : colors.border

  return (
    <div
      className="lc-in-left"
      style={{
        // Indented to the width of an avatar plus its gap, so tool activity lines up under
        // the assistant's bubbles rather than starting a third column.
        margin: '6px 10px 6px 40px',
        borderRadius: 10,
        border: `1px solid ${edge}`,
        background: isConsultation
          ? colors.expertSoft
          : pending
            ? colors.accentSoft
            : 'transparent',
        ...(isConsultation ? { boxShadow: `0 0 0 3px ${colors.expertSoft}` } : {}),
        overflow: 'hidden',
        transition: 'background-color 190ms ease',
      }}
    >
      <button
        type="button"
        className="lc-btn"
        aria-expanded={expanded}
        title={expanded ? 'Hide details' : 'Show details'}
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
        <span
          style={{
            display: 'flex',
            color: colors.muted,
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 190ms cubic-bezier(0.22, 0.85, 0.28, 1)',
          }}
        >
          <ChevronIcon />
        </span>
        {/* The consultation itself gets the expert mark; work that merely followed one gets
            it in a quieter position, so the two are distinguishable. */}
        {isConsultation && (
          <span
            title="Expert consultation — answered by Claude"
            aria-label="Expert consultation, answered by Claude"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              borderRadius: '50%',
              flexShrink: 0,
              background: colors.expertGradient,
              color: colors.expertContrast,
            }}
          >
            <ExpertIcon size={11} />
          </span>
        )}
        <span style={{ fontFamily: monospace, color: isConsultation ? colors.expert : undefined }}>{toolCall.name}</span>
        {/*
          What the call is for, beside the name.

          A bare tool name says what happened and nothing about why, and most models emit no
          assistant text alongside a call - so the transcript read as a list of verbs. This is the
          model's own stated reason, shown in the collapsed row where it is actually useful.

          Truncated rather than wrapped: the row is a heading, and a model that writes a paragraph
          here should not push the status icon off the end. The full text is the title.
        */}
        {toolCall.why !== undefined && (
          <span
            title={toolCall.why}
            style={{
              color: colors.muted,
              fontFamily,
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {toolCall.why}
          </span>
        )}
        {!isConsultation && props.expertInformed === true && (
          <span
            title="Following expert advice"
            aria-label="Following expert advice"
            style={{ display: 'flex', color: colors.expert }}
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
              <div style={{ color: isConsultation ? colors.expert : colors.muted, marginBottom: 2 }}>
                {isConsultation ? "Claude's answer" : 'Result'}
              </div>
              <pre
                className={isConsultation ? 'lc-scroll' : undefined}
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 300,
                  overflowY: 'auto',
                  // The one pane in the product containing another model's prose verbatim, so
                  // it is ruled off in that model's colour rather than left looking like ours.
                  ...(isConsultation
                    ? {
                        borderLeft: `2px solid ${colors.expert}`,
                        paddingLeft: 8,
                        fontFamily: fontFamily,
                        fontSize: 12,
                      }
                    : {}),
                }}
              >
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
    <div className="lc-in-left" style={{ margin: '4px 10px 4px 40px' }}>
      <button
        type="button"
        className="lc-btn"
        aria-expanded={expanded}
        title={expanded ? 'Hide the reasoning' : 'Show the reasoning'}
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          border: 'none',
          borderRadius: 6,
          color: colors.muted,
          cursor: 'pointer',
          padding: '2px 6px 2px 2px',
          fontFamily,
          fontSize: 11,
          fontStyle: 'italic',
        }}
      >
        <span
          style={{
            display: 'flex',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 190ms cubic-bezier(0.22, 0.85, 0.28, 1)',
          }}
        >
          <ChevronIcon />
        </span>
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
  /*
   * The newest user message, marked so `Chat` can observe whether it has scrolled away. Found
   * by index rather than by a flag on the message, because `DisplayMessage` is the shared
   * transcript shape and a rendering concern has no business in it.
   */
  let latestPromptIndex = -1
  for (let index = props.messages.length - 1; index >= 0; index--) {
    const message = props.messages[index]
    if (message?.kind === 'text' && message.role === 'user') {
      latestPromptIndex = index
      break
    }
  }

  return (
    <div role="log" aria-live="polite">
      {props.messages.map((message, index) =>
        message.kind === 'tool' ? (
          <ToolBlock key={index} toolCall={message.toolCall} expertInformed={message.expertInformed} />
        ) : message.kind === 'reasoning' ? (
          <ReasoningBlock key={index} content={message.content} pending={message.pending} />
        ) : (
          <TextBlock
            key={index}
            role={message.role}
            content={message.content}
            expertInformed={message.expertInformed}
            isLatestPrompt={index === latestPromptIndex}
          />
        ),
      )}
      {props.error !== undefined && (
        <div
          role="alert"
          className="lc-fade-up"
          style={{
            padding: '8px 12px',
            margin: '6px 10px 6px 40px',
            borderRadius: 10,
            border: `1px solid ${colors.error}`,
            color: colors.error,
            fontFamily,
            fontSize: 12,
          }}
        >
          {props.error}
        </div>
      )}
    </div>
  )
}
