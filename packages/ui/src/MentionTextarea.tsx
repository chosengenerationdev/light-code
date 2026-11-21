import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type Ref } from 'react'

import type { HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'

import { activeMentionQuery, insertMention, opensInside, splitMentions } from './mentions.js'
import { colors, fontFamily, monospaceFamily, textFieldStyle } from './theme.js'

/**
 * A text box where `@` opens the workspace file picker, as in the chat's message box - for text that is sent to
 * an agent later (a strategy step's instructions), where naming a file should attach it then. Asks the host for
 * candidates itself and listens for its own answer, so it works wherever there is a transport: over the chat
 * panel and in the Strategy window's own editor tab.
 *
 * The files mentioned are listed under the box as chips - the composer's way of making attachments countable
 * at a glance, since a mention is the same colour as the sentence around it.
 */
export interface MentionTextareaProps {
  transport: Transport
  value: string
  onChange: (value: string) => void
  id?: string
  rows?: number
  maxLength?: number
  placeholder?: string
  ariaLabel?: string
  inputRef?: Ref<HTMLTextAreaElement>
  style?: CSSProperties
}

export function MentionTextarea(props: MentionTextareaProps): ReactElement {
  const { transport } = props
  const [query, setQuery] = useState<string | undefined>(undefined)
  const [candidates, setCandidates] = useState<string[]>([])
  const [answeredFor, setAnsweredFor] = useState<string | undefined>(undefined)
  const [highlighted, setHighlighted] = useState(0)
  const box = useRef<HTMLTextAreaElement | null>(null)
  const latest = useRef<string | undefined>(undefined)

  useEffect(
    () =>
      transport.onMessage((raw) => {
        const message = raw as HostToUiMessage
        if (message.type !== 'mentionCandidates') return
        // Only the answer to this box's latest question: the chat's own box asks over the same transport.
        if (latest.current === undefined || message.query !== latest.current) return
        setCandidates(message.paths)
        setAnsweredFor(message.query)
        setHighlighted(0)
      }),
    [transport],
  )

  useEffect(() => {
    if (query === undefined) return
    // Debounced like the composer: a file search over a large repository is not free, and every keystroke changes the query.
    const timer = setTimeout(() => {
      latest.current = query
      transport.post({ type: 'requestMentionCandidates', query } satisfies UiToHostMessage)
    }, 120)
    return () => clearTimeout(timer)
  }, [query, transport])

  const showing = query !== undefined && answeredFor === query && candidates.length > 0
  const nothing = query !== undefined && query.length > 0 && answeredFor === query && candidates.length === 0

  const sync = (value: string, caret: number): void => {
    const next = activeMentionQuery(value, caret)
    setQuery(next)
    if (next === undefined) latest.current = undefined
  }

  const choose = (candidate: string): void => {
    const textarea = box.current
    const caret = textarea?.selectionStart ?? props.value.length
    const inserted = insertMention(props.value, caret, candidate)
    if (inserted === undefined) return
    props.onChange(inserted.text)
    setQuery(opensInside(candidate) ? candidate : undefined)
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }

  const mentioned = [...new Set(splitMentions(props.value).filter((segment) => segment.isMention).map((segment) => segment.text.replace(/^@"?|"$/g, '')))]

  return (
    <div style={{ position: 'relative' }}>
      <textarea
        id={props.id}
        aria-label={props.ariaLabel}
        ref={(element) => {
          box.current = element
          const ref = props.inputRef
          if (typeof ref === 'function') ref(element)
          else if (ref !== null && ref !== undefined) (ref as { current: HTMLTextAreaElement | null }).current = element
        }}
        value={props.value}
        rows={props.rows ?? 6}
        maxLength={props.maxLength}
        placeholder={props.placeholder}
        onChange={(event) => {
          props.onChange(event.target.value)
          sync(event.target.value, event.target.selectionStart)
        }}
        onClick={(event) => sync(event.currentTarget.value, event.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setQuery(undefined), 150)}
        onKeyDown={(event) => {
          if (!showing) {
            if (event.key === 'Escape' && query !== undefined) {
              event.stopPropagation()
              setQuery(undefined)
            }
            return
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setHighlighted((current) => (current + 1) % candidates.length)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setHighlighted((current) => (current - 1 + candidates.length) % candidates.length)
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            // Enter would otherwise put a newline mid-mention and leave a broken path behind.
            event.preventDefault()
            const candidate = candidates[highlighted]
            if (candidate !== undefined) choose(candidate)
          } else if (event.key === 'Escape') {
            // The picker closes; the window around it stays open.
            event.preventDefault()
            event.stopPropagation()
            setQuery(undefined)
          }
        }}
        style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily, ...props.style }}
      />
      {showing ? (
        <div
          role="listbox"
          aria-label="Workspace files"
          className="lc-scroll"
          style={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${colors.accent}`, borderRadius: 8, marginTop: 2, background: colors.background }}
        >
          {candidates.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              // mousedown, not click: click fires after blur, which closes the list first.
              onMouseDown={(event) => {
                event.preventDefault()
                choose(candidate)
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '4px 8px',
                background: index === highlighted ? colors.accent : 'transparent',
                border: 'none',
                color: index === highlighted ? colors.accentContrast : colors.foreground,
                cursor: 'pointer',
                fontFamily: monospaceFamily,
                fontSize: 11,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {candidate}
            </button>
          ))}
        </div>
      ) : nothing ? (
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>No file or folder matches "{query}".</div>
      ) : null}
      {mentioned.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }} aria-label="Files attached when it is sent">
          {mentioned.map((path) => (
            <span
              key={path}
              title={`Attached when this is sent: ${path}`}
              style={{ fontFamily: monospaceFamily, fontSize: 10, padding: '1px 6px', borderRadius: 999, border: `1px solid ${colors.accent}`, color: colors.accent, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              @{path}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
