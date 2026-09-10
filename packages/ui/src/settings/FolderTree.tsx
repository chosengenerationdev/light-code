import { useMemo, useState, type ReactElement } from 'react'
import { colors, textFieldStyle } from '../theme.js'

export interface MailFolderNode {
  name: string
  path: string
  depth: number
  unread?: number | null
}

export interface FolderTreeProps {
  folders: readonly MailFolderNode[]
  selected: readonly string[]
  onChange: (next: string[]) => void
  /** True when the whole subtree under a ticked folder is indexed too. */
  includeSubfolders: boolean
}

/**
 * Picking mail folders from the mailbox rather than typing their paths.
 *
 * ## Why this replaced a text box
 *
 * A typed path is a guess. It has to match a separator convention, may or may not need the
 * mailbox name, and is wrong in ways that look right — the previous version accepted anything
 * and the sync then indexed nothing from it, which nobody would notice for weeks. A tree cannot
 * be mistyped: every path in it came from Outlook.
 *
 * ## What a tick means
 *
 * The folder itself, and — when *Include subfolders* is on — everything beneath it. Only the
 * ticked folder is stored, never its expansion: storing the expansion would freeze the tree as it
 * was on the day it was ticked, so a new subfolder created next month would silently never be
 * indexed. Resolving it at sync time is what makes "everything under Alerts" keep meaning that.
 *
 * A folder inside a ticked subtree is shown as covered rather than ticked, because unticking
 * something that was never ticked is a control nobody can predict.
 */
export function FolderTree(props: FolderTreeProps): ReactElement {
  const [filter, setFilter] = useState('')
  /*
   * Collapsed by path, and collapsing hides descendants rather than the folder itself.
   *
   * A real mailbox is hundreds of folders deep in places, and the tree was a flat scroll of all
   * of them. Note a *ticked* folder is never hidden by a collapse: it would look as though the
   * selection had been lost, and a setting that appears to have forgotten itself is the one
   * report this project keeps getting.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string> | undefined>(undefined)

  const selected = useMemo(() => new Set(props.selected), [props.selected])

  /** Whether an ancestor is ticked, which is what "covered" means. */
  const coveredBy = (path: string): string | undefined => {
    if (!props.includeSubfolders) return undefined
    for (const entry of props.selected) {
      if (entry !== path && path.startsWith(`${entry}\\`)) return entry
    }
    return undefined
  }

  const hasChildren = useMemo(() => {
    const parents = new Set<string>()
    for (const folder of props.folders) {
      const cut = folder.path.lastIndexOf('\\')
      if (cut > 0) parents.add(folder.path.slice(0, cut))
    }
    return parents
  }, [props.folders])

  /*
   * Collapsed until told otherwise.
   *
   * `undefined` means "not chosen yet" and resolves to every parent collapsed, which is why it is
   * not simply seeded with `hasChildren`: that is computed from props that arrive after the first
   * render, so seeding would fix the set while the tree was still empty and expand everything the
   * moment it loaded.
   */
  const collapsedNow = collapsed ?? hasChildren

  const toggleCollapsed = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current ?? hasChildren)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle.length === 0) {
      if (collapsedNow.size === 0) return props.folders
      return props.folders.filter((folder) => {
        // Kept when ticked, whatever is collapsed above it: a selection that vanished from view
        // reads as a selection that was lost.
        if (props.selected.includes(folder.path)) return true
        for (const parent of collapsedNow) {
          if (folder.path.startsWith(`${parent}\\`)) return false
        }
        return true
      })
    }
    /*
     * A match keeps its ancestors, or the result is a flat list of leaves with no indication of
     * where they live — and two folders called `Alerts` in different mailboxes are indistinguishable.
     */
    const keep = new Set<string>()
    for (const folder of props.folders) {
      if (!folder.path.toLowerCase().includes(needle)) continue
      keep.add(folder.path)
      const parts = folder.path.split('\\')
      for (let index = 1; index < parts.length; index++) keep.add(parts.slice(0, index).join('\\'))
    }
    return props.folders.filter((folder) => keep.has(folder.path))
  }, [props.folders, filter, collapsedNow, props.selected])

  const toggle = (path: string): void => {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    props.onChange(props.folders.map((folder) => folder.path).filter((path) => next.has(path)))
  }

  if (props.folders.length === 0) {
    return (
      <span style={{ color: colors.muted, fontSize: 11 }}>
        No folders loaded. Press Refresh, or check Outlook is running.
      </span>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        {/*
          Two buttons rather than one that toggles: with a partly-collapsed tree a single control
          has no honest label, and pressing it does whichever of the two you were not expecting.
        */}
        <button
          type="button"
          style={{
            background: 'none',
            border: 'none',
            color: colors.accent,
            cursor: 'pointer',
            padding: 0,
            fontSize: 11,
          }}
          onClick={() => setCollapsed(new Set(hasChildren))}
        >
          Collapse all
        </button>
        <button
          type="button"
          style={{
            background: 'none',
            border: 'none',
            color: colors.accent,
            cursor: 'pointer',
            padding: 0,
            fontSize: 11,
          }}
          onClick={() => setCollapsed(new Set())}
        >
          Expand all
        </button>
        <span style={{ color: colors.muted, fontSize: 11 }}>
          {`${String(props.selected.length)} selected of ${String(props.folders.length)}`}
        </span>
      </div>

      {props.folders.length > 12 && (
        <input
          type="text"
          value={filter}
          spellCheck={false}
          placeholder={`Filter ${String(props.folders.length)} folders…`}
          aria-label="Filter folders"
          onChange={(event) => setFilter(event.target.value)}
          style={{ ...textFieldStyle(), marginBottom: 6 }}
        />
      )}

      <div
        className="lc-scroll"
        style={{
          maxHeight: 260,
          overflowY: 'auto',
          border: `1px solid ${colors.border}`,
          borderRadius: 4,
          padding: 6,
        }}
      >
        {visible.map((folder) => {
          const covered = coveredBy(folder.path)
          const ticked = selected.has(folder.path)
          return (
            <label
              key={folder.path}
              title={folder.path}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                padding: '2px 0',
                paddingLeft: folder.depth * 14,
                cursor: covered === undefined ? 'pointer' : 'default',
                opacity: covered === undefined ? 1 : 0.65,
              }}
            >
              {/*
                Outside the checkbox's label, so expanding a branch never ticks it. The two are
                different acts on the same row and one must not perform the other.
              */}
              {hasChildren.has(folder.path) ? (
                <button
                  type="button"
                  aria-label={collapsedNow.has(folder.path) ? `Expand ${folder.name}` : `Collapse ${folder.name}`}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: colors.muted,
                    cursor: 'pointer',
                    padding: 0,
                    width: 12,
                    fontSize: 10,
                    lineHeight: '12px',
                  }}
                  onClick={(event) => {
                    event.preventDefault()
                    toggleCollapsed(folder.path)
                  }}
                >
                  {collapsedNow.has(folder.path) ? '▶' : '▼'}
                </button>
              ) : (
                <span style={{ width: 12 }} />
              )}
              <input
                type="checkbox"
                checked={ticked || covered !== undefined}
                disabled={covered !== undefined}
                onChange={() => toggle(folder.path)}
              />
              <span style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>
                {folder.name}
                {typeof folder.unread === 'number' && folder.unread > 0 && (
                  <span style={{ color: colors.muted }}> ({String(folder.unread)} unread)</span>
                )}
                {covered !== undefined && (
                  <span style={{ color: colors.muted, fontSize: 11 }}> — covered by {covered.split('\\').pop()}</span>
                )}
              </span>
            </label>
          )
        })}
      </div>

      <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 4 }}>
        {selected.size === 0 ? 'Nothing selected — nothing will be indexed.' : `${String(selected.size)} folder(s) selected`}
      </span>
    </div>
  )
}
