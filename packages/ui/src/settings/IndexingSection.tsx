import type { IndexProgress, IndexResult, ProfileSummary } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { colors, labelStyle, optionStyle, primaryButtonStyle, secondaryButtonStyle, selectStyle, textFieldStyle } from '../theme.js'

export interface EmbedderState {
  profileId?: string
  model?: string
  dimensions?: number
  indexName?: string
  indexedFiles: number
}

export interface IndexingSectionProps {
  embedder: EmbedderState | undefined
  profiles: ProfileSummary[]
  /** The connection the index will be written to, or undefined if none is active. */
  connectionLabel: string | undefined
  progress: IndexProgress | undefined
  lastResult: { result?: IndexResult; error?: string } | undefined
  onSaveEmbedder: (profileId: string, model: string, dimensions: number) => void
  onStartIndexing: () => void
  onCancelIndexing: () => void
}

/** Common widths, offered because getting this wrong is a full reindex to discover. */
const COMMON_DIMENSIONS = [384, 768, 1024, 1536, 3072]

/**
 * Codebase indexing: the embedder, and the button that starts a run.
 *
 * **Indexing is the largest egress in the product**, so the destination is stated in full
 * before the button rather than buried in documentation — the user should not have to infer
 * that pressing this sends their source code somewhere. Nothing here is reachable by the
 * model; the run only ever starts from this button.
 */
export function IndexingSection(props: IndexingSectionProps): ReactElement {
  const [profileId, setProfileId] = useState('')
  const [model, setModel] = useState('')
  const [dimensions, setDimensions] = useState('')
  const [confirming, setConfirming] = useState(false)

  // Resynced rather than seeded once: the host's reply can arrive after this renders.
  useEffect(() => {
    setProfileId(props.embedder?.profileId ?? '')
    setModel(props.embedder?.model ?? '')
    setDimensions(props.embedder?.dimensions !== undefined ? String(props.embedder.dimensions) : '')
  }, [props.embedder])

  const running = props.progress !== undefined && props.progress.phase !== 'done'
  const parsedDimensions = Number.parseInt(dimensions, 10)
  const configured =
    profileId.length > 0 && model.trim().length > 0 && Number.isFinite(parsedDimensions) && parsedDimensions > 0
  const profile = props.profiles.find((candidate) => candidate.id === profileId)
  const ready = configured && props.connectionLabel !== undefined && props.embedder?.indexName !== undefined

  return (
    <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}`, marginTop: 12 }}>
      <strong style={{ fontSize: 12, color: colors.foreground }}>Codebase indexing</strong>
      <p style={{ color: colors.muted, fontSize: 11, margin: '4px 0 10px' }}>
        Lets the model search this workspace by meaning rather than by exact text — useful when you
        do not know what something is called. Optional, and off until you index.
      </p>

      <div style={{ marginBottom: 10 }}>
        <label htmlFor="lc-emb-profile" style={labelStyle()}>
          Embedding provider
        </label>
        <select
          id="lc-emb-profile"
          value={profileId}
          onChange={(event) => setProfileId(event.target.value)}
          style={{ ...selectStyle(), width: '100%' }}
        >
          <option value="" style={optionStyle()}>
            Choose a provider profile…
          </option>
          {props.profiles.map((candidate) => (
            <option key={candidate.id} value={candidate.id} style={optionStyle()}>
              {candidate.label}
            </option>
          ))}
        </select>
        <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
          Reuses an existing profile&apos;s URL, credentials and certificates — one place to get
          mutual TLS right instead of two.
          {profile !== undefined && ` Requests go to ${profile.baseUrl}.`}
        </span>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label htmlFor="lc-emb-model" style={labelStyle()}>
          Embedding model
        </label>
        <input
          id="lc-emb-model"
          type="text"
          value={model}
          spellCheck={false}
          placeholder="text-embedding-3-small"
          onChange={(event) => setModel(event.target.value)}
          style={textFieldStyle()}
        />
        <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
          An embedding model, not a chat model. Ask your gateway which it exposes.
        </span>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label htmlFor="lc-emb-dims" style={labelStyle()}>
          Vector width
        </label>
        <input
          id="lc-emb-dims"
          type="number"
          list="lc-emb-dims-common"
          value={dimensions}
          placeholder="1536"
          onChange={(event) => setDimensions(event.target.value)}
          style={{ ...textFieldStyle(), width: 160 }}
        />
        <datalist id="lc-emb-dims-common">
          {COMMON_DIMENSIONS.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
          Must match what the model actually returns — OpenSearch fixes this when the index is
          created. Getting it wrong fails on the first batch with the real width in the message.
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={!configured}
          onClick={() => props.onSaveEmbedder(profileId, model.trim(), parsedDimensions)}
        >
          Save embedder
        </button>
        {props.embedder?.indexedFiles !== undefined && props.embedder.indexedFiles > 0 && (
          <span style={{ fontSize: 11, color: colors.muted }}>
            {props.embedder.indexedFiles} file(s) indexed
          </span>
        )}
      </div>

      {/*
        Stated before the action, not after. This is the one control in the product that
        uploads the workspace, and the README commits to saying so plainly.
      */}
      {ready && !running && (
        <div
          style={{
            fontSize: 11,
            color: colors.muted,
            border: `1px solid ${colors.border}`,
            borderRadius: 3,
            padding: '8px 10px',
            marginBottom: 8,
          }}
        >
          Indexing reads every source file in this workspace, sends it to{' '}
          <strong style={{ color: colors.foreground }}>{profile?.baseUrl ?? 'the embedding endpoint'}</strong> to be
          embedded, and stores the result in{' '}
          <strong style={{ color: colors.foreground }}>{props.embedder?.indexName}</strong> on{' '}
          <strong style={{ color: colors.foreground }}>{props.connectionLabel}</strong>. Files that are
          gitignored, deny-listed or binary are never sent.
        </div>
      )}

      {running ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" style={secondaryButtonStyle()} onClick={props.onCancelIndexing}>
            Stop
          </button>
          <span style={{ fontSize: 11, color: colors.muted }}>
            {props.progress?.phase} — {props.progress?.filesIndexed} indexed, {props.progress?.filesSkipped} skipped
            {props.progress?.current !== undefined && ` · ${props.progress.current}`}
          </span>
        </div>
      ) : confirming ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12 }}>Send this workspace to be embedded?</span>
          <button
            type="button"
            style={primaryButtonStyle(false)}
            onClick={() => {
              setConfirming(false)
              props.onStartIndexing()
            }}
          >
            Index now
          </button>
          <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            style={primaryButtonStyle(!ready)}
            disabled={!ready}
            onClick={() => setConfirming(true)}
          >
            {props.embedder !== undefined && props.embedder.indexedFiles > 0 ? 'Reindex workspace' : 'Index workspace'}
          </button>
          {!ready && (
            <span style={{ fontSize: 11, color: colors.muted }}>
              {props.connectionLabel === undefined
                ? 'Choose an active connection above first.'
                : props.embedder?.indexName === undefined
                  ? 'Open a folder to index.'
                  : 'Save an embedder first.'}
            </span>
          )}
        </div>
      )}

      {props.lastResult?.error !== undefined && (
        <div style={{ fontSize: 11, color: colors.error, marginTop: 8 }}>{props.lastResult.error}</div>
      )}
      {props.lastResult?.result !== undefined && !running && (
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 8 }}>
          Indexed {props.lastResult.result.filesIndexed} file(s), {props.lastResult.result.chunksWritten} chunk(s)
          {props.lastResult.result.filesRemoved > 0 && `, removed ${props.lastResult.result.filesRemoved}`}.
          {/*
            Skip reasons are shown rather than summed away: "0 files indexed" is otherwise
            impossible to diagnose, and the usual causes — everything gitignored, wrong
            file types — are only visible here.
          */}
          {Object.keys(props.lastResult.result.skipReasons).length > 0 && (
            <span>
              {' '}
              Skipped:{' '}
              {Object.entries(props.lastResult.result.skipReasons)
                .map(([reason, count]) => `${count} ${reason}`)
                .join(', ')}
              .
            </span>
          )}
        </div>
      )}
    </div>
  )
}
