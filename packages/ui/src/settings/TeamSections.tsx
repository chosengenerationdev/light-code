import { useEffect, useState, type ReactElement } from 'react'

import type { HostToUiMessage, TeamMessage, TeamReviewView, Transport, UiToHostMessage } from '@light-code/core/browser'

import { DiffView } from '../approval/DiffView.js'
import { disabledWhen } from '../disabledWhen.js'
import { badgeStyle, colors, labelStyle, monospaceFamily, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { Panel } from './Panel.js'

/**
 * Team admins (Settings → Project) and the Team reviews tab (`team/admins.ts` in core). Self-contained, like the
 * observers' panels: each listens on the transport and asks for `team` itself.
 */

function useTeam(transport: Transport): { team: TeamMessage | undefined; result: { ok: boolean; message: string } | undefined } {
  const [team, setTeam] = useState<TeamMessage | undefined>(undefined)
  const [result, setResult] = useState<{ ok: boolean; message: string } | undefined>(undefined)
  useEffect(() => {
    const unsubscribe = transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'team') setTeam(message)
      else if (message.type === 'teamResult') setResult({ ok: message.ok, message: message.message })
    })
    transport.post({ type: 'requestTeam' } satisfies UiToHostMessage)
    return unsubscribe
  }, [transport])
  return { team, result }
}

/** "3 days 4 hours", "25 minutes": how long something has waited. */
export function waitedFor(since: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000))
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'}${minutes % 60 > 0 ? ` ${String(minutes % 60)} min` : ''}`
  const days = Math.floor(hours / 24)
  return `${String(days)} day${days === 1 ? '' : 's'}${hours % 24 > 0 ? ` ${String(hours % 24)} hour${hours % 24 === 1 ? '' : 's'}` : ''}`
}

const hint = { display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 10px' } as const

export function TeamAdminsSection(props: { transport: Transport }): ReactElement {
  const { team, result } = useTeam(props.transport)
  const stored = team?.admins?.ids.join(', ') ?? ''
  const [text, setText] = useState(stored)
  useEffect(() => setText(stored), [stored])
  if (team === undefined || !team.hasWorkspace) return <></>
  const readOnly = !team.canEditAdmins
  const typed = text.split(/[\s,;]+/).map((id) => id.trim().toLowerCase().replace(/^.*\\/, '')).filter((id) => id.length > 0)
  const withoutMe = !typed.includes(team.me)
  const dirty = text.trim() !== stored
  return (
    <Panel id="project.teamAdmins" title="Team admins" summary={team.admins !== undefined ? team.admins.ids.join(', ') : 'None yet'} defaultOpen>
      <span style={hint}>
        Admins approve changes to anybody&apos;s skills and tools. Whoever creates a skill or tool owns it; a change by anyone else goes to the owner (or an
        admin) and nobody - its author included - uses it until it is approved. Kept in the team&apos;s OpenSearch index, so everyone on this project sees the
        same admins. Until a list exists, nothing needs approval.
      </span>
      {!team.available ? (
        <div style={{ color: colors.warning, fontSize: 12 }}>{team.problem}</div>
      ) : (
        <>
          <label htmlFor="team-admins" style={labelStyle()}>
            Admins (Windows user ids)
          </label>
          <textarea
            id="team-admins"
            value={text}
            readOnly={readOnly}
            rows={2}
            spellCheck={false}
            placeholder="e.g. jsmith, a123456"
            title={readOnly ? `Only an admin can change this (${team.admins?.ids.join(', ') ?? ''}).` : 'Comma or line separated.'}
            onChange={(event) => setText(event.target.value)}
            style={{ ...textFieldStyle(), width: '100%', fontFamily: monospaceFamily, opacity: readOnly ? 0.7 : 1 }}
          />
          <span style={hint}>
            Your Windows user id: <code style={{ fontFamily: monospaceFamily }}>{team.me}</code>
            {team.admins !== undefined ? ` · set by ${team.admins.by} on ${new Date(team.admins.at).toLocaleDateString()}` : ' · the first list saved for this project wins'}
            {team.index !== undefined ? ` · index ${team.index}` : ''}
          </span>
          {!readOnly && withoutMe && typed.length > 0 ? (
            <div style={{ color: colors.warning, fontSize: 12, marginBottom: 6 }}>Your own id is not in the list: once saved, you will not be able to change it.</div>
          ) : null}
          {readOnly ? (
            <div style={{ fontSize: 12, color: colors.muted }}>Read-only: only an admin can change the team&apos;s admins.</div>
          ) : (
            <button
              type="button"
              style={primaryButtonStyle(!dirty || typed.length === 0)}
              {...disabledWhen([typed.length === 0, 'Name at least one Windows user id.'], [!dirty, 'Nothing has changed since the last save.'])}
              onClick={() => props.transport.post({ type: 'saveTeamAdmins', ids: text } satisfies UiToHostMessage)}
            >
              Save admins
            </button>
          )}
          {result !== undefined ? <div style={{ color: result.ok ? colors.foreground : colors.error, fontSize: 12, marginTop: 6 }}>{result.message}</div> : null}
        </>
      )}
    </Panel>
  )
}

/** Whether the Team reviews tab is shown: for admins, and owners with something to decide. */
export function useTeamTabVisible(transport: Transport | undefined): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (transport === undefined) return
    return transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'team') setVisible(message.showTab)
    })
  }, [transport])
  return visible
}

function ReviewCard(props: { review: TeamReviewView; transport: Transport; now: number }): ReactElement {
  const { review } = props
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const pending = review.status === 'pending'
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 6, padding: '8px 10px', margin: '8px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>{review.name}</strong>
        <span style={badgeStyle('neutral')}>{review.kind}</span>
        {pending ? (
          <span style={badgeStyle(props.now - review.at > 3 * 86_400_000 ? 'warning' : 'neutral')}>pending {waitedFor(review.at, props.now)}</span>
        ) : (
          <span style={badgeStyle('neutral')}>
            {review.status} by {review.decidedBy ?? '?'}
            {review.decidedAt !== undefined ? ` after ${waitedFor(review.at, review.decidedAt)}` : ''}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>
        Changed by {review.by} · owner {review.owner || 'nobody recorded (admins decide)'} · sent {new Date(review.at).toLocaleString()}
        {review.reason !== undefined ? ` · ${review.reason}` : ''}
      </div>
      <button type="button" style={{ ...secondaryButtonStyle(), marginTop: 6 }} onClick={() => setOpen(!open)}>
        {open ? 'Hide the change' : 'Show the change'}
      </button>
      {open ? <DiffView path={review.kind === 'tool' ? `${review.name}.py` : `${review.name}.md`} before={review.existingContent} after={review.content} /> : null}
      {review.canDecide ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            style={primaryButtonStyle(!open)}
            {...disabledWhen([!open, 'Read the change first: Show the change.'])}
            onClick={() => props.transport.post({ type: 'decideTeamReview', id: review.id, decision: 'approved' } satisfies UiToHostMessage)}
          >
            Approve and publish
          </button>
          <input
            type="text"
            value={reason}
            placeholder="Reason (optional, for a rejection)"
            onChange={(event) => setReason(event.target.value)}
            style={{ ...textFieldStyle(), flex: 1, minWidth: 140 }}
          />
          <button
            type="button"
            style={secondaryButtonStyle()}
            onClick={() => props.transport.post({ type: 'decideTeamReview', id: review.id, decision: 'rejected', ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}) } satisfies UiToHostMessage)}
          >
            Reject
          </button>
        </div>
      ) : pending ? (
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 6 }}>Waiting for {review.owner || 'a team admin'}.</div>
      ) : null}
    </div>
  )
}

export function TeamReviewsTab(props: { transport: Transport }): ReactElement {
  const { team, result } = useTeam(props.transport)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  if (team === undefined) return <p style={{ color: colors.muted }}>Loading…</p>
  if (!team.available) return <p style={{ color: colors.warning }}>{team.problem}</p>
  const pending = team.reviews.filter((r) => r.status === 'pending')
  const decided = team.reviews.filter((r) => r.status !== 'pending')
  const oldest = pending.reduce<number | undefined>((min, r) => (min === undefined || r.at < min ? r.at : min), undefined)
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>
          {String(pending.length)} change{pending.length === 1 ? '' : 's'} waiting
        </strong>
        {oldest !== undefined ? <span style={{ color: colors.muted, fontSize: 12 }}>oldest waiting {waitedFor(oldest, now)}</span> : null}
        <span style={{ flex: 1 }} />
        <button type="button" style={secondaryButtonStyle()} onClick={() => props.transport.post({ type: 'requestTeam' } satisfies UiToHostMessage)}>
          Refresh
        </button>
      </div>
      <span style={hint}>
        {team.isAdmin ? 'As an admin you see every change to the team\'s skills and tools.' : 'Changes to skills and tools you own.'} An approved change is published where
        the team keeps it and reaches everyone at their next sync; a tool&apos;s code is still approved once on each computer.
      </span>
      {result !== undefined ? <div style={{ color: result.ok ? colors.foreground : colors.error, fontSize: 12, margin: '6px 0' }}>{result.message}</div> : null}
      {pending.map((review) => (
        <ReviewCard key={review.id} review={review} transport={props.transport} now={now} />
      ))}
      {decided.length > 0 ? (
        <Panel id="teamReviews.decided" title="Decided in the last 30 days" summary={String(decided.length)}>
          {decided.map((review) => (
            <ReviewCard key={review.id} review={review} transport={props.transport} now={now} />
          ))}
        </Panel>
      ) : null}
    </div>
  )
}
