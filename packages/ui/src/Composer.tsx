import type { ImageAttachmentInput, ProfileSummary } from '@light-code/core/browser'
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type ReactElement } from 'react'
import { AttachIcon, ExpertIcon, SendIcon, StopIcon } from './icons.js'
import { badgeStyle, colors, fontFamily, iconButtonStyle, optionStyle, selectStyle } from './theme.js'

export interface ComposerProps {
  isStreaming: boolean
  onSend: (text: string, images: ImageAttachmentInput[]) => void
  onCancel: () => void
  /** Hides attachment entirely when the active model has no vision support (§9). */
  supportsVision: boolean
  /** Paths matching the current `@` query, supplied by the host. */
  mentionCandidates: string[]
  onQueryMentions: (query: string) => void
  /** Shown as a selector under the input, so the answering model is switchable in place. */
  profiles: ProfileSummary[]
  activeProfileId: string | undefined
  onSelectProfile: (id: string) => void
  /** Whether the Claude CLI expert is configured and runnable. */
  expertEnabled: boolean
}

/** Beyond this the request usually fails on the provider side, so refuse it here instead. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Reads a File into the bare base64 the protocol expects, without the data: prefix. */
async function toAttachment(file: File): Promise<ImageAttachmentInput | undefined> {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) return undefined
  if (file.size > MAX_IMAGE_BYTES) return undefined

  const buffer = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  // Chunked: spreading a multi-megabyte array into String.fromCharCode overflows the stack.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return { mediaType: file.type, data: btoa(binary), name: file.name || 'pasted image' }
}

/** The `@` token the caret currently sits in, or undefined when it is not in one. */
function activeMentionQuery(text: string, caret: number): string | undefined {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return undefined
  const token = before.slice(at + 1)
  // A space closes the mention; so does a second @.
  if (/[\s@]/.test(token)) return undefined
  return token
}

export function Composer(props: ComposerProps): ReactElement {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageAttachmentInput[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | undefined>(undefined)
  const [highlighted, setHighlighted] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /** Grows the box to fit the text, capped, so the send button never drifts out of line. */
  const resize = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }
  const fileInputRef = useRef<HTMLInputElement>(null)

  const showingMentions = mentionQuery !== undefined && props.mentionCandidates.length > 0

  // Held in a ref so the effect below depends only on the query. Depending on the callback
  // itself would fire a workspace lookup on every parent render, which is most keystrokes.
  const queryMentionsRef = useRef(props.onQueryMentions)
  queryMentionsRef.current = props.onQueryMentions

  useEffect(() => {
    if (mentionQuery === undefined) return
    // Debounced: `findFiles` over a large repository is not free, and the query changes on
    // every keystroke inside a mention.
    const timer = setTimeout(() => queryMentionsRef.current(mentionQuery), 120)
    return () => clearTimeout(timer)
  }, [mentionQuery])

  const syncMentionQuery = (value: string, caret: number): void => {
    const query = activeMentionQuery(value, caret)
    setMentionQuery(query)
    setHighlighted(0)
  }

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const accepted: ImageAttachmentInput[] = []
    let rejected = 0
    for (const file of Array.from(files)) {
      const attachment = await toAttachment(file)
      if (attachment === undefined) rejected += 1
      else accepted.push(attachment)
    }
    if (accepted.length > 0) setImages((previous) => [...previous, ...accepted])
    setNotice(
      rejected > 0
        ? `${rejected} file(s) skipped — images only (PNG, JPEG, WebP, GIF) up to 5MB.`
        : undefined,
    )
  }

  const insertMention = (candidatePath: string): void => {
    const textarea = textareaRef.current
    const caret = textarea?.selectionStart ?? text.length
    const before = text.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at === -1) return

    // Quote paths with spaces so the resolver reads them as one target.
    const rendered = candidatePath.includes(' ') ? `@"${candidatePath}"` : `@${candidatePath}`
    const next = `${text.slice(0, at)}${rendered} ${text.slice(caret)}`
    setText(next)
    setMentionQuery(undefined)

    // Restore the caret after the inserted mention rather than leaving it at the end.
    const position = at + rendered.length + 1
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(position, position)
    })
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0 && images.length === 0) return
    props.onSend(trimmed, images)
    setText('')
    if (textareaRef.current !== null) {
      textareaRef.current.style.height = 'auto'
    }
    setImages([])
    setMentionQuery(undefined)
    setNotice(undefined)
  }

  const canSend = (text.trim().length > 0 || images.length > 0) && !props.isStreaming

  /**
   * Attaching is never blocked on the capability table.
   *
   * It used to be, and the result was that pasting a screenshot did nothing at all for any
   * model the table did not recognise — which is most models behind a corporate gateway,
   * since the id is usually renamed. Silence is the worst possible response: there is
   * nothing to react to and no hint that a setting exists.
   *
   * So the paste always lands, and an unrecognised model gets a note pointing at the
   * override. The host still refuses to send images to a model marked text-only, and says
   * why.
   */
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return
    event.preventDefault()
    void addFiles(files)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    void addFiles(event.dataTransfer.files)
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(event) => {
        if (props.supportsVision) event.preventDefault()
      }}
      style={{ borderTop: `1px solid ${colors.border}`, flexShrink: 0 }}
    >
      {showingMentions && (
        <div
          role="listbox"
          aria-label="Workspace files"
          style={{ maxHeight: 160, overflowY: 'auto', borderBottom: `1px solid ${colors.border}` }}
        >
          {props.mentionCandidates.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              onMouseDown={(event) => {
                // mousedown, not click: click fires after blur, which closes the list first.
                event.preventDefault()
                insertMention(candidate)
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '4px 12px',
                background: index === highlighted ? colors.assistantBubble : 'transparent',
                border: 'none',
                color: colors.foreground,
                cursor: 'pointer',
                fontFamily,
                fontSize: 12,
              }}
            >
              {candidate}
            </button>
          ))}
        </div>
      )}

      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '6px 8px 0' }}>
          {images.map((image, index) => (
            <div
              key={`${image.name}-${index}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '2px 6px',
                border: `1px solid ${colors.border}`,
                borderRadius: 3,
                fontSize: 11,
                color: colors.muted,
              }}
            >
              <img
                src={`data:${image.mediaType};base64,${image.data}`}
                alt=""
                style={{ width: 20, height: 20, objectFit: 'cover', borderRadius: 2 }}
              />
              <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {image.name}
              </span>
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => setImages((previous) => previous.filter((_, i) => i !== index))}
                style={{ background: 'transparent', border: 'none', color: colors.muted, cursor: 'pointer', padding: 0 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {notice !== undefined && <div style={{ padding: '4px 10px 0', fontSize: 11, color: colors.error }}>{notice}</div>}

      {images.length > 0 && !props.supportsVision && (
        <div style={{ padding: '4px 10px 0', fontSize: 11, color: colors.error }}>
          This model is not known to accept images. If it does, tick “Supports images” in
          Settings → Providers → Edit → Model capability overrides.
        </div>
      )}

      {/* One bordered box containing the textarea and its buttons, so the control reads as
          a single field rather than an input with things bolted beside it. The border lives
          here; the textarea itself is borderless and transparent. */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          alignItems: 'flex-end',
          margin: 8,
          padding: 4,
          background: colors.inputBackground,
          border: `1px solid ${colors.inputBorder}`,
          borderRadius: 4,
        }}
      >
        <textarea
          ref={textareaRef}
          value={text}
          disabled={props.isStreaming}
          rows={2}
          placeholder="Message Light Code…  @ to attach a file"
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setText(event.target.value)
            syncMentionQuery(event.target.value, event.target.selectionStart)
            resize(event.target)
          }}
          onClick={(event) => syncMentionQuery(text, event.currentTarget.selectionStart)}
          onBlur={() => setMentionQuery(undefined)}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (showingMentions) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setHighlighted((current) => (current + 1) % props.mentionCandidates.length)
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setHighlighted((current) => (current - 1 + props.mentionCandidates.length) % props.mentionCandidates.length)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                const candidate = props.mentionCandidates[highlighted]
                if (candidate !== undefined) {
                  event.preventDefault()
                  insertMention(candidate)
                  return
                }
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setMentionQuery(undefined)
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          style={{
            flex: 1,
            resize: 'none',
            background: 'transparent',
            color: colors.inputForeground,
            border: 'none',
            outline: 'none',
            padding: '5px 6px',
            margin: 0,
            fontFamily,
            fontSize: 13,
            lineHeight: 1.45,
            // Grows with the text up to a limit, instead of a fixed two rows that is too
            // small for a paragraph and too tall for one line.
            minHeight: 44,
            maxHeight: 200,
            overflowY: 'auto',
          }}
        />

        {/* Always offered. Hiding it for an unrecognised model made attachment look
            unsupported when it was only unknown. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={SUPPORTED_IMAGE_TYPES.join(',')}
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files !== null) void addFiles(event.target.files)
            event.target.value = ''
          }}
        />
        <button
          type="button"
          title={props.supportsVision ? 'Attach an image' : 'Attach an image (this model is not known to accept images)'}
          aria-label="Attach an image"
          style={iconButtonStyle('secondary', props.isStreaming)}
          disabled={props.isStreaming}
          onClick={() => fileInputRef.current?.click()}
        >
          <AttachIcon />
        </button>

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

      {/* Which model is about to answer, switchable without leaving the chat. Below the
          input rather than in the header because it belongs to the message being sent. */}
      {/* Rendered whenever there is anything to report. Previously the whole row hung off
          `profiles.length > 0`, which hid the expert indicator too — so "is the expert
          actually on?" was unanswerable without opening Settings. */}
      {(props.profiles.length > 0 || props.expertEnabled) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 8px' }}>
          {props.profiles.length > 0 && (
          <select
            aria-label="Provider profile"
            title="Which provider answers the next message"
            value={props.activeProfileId ?? ''}
            disabled={props.isStreaming}
            onChange={(event) => props.onSelectProfile(event.target.value)}
            style={{
              ...selectStyle(true),
              cursor: props.isStreaming ? 'default' : 'pointer',
              maxWidth: '60%',
            }}
          >
            {props.profiles.map((profile) => (
              <option key={profile.id} value={profile.id} style={optionStyle()}>
                {profile.label} · {profile.model}
              </option>
            ))}
          </select>
          )}
          {props.expertEnabled && (
            <span
              title="Claude is available as an expert. Ask it directly — say “ask Claude …”."
              style={{ ...badgeStyle(), marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <ExpertIcon size={11} />
              expert
            </span>
          )}
        </div>
      )}
    </div>
  )
}
