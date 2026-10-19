import { useEffect, useRef, useState, type ReactElement } from 'react'
import { disabledWhen } from './disabledWhen.js'
import { MarkdownView } from './MarkdownView.js'
import { colors, fontFamily, primaryButtonStyle, secondaryButtonStyle } from './theme.js'

/**
 * The panel's own editor, for a skill, a Python tool or the standing instructions - in a host that has
 * no editor of its own (Fire Code, the browser host, JetBrains). VS Code opens its own editor instead.
 *
 * Asked for: "i am not able to edit things like standing instruction with in fire code". Deliberately
 * plain - a monospace text box - because these are short files and a code editor would be megabytes in
 * every install. What matters is that saving cannot lose work: the host refuses a save when the file
 * changed on disk after it was opened, and closing with unsaved changes asks first.
 */
export interface EditorFile {
  path: string
  name: string
  content: string
  mtimeMs: number
}

export interface FileEditorProps {
  file: EditorFile
  /** The host's answer to the last save, if any. */
  saved?: { ok: boolean; mtimeMs?: number; conflict?: boolean; message?: string } | undefined
  onSave: (content: string, mtimeMs: number) => void
  onClose: () => void
}

const monospace = 'var(--vscode-editor-font-family, Consolas, monospace)'

export function FileEditor(props: FileEditorProps): ReactElement {
  const [text, setText] = useState(props.file.content)
  // The version on disk this text was based on: moves forward with each successful save.
  const [base, setBase] = useState({ content: props.file.content, mtimeMs: props.file.mtimeMs })
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const markdown = /\.(md|markdown)$/i.test(props.file.name)
  const dirty = text !== base.content

  useEffect(() => box.current?.focus(), [])

  useEffect(() => {
    if (props.saved === undefined) return
    setSaving(false)
    if (props.saved.ok && props.saved.mtimeMs !== undefined) setBase({ content: text, mtimeMs: props.saved.mtimeMs })
    // Only the answer matters here; `text` is read at the moment it arrives.
  }, [props.saved])

  const save = (): void => {
    if (!dirty || saving) return
    setSaving(true)
    props.onSave(text, base.mtimeMs)
  }
  const close = (): void => {
    if (dirty && !confirm(`${props.file.name} has unsaved changes. Close without saving?`)) return
    props.onClose()
  }

  return (
    <div
      role="dialog"
      aria-label={`Edit ${props.file.name}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        background: colors.background,
        color: colors.foreground,
        fontFamily,
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          save()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          close()
        }
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {props.file.name}
            {dirty && <span style={{ color: colors.muted, fontWeight: 400 }}> — unsaved</span>}
          </div>
          <div title={props.file.path} style={{ color: colors.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {props.file.path}
          </div>
        </div>
        {markdown && (
          <button type="button" style={secondaryButtonStyle()} onClick={() => setPreview((on) => !on)} title="Show how the Markdown reads">
            {preview ? 'Edit' : 'Preview'}
          </button>
        )}
        <button
          type="button"
          style={primaryButtonStyle(!dirty || saving)}
          {...disabledWhen([saving, 'Saving…'], [!dirty, 'Nothing has changed since it was opened or last saved.'], { enabledTitle: 'Save (Ctrl+S)' })}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" style={secondaryButtonStyle()} title="Close (Esc)" onClick={close}>
          Close
        </button>
      </div>
      {props.saved !== undefined && !props.saved.ok && (
        <div role="alert" style={{ padding: '6px 12px', color: colors.error, fontSize: 12, borderBottom: `1px solid ${colors.border}` }}>
          {props.saved.message ?? 'Could not save.'}
        </div>
      )}
      {preview ? (
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 16px' }}>
          <MarkdownView text={text} />
        </div>
      ) : (
        <textarea
          ref={box}
          aria-label={`Contents of ${props.file.name}`}
          value={text}
          spellCheck={markdown}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Tab indents rather than leaving the box: skills and tools are indented text.
            if (event.key === 'Tab' && !event.shiftKey) {
              event.preventDefault()
              const target = event.currentTarget
              const { selectionStart, selectionEnd } = target
              const next = `${text.slice(0, selectionStart)}  ${text.slice(selectionEnd)}`
              setText(next)
              requestAnimationFrame(() => target.setSelectionRange(selectionStart + 2, selectionStart + 2))
            }
          }}
          style={{
            flex: 1,
            resize: 'none',
            border: 'none',
            outline: 'none',
            padding: '10px 14px',
            background: colors.inputBackground,
            color: colors.inputForeground,
            fontFamily: monospace,
            fontSize: 12.5,
            lineHeight: 1.5,
            tabSize: 2,
          }}
        />
      )}
    </div>
  )
}
