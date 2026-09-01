import type { ImageAttachmentInput, ProfileSummary } from '@light-code/core/browser'
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type ReactElement } from 'react'
import { AttachIcon, CrossIcon, ExpertIcon, SendIcon, StopIcon } from './icons.js'
import { activeMentionQuery, insertMention as insertMentionInto, splitMentions } from './mentions.js'
import { Select } from './Select.js'
import { badgeStyle, colors, fontFamily, iconButtonStyle } from './theme.js'

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
  /** Messages typed during the current turn, waiting to be folded in. */
  queued: string[]
  onUnqueue: (index: number) => void
  /** OpenSearch connections, and which one this session may search. */
  searchConnections: { id: string; label: string }[]
  activeSearchId: string | undefined
  onSelectSearch: (id: string | undefined) => void
}

/** Beyond this the request usually fails on the provider side, so refuse it here instead. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Reads a File into the bare base64 the protocol expects, without the data: prefix. */
/** A non-image file, read as text and prepended to the message. */
export interface TextAttachment {
  name: string
  text: string
}

/** Above this a file belongs in the workspace, where `read_file` can page through it. */
const MAX_TEXT_BYTES = 512 * 1024

/** A NUL says the file is not text; sending its bytes as characters would be noise. */
function looksBinary(text: string): boolean {
  return text.includes('\u0000')
}

async function toTextAttachment(file: File): Promise<TextAttachment | { error: string }> {
  if (file.size > MAX_TEXT_BYTES) {
    return {
      error: `${file.name} is too large to attach (${Math.round(file.size / 1024)}KB). Put it in the workspace and ask me to read it — read_file can page through any size.`,
    }
  }
  const text = await file.text()
  if (looksBinary(text)) {
    return { error: `${file.name} is not a text file, so there is nothing readable to attach.` }
  }
  return { name: file.name || 'attachment', text }
}

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

/**
 * Every property that decides where a glyph lands.
 *
 * Shared by the textarea and the highlight layer drawn behind it, because the two only line up
 * while they agree exactly. Changing padding or line height in one place alone is the bug this
 * constant exists to make impossible.
 */
const composerTextLayout = {
  padding: '5px 6px',
  margin: 0,
  fontFamily,
  fontSize: 13,
  lineHeight: 1.45,
  // A textarea wraps and preserves runs of spaces; the mirror has to be told to.
  whiteSpace: 'pre-wrap',
  overflowWrap: 'break-word',
  border: 'none',
} as const

/** The `@` token the caret currently sits in, or undefined when it is not in one. */
export function Composer(props: ComposerProps): ReactElement {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageAttachmentInput[]>([])
  const [texts, setTexts] = useState<TextAttachment[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | undefined>(undefined)
  const [highlighted, setHighlighted] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)

  /** Keeps the highlight layer scrolled to wherever the textarea is. */
  const syncMirrorScroll = (element: HTMLTextAreaElement): void => {
    const mirror = mirrorRef.current
    if (mirror === null) return
    mirror.scrollTop = element.scrollTop
    mirror.scrollLeft = element.scrollLeft
  }

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

  /**
   * Any file, not only images.
   *
   * An image goes to the model as an image; everything else is read as text and prepended to
   * the message. Refusing a `.log` or a `.crt` because it is not a picture was an artefact of
   * attachments having been built for vision — the model can read text perfectly well, and a
   * file the user dragged in may not even be inside the workspace for `read_file` to reach.
   */
  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const acceptedImages: ImageAttachmentInput[] = []
    const acceptedTexts: TextAttachment[] = []
    const problems: string[] = []

    for (const file of Array.from(files)) {
      if (SUPPORTED_IMAGE_TYPES.includes(file.type)) {
        const image = await toAttachment(file)
        if (image === undefined) problems.push(`${file.name} is larger than 5MB.`)
        else acceptedImages.push(image)
        continue
      }
      const result = await toTextAttachment(file)
      if ('error' in result) problems.push(result.error)
      else acceptedTexts.push(result)
    }

    if (acceptedImages.length > 0) setImages((previous) => [...previous, ...acceptedImages])
    if (acceptedTexts.length > 0) setTexts((previous) => [...previous, ...acceptedTexts])
    setNotice(problems.length > 0 ? problems.join(' ') : undefined)
  }

  const insertMention = (candidatePath: string): void => {
    const textarea = textareaRef.current
    const caret = textarea?.selectionStart ?? text.length
    const inserted = insertMentionInto(text, caret, candidatePath)
    if (inserted === undefined) return

    setText(inserted.text)
    setMentionQuery(undefined)

    // Restore the caret after the inserted mention rather than leaving it at the end.
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0 && images.length === 0 && texts.length === 0) return

    /*
     * Attached text is prepended in fenced blocks rather than sent as a separate field: it
     * then travels through the ordinary message path, is visible in the transcript exactly as
     * the model saw it, and needs no protocol change. Fenced and named so the model can tell
     * the file apart from the question about it.
     */
    const attached = texts
      .map((attachment) => `--- ${attachment.name} ---\n\`\`\`\n${attachment.text}\n\`\`\``)
      .join('\n\n')
    const body = attached.length > 0 ? `${attached}\n\n${trimmed}` : trimmed

    props.onSend(body, images)
    setTexts([])
    setText('')
    if (textareaRef.current !== null) {
      textareaRef.current.style.height = 'auto'
    }
    setImages([])
    setMentionQuery(undefined)
    setNotice(undefined)
  }

  // Sending mid-turn queues rather than being refused. Waiting for a long turn to finish
  // before you can even type the follow-up is the thing this exists to fix.
  const canSend = text.trim().length > 0 || images.length > 0 || texts.length > 0

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
          className="lc-scroll lc-fade-up"
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
                // Keyboard selection is a selection, so it gets the accent like every
                // other one — the neutral bubble colour read as "slightly different row".
                background: index === highlighted ? colors.accent : 'transparent',
                border: 'none',
                color: index === highlighted ? colors.accentContrast : colors.foreground,
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

      {props.queued.length > 0 && (
        <div style={{ padding: '6px 10px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {props.queued.map((message, index) => (
            <div
              key={`${index}-${message.slice(0, 24)}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                fontSize: 11,
                color: colors.muted,
                borderLeft: `2px solid ${colors.accent}`,
                paddingLeft: 6,
              }}
            >
              <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{message}</span>
              <button
                type="button"
                title="Remove from the queue"
                aria-label="Remove from the queue"
                onClick={() => props.onUnqueue(index)}
                style={{ background: 'transparent', border: 'none', color: colors.muted, cursor: 'pointer', padding: 0 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/*
        Listed and removable, like an image. An attachment the user cannot see is one they
        cannot un-attach, and a whole log file silently riding along on the next message is an
        expensive surprise.
      */}
      {texts.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '6px 8px 0' }}>
          {texts.map((attachment, index) => (
            <div
              key={`${attachment.name}-${index}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '2px 4px 2px 8px',
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                fontSize: 11,
                color: colors.muted,
              }}
              title={`${attachment.name} — ${String(Math.max(1, Math.round(attachment.text.length / 1024)))}KB of text, included in your next message`}
            >
              <span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>{attachment.name}</span>
              <span>{Math.max(1, Math.round(attachment.text.length / 1024))}KB</span>
              <button
                type="button"
                title="Remove"
                aria-label={`Remove ${attachment.name}`}
                style={iconButtonStyle('ghost')}
                onClick={() => setTexts((current) => current.filter((_, position) => position !== index))}
              >
                <CrossIcon size={11} />
              </button>
            </div>
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
        // `lc-input` gives the whole box the accent focus ring via :focus-within, so focusing
        // the borderless textarea inside lights up the control the user actually sees.
        className="lc-input"
        style={{
          display: 'flex',
          gap: 4,
          alignItems: 'flex-end',
          margin: 8,
          padding: 4,
          background: colors.inputBackground,
          border: `1px solid ${colors.inputBorder}`,
          borderRadius: 12,
        }}
      >
        {/*
          The mention highlighter.

          A textarea cannot colour part of its own text, so the text is drawn twice: this
          layer paints it with the mentions coloured, and the textarea sits exactly on top with
          transparent glyphs and a visible caret. Everything that affects layout — font, size,
          line height, padding, wrapping — has to match between the two or the highlight drifts
          away from the words underneath it, which is why both read from the same constants.

          `aria-hidden`, because a screen reader should hear the textarea once, not twice.
        */}
        <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
          <div
            ref={mirrorRef}
            aria-hidden
            style={{
              ...composerTextLayout,
              position: 'absolute',
              inset: 0,
              overflow: 'hidden',
              pointerEvents: 'none',
              color: colors.inputForeground,
            }}
          >
            {splitMentions(text).map((segment, index) => (
              <span
                key={index}
                style={
                  segment.isMention
                    ? { color: colors.accent, fontWeight: 600 }
                    : undefined
                }
              >
                {segment.text}
              </span>
            ))}
            {/*
              A trailing newline is not rendered by the browser, so without this the mirror is
              one line shorter than the textarea and every wrapped line after it sits wrong.
            */}
            {text.endsWith('\n') && <span>{'​'}</span>}
          </div>
          <textarea
          ref={textareaRef}
          value={text}
          rows={2}
          placeholder={props.isStreaming ? "Add a message — it joins the current turn" : "Message Light Code…  @ to attach a file"}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setText(event.target.value)
            syncMentionQuery(event.target.value, event.target.selectionStart)
            resize(event.target)
            syncMirrorScroll(event.target)
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
            ...composerTextLayout,
            flex: 1,
            resize: 'none',
            border: 'none',
            outline: 'none',
            // Grows with the text up to a limit, instead of a fixed two rows that is too
            // small for a paragraph and too tall for one line.
            minHeight: 44,
            maxHeight: 200,
            overflowY: 'auto',
            // Drawn by the layer beneath; only the caret and the selection stay visible here.
            color: 'transparent',
            caretColor: colors.inputForeground,
            position: 'relative',
            background: 'transparent',
          }}
          onScroll={(event) => syncMirrorScroll(event.currentTarget)}
        />
        </div>

        {/* Always offered. Hiding it for an unrecognised model made attachment look
            unsupported when it was only unknown. */}
        <input
          ref={fileInputRef}
          type="file"

          multiple
          hidden
          onChange={(event) => {
            if (event.target.files !== null) void addFiles(event.target.files)
            event.target.value = ''
          }}
        />
        <button
          type="button"
          title={
            props.supportsVision
              ? 'Attach a file — text is included in the message, images are sent to the model'
              : 'Attach a file. Text is included in the message; this model is not known to accept images'
          }
          aria-label="Attach a file"
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
            className="lc-btn-accent"
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
          <Select
            compact
            ariaLabel="Provider profile"
            title="Which provider answers the next message"
            value={props.activeProfileId ?? ''}
            disabled={props.isStreaming}
            onChange={props.onSelectProfile}
            style={{ maxWidth: '60%' }}
            options={props.profiles.map((profile) => ({
              value: profile.id,
              label: profile.label,
              detail: profile.model,
            }))}
          />
          )}
          {props.searchConnections.length > 0 && (
            <Select
              compact
              ariaLabel="OpenSearch connection"
              title="Which cluster this conversation may search. Change it between messages."
              value={props.activeSearchId ?? ''}
              disabled={props.isStreaming}
              onChange={(value) => props.onSelectSearch(value.length > 0 ? value : undefined)}
              style={{ maxWidth: '38%' }}
              options={[
                // Off is a real choice, and the default one: no connection means the search
                // tools are not offered at all.
                { value: '', label: 'No search' },
                ...props.searchConnections.map((connection) => ({ value: connection.id, label: connection.label })),
              ]}
            />
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
