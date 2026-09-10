import { useEffect, useState, type ReactElement } from 'react'
import { Select } from '../Select.js'
import { colors, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

export interface MailStatusState {
  enabled: boolean
  /** False on a machine where Outlook access is off or unavailable. */
  available: boolean
  folders: string[]
  syncMinutes: number
  retentionMonths: number
  indexed: number
  oldest?: number
  newest?: number
  sizeBytes: number
  /** Whether a vector store and embedder are configured, so meaning-ranking is possible. */
  semantic: boolean
  /** Which store mail is embedded into. Absent means whichever is active. */
  storeId?: string
  /** Every configured connection, so this can be chosen rather than hand-edited. */
  stores: { id: string; label: string }[]
  busy?: boolean
  lastResult?: string
}

export interface MailSectionProps {
  status: MailStatusState | undefined
  onSave: (settings: {
    enabled: boolean
    folders: string[]
    syncMinutes: number
    retentionMonths: number
    storeId: string
  }) => void
  onSyncNow: () => void
  onPrune: () => void
  /** Checks one path against the live mailbox. The reply arrives as `validation`. */
  onValidateFolder: (path: string) => void
  validation: FolderValidation | undefined
}

export interface FolderValidation {
  /** What was asked about, so a late reply cannot be shown against a different entry. */
  requested: string
  ok: boolean
  canonical?: string
  how?: string
  items?: number
  error?: string
  suggestions?: string[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Indexing Outlook mail, and keeping it from growing without bound.
 *
 * ## Why the destination is stated before the switch
 *
 * This is the largest egress in the product after codebase indexing, and it is somebody's mail.
 * The same rule the indexing section follows applies here: the user should not have to infer
 * from a checkbox that enabling it sends the contents of named folders to an embedding endpoint.
 * So it says so, above the control, in those words.
 *
 * ## Why retention is months rather than a size cap
 *
 * "Keep six months" is a decision somebody can make about their own mailbox. "Keep 200MB" is
 * not — nobody knows what that is in messages. The size is still shown, because the user asked
 * to be able to see it growing before deciding, and a retention control with no indication of
 * what it would reclaim is a guess.
 */
export function MailSection(props: MailSectionProps): ReactElement {
  const [enabled, setEnabled] = useState(false)
  const [folders, setFolders] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [checking, setChecking] = useState<string | undefined>(undefined)
  const [syncMinutes, setSyncMinutes] = useState('15')
  const [retentionMonths, setRetentionMonths] = useState('6')
  const [storeId, setStoreId] = useState('')

  // Resynced rather than seeded once: the host's reply can arrive after this renders.
  useEffect(() => {
    if (props.status === undefined) return
    setEnabled(props.status.enabled)
    setFolders(props.status.folders)
    setSyncMinutes(String(props.status.syncMinutes))
    setRetentionMonths(String(props.status.retentionMonths))
    setStoreId(props.status.storeId ?? '')
  }, [props.status])

  const status = props.status

  /*
   * A validated folder is added under the name Outlook uses, not the one that was typed.
   *
   * Storing what someone typed would work today and break the first time two paths were compared
   * - `inbox/alerts` and `mailbox@x\\Inbox\\Alerts` are the same folder and no string
   * comparison will ever agree.
   */
  useEffect(() => {
    const reply = props.validation
    if (reply === undefined || checking === undefined) return
    if (reply.requested !== checking) return
    setChecking(undefined)
    if (!reply.ok) return
    const canonical = reply.canonical ?? reply.requested
    setFolders((current) => (current.includes(canonical) ? current : [...current, canonical]))
    setDraft('')
  }, [props.validation, checking])

  const addFolder = (): void => {
    const wanted = draft.trim()
    if (wanted.length === 0) return
    setChecking(wanted)
    props.onValidateFolder(wanted)
  }

  const save = (): void => {
    props.onSave({
      enabled,
      folders,
      syncMinutes: Math.max(5, Math.min(1440, Number(syncMinutes) || 15)),
      retentionMonths: Math.max(1, Math.min(120, Number(retentionMonths) || 6)),
      storeId,
    })
  }

  /*
   * Nothing interactive until the host has said whether this is even possible.
   *
   * Rendering the form first would invite someone to tick a box and name folders on a machine
   * with no Outlook access at all, and then wonder why nothing happened. The reply arrives in
   * milliseconds; the placeholder is what stops a wrong assumption being offered in the gap.
   */
  if (status === undefined) {
    return (
      <section style={{ marginTop: 18 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>Mail index</h3>
        <p style={{ margin: 0, color: colors.muted, fontSize: 11 }}>Checking…</p>
      </section>
    )
  }

  if (!status.available) {
    return (
      <section style={{ marginTop: 18 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>Mail index</h3>
        <p style={{ margin: 0, color: colors.muted, fontSize: 11 }}>
          Needs Outlook access, which is Windows only and is switched on in Settings &rarr; Tools.
          Until then this does nothing rather than half-working.
        </p>
      </section>
    )
  }

  return (
    <section style={{ marginTop: 18 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>Mail index</h3>

      {/*
        Before the switch, deliberately. Enabling this sends the subject, sender and the opening
        of every message in the named folders to whichever embedding endpoint is configured.
      */}
      <p style={{ margin: '0 0 8px', color: colors.muted, fontSize: 11 }}>
        Indexes the folders below so the assistant can answer &ldquo;any alerts in the last six
        hours&rdquo; and &ldquo;does this happen every day at the same time&rdquo;.{' '}
        <strong>
          Subjects, senders and the opening of each message are sent to your configured embedding
          endpoint
        </strong>{' '}
        and stored in the vector store you chose for mail &mdash; set that separately in Search if
        you want mail kept off a shared cluster. Times and subjects are also kept locally so the
        &ldquo;last N hours&rdquo; questions are answered exactly rather than approximately.
      </p>

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 8 }}>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} style={{ marginTop: 2 }} />
        <span>
          <span style={{ display: 'block', fontSize: 13 }}>Index mail automatically</span>
          <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
            New messages are collected on a timer. Unticking stops the timer entirely &mdash;
            nothing is read while it is off.
          </span>
        </span>
      </label>

      <label htmlFor="lc-mail-folder-add" style={labelStyle()}>
        Folders to index
      </label>
      {/*
        Checked when it is added rather than when the sync runs.

        A mistyped folder is otherwise invisible: the sync succeeds, indexes nothing from it, and
        nobody finds out until they ask about mail that should have been there. Validating on the
        button turns that into an immediate no.
      */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          id="lc-mail-folder-add"
          type="text"
          value={draft}
          spellCheck={false}
          placeholder="Inbox\\Alerts"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addFolder()
            }
          }}
          style={{ ...textFieldStyle(), flex: 1 }}
        />
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={draft.trim().length === 0 || checking !== undefined}
          title="Check this folder exists, then add it"
          onClick={addFolder}
        >
          {checking !== undefined ? 'Checking…' : '+ Add'}
        </button>
      </div>
      <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
        Either slash works, and the mailbox name is optional &mdash; <code>Inbox\\Alerts</code> is
        enough unless two mailboxes both have one. Use outlook_folders in the chat to list them.
      </span>

      {props.validation !== undefined && props.validation.requested === draft.trim() && !props.validation.ok && (
        <div style={{ color: colors.error, fontSize: 11, marginTop: 4 }}>
          <span style={{ display: 'block' }}>{props.validation.error ?? 'That folder was not found.'}</span>
          {/*
            Suggestions rather than a bare refusal: told only that it does not exist, someone
            guesses again; shown that `Inbox\Alerts` does exist, they are finished.
          */}
          {(props.validation.suggestions ?? []).length > 0 && (
            <span style={{ display: 'block', color: colors.muted, marginTop: 2 }}>
              Did you mean:{' '}
              {(props.validation.suggestions ?? []).map((suggestion, index) => (
                <span key={suggestion}>
                  {index > 0 && ', '}
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: colors.accent, cursor: 'pointer', padding: 0, fontSize: 11 }}
                    onClick={() => setDraft(suggestion)}
                  >
                    {suggestion}
                  </button>
                </span>
              ))}
            </span>
          )}
        </div>
      )}

      <div style={{ marginTop: 6 }}>
        {folders.length === 0 ? (
          <span style={{ color: colors.muted, fontSize: 11 }}>
            No folders yet. Nothing is indexed until at least one is added.
          </span>
        ) : (
          folders.map((folder) => (
            <div
              key={folder}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '3px 0',
                borderBottom: `1px solid ${colors.border}`,
              }}
            >
              <code style={{ fontSize: 11, fontFamily: 'var(--vscode-editor-font-family, monospace)', minWidth: 0, overflowWrap: 'anywhere' }}>
                {folder}
              </code>
              <button
                type="button"
                style={{ background: 'none', border: 'none', color: colors.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
                title={`Stop indexing ${folder}`}
                aria-label={`Remove ${folder}`}
                onClick={() => setFolders((current) => current.filter((entry) => entry !== folder))}
              >
                &times;
              </button>
            </div>
          ))
        )}
      </div>

      <div style={{ marginTop: 8 }}>
        <label htmlFor="lc-mail-store" style={labelStyle()}>
          Store mail in
        </label>
        <Select
          id="lc-mail-store"
          value={storeId}
          options={[
            { value: '', label: 'The active search connection' },
            ...status.stores.map((store) => ({ value: store.id, label: store.label })),
          ]}
          onChange={setStoreId}
          ariaLabel="Vector store for indexed mail"
        />
        <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
          Choose a separate connection to keep mail off a shared cluster &mdash; a Qdrant or Chroma
          container on this machine is the usual answer. Add connections in Settings &rarr; Search.
          Changing this points at a new, empty collection; the old one keeps its data until you
          delete it.
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="lc-mail-sync" style={labelStyle()}>
            Check every (minutes)
          </label>
          <input
            id="lc-mail-sync"
            type="text"
            inputMode="numeric"
            value={syncMinutes}
            onChange={(event) => setSyncMinutes(event.target.value)}
            style={textFieldStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="lc-mail-retention" style={labelStyle()}>
            Keep for (months)
          </label>
          <input
            id="lc-mail-retention"
            type="text"
            inputMode="numeric"
            value={retentionMonths}
            onChange={(event) => setRetentionMonths(event.target.value)}
            style={textFieldStyle()}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={primaryButtonStyle(false)} onClick={save}>
          Save
        </button>
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={status?.busy === true || !enabled}
          onClick={props.onSyncNow}
        >
          {status?.busy === true ? 'Working…' : 'Sync now'}
        </button>
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={status?.busy === true || (status?.indexed ?? 0) === 0}
          title={`Remove indexed mail older than ${retentionMonths} months`}
          onClick={props.onPrune}
        >
          Remove older than {retentionMonths}m
        </button>
      </div>

      {status !== undefined && (
        <div style={{ marginTop: 8, color: colors.muted, fontSize: 11 }}>
          <span style={{ display: 'block' }}>
            {status.indexed === 0
              ? 'Nothing indexed yet.'
              : `${String(status.indexed)} message(s), ${formatSize(status.sizeBytes)} on disk` +
                `${status.oldest !== undefined ? `, oldest ${new Date(status.oldest).toLocaleDateString()}` : ''}.`}
          </span>
          {/*
            Said plainly, because a mail index without an embedder still answers every temporal
            question — and someone seeing "no vector store" should not conclude the feature is
            broken when the half they actually asked for is working.
          */}
          {!status.semantic && (
            <span style={{ display: 'block' }}>
              No vector store or embedding model configured, so searching by meaning is off.
              &ldquo;Last N hours&rdquo;, alert filtering and repeat detection all still work.
            </span>
          )}
          {status.lastResult !== undefined && <span style={{ display: 'block' }}>{status.lastResult}</span>}
        </div>
      )}
    </section>
  )
}
