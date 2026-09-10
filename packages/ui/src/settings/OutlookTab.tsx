import { useEffect, useState, type ReactElement } from 'react'

import { FolderTree, type MailFolderNode } from './FolderTree.js'
import { IndexingProgress, type IndexingProgressState } from './IndexingProgress.js'
import { Select } from '../Select.js'
import { colors, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

export interface MailStatusState {
  enabled: boolean
  available: boolean
  folders: string[]
  includeSubfolders?: boolean
  syncMinutes: number
  retentionMonths: number
  indexed: number
  oldest?: number
  newest?: number
  sizeBytes: number
  semantic: boolean
  storeId?: string
  stores: { id: string; label: string }[]
  busy?: boolean
  lastResult?: string
}

export interface OutlookTabProps {
  status: MailStatusState | undefined
  tree: { folders: MailFolderNode[]; error?: string; loading: boolean; scannedAt?: number }
  progress: IndexingProgressState | undefined
  onSave: (settings: {
    enabled: boolean
    folders: string[]
    includeSubfolders: boolean
    syncMinutes: number
    retentionMonths: number
    storeId: string
  }) => void
  onRefreshFolders: () => void
  onSyncNow: () => void
  onPrune: () => void
  onStop: () => void
  onOpenTools: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A titled block, so a long settings page reads as parts rather than a wall. */
function Section(props: { title: string; hint?: string; children: React.ReactNode }): ReactElement {
  return (
    <section style={{ marginBottom: 18 }}>
      <h3 style={{ margin: '0 0 2px', fontSize: 12, letterSpacing: 0.3, textTransform: 'uppercase', color: colors.muted }}>
        {props.title}
      </h3>
      {props.hint !== undefined && (
        <p style={{ margin: '0 0 8px', color: colors.muted, fontSize: 11 }}>{props.hint}</p>
      )}
      {props.children}
    </section>
  )
}

/**
 * Everything about indexing Outlook mail, on one tab.
 *
 * ## Why it is a tab and why it is always here
 *
 * It had outgrown the corner of Tools it started in. It is also always present, even with Outlook
 * switched off, because this codebase already decided that question — the Office toggles are
 * *disabled with a reason rather than hidden*, and there is a test named for it. Hiding this one
 * would be worse still: to configure mail you must first enable Outlook, which lives on another
 * tab, so hiding it makes the feature invisible to exactly the person looking for it.
 */
export function OutlookTab(props: OutlookTabProps): ReactElement {
  const [enabled, setEnabled] = useState(false)
  const [folders, setFolders] = useState<string[]>([])
  const [includeSubfolders, setIncludeSubfolders] = useState(true)
  const [syncMinutes, setSyncMinutes] = useState('15')
  const [retentionMonths, setRetentionMonths] = useState('6')
  const [storeId, setStoreId] = useState('')

  // Resynced rather than seeded once: the host's reply can arrive after this renders.
  useEffect(() => {
    if (props.status === undefined) return
    setEnabled(props.status.enabled)
    setFolders(props.status.folders)
    setIncludeSubfolders(props.status.includeSubfolders !== false)
    setSyncMinutes(String(props.status.syncMinutes))
    setRetentionMonths(String(props.status.retentionMonths))
    setStoreId(props.status.storeId ?? '')
  }, [props.status])

  const status = props.status

  /*
   * Asked for on open, and answered from the cache. Making people press a button before they can
   * see anything is a step that exists only because it was easier to build.
   */
  useEffect(() => {
    if (props.status?.available === true && props.tree.folders.length === 0 && !props.tree.loading) {
      props.onRefreshFolders()
    }
  }, [props.status?.available])

  const save = (): void => {
    props.onSave({
      enabled,
      folders,
      includeSubfolders,
      syncMinutes: Math.max(5, Math.min(1440, Number(syncMinutes) || 15)),
      retentionMonths: Math.max(1, Math.min(120, Number(retentionMonths) || 6)),
      storeId,
    })
  }

  const header = (
    <>
      <h2 style={{ margin: '0 0 4px', fontSize: 14 }}>Outlook</h2>
      <p style={{ margin: '0 0 14px', color: colors.muted, fontSize: 11 }}>
        Index mail folders so the assistant can answer questions about them &mdash; what arrived in
        the last few hours, whether an alert keeps repeating, and when it usually lands.
      </p>
    </>
  )

  if (status === undefined) {
    return (
      <div>
        {header}
        <span style={{ color: colors.muted, fontSize: 11 }}>Checking&hellip;</span>
      </div>
    )
  }

  if (!status.available) {
    return (
      <div>
        {header}
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 4, padding: 10, fontSize: 11, color: colors.muted }}>
          <span style={{ display: 'block', marginBottom: 6 }}>
            Outlook access is switched off, so nothing here can run yet. It is Windows only.
          </span>
          {/* The link, not just the sentence: being told a prerequisite without being taken to it
              is what leaves people hunting through tabs. */}
          <button
            type="button"
            style={{ background: 'none', border: 'none', color: colors.accent, cursor: 'pointer', padding: 0, fontSize: 11 }}
            onClick={props.onOpenTools}
          >
            Open Tools to enable Outlook
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      {header}

      <Section title="Indexing">
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} style={{ marginTop: 2 }} />
          <span>
            <span style={{ display: 'block', fontSize: 13 }}>Keep mail indexed automatically</span>
            <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
              New messages are collected on a timer. Unticking stops it entirely &mdash; nothing is
              read while it is off.
            </span>
          </span>
        </label>
      </Section>

      <Section
        title="Folders"
        hint="Tick what to index. Everything here came from Outlook, so nothing can be mistyped."
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          {/*
            Rescan, not load. The tree is served from a cache the moment the tab opens, because
            walking a mailbox is a server round trip per folder on Exchange and the tree changes
            every few weeks at most. This is for when it has genuinely changed.
          */}
          <button type="button" style={secondaryButtonStyle()} disabled={props.tree.loading} onClick={props.onRefreshFolders}>
            {props.tree.loading ? 'Scanning…' : 'Rescan mailbox'}
          </button>
          {props.tree.scannedAt !== undefined && (
            <span style={{ color: colors.muted, fontSize: 11 }}>
              Scanned {new Date(props.tree.scannedAt).toLocaleString()}
            </span>
          )}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 11 }}>
            <input
              type="checkbox"
              checked={includeSubfolders}
              onChange={(event) => setIncludeSubfolders(event.target.checked)}
            />
            {/*
              Resolved when the sync runs, never expanded here. Storing the expansion would freeze
              the tree as it was the day it was ticked, so a subfolder created next month would
              silently never be indexed.
            */}
            <span>Include subfolders</span>
          </label>
        </div>

        {props.tree.error !== undefined && (
          <span style={{ display: 'block', color: colors.error, fontSize: 11, marginBottom: 6 }}>{props.tree.error}</span>
        )}

        <FolderTree
          folders={props.tree.folders}
          selected={folders}
          onChange={setFolders}
          includeSubfolders={includeSubfolders}
        />
      </Section>

      <Section
        title="Where it is stored"
        hint="Subjects, senders and the opening of each message are sent to your embedding endpoint. Choose a separate connection to keep mail off a shared cluster."
      >
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
        {!status.semantic && (
          <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 4 }}>
            No embedding model configured, so searching by meaning is off. Time windows, alert
            filtering and repeat detection all still work.
          </span>
        )}
      </Section>

      <Section title="Schedule and retention">
        <div style={{ display: 'flex', gap: 10 }}>
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
      </Section>

      <Section title="Actions">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={primaryButtonStyle(false)} onClick={save}>
            Save
          </button>
          <button type="button" style={secondaryButtonStyle()} disabled={status.busy === true || !enabled} onClick={props.onSyncNow}>
            Sync now
          </button>
          <button
            type="button"
            style={secondaryButtonStyle()}
            disabled={status.busy === true || status.indexed === 0}
            title={`Remove indexed mail older than ${retentionMonths} months`}
            onClick={props.onPrune}
          >
            Remove older than {retentionMonths}m
          </button>
        </div>

        <IndexingProgress progress={props.progress} onStop={props.onStop} />

        <div style={{ marginTop: 8, color: colors.muted, fontSize: 11 }}>
          <span style={{ display: 'block' }}>
            {status.indexed === 0
              ? 'Nothing indexed yet.'
              : `${String(status.indexed)} message(s), ${formatSize(status.sizeBytes)} on disk` +
                `${status.oldest !== undefined ? `, oldest ${new Date(status.oldest).toLocaleDateString()}` : ''}.`}
          </span>
          {status.lastResult !== undefined && <span style={{ display: 'block' }}>{status.lastResult}</span>}
        </div>
      </Section>
    </div>
  )
}
