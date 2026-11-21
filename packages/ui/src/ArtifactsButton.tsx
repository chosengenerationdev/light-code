import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'

import type { ArtifactEntry, ArtifactInfo, ArtifactKind, ArtifactList, HostToUiMessage, UiToHostMessage } from '@light-code/core/browser'

import { FilesIcon } from './icons.js'
import { badgeStyle, colors, fontFamily, iconButtonStyle, monospaceFamily, secondaryButtonStyle, textFieldStyle } from './theme.js'
import type { Transport } from '@light-code/core/browser'

/**
 * The Files button in the chat header, and the panel it opens: the files in the folder the agent works
 * in, newest first, with what this chat wrote.
 *
 * Asked for "especially for non-code bases ... where there won't be any git to show the artefacts", and to
 * show "some info about the artefact" with each name. So each row says what kind of file it is, its size,
 * when it changed, whether this chat made or changed it - and which tool wrote it, with the reason the
 * agent gave - plus a one-line summary where one is cheap (a table's columns, a document's heading).
 * Opening a row reads more: line counts, a workbook's sheets, the start of its text.
 *
 * Self-contained, like `StrategyButton`: it posts and listens on the transport itself.
 */

type Filter = 'chat' | 'all'

const KIND_LABEL: Record<ArtifactKind, string> = {
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Slides',
  image: 'Picture',
  data: 'Data',
  code: 'Code',
  archive: 'Archive',
  email: 'Email',
  text: 'Text',
  other: 'File',
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? 'GB'}`
}

export function formatWhen(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)} h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${String(days)} day${days === 1 ? '' : 's'} ago`
  return new Date(ms).toLocaleDateString()
}

/** Whether the row belongs to "This chat": written by its tools, or changed since it started. */
export function touchedThisChat(entry: ArtifactEntry): boolean {
  return entry.writes !== undefined || entry.changedThisChat
}

function folderOf(relative: string): string {
  const cut = relative.lastIndexOf('/')
  return cut < 0 ? '' : relative.slice(0, cut)
}

/** The badges on a row, most specific first. */
export function badgesFor(entry: ArtifactEntry): string[] {
  const badges: string[] = []
  if (entry.writes !== undefined) badges.push(entry.newThisChat ? 'Created by the agent' : 'Written by the agent')
  else if (entry.newThisChat) badges.push('New this chat')
  else if (entry.changedThisChat) badges.push('Changed this chat')
  return badges
}

export function ArtifactsButton(props: { transport: Transport; onMention?: (path: string) => void }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label="Files"
        title="Files - what is in the folder the agent works in, newest first, and what this chat made or changed"
        style={iconButtonStyle('ghost')}
        onClick={() => setOpen(true)}
      >
        <FilesIcon />
      </button>
      {open ? <ArtifactsPanel transport={props.transport} onClose={() => setOpen(false)} {...(props.onMention !== undefined ? { onMention: props.onMention } : {})} /> : null}
    </>
  )
}

export function ArtifactsPanel(props: { transport: Transport; onClose: () => void; onMention?: (path: string) => void }): ReactElement {
  const { transport } = props
  const [list, setList] = useState<ArtifactList | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [opens, setOpens] = useState({ open: false, reveal: false })
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [details, setDetails] = useState<Record<string, { info?: ArtifactInfo; error?: string }>>({})
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const unsubscribe = transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'artifacts') {
        setLoading(false)
        setOpens(message.opens)
        setError(message.error)
        setList(message.list)
        setNow(Date.now())
      } else if (message.type === 'artifactInfo') {
        setDetails((previous) => ({ ...previous, [message.path]: { ...(message.info !== undefined ? { info: message.info } : {}), ...(message.error !== undefined ? { error: message.error } : {}) } }))
      }
    })
    transport.post({ type: 'requestArtifacts' } satisfies UiToHostMessage)
    return unsubscribe
  }, [transport])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  const files = list?.files ?? []
  const chatCount = files.filter(touchedThisChat).length
  // "This chat" first when it has anything; otherwise the whole folder, so the panel is never empty for no reason.
  const effective: Filter = filter ?? (chatCount > 0 ? 'chat' : 'all')

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return files.filter(
      (entry) =>
        (effective === 'all' || touchedThisChat(entry)) &&
        (needle === '' || entry.path.toLowerCase().includes(needle) || (entry.summary ?? '').toLowerCase().includes(needle) || KIND_LABEL[entry.kind].toLowerCase().includes(needle)),
    )
  }, [files, effective, query])

  const refresh = (): void => {
    setLoading(true)
    setDetails({})
    transport.post({ type: 'requestArtifacts' } satisfies UiToHostMessage)
  }

  const toggle = (entry: ArtifactEntry): void => {
    if (expanded === entry.path) {
      setExpanded(undefined)
      return
    }
    setExpanded(entry.path)
    if (details[entry.path] === undefined) transport.post({ type: 'describeArtifact', path: entry.path } satisfies UiToHostMessage)
  }

  const chip = (value: Filter, label: string): ReactElement => (
    <button
      type="button"
      aria-pressed={effective === value}
      onClick={() => setFilter(value)}
      style={{
        ...secondaryButtonStyle(),
        padding: '2px 10px',
        fontSize: 12,
        borderRadius: 12,
        ...(effective === value ? { background: colors.buttonBackground, color: colors.buttonForeground } : {}),
      }}
    >
      {label}
    </button>
  )

  const overlay: CSSProperties = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', padding: 12, fontFamily }
  const sheet: CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: colors.background, color: colors.foreground, border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden', fontSize: 13 }

  return (
    <div style={overlay} role="dialog" aria-label="Files" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${colors.border}` }}>
          <FilesIcon />
          <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={list?.root}>
            Files{list !== undefined ? ` in ${list.root.split(/[\\/]/).filter((part) => part !== '').pop() ?? list.root}` : ''}
          </strong>
          <button type="button" style={{ ...secondaryButtonStyle(), padding: '2px 8px', fontSize: 12 }} onClick={refresh} disabled={loading} title="Look at the folder again">
            {loading ? 'Reading…' : 'Refresh'}
          </button>
          <button type="button" aria-label="Close" title="Close (Esc)" style={iconButtonStyle('ghost')} onClick={props.onClose}>
            ✕
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: `1px solid ${colors.border}` }}>
          {chip('chat', `This chat (${String(chatCount)})`)}
          {chip('all', `All files (${String(files.length)})`)}
          <input
            type="search"
            aria-label="Filter files"
            placeholder="Filter by name, kind or content"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ ...textFieldStyle(), flex: 1, minWidth: 140, padding: '3px 8px' }}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {error !== undefined ? <div style={{ padding: 12, color: colors.error }}>{error}</div> : null}
          {loading && list === undefined ? <div style={{ padding: 12, color: colors.muted }}>Reading the folder…</div> : null}
          {!loading && error === undefined && shown.length === 0 ? (
            <div style={{ padding: 12, color: colors.muted }}>
              {effective === 'chat' ? 'Nothing in this folder has been made or changed in this chat yet.' : query !== '' ? 'No file matches that filter.' : 'This folder has no files.'}
            </div>
          ) : null}
          {shown.map((entry) => (
            <ArtifactRow
              key={entry.path}
              entry={entry}
              now={now}
              open={expanded === entry.path}
              detail={details[entry.path]}
              opens={opens}
              onToggle={() => toggle(entry)}
              onOpen={(how) => transport.post({ type: 'openArtifact', path: entry.path, how } satisfies UiToHostMessage)}
              {...(props.onMention !== undefined
                ? {
                    onMention: () => {
                      props.onMention?.(entry.path)
                      props.onClose()
                    },
                  }
                : {})}
            />
          ))}
        </div>

        {list !== undefined ? (
          <div style={{ padding: '6px 12px', borderTop: `1px solid ${colors.border}`, fontSize: 11, color: colors.muted }}>
            {list.truncated
              ? `The folder has more files than were looked at (${String(list.scanned)} read); the newest are shown.`
              : `${String(list.scanned)} file(s) in the folder${files.length < list.scanned ? `, the newest ${String(files.length)} shown` : ''}.`}{' '}
            "This chat" means written by the agent's tools, or changed since the chat started (by a command, a script or you).
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ArtifactRow(props: {
  entry: ArtifactEntry
  now: number
  open: boolean
  detail: { info?: ArtifactInfo; error?: string } | undefined
  opens: { open: boolean; reveal: boolean }
  onToggle: () => void
  onOpen: (how: 'open' | 'reveal') => void
  onMention?: () => void
}): ReactElement {
  const { entry } = props
  const folder = folderOf(entry.path)
  const badges = badgesFor(entry)
  const lastWrite = entry.writes?.at(-1)
  return (
    <div style={{ borderBottom: `1px solid ${colors.border}` }}>
      <button
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
        style={{ display: 'block', width: '100%', textAlign: 'left', background: props.open ? colors.hoverBackground : 'transparent', color: colors.foreground, border: 'none', padding: '6px 12px', cursor: 'pointer', font: 'inherit' }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, wordBreak: 'break-all' }}>{entry.name}</span>
          {folder !== '' ? <span style={{ fontSize: 11, color: colors.muted, wordBreak: 'break-all' }}>{folder}/</span> : null}
          {badges.map((badge) => (
            <span key={badge} style={{ ...badgeStyle(), fontSize: 10, color: colors.accent, borderColor: colors.accent }}>
              {badge}
            </span>
          ))}
        </div>
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>
          {KIND_LABEL[entry.kind]} · {formatSize(entry.size)} · changed {formatWhen(entry.modified, props.now)}
          {lastWrite !== undefined ? ` · by ${lastWrite.tool}` : ''}
        </div>
        {entry.summary !== undefined ? <div style={{ fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.summary}</div> : null}
        {lastWrite?.why !== undefined ? <div style={{ fontSize: 12, marginTop: 2, fontStyle: 'italic', color: colors.muted }}>“{lastWrite.why}”</div> : null}
      </button>

      {props.open ? (
        <div style={{ padding: '4px 12px 10px 24px' }}>
          {props.detail === undefined ? <div style={{ color: colors.muted, fontSize: 12 }}>Reading…</div> : null}
          {props.detail?.error !== undefined ? <div style={{ color: colors.error, fontSize: 12 }}>{props.detail.error}</div> : null}
          {props.detail?.info !== undefined ? <ArtifactDetails info={props.detail.info} now={props.now} /> : null}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {props.opens.open ? (
              <button type="button" style={{ ...secondaryButtonStyle(), padding: '2px 10px', fontSize: 12 }} onClick={() => props.onOpen('open')}>
                Open
              </button>
            ) : null}
            {props.opens.reveal ? (
              <button type="button" style={{ ...secondaryButtonStyle(), padding: '2px 10px', fontSize: 12 }} onClick={() => props.onOpen('reveal')}>
                Show in folder
              </button>
            ) : null}
            {props.onMention !== undefined ? (
              <button type="button" style={{ ...secondaryButtonStyle(), padding: '2px 10px', fontSize: 12 }} onClick={props.onMention} title="Put @path in the message box, so the agent reads this file">
                Mention in message
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ArtifactDetails(props: { info: ArtifactInfo; now: number }): ReactElement {
  const { info } = props
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ color: colors.muted }}>
        {info.path} · {formatSize(info.size)} · created {new Date(info.created).toLocaleString()} · changed {new Date(info.modified).toLocaleString()}
      </div>
      {info.facts.length > 0 ? <div style={{ marginTop: 4 }}>{info.facts.join(' · ')}</div> : null}
      {(info.writes ?? []).length > 0 ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontWeight: 600 }}>Written in this chat by</div>
          <ul style={{ margin: '2px 0 0 0', paddingLeft: 18 }}>
            {(info.writes ?? []).map((write, index) => (
              <li key={index}>
                <code style={{ fontFamily: monospaceFamily }}>{write.tool}</code>
                {write.why !== undefined ? ` - ${write.why}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {info.preview !== undefined ? (
        <pre style={{ marginTop: 6, maxHeight: 220, overflow: 'auto', padding: 8, background: colors.codeBlockBackground, borderRadius: 4, fontFamily: monospaceFamily, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {info.preview}
        </pre>
      ) : null}
    </div>
  )
}
