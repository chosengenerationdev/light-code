import type { CheckpointView, ImageAttachmentInput, ProfileSummary } from '@light-code/core/browser'
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type ReactElement,
} from 'react'
import { AddFileIcon, AttachIcon, CrossIcon, ExpertIcon, SendIcon, StopIcon } from './icons.js'
import {
  activeMentionQuery,
  activeRoleQuery,
  addMentions,
  insertMention as insertMentionInto,
  splitMentions,
} from './mentions.js'
import { PlanProgress } from './PlanProgress.js'
import type { StageFile } from './stagedFiles.js'
import { Select } from './Select.js'
import {
  badgeStyle,
  colors,
  fontFamily,
  iconButtonStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  textFieldStyle,
} from './theme.js'

export interface ComposerProps {
  isStreaming: boolean
  /**
   * The plan for this conversation, as the host holds it. Empty means none is set.
   *
   * Shown under the composer rather than tucked in Settings: it constrains *this* chat, and a
   * constraint you cannot see is one you forget you imposed — which turns "why did it refuse to
   * fix that?" into a mystery rather than a glance.
   */
  plan: string
  /**
   * The plan's steps with their progress, resolved by the host.
   *
   * Not derived from `plan` here: the numbering is a contract with the assistant, which is
   * given the same numbers in its prompt, so a second reading of the plan in the UI would
   * eventually light up the wrong row.
   */
  planCheckpoints: CheckpointView[]
  onSetPlan: (plan: string) => void
  onSend: (text: string, images: ImageAttachmentInput[]) => void
  onCancel: () => void
  /** Hides attachment entirely when the active model has no vision support (§9). */
  supportsVision: boolean
  /** Paths matching the current `@` query, supplied by the host. */
  mentionCandidates: string[]
  /** The query `mentionCandidates` answers; with none found, the picker says so instead of vanishing. */
  mentionAnsweredFor?: string | undefined
  /** Specialists that can answer, for the `#` picker. Unavailable ones are not offered. */
  directRoles: { role: string; name: string; summary: string }[]
  onQueryMentions: (query: string) => void
  /** Shown as a selector under the input, so the answering model is switchable in place. */
  profiles: ProfileSummary[]
  activeProfileId: string | undefined
  onSelectProfile: (id: string) => void
  /** Whether the Claude CLI expert is configured and runnable. */
  expertEnabled: boolean
  /** Messages typed during the current turn, waiting to be folded in. */
  /** Waiting to be folded into the turn. `images` is a count, which is all the row shows. */
  queued: { text: string; images?: number }[]
  onUnqueue: (index: number) => void
  /** OpenSearch connections, and which one this session may search. */
  searchConnections: { id: string; label: string }[]
  activeSearchId: string | undefined
  onSelectSearch: (id: string | undefined) => void
  /**
   * Hands a file the panel cannot read (too big, PDF, Office, an Outlook message) to the host,
   * which saves it to a temporary folder and reads it. Absent in tests; such files are then refused.
   */
  stageFile?: StageFile | undefined
  /** The editor's file list ("Add files to context"); absent where there is no editor. */
  onPickFiles?: (() => void) | undefined
  /** Files to add as mentions, from the picker or the editor's menu; `nonce` makes a repeat land. */
  addedFiles?: { paths: string[]; nonce: number } | undefined
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

/** The last `addedFiles` applied, kept outside the component because the box is remounted. */
let lastAddedNonce: number | undefined

/** Above this a text file is read by the host rather than pasted whole into the message. */
const MAX_TEXT_BYTES = 512 * 1024

/**
 * What the host will take in one message: base64 adds a third, and the Node host refuses a
 * request body over 32 MB.
 */
const MAX_STAGED_BYTES = 20 * 1024 * 1024

/** Formats only the host can read; never decoded in the panel. */
const HOST_READ_FORMAT = /\.(pdf|docx|xlsx|xlsm|msg)$/i

/** Bare base64 of a file, chunked: spreading megabytes into String.fromCharCode overflows the stack. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

/** A NUL says the file is not text; sending its bytes as characters would be noise. */
function looksBinary(text: string): boolean {
  return text.includes('\u0000')
}

/**
 * A small text file is pasted as it is; anything else - big, binary, PDF, Office, an Outlook
 * message dragged out of Outlook - is handed to the host to save and read. Reported: refusing
 * those and asking the person to save the file and say where "defeats the purpose of easy usage".
 */
async function toTextAttachment(file: File, stageFile: StageFile | undefined): Promise<TextAttachment | { error: string }> {
  const name = file.name || 'attachment'
  if (file.size <= MAX_TEXT_BYTES && !HOST_READ_FORMAT.test(name)) {
    const text = await file.text()
    if (!looksBinary(text)) return { name, text }
  }
  if (stageFile === undefined) {
    return { error: `${name} cannot be read here. Put it in the workspace and ask me to read it.` }
  }
  if (file.size > MAX_STAGED_BYTES) {
    return {
      error: `${name} is ${(file.size / 1024 / 1024).toFixed(0)} MB - over the 20 MB a dropped file can be. Ask me to read it from where it is saved instead.`,
    }
  }
  const staged = await stageFile(name, await toBase64(file))
  if ('error' in staged) return staged
  return { name: staged.name, text: `(saved at ${staged.path})\n${staged.text}` }
}

async function toAttachment(file: File): Promise<ImageAttachmentInput | undefined> {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) return undefined
  if (file.size > MAX_IMAGE_BYTES) return undefined

  return { mediaType: file.type, data: await toBase64(file), name: file.name || 'pasted image' }
}

/** How the message text is laid out. */
const composerTextLayout = {
  padding: '5px 6px',
  margin: 0,
  fontFamily,
  fontSize: 13,
  lineHeight: 1.45,
  border: 'none',
} as const

/** The `@` token the caret currently sits in, or undefined when it is not in one. */
/** The first non-empty line, for the collapsed strip. A plan is usually a list; its head is the gist. */
function firstPlanLine(plan: string): string {
  const line =
    plan
      .split('\n')
      .find((candidate) => candidate.trim().length > 0)
      ?.trim() ?? ''
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line
}

/*
 * The draft outlives the composer. Reported: type something, switch away (Settings, History, another
 * view) and come back, and it was gone - the box is unmounted with the view. Kept in this page's own
 * storage, so it also survives the webview being rebuilt. Best effort: storage can be unavailable,
 * and then the draft simply is not kept.
 */
const DRAFT_KEY = 'light-code:composer-draft'

function readDraft(): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}

function keepDraft(text: string): void {
  try {
    if (text.length > 0) window.localStorage.setItem(DRAFT_KEY, text)
    else window.localStorage.removeItem(DRAFT_KEY)
  } catch {
    // Nowhere to keep it; typing still works.
  }
}

export function Composer(props: ComposerProps): ReactElement {
  const [text, setText] = useState(readDraft)
  useEffect(() => keepDraft(text), [text])
  const [roleQuery, setRoleQuery] = useState<string | undefined>(undefined)
  const [planOpen, setPlanOpen] = useState(false)
  const [progressOpen, setProgressOpen] = useState(false)
  const [planDraft, setPlanDraft] = useState(props.plan)
  const [images, setImages] = useState<ImageAttachmentInput[]>([])
  const [texts, setTexts] = useState<TextAttachment[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | undefined>(undefined)
  const [highlighted, setHighlighted] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /** Files being read by the host; sending waits for them so none is silently left out. */
  const [reading, setReading] = useState<string[]>([])

  // A new object per addition (with its nonce), so the same files added twice still land.
  useEffect(() => {
    if (props.addedFiles === undefined || props.addedFiles.paths.length === 0) return
    // The box is remounted whenever the chat view returns; files already added must not come back.
    if (props.addedFiles.nonce === lastAddedNonce) return
    lastAddedNonce = props.addedFiles.nonce
    const paths = props.addedFiles.paths
    setText((previous) => addMentions(previous, paths))
    requestAnimationFrame(() => {
      const box = textareaRef.current
      if (box === null) return
      box.focus()
      box.setSelectionRange(box.value.length, box.value.length)
    })
  }, [props.addedFiles])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /** Grows the box to fit the text, capped, so the send button never drifts out of line. */
  const resize = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }
  const fileInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (textareaRef.current !== null && text.length > 0) resize(textareaRef.current)
    // Only on mount: afterwards the input handler sizes it as the user types.
  }, [])

  const showingMentions = mentionQuery !== undefined && props.mentionCandidates.length > 0
  // An empty picker looks exactly like a broken one, so a search that found nothing says so.
  const nothingMatches =
    mentionQuery !== undefined &&
    mentionQuery.length > 0 &&
    props.mentionCandidates.length === 0 &&
    props.mentionAnsweredFor === mentionQuery
  // Matched on the id and the name, because somebody typing `#rev` means the reviewer and
  // somebody typing `#DB` means the role they called DB reviewer.
  const matchingRoles =
    roleQuery === undefined
      ? []
      : props.directRoles.filter(
          (candidate) =>
            candidate.role.startsWith(roleQuery) ||
            candidate.name.toLowerCase().startsWith(roleQuery),
        )

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
    /*
     * The role picker, opened by `#`.
     *
     * Only when there is somebody to offer: a picker listing nothing teaches that the symbol does
     * not work, which is worse than the symbol doing nothing at all.
     */
    const role = activeRoleQuery(value, caret)
    setRoleQuery(role !== undefined && props.directRoles.length > 0 ? role : undefined)
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
      if (SUPPORTED_IMAGE_TYPES.includes(file.type) && file.size <= MAX_IMAGE_BYTES) {
        const image = await toAttachment(file)
        if (image !== undefined) {
          acceptedImages.push(image)
          continue
        }
      }
      const label = file.name || 'attachment'
      setReading((previous) => [...previous, label])
      try {
        const result = await toTextAttachment(file, props.stageFile)
        if ('error' in result) problems.push(result.error)
        else acceptedTexts.push(result)
      } finally {
        setReading((previous) => {
          const at = previous.indexOf(label)
          return at === -1 ? previous : [...previous.slice(0, at), ...previous.slice(at + 1)]
        })
      }
    }

    if (acceptedImages.length > 0) setImages((previous) => [...previous, ...acceptedImages])
    if (acceptedTexts.length > 0) setTexts((previous) => [...previous, ...acceptedTexts])
    setNotice(problems.length > 0 ? problems.join(' ') : undefined)
  }

  /**
   * Replaces the `#…` being typed with the chosen role.
   *
   * Written out rather than reusing `insertMentionInto`, which quotes paths containing spaces and
   * anchors on `@`. A role id has neither problem, and bending that helper to serve both would
   * make the file picker's rules depend on the specialist picker's.
   */
  const insertRole = (role: string): void => {
    const textarea = textareaRef.current
    const caret = textarea?.selectionStart ?? text.length
    const at = text.slice(0, caret).lastIndexOf('#')
    if (at === -1) return

    const next = `${text.slice(0, at)}#${role} ${text.slice(caret)}`
    setText(next)
    setRoleQuery(undefined)

    const position = at + role.length + 2
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(position, position)
    })
  }

  const insertMention = (candidatePath: string): void => {
    const textarea = textareaRef.current
    const caret = textarea?.selectionStart ?? text.length
    const inserted = insertMentionInto(text, caret, candidatePath)
    if (inserted === undefined) return

    setText(inserted.text)
    // A codebase (`name:`) opens the picker inside it; a file closes it.
    setMentionQuery(candidatePath.endsWith(':') ? candidatePath : undefined)

    // Restore the caret after the inserted mention rather than leaving it at the end.
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (reading.length > 0) return
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
  const canSend = reading.length === 0 && (text.trim().length > 0 || images.length > 0 || texts.length > 0)

  /** Paths the message refers to, with the `@` and any quoting taken off for display. */
  const mentionedFiles = splitMentions(text)
    .filter((segment) => segment.isMention)
    .map((segment) => segment.text.replace(/^@/, '').replace(/^"|"$/g, ''))

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
      {/*
        Addressing a specialist, by name.

        The same shape as the file picker above it, deliberately: one list, one highlight, one
        insertion. A second interaction pattern for the same gesture would be a thing to learn for
        no reason. Only specialists that can actually answer are here — offering one nobody is
        assigned to produces a message that quietly does nothing.
      */}
      {roleQuery !== undefined && matchingRoles.length > 0 && (
        <div
          role="listbox"
          aria-label="Specialists"
          className="lc-scroll lc-fade-up"
          style={{ maxHeight: 160, overflowY: 'auto', borderBottom: `1px solid ${colors.border}` }}
        >
          {matchingRoles.map((candidate) => (
            <button
              key={candidate.role}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(event) => {
                // mousedown, not click: click fires after blur, which closes the list first.
                event.preventDefault()
                insertRole(candidate.role)
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                background: 'none',
                border: 'none',
                padding: '4px 10px',
                cursor: 'pointer',
                fontFamily,
                fontSize: 12,
                color: colors.foreground,
              }}
            >
              <span style={{ color: colors.accent }}>#{candidate.role}</span>{' '}
              <span style={{ color: colors.muted }}>{candidate.summary}</span>
            </button>
          ))}
        </div>
      )}

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

      {nothingMatches && (
        <div
          role="status"
          style={{ padding: '4px 12px', fontSize: 12, color: colors.muted, borderBottom: `1px solid ${colors.border}` }}
        >
          No file or folder name matches “{mentionQuery}”. @ looks at names; to find text inside files, ask the
          assistant.
        </div>
      )}

      {props.queued.length > 0 && (
        <div style={{ padding: '6px 10px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {props.queued.map((message, index) => (
            <div
              key={`${index}-${message.text.slice(0, 24)}`}
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
              <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {message.text}
                {/*
                  Said, because it was silently lost before this.
                  A queued message's attachments were dropped on the way to the host, so the words
                  arrived and the screenshot they were about did not — and nothing on screen
                  indicated it. Showing the count is how somebody can tell it is still coming.
                */}
                {message.images !== undefined && message.images > 0 && (
                  <span style={{ opacity: 0.8 }}>
                    {' '}
                    [{message.images} image{message.images === 1 ? '' : 's'}]
                  </span>
                )}
              </span>
              <button
                type="button"
                title="Remove from the queue"
                aria-label="Remove from the queue"
                onClick={() => props.onUnqueue(index)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: colors.muted,
                  cursor: 'pointer',
                  padding: 0,
                }}
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
      {/*
        The files this message mentions, listed under it.

        The first attempt at making mentions visible painted them *inside* the box, with the
        textarea's own glyphs turned transparent over a coloured copy of the same text. It looked
        right and broke typing: the caret sat behind the last character, because two independently
        laid-out layers cannot be relied upon to agree to the pixel across fonts and zoom levels,
        and nothing automated can see that they have stopped agreeing.

        So the highlight moved out of the input. Nothing here can touch the caret, it counts the
        attachments at a glance — which is what the request was actually about in a long prompt —
        and it reads the same as the file and image chips beside it.
      */}
      {mentionedFiles.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            padding: '6px 8px 0',
            alignItems: 'center',
          }}
        >
          <span style={{ color: colors.muted, fontSize: 11 }}>
            {mentionedFiles.length === 1
              ? 'Mentions'
              : `Mentions (${String(mentionedFiles.length)})`}
          </span>
          {mentionedFiles.map((mention, index) => (
            <span
              key={`${mention}-${index}`}
              title={mention}
              style={{
                padding: '1px 8px',
                borderRadius: 8,
                fontSize: 11,
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                color: colors.accent,
                border: `1px solid ${colors.accent}`,
                background: `color-mix(in srgb, ${colors.accent} 12%, transparent)`,
              }}
            >
              {mention}
            </span>
          ))}
        </div>
      )}

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
              <span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>
                {attachment.name}
              </span>
              <span>{Math.max(1, Math.round(attachment.text.length / 1024))}KB</span>
              <button
                type="button"
                title="Remove"
                aria-label={`Remove ${attachment.name}`}
                style={iconButtonStyle('ghost')}
                onClick={() =>
                  setTexts((current) => current.filter((_, position) => position !== index))
                }
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
              <span
                style={{
                  maxWidth: 120,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {image.name}
              </span>
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => setImages((previous) => previous.filter((_, i) => i !== index))}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: colors.muted,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {reading.length > 0 && (
        <div style={{ padding: '4px 10px 0', fontSize: 11, color: colors.muted }}>
          Reading {reading.join(', ')}…
        </div>
      )}

      {notice !== undefined && (
        <div style={{ padding: '4px 10px 0', fontSize: 11, color: colors.error }}>{notice}</div>
      )}

      {images.length > 0 && !props.supportsVision && (
        <div style={{ padding: '4px 10px 0', fontSize: 11, color: colors.error }}>
          This model is not known to accept images. If it does, tick “Supports images” in Settings →
          Providers → Edit → Model capability overrides.
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
        <textarea
          ref={textareaRef}
          value={text}
          rows={2}
          placeholder={
            props.isStreaming
              ? 'Add a message — it joins the current turn'
              : 'Message Light Code…  @ to attach a file'
          }
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
                setHighlighted(
                  (current) =>
                    (current - 1 + props.mentionCandidates.length) % props.mentionCandidates.length,
                )
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
            color: colors.inputForeground,
            background: 'transparent',
          }}
        />

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
          /*
           * Offered mid-turn too.
           *
           * It was disabled while streaming, left over from when a message sent during a turn was
           * refused outright. Queuing has carried attachments for a while — and paste and drop
           * were never disabled — so the button was the only way in that still said no. Reported
           * as "the attachment doesn't seem to be queued, only the message is passed on", which is
           * exactly what it looks like: you click, nothing happens, and the text goes on its own.
           */
          style={iconButtonStyle('secondary', false)}
          onClick={() => fileInputRef.current?.click()}
        >
          <AttachIcon />
        </button>
        {props.onPickFiles !== undefined && (
          <button
            type="button"
            title="Add files to context - pick from the workspace; open files are listed first and the current one is ticked"
            aria-label="Add files to context"
            style={iconButtonStyle('secondary', false)}
            onClick={props.onPickFiles}
          >
            <AddFileIcon />
          </button>
        )}

        {props.isStreaming ? (
          <button
            type="button"
            title="Cancel"
            aria-label="Cancel"
            style={iconButtonStyle('secondary')}
            onClick={props.onCancel}
          >
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
      {/*
        The plan, under the input where the work is described.

        Collapsed to a single line when set, because it is context rather than content: you need
        to know it is there and roughly what it says, and the full text only when editing it.
      */}
      <div style={{ padding: '0 10px 6px' }}>
        {planOpen ? (
          <div>
            <textarea
              value={planDraft}
              rows={6}
              spellCheck={false}
              aria-label="Plan for this conversation"
              placeholder={
                'What this conversation is for.\n\n' +
                'Example:\n1. Fix the retry logic in http.ts\n2. Add a test for the timeout path\n' +
                'Do not touch anything else.'
              }
              onChange={(event) => setPlanDraft(event.target.value)}
              style={{ ...textFieldStyle(), width: '100%', resize: 'vertical', fontFamily }}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
              <button
                type="button"
                style={primaryButtonStyle(false)}
                onClick={() => {
                  props.onSetPlan(planDraft)
                  setPlanOpen(false)
                }}
              >
                Set plan
              </button>
              <button
                type="button"
                style={secondaryButtonStyle()}
                onClick={() => setPlanOpen(false)}
              >
                Cancel
              </button>
              {props.plan.length > 0 && (
                <button
                  type="button"
                  style={secondaryButtonStyle()}
                  onClick={() => {
                    setPlanDraft('')
                    props.onSetPlan('')
                    setPlanOpen(false)
                  }}
                >
                  Clear
                </button>
              )}
              <span style={{ color: colors.muted, fontSize: 11 }}>
                Kept in front of the assistant for the whole conversation.
              </span>
            </div>
          </div>
        ) : progressOpen ? (
          <PlanProgress
            checkpoints={props.planCheckpoints}
            onClose={() => setProgressOpen(false)}
            onEdit={() => {
              setProgressOpen(false)
              setPlanDraft(props.plan)
              setPlanOpen(true)
            }}
          />
        ) : (
          <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
          <button
            type="button"
            style={{
              ...secondaryButtonStyle(),
              flex: 1,
              minWidth: 0,
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              ...(props.plan.length > 0 ? { borderColor: colors.accent } : {}),
            }}
            title={props.plan.length > 0 ? props.plan : 'Set what this conversation is for'}
            onClick={() => {
              setPlanDraft(props.plan)
              setPlanOpen(true)
            }}
          >
            <span style={{ color: props.plan.length > 0 ? colors.accent : colors.muted }}>
              {props.plan.length > 0 ? 'Plan' : 'Set a plan'}
            </span>
            <span
              style={{
                color: colors.muted,
                fontSize: 11,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
            >
              {props.plan.length > 0 ? firstPlanLine(props.plan) : 'keeps the assistant on the job'}
            </span>
          </button>
          {/*
            Only where there is something to show. A progress button beside an unset plan would
            open an empty panel, which teaches that the feature is broken rather than unused.
          */}
          {props.planCheckpoints.length > 0 && (
            <button
              type="button"
              style={{ ...secondaryButtonStyle(), whiteSpace: 'nowrap' }}
              title="Which steps of the plan are done, and who was consulted on them"
              onClick={() => setProgressOpen(true)}
            >
              <span style={{ color: colors.muted }}>
                Progress{' '}
                <span style={{ color: colors.accent }}>
                  {props.planCheckpoints.filter((c) => c.status === 'done').length}/
                  {props.planCheckpoints.length}
                </span>
              </span>
            </button>
          )}
          </div>
        )}
      </div>

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
                ...props.searchConnections.map((connection) => ({
                  value: connection.id,
                  label: connection.label,
                })),
              ]}
            />
          )}
          {props.expertEnabled && (
            <span
              title="Claude is available as an expert. Ask it directly — say “ask Claude …”."
              style={{
                ...badgeStyle(),
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
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
