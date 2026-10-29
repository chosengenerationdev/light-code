import type { HostToUiMessage, TeamRepoSettings, TeamRepoStatus, Transport, UiToHostMessage } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'

import { disabledWhen } from '../disabledWhen.js'
import { colors, labelStyle, monospaceFamily, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { Panel } from './Panel.js'

/**
 * The team's Bitbucket repository for skills and Python tools (core \`teamrepo/sync.ts\`).
 *
 * Self-contained, as the Usage tab is: it asks the host for its state and listens for it, so nothing is
 * threaded through the app. Offered only once Bitbucket is set up - the repository is reached with that
 * connection and its token.
 */

type Message = Extract<HostToUiMessage, { type: 'teamRepo' }>

const hintStyle = { display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 10px' } as const

function field(id: string, label: string, value: string, onChange: (value: string) => void, placeholder: string, hint?: string): ReactElement {
  return (
    <div>
      <label htmlFor={id} style={labelStyle()}>
        {label}
      </label>
      <input id={id} type="text" value={value} spellCheck={false} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} style={textFieldStyle()} />
      {hint !== undefined && <span style={hintStyle}>{hint}</span>}
    </div>
  )
}

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function StatusView(props: { status: TeamRepoStatus }): ReactElement {
  const { status } = props
  if (status.error !== undefined) {
    return (
      <div role="alert" style={{ color: colors.error, fontSize: 12, marginTop: 8 }}>
        Last sync, {when(status.at)}: failed - {status.error}
      </div>
    )
  }
  const list = (title: string, items: readonly string[], colour?: string): ReactElement | null =>
    items.length === 0 ? null : (
      <details style={{ marginTop: 4 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: colour }}>
          {title} ({items.length})
        </summary>
        <ul style={{ margin: '4px 0', paddingLeft: 18, fontFamily: monospaceFamily, fontSize: 11 }}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </details>
    )
  return (
    <div style={{ marginTop: 8, fontSize: 12 }}>
      <div style={{ color: colors.muted }}>
        Last sync {when(status.at)}
        {status.branch !== undefined ? ` on ${status.branch}` : ''}: {status.pushed.length} committed, {status.pulled.length} brought in
        {status.removed.length > 0 ? `, ${String(status.removed.length)} removed from the team copy` : ''}.
        {status.branchCreated !== undefined ? ` Created branch ${status.branchCreated}.` : ''}
      </div>
      {status.conflicts.length > 0 && (
        <details open style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: colors.error }}>Not synced - nothing was overwritten ({status.conflicts.length})</summary>
          <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 11 }}>
            {status.conflicts.map((conflict) => (
              <li key={conflict.path}>
                <code style={{ fontFamily: monospaceFamily }}>{conflict.path}</code> - {conflict.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {list('Newer in the repository - your copy is unchanged; it catches up with the next bucket sync, and the team copy already has it', status.behind ?? [])}
      {list('Deleted here, still in the repository - remove them in Bitbucket if they should go', status.deletedHere)}
      {list('Committed', status.pushed)}
      {list('Brought in', status.pulled)}
    </div>
  )
}

/**
 * Switching the S3 bucket folders off once the repository holds everything they do. Two presses: Check
 * (syncs, then compares every bucket file with the repository) and, only when that came back clean, the
 * switch itself - which the host checks again before unticking anything.
 */
function RetireBuckets(props: { message: Message; transport: Transport }): ReactElement {
  const { message } = props
  const retire = message.retire
  const folders = message.bucketFolders ?? []
  const busy = retire?.checking === true || message.syncing === true
  const noBuckets = folders.length === 0
  const noBucketsWhy = 'No S3 bucket folders are syncing skills or tools - there is nothing to switch off.'
  const post = (confirm: boolean): void => props.transport.post({ type: 'retireS3Buckets', confirm } satisfies UiToHostMessage)
  return (
    <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${colors.border}` }}>
      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Use the repository instead of the S3 bucket</div>
      {retire?.done !== undefined ? (
        <div role="status" style={{ fontSize: 12 }}>{retire.done}</div>
      ) : (
        <>
          <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
            {noBuckets
              ? 'No S3 bucket folders are syncing skills or tools, so there is nothing to switch off.'
              : `Switches the skills and tools bucket folders off together once every file in them is in the repository: ${folders.join('; ')}. Nothing is deleted, and ticking them again in Settings → S3 undoes it. New skills and tools are then saved in this project's folders and committed to the repository. Colleagues who still rely on the bucket alone will stop receiving yours, so switch over together.`}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              style={secondaryButtonStyle()}
              {...disabledWhen([noBuckets, noBucketsWhy], [busy, 'A sync or check is running.'], { enabledTitle: 'Sync, then check that the repository holds everything in the bucket folders' })}
              onClick={() => post(false)}
            >
              {retire?.checking === true ? 'Checking…' : 'Check'}
            </button>
            <button
              type="button"
              style={primaryButtonStyle(retire?.ready !== true || busy)}
              {...disabledWhen(
                [noBuckets, noBucketsWhy],
                [retire?.ready !== true, 'Press Check first - this is offered only when the repository holds everything in the bucket folders.'],
                [busy, 'A sync or check is running.'],
                { enabledTitle: 'Checks once more, then switches the bucket folders off' },
              )}
              onClick={() => post(true)}
            >
              Switch bucket folders off
            </button>
          </div>
          {retire !== undefined && retire.checking !== true && retire.ready && (
            <div role="status" style={{ fontSize: 12, marginTop: 6 }}>
              Ready: {retire.covered.skills} skill file(s) and {retire.covered.tools} tool(s) from the bucket are in the repository.
            </div>
          )}
          {retire !== undefined && retire.checking !== true && !retire.ready && retire.problems.length > 0 && (
            <details open style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: colors.error }}>Not yet - {retire.problems.length} to sort out first</summary>
              <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 11 }}>
                {retire.problems.slice(0, 50).map((problem) => (
                  <li key={problem} style={{ fontFamily: monospaceFamily }}>{problem}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}

export function TeamRepoPanel(props: { transport: Transport }): ReactElement {
  const [state, setState] = useState<Message | undefined>(undefined)
  const [draft, setDraft] = useState<TeamRepoSettings | undefined>(undefined)
  const savedKey = state === undefined ? '' : JSON.stringify(state.settings)

  useEffect(() => {
    const stop = props.transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'teamRepo') setState(message)
    })
    props.transport.post({ type: 'requestTeamRepo' } satisfies UiToHostMessage)
    return stop
  }, [props.transport])
  // Resynced by value, so a status update does not discard a half-typed field.
  useEffect(() => {
    if (savedKey.length > 0) setDraft(JSON.parse(savedKey) as TeamRepoSettings)
  }, [savedKey])

  if (state === undefined || draft === undefined) {
    return (
      <Panel id="atlassian.teamRepo" title="Team repository for skills and tools" summary="Loading…">
        <span style={{ color: colors.muted, fontSize: 12 }}>Loading…</span>
      </Panel>
    )
  }
  const set = (change: Partial<TeamRepoSettings>): void => setDraft({ ...draft, ...change })
  const dirty = JSON.stringify(draft) !== savedKey
  const summary = !state.available
    ? 'Needs Bitbucket'
    : !state.settings.enabled
      ? 'Off'
      : `${state.settings.project}/${state.settings.repo} · ${state.settings.branch}${state.status?.error !== undefined || (state.status?.conflicts.length ?? 0) > 0 ? ' · needs attention' : ''}`

  return (
    <Panel id="atlassian.teamRepo" title="Team repository for skills and tools" summary={summary}>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 10px' }}>
        A Bitbucket repository - not your working folder&apos;s - where everyone&apos;s skills and Python tools are kept. Everything
        your skills and tools load from - your folders and S3 bucket folders - is committed there as it is written and
        changed, and your colleagues&apos; are brought back to you, every few minutes.
        A colleague&apos;s change is never overwritten: a file changed on both sides is reported, not replaced. Tools from the
        repository still need approving once on each machine before they run. A skill or tool you delete stays in the
        repository until someone removes it there.
      </p>
      {!state.available && (
        <div role="note" style={{ fontSize: 12, marginBottom: 8 }}>
          {state.reason ?? 'Set up Bitbucket above first.'}
        </div>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: state.available ? 'pointer' : 'default' }}>
        <input type="checkbox" checked={draft.enabled} disabled={!state.available} title={state.available ? undefined : 'Set up Bitbucket above first.'} onChange={(event) => set({ enabled: event.target.checked })} />
        <span>Keep the team&apos;s skills and tools in this repository</span>
      </label>
      {field('lc-teamrepo-project', 'Project key', draft.project, (value) => set({ project: value }), 'e.g. TEAM', 'As in the repository address: /projects/TEAM/repos/…')}
      {field('lc-teamrepo-repo', 'Repository slug', draft.repo, (value) => set({ repo: value }), 'e.g. light-code-skills')}
      {field('lc-teamrepo-branch', 'Branch', draft.branch, (value) => set({ branch: value }), 'main', 'Where changes are committed. If your team cannot commit to main, name another branch; it is created from the default branch when it does not exist.')}
      {field('lc-teamrepo-folder', 'Folder in the repository (optional)', draft.folder, (value) => set({ folder: value }), 'e.g. light-code', 'Holds skills/ and tools/. Empty means the top of the repository.')}
      <div>
        <label htmlFor="lc-teamrepo-minutes" style={labelStyle()}>
          Sync every (minutes)
        </label>
        <input
          id="lc-teamrepo-minutes"
          type="number"
          min={1}
          value={String(draft.syncMinutes)}
          onChange={(event) => set({ syncMinutes: Number(event.target.value) || 15 })}
          style={{ ...textFieldStyle(), width: 100 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          style={primaryButtonStyle(!dirty)}
          {...disabledWhen([!dirty, 'Nothing has changed since the last save.'], [!state.available, 'Set up Bitbucket above first.'])}
          onClick={() => props.transport.post({ type: 'saveTeamRepo', settings: draft } satisfies UiToHostMessage)}
        >
          Save
        </button>
        <button
          type="button"
          style={secondaryButtonStyle()}
          {...disabledWhen(
            [!state.settings.enabled, 'Switch it on and save first.'],
            [dirty, 'Save your changes first.'],
            [state.syncing === true, 'A sync is running.'],
            { enabledTitle: 'Commit your changes and bring in your colleagues’ now' },
          )}
          onClick={() => props.transport.post({ type: 'syncTeamRepo' } satisfies UiToHostMessage)}
        >
          {state.syncing === true ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      {state.saveError !== undefined && (
        <div role="alert" style={{ color: colors.error, fontSize: 12, marginTop: 6 }}>
          Not saved: {state.saveError}
        </div>
      )}
      {state.savedIn !== undefined && (
        <div style={{ color: colors.muted, fontSize: 11, marginTop: 8 }}>
          New skills are saved in <code style={{ fontFamily: monospaceFamily }}>{state.savedIn.skills ?? '-'}</code> and new Python tools in{' '}
          <code style={{ fontFamily: monospaceFamily }}>{state.savedIn.tools ?? '-'}</code> - outside the project, so they never land in its git. Choose another in
          Settings → Skills and Settings → Python.
        </div>
      )}
      {state.status !== undefined && <StatusView status={state.status} />}
      {state.settings.enabled && (
        <RetireBuckets message={state} transport={props.transport} />
      )}
    </Panel>
  )
}
