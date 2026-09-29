import { useState, type ReactElement } from 'react'

import { tokenize, TOKEN_COLORS } from './highlight.js'
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
  /**
   * Why an approval did not take, keyed by tool.
   *
   * A tool that parses but fails to load cannot be approved at all - pinning it would have the
   * registry certifying broken code. That is right, and it used to be invisible: the row looked
   * like every other one, the reason went into a toast that scrolled past, and the only thing
   * left to do was press Approve again and watch nothing happen. Reported here, this is the row
   * that says so.
   */
  problems?: Record<string, string> | undefined
  /**
   * Tools whose approval has been sent and not yet answered. Approving loads each tool into the
   * worker, seconds apiece, and a panel that did not change in that time read as a button that
   * had not worked. The rows say so instead, and leave one by one as each tool is done.
   */
  approving?: readonly string[] | undefined
  /** How far through the current approval the host is, counting tools already done. */
  approvalProgress?: { done: number; total: number } | undefined
  /**
   * Packages each tool needs that the tools' Python environment lacks. A tool whose import fails
   * cannot be approved at all, so this is said beside it with a way to fix it, rather than left
   * to surface as "could not be loaded".
   */
  missingPackages?: Record<string, string[]> | undefined
  /** Whether Light Code may install into that environment. */
  canInstallPackages?: boolean
  install?: { running: boolean; packages: string[]; error?: string; installed?: string[] } | undefined
  onInstall?: (packages: string[]) => void
}

/**
 * A small turning arc, for the tool being checked right now. Motion is the point: a still
 * "Approving…" for ten seconds reads as hung, and the whole reason this exists is that it did.
 * `lc-spin` is switched off under reduced motion by the shared stylesheet; the words remain.
 */
function Spinner(): ReactElement {
  return (
    <svg className="lc-spin" width={12} height={12} viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="8" cy="8" r="6" fill="none" stroke={colors.border} strokeWidth="2" />
      <path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke={colors.accent} strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** Checking N of M, with a bar. Determinate, because the host reports each tool as it finishes. */
function ApprovalProgress(props: { done: number; total: number; current: string | undefined }): ReactElement {
  const fraction = props.total === 0 ? 0 : props.done / props.total
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }} role="status">
        <Spinner />
        <span>
          Checking {Math.min(props.done + 1, props.total)} of {props.total}
          {props.current !== undefined ? <> &mdash; loading py__{props.current} to make sure it runs</> : null}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={props.total}
        aria-valuenow={props.done}
        style={{ height: 3, marginTop: 4, borderRadius: 2, background: colors.border, overflow: 'hidden' }}
      >
        <div
          style={{
            height: '100%',
            width: `${String(Math.round(fraction * 100))}%`,
            background: colors.accent,
            transition: 'width 200ms linear',
          }}
        />
      </div>
    </div>
  )
}

/** Python source in the editor's own colours, the same highlighter chat code blocks use. */
function HighlightedSource(props: { source: string }): ReactElement {
  return (
    <>
      {tokenize(props.source, 'python').map((token, index) => {
        const color = TOKEN_COLORS[token.kind]
        return color === undefined ? (
          <span key={index}>{token.text}</span>
        ) : (
          <span key={index} style={{ color }}>
            {token.text}
          </span>
        )
      })}
    </>
  )
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
  const approving = new Set(props.approving ?? [])
  const busy = props.tools.filter((tool) => approving.has(tool.name)).length
  // The host checks tools one at a time, in the order they were sent, which is list order.
  const current = props.tools.find((tool) => approving.has(tool.name))?.name
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
      {props.install !== undefined && props.install.running !== true && (
        <div role="status" style={{ fontSize: 11, marginTop: 6, color: props.install.error !== undefined ? colors.error : colors.muted }}>
          {props.install.error !== undefined
            ? `Could not install ${props.install.packages.join(', ')}: ${props.install.error}`
            : `Installed ${(props.install.installed ?? props.install.packages).join(', ')}.`}
        </div>
      )}
      {busy > 0 && (
        <ApprovalProgress
          done={props.approvalProgress?.done ?? 0}
          total={Math.max(props.approvalProgress?.total ?? busy, busy)}
          current={current}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {props.tools.map((tool) => {
          const fetched = props.sources[tool.name]
          const expanded = open.includes(tool.name)
          return (
            /*
             * Keyed by path, not by name. The same tool can legitimately sit in two folders - a
             * bucket mirror beside the local one - and two rows sharing a React key is a list
             * React cannot update predictably as it shrinks.
             */
            <div
              key={tool.filePath}
              style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 6 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: monospace, fontSize: 12 }}>py__{tool.name}</span>
                {tool.kind === 'hash-mismatch' && (
                  <span style={{ color: colors.error, fontSize: 10 }}>changed</span>
                )}
                {approving.has(tool.name) ? (
                  <span
                    style={{
                      marginLeft: 'auto',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      color: colors.muted,
                      fontSize: 11,
                    }}
                  >
                    {tool.name === current ? (
                      <>
                        <Spinner />
                        Checking…
                      </>
                    ) : (
                      'Queued'
                    )}
                  </span>
                ) : (
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
                )}
              </div>
              <div
                style={{ color: colors.muted, fontSize: 10, fontFamily: monospace, marginTop: 2 }}
              >
                {tool.filePath}
              </div>
              {(props.missingPackages?.[tool.name]?.length ?? 0) > 0 && (
                <div style={{ fontSize: 11, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span>
                    Needs <code style={{ fontFamily: monospace }}>{props.missingPackages?.[tool.name]?.join(', ')}</code>,
                    not installed in the tools&apos; Python environment.
                  </span>
                  {props.canInstallPackages === true && props.onInstall !== undefined ? (
                    props.install?.running === true ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: colors.muted }} role="status">
                        <Spinner /> Installing…
                      </span>
                    ) : (
                      <button
                        type="button"
                        style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
                        title="Installs into the environment Python tools run in, from the configured package index"
                        onClick={() => props.onInstall?.([...(props.missingPackages?.[tool.name] ?? [])])}
                      >
                        Install
                      </button>
                    )
                  ) : (
                    <span style={{ color: colors.muted }}>Install them into that environment, then approve.</span>
                  )}
                </div>
              )}
              {props.problems?.[tool.name] !== undefined && (
                <div style={{ color: colors.error, fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
                  Could not be approved: {props.problems[tool.name]}. Approving again will not help
                  &mdash; fix the file, or Decline to hide it.
                </div>
              )}
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
                  {fetched?.source !== undefined ? (
                    <HighlightedSource source={fetched.source} />
                  ) : (
                    (fetched?.problem ?? 'Loading…')
                  )}
                </pre>
              )}
            </div>
          )
        })}
      </div>

      {props.tools.length > 1 && busy === 0 && (
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
