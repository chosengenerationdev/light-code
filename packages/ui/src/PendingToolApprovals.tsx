import { useState, type ReactElement } from 'react'

import { colors, fontFamily, primaryButtonStyle, secondaryButtonStyle } from './theme.js'

/**
 * Python tools waiting to be read, shown in the chat until somebody deals with them.
 *
 * ## Why it lives in the chat and not only in Settings
 *
 * The Python tab has always listed refused tools, and that is where nobody was looking. A tool
 * synced from the team's bucket is *useless* until it is approved, and the moment you find that
 * out is the moment you asked the assistant to do something and it could not. Putting the list in
 * front of the conversation is what closes that gap.
 *
 * It is **derived state, not a message**: rendered from the Python status the panel already
 * receives, so it appears when a sync brings something down, survives a reload, and disappears on
 * its own the moment the list is empty. A posted message would have to be cleaned up by somebody.
 *
 * ## Why "Approve all" still shows the source
 *
 * §13's requirement is that a human sees the source once — not that they press a button per file.
 * So a bulk action is legitimate exactly when the code was on screen, and that is what this
 * enforces: the bulk button expands every source first and only then offers to approve. It is two
 * clicks instead of one, and the difference between them is whether anybody could have read it.
 *
 * ## Declining deletes nothing
 *
 * "No" is a judgement made in a second and people make it by mistake, so it only records the hash
 * of what was read. The file stays, Settings → Python lists it, and restoring costs nothing. A
 * version published later comes back on its own, because the decline was about those bytes.
 */

export interface PendingTool {
  name: string
  filePath: string
  /** `unapproved` is new here; `hash-mismatch` changed after it was approved. */
  kind: 'unapproved' | 'hash-mismatch'
}

export interface PendingToolApprovalsProps {
  tools: PendingTool[]
  /** Sources already fetched, keyed by tool name. */
  sources: Record<string, { source?: string; problem?: string }>
  onRequestSource: (name: string) => void
  onApprove: (names: string[]) => void
  onDecline: (names: string[]) => void
}

export function PendingToolApprovals(props: PendingToolApprovalsProps): ReactElement | null {
  const [open, setOpen] = useState<string[]>([])
  const [reviewingAll, setReviewingAll] = useState(false)

  if (props.tools.length === 0) return null

  const show = (name: string): void => {
    if (!open.includes(name)) setOpen((current) => [...current, name])
    if (props.sources[name] === undefined) props.onRequestSource(name)
  }

  const showAll = (): void => {
    setReviewingAll(true)
    for (const tool of props.tools) show(tool.name)
  }

  const names = props.tools.map((tool) => tool.name)
  const changed = props.tools.filter((tool) => tool.kind === 'hash-mismatch').length

  return (
    <div
      style={{
        fontFamily,
        margin: '8px 0',
        padding: 12,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        background: colors.inputBackground,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>
        {props.tools.length} Python tool{props.tools.length === 1 ? '' : 's'} waiting for you
      </div>
      <div style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>
        {/*
          The two kinds need different words. "New" and "changed since you approved it" are not the
          same news, and the second is the one worth reading carefully.
        */}
        {changed === 0
          ? 'Read the source before approving. Nothing here can run until you do.'
          : `${String(changed)} changed after you approved ${changed === 1 ? 'it' : 'them'} — read what changed.`}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {props.tools.map((tool) => {
          const fetched = props.sources[tool.name]
          const expanded = open.includes(tool.name)
          return (
            <div key={tool.name} style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: monospace, fontSize: 12 }}>py__{tool.name}</span>
                {tool.kind === 'hash-mismatch' && (
                  <span style={{ color: colors.error, fontSize: 10 }}>changed</span>
                )}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
                    onClick={() =>
                      expanded
                        ? setOpen((current) => current.filter((entry) => entry !== tool.name))
                        : show(tool.name)
                    }
                  >
                    {expanded ? 'Hide source' : 'View source'}
                  </button>
                  <button
                    type="button"
                    style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
                    onClick={() => props.onApprove([tool.name])}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
                    title="Hide it. The file stays, and Settings → Python can restore it."
                    onClick={() => props.onDecline([tool.name])}
                  >
                    Decline
                  </button>
                </span>
              </div>
              <div
                style={{ color: colors.muted, fontSize: 10, fontFamily: monospace, marginTop: 2 }}
              >
                {tool.filePath}
              </div>
              {expanded && (
                <pre
                  style={{
                    margin: '6px 0 0 0',
                    padding: 8,
                    maxHeight: 260,
                    overflow: 'auto',
                    background: colors.background,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 4,
                    fontFamily: monospace,
                    fontSize: 11,
                    whiteSpace: 'pre',
                  }}
                >
                  {fetched?.source ?? fetched?.problem ?? 'Loading…'}
                </pre>
              )}
            </div>
          )
        })}
      </div>

      {props.tools.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
          {reviewingAll ? (
            <button
              type="button"
              style={primaryButtonStyle(false)}
              onClick={() => props.onApprove(names)}
            >
              Approve all {props.tools.length}
            </button>
          ) : (
            <button type="button" style={secondaryButtonStyle()} onClick={showAll}>
              Review all {props.tools.length}
            </button>
          )}
          <button
            type="button"
            style={secondaryButtonStyle()}
            onClick={() => props.onDecline(names)}
          >
            Decline all
          </button>
          <span style={{ color: colors.muted, fontSize: 10 }}>
            {reviewingAll ? 'Sources are shown above.' : 'Shows every source, then offers to approve.'}
          </span>
        </div>
      )}
    </div>
  )
}

const monospace = 'var(--vscode-editor-font-family, monospace)'
