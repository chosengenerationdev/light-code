import { useState, type ReactElement } from 'react'
import { DiffView } from '../approval/DiffView.js'
import { badgeStyle, colors, fontFamily, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

export interface ReviewItem {
  id: string
  kind: 'python-tool' | 'skill'
  name: string
  content: string
  existingContent: string
  authorName: string
  submittedAt: number
  status: 'pending' | 'approved' | 'rejected'
  producedBy?: string
  decidedBy?: string
  reason?: string
}

export interface ReviewsTabProps {
  items: ReviewItem[]
  /** False for an author looking at their own submissions. */
  canDecide: boolean
  onDecide: (id: string, approved: boolean, reason?: string) => void
}

/**
 * Python tools and skills waiting to be approved.
 *
 * The queue exists because the approval gate assumes the approver is present, which is false on a
 * shared server: the person who may approve is not the person who asked. So the work is held, the
 * author's turn carries on, and this is where someone with the authority reads it.
 *
 * **The full source, always.** §13 requires approval to show what will actually run, and that is
 * no weaker for being asynchronous — if anything it matters more, because the reviewer was not in
 * the conversation that produced it and has no other context to go on.
 */
export function ReviewsTab(props: ReviewsTabProps): ReactElement {
  const pending = props.items.filter((item) => item.status === 'pending')
  const decided = props.items.filter((item) => item.status !== 'pending')

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily, fontSize: 13, color: colors.foreground }}>
      <h3 style={{ margin: '0 0 4px' }}>Review queue</h3>
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 0 }}>
        {props.canDecide
          ? 'Python tools and skills written by other people. Nothing here can run until you approve it.'
          : 'What you have submitted. An administrator has to approve it before it can run.'}
      </p>

      {pending.length === 0 && (
        <p style={{ color: colors.muted, fontSize: 12, marginTop: 14 }}>Nothing waiting.</p>
      )}

      {pending.map((item) => (
        <PendingItem key={item.id} item={item} canDecide={props.canDecide} onDecide={props.onDecide} />
      ))}

      {decided.length > 0 && (
        <section style={{ marginTop: 22, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
          <span style={labelStyle()}>Decided</span>
          {/*
            Kept for a while rather than cleared on decision: "who approved this, and when" is the
            question a review queue exists to answer afterwards.
          */}
          {decided.map((item) => (
            <div key={item.id} style={{ padding: '6px 0', borderBottom: `1px solid ${colors.border}`, fontSize: 12 }}>
              <span style={{ ...badgeStyle(), fontSize: 9, marginRight: 6 }}>{item.status}</span>
              <strong>{item.name}</strong>{' '}
              <span style={{ color: colors.muted }}>
                by {item.authorName}
                {item.decidedBy !== undefined ? `, decided by ${item.decidedBy}` : ''}
              </span>
              {item.reason !== undefined && (
                <div style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>{item.reason}</div>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

function PendingItem(props: { item: ReviewItem; canDecide: boolean; onDecide: ReviewsTabProps['onDecide'] }): ReactElement {
  const { item } = props
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 5, padding: 10, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ ...badgeStyle(), fontSize: 9 }}>{item.kind === 'python-tool' ? 'tool' : 'skill'}</span>
        <strong style={{ fontSize: 13 }}>{item.name}</strong>
        <span style={{ color: colors.muted, fontSize: 11 }}>
          from {item.authorName} · {new Date(item.submittedAt).toLocaleString()}
        </span>
      </div>

      {/*
        Where the bytes came from. A second model wrote them, and the reviewer was not in the
        conversation that asked for them — so this is the only place that can be said.
      */}
      {item.producedBy !== undefined && (
        <div style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>Written by {item.producedBy}</div>
      )}

      <button
        type="button"
        style={{ ...secondaryButtonStyle(), fontSize: 11, marginTop: 8 }}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide the source' : 'Read the source'}
      </button>

      {open && (
        <div style={{ marginTop: 8 }}>
          <DiffView path={item.name} before={item.existingContent} after={item.content} />
        </div>
      )}

      {props.canDecide ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            style={primaryButtonStyle(!open)}
            disabled={!open}
            title={open ? undefined : 'Read the source first'}
            onClick={() => props.onDecide(item.id, true)}
          >
            Approve
          </button>
          <button
            type="button"
            style={{ ...secondaryButtonStyle(), color: colors.error }}
            onClick={() => props.onDecide(item.id, false, reason.trim().length > 0 ? reason.trim() : undefined)}
          >
            Reject
          </button>
          <input
            type="text"
            aria-label="Reason for rejecting"
            placeholder="Why? The author sees this."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            style={{ ...textFieldStyle(), flex: 1, minWidth: 140 }}
          />
          {/*
            Approve is disabled until the source has been opened. Not a security control — anyone
            can open it and not read it — but approving code you have not looked at is the one
            mistake this whole queue exists to make harder, and a click that requires no step in
            between is a click people make by reflex.
          */}
          {!open && (
            <span style={{ color: colors.muted, fontSize: 11, flexBasis: '100%' }}>
              Open the source before approving it.
            </span>
          )}
        </div>
      ) : (
        <div style={{ color: colors.muted, fontSize: 11, marginTop: 8 }}>Waiting for an administrator.</div>
      )}
    </div>
  )
}
