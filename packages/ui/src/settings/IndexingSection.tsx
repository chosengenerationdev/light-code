import type { IndexProgress, IndexResult, ProfileSummary } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { Select } from '../Select.js'
import { colors, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

export interface EmbedderState {
  profileId?: string
  model?: string
  dimensions?: number
  indexName?: string
  indexNameIsCustom?: boolean
  /**
   * What skills and tool documentation actually resolve to, alongside the codebase index.
   *
   * Resolved rather than configured, and shown read-only: somebody has to be able to match what
   * Light Code writes against what is in the cluster. They were computed in four places and
   * displayed in none.
   */
  skillsIndexName?: string
  docsIndexName?: string
  indexPrefix?: string
  defaultIndexPrefix?: string
  /**
   * A name pointing at every team member's index, so they can be searched together.
   *
   * Still singular here because this mirrors what the host sends, and the host writes both this
   * and `indexAliases` — `codebaseAliases` merges them into the list the field shows. Older
   * configs have only this one.
   */
  indexAlias?: string
  /** The further names, beyond `indexAlias`. See `rag/aliases.ts` for why there are two keys. */
  indexAliases?: string[]
  /** The same for skills. Shown in the Skills tab rather than here. */
  skillsAlias?: string
  /** The further skills names, carried so the Skills tab can merge them. */
  skillsAliases?: string[]
  indexedFiles: number
}

export interface IndexingSectionProps {
  embedder: EmbedderState | undefined
  profiles: ProfileSummary[]
  /** The connection the index will be written to, or undefined if none is active. */
  connectionLabel: string | undefined
  progress: IndexProgress | undefined
  lastResult: { result?: IndexResult; error?: string } | undefined
  /** Catalogue for the chosen profile. Empty is normal — free text always works (§9). */
  models: string[]
  modelsWarning?: string | undefined
  modelsLoading: boolean
  /** Increments when the host confirms the save reached disk. */
  savedTick: number
  onRequestModels: (profileId: string) => void
  /** The model only; names and aliases are saved from Settings → Project. */
  onSaveEmbedder: (profileId: string, model: string, dimensions: number) => void
  onStartIndexing: () => void
  /** Empties the index and forgets the manifest, so the next run rebuilds from nothing. */
  onClearIndex: () => void
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
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [saved, setSaved] = useState(false)

  // Resynced rather than seeded once: the host's reply can arrive after this renders.
  useEffect(() => {
    setProfileId(props.embedder?.profileId ?? '')
    setModel(props.embedder?.model ?? '')
    setDimensions(props.embedder?.dimensions !== undefined ? String(props.embedder.dimensions) : '')
  }, [props.embedder])


  /*
   * Fetched on selection rather than behind a button. The user has already told us which
   * profile to use, so making them press Refresh to discover what it offers is a step that
   * exists only because it was easier to build.
   */
  useEffect(() => {
    if (profileId.length > 0) props.onRequestModels(profileId)
    // Deliberately keyed on the profile alone: refetching on every keystroke in the model
    // field would hammer the gateway.
  }, [profileId])

  useEffect(() => {
    if (props.savedTick === 0) return
    setSaved(true)
    const timer = setTimeout(() => setSaved(false), 3000)
    return () => clearTimeout(timer)
  }, [props.savedTick])

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
        <Select
          id="lc-emb-profile"
          value={profileId}
          onChange={setProfileId}
          style={{ width: '100%' }}
          options={[
            { value: '', label: 'Choose a provider profile…' },
            ...props.profiles.map((candidate) => ({ value: candidate.id, label: candidate.label })),
          ]}
        />
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
        {/*
          Dropdown *and* free text, always both (§9). A gateway that publishes no catalogue,
          or publishes one that omits its embedding models, is common — so the list is a
          convenience layered over the field, never a gate in front of it.
        */}
        {props.models.length > 0 && (
          <Select
            ariaLabel="Available models"
            value={props.models.includes(model) ? model : ''}
            onChange={(value) => {
              if (value.length > 0) setModel(value)
            }}
            style={{ width: '100%', marginBottom: 4 }}
            options={[
              { value: '', label: `Choose from ${props.models.length} model(s)…` },
              ...props.models.map((candidate) => ({ value: candidate, label: candidate })),
            ]}
          />
        )}
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
          {profileId.length === 0
            ? 'Choose a provider above to see what it offers.'
            : props.modelsLoading
              ? 'Fetching the model list…'
              : props.models.length === 0
                ? `No catalogue from this provider${props.modelsWarning !== undefined ? ` (${props.modelsWarning})` : ''} — type the model name.`
                : 'Pick one, or type a name the list does not include.'}
          {' '}An embedding model, not a chat model.
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

      {/*
        Index names and team aliases live in Settings → Project now, with the project name and the
        author they are built from. Shown here read-only because this is where the indexing button
        is, and pressing it should not mean guessing where the source code goes.
      */}
      <div style={{ marginBottom: 12, fontSize: 11, color: colors.muted, lineHeight: 1.6 }}>
        {props.embedder?.indexName !== undefined && (
          <div style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', wordBreak: 'break-all' }}>
            codebase → {props.embedder.indexName}
            {props.embedder.skillsIndexName !== undefined && (
              <>
                <br />
                skills → {props.embedder.skillsIndexName}
              </>
            )}
            {props.embedder.docsIndexName !== undefined && (
              <>
                <br />
                tool docs → {props.embedder.docsIndexName}
              </>
            )}
          </div>
        )}
        Index names, the prefix and team aliases are set in <strong>Settings → Project</strong>.
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
        {/*
          A disabled button that says nothing is indistinguishable from a broken one — which
          is exactly how this was first reported. It now names the missing field.
        */}
        {!configured && (
          <span style={{ fontSize: 11, color: colors.muted }}>
            {profileId.length === 0
              ? 'Choose a provider first.'
              : model.trim().length === 0
                ? 'Enter or pick an embedding model.'
                : 'Enter the vector width.'}
          </span>
        )}
        {configured && saved && <span style={{ fontSize: 11, color: colors.muted }}>Saved.</span>}
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
          {/*
            Clearing is the move nobody had.

            Reindex is incremental - it diffs the workspace against the manifest - so a suspicion
            that the index has gone wrong had no answer: the button that looks like "build it
            again" would decide nothing had changed and do nothing. This throws away the vectors
            *and* the manifest, which is the pair that has to go together: an emptied index with
            its manifest intact believes it is complete, for ever.
          */}
          {confirmingClear ? (
            <>
              <span style={{ fontSize: 11 }}>Throw away the whole index?</span>
              <button
                type="button"
                style={primaryButtonStyle(false)}
                onClick={() => {
                  setConfirmingClear(false)
                  props.onClearIndex()
                }}
              >
                Clear it
              </button>
              <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirmingClear(false)}>
                Keep it
              </button>
            </>
          ) : (
            props.embedder !== undefined &&
            props.embedder.indexedFiles > 0 && (
              <button
                type="button"
                style={secondaryButtonStyle()}
                title="Removes every chunk and forgets what was indexed, so the next run starts from nothing"
                onClick={() => setConfirmingClear(true)}
              >
                Clear index
              </button>
            )
          )}
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
